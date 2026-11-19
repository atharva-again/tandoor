import { defineTask, InboxDoc, LiveDoc, type SubmissionId } from "@earendil-works/pi-durable";

/** Stopping one answer must not discard or strand the inputs already queued behind it. */
export const AdvanceInboxAfterStop = defineTask<{ submissionId: SubmissionId }, { phase: "advance" }, null>({
  name: "tandoor.advance-inbox-after-stop",
  version: 1,
  initial: () => ({ phase: "advance" }),
  phases: {
    advance: async (task, runtime, context) => {
      const conversation = await runtime.conversation(task.conversationId, context);
      if (!conversation) throw new Error("The stopped conversation is missing.");
      await runtime.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, task.conversationId);
        if (live.run?.inputs.includes(task.input.submissionId)) {
          return {
            status: "waiting", on: [live.run.taskId], policy: "allSettled",
            checkpoint: { phase: "advance" },
          };
        }
        const inbox = await tx.doc(InboxDoc, task.conversationId);
        if (!live.run && inbox.items.some((item) => item.mode !== "write")) {
          await conversation.submit(tx, {
            type: "continue", requestId: `stop-followups:${task.input.submissionId}`,
          });
        }
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});
