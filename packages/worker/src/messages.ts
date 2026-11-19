import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
  AssistantEntry, ConversationBusy, LiveDoc,
  type Conversation, type Harness, type SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { AgentMessage, MessageReceipt, MessageReference, TelegramAttachment } from "../../shared/src/grpc.js";
import { removeWorkspaceMediaMarkers } from "./media.js";
import { restoreAttachment, type AgentResponse } from "../../shared/src/agent-response.js";
import { AdvanceInboxAfterStop } from "./inbox-after-stop.js";
import { MessageResponse } from "./response-snapshot.js";

export class InvalidAgentMessage extends Error {}

export class WorkerMessages {
  constructor(
    private readonly harness: Harness,
    private readonly getConversation: (key: string) => Promise<Conversation>,
    private readonly workspace: string,
  ) {}

  private async find(reference: MessageReference) {
    const conversation = await this.getConversation(reference.conversationKey);
    const record = await this.harness.commit(
      (tx) => tx.submissionByRequest(conversation.id, reference.requestId), BACKGROUND_CONTEXT,
    );
    return { conversation, record };
  }

  async inspect(reference: MessageReference): Promise<MessageReceipt> {
    return this.receipt((await this.find(reference)).record);
  }

  private receipt(record: SubmissionRecord | undefined): MessageReceipt {
    if (!record) return { status: "missing" };
    switch (record.status) {
      case "placed": return { status: "running" };
      case "done": return { status: "completed" };
      case "queued": return { status: "queued" };
      case "unanswered": return { status: "unanswered" };
    }
  }

  /** Admission and observation are separate: a disconnected UI never cancels committed work. */
  async admit(message: AgentMessage, onlyIfIdle: boolean): Promise<MessageReceipt> {
    if (message.attachments.length > 10 ||
      message.attachments.reduce((sum, file) => sum + file.data.byteLength, 0) > 20 * 1024 * 1024) {
      throw new InvalidAgentMessage("Telegram attachments exceed the 10-file / 20 MB limit.");
    }
    const { conversation, record } = await this.find(message);
    if (record) return this.receipt(record);
    const content = await this.messageContent(message);
    try {
      const submission = await conversation.submit({
        type: "input",
        requestId: message.requestId,
        content,
        whenBusy: onlyIfIdle ? "reject" : "followUp",
        entry: {
          kind: "tandoor.telegram.input",
          data: {
            requestId: message.requestId,
            responseSnapshot: true,
            channel: message.channel || "telegram",
            senderId: message.senderId, senderName: message.senderName,
            chatId: message.chatId, threadId: message.threadId, timestampMs: message.timestampMs,
          },
        },
      }, BACKGROUND_CONTEXT);
      return this.receipt(await submission.status(BACKGROUND_CONTEXT));
    } catch (error) {
      if (error instanceof ConversationBusy) return { status: "busy" };
      throw error;
    }
  }

  async cancel(reference: MessageReference, queuedOnly: boolean): Promise<boolean> {
    const { conversation, record } = await this.find(reference);
    if (!record || record.status === "done" || record.status === "unanswered") return false;
    const result = await this.harness.abortSubmission(record.id, BACKGROUND_CONTEXT, conversation.id);
    if (result === "aborted") return true;
    if (queuedOnly || result !== "already_placed") return false;
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(MessageResponse, conversation.id, reference.requestId, null);
      if (state.advanceAfterStop) return;
      state.advanceAfterStop = true;
      await tx.createTask(AdvanceInboxAfterStop, { submissionId: record.id }, {
        conversationId: conversation.id, ownership: { kind: "conversation" }, background: true,
      });
    }, BACKGROUND_CONTEXT);
    // Withdraw only this queued input, or stop only the run that owns this placed input.
    // A generation can hand the run to another task between the snapshot and abort.
    for (;;) {
      const live = await this.harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
      if (!live?.run?.inputs.includes(record.id)) return false;
      if (await this.harness.abortTask(live.run.taskId, BACKGROUND_CONTEXT) !== "terminal") return true;
    }
  }

  async watch(
    reference: MessageReference,
    onTextUpdate: (text: string) => void,
    signal: AbortSignal,
  ): Promise<{ text: string; attachments: TelegramAttachment[] }> {
    const { conversation, record } = await this.find(reference);
    if (!record) throw new Error("This message has not been admitted.");
    const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
    const watch = await this.harness.watchDoc(LiveDoc, conversation.id, context);
    let latest = "";
    const publish = (live: NonNullable<typeof watch>["value"]) => {
      if (!live.run?.inputs.includes(record.id)) return;
      const text = live.generation?.message?.content.flatMap(
        (part) => part.type === "text" ? [part.text] : [],
      ).join("") ?? "";
      if (text !== latest) { latest = text; onTextUpdate(text); }
    };
    if (watch) {
      publish(watch.value);
      watch.start(async (call) => { if (call.kind === "value") publish(call.value); });
    }
    try {
      const submission = await this.harness.submission(record.id, context);
      if (!submission) throw new Error("The admitted message is missing.");
      const settled = await submission.wait(context);
      if (settled.status !== "done" || settled.type !== "input") {
        throw new Error(String(settled.detail ?? settled.reason ?? "The submission was unanswered."));
      }
      // Durable settles the submission before its afterRun tasks. The generation
      // still owns the workspace until those tasks finish, including after restart.
      const run = (await this.harness.snapshot(LiveDoc, conversation.id, context))?.run;
      if (run?.afterRun && (run.first ?? settled.answer) <= settled.entry) {
        await this.harness.waitForTask(run.taskId, context);
      }
      const saved = await this.harness.snapshot(MessageResponse, conversation.id, reference.requestId, context);
      if (saved?.response) {
        return { text: saved.response.text, attachments: saved.response.attachments.map(restoreAttachment) };
      }
      const input = await conversation.commit((tx) => tx.entry(settled.entry), context);
      if (input?.data && typeof input.data === "object" && !Array.isArray(input.data) && input.data.responseSnapshot === true) {
        throw new Error("The response could not be prepared for delivery. Please try the request again.");
      }
      const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
      const assistant = entry?.model?.[0];
      if (!assistant || assistant.role !== "assistant") throw new Error("The run contained no assistant answer.");
      const text = assistant.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("").trim();
      const legacy = removeWorkspaceMediaMarkers(text);
      return {
        text: legacy.count === 0
          ? text
          : [
              legacy.text.trim(),
              "The original file could not be verified. Please ask me to recreate it.",
            ].filter(Boolean).join("\n\n"),
        attachments: [],
      };
    } finally {
      await watch?.stop();
    }
  }

  private async messageContent(message: AgentMessage) {
    const { attachments } = message;
    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
      { type: "text", text: message.text || "Please inspect the attached file." },
    ];
    if (!attachments.length) return content;
    const directory = join(this.workspace, "telegram-uploads");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const [index, attachment] of attachments.entries()) {
      const safeName = attachment.filename.replace(/\\/g, "/").split("/").pop()!
        .replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120) || "attachment.bin";
      const name = `${message.chatId}-${message.requestId.replace(/[^A-Za-z0-9_-]/g, "_")}-${index}-${safeName}`;
      const path = join(directory, name);
      const temporary = `${path}.${randomUUID()}.tmp`;
      const data = Buffer.from(attachment.data);
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, path);
      const mimeType = attachment.mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
      content.push({ type: "text", text: `Telegram attachment saved at telegram-uploads/${name} (${mimeType || "unknown type"}).` });
      if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType)) {
        content.push({ type: "image", data: data.toString("base64"), mimeType });
      }
    }
    return content;
  }
}
