import { randomUUID, timingSafeEqual } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import { isConversationAction, WORKER_PROTOCOL_VERSION, workerServiceDefinition } from "../../shared/src/grpc.js";
import type { AgentEvent, OAuthLoginEvent, WorkerHandlers } from "../../shared/src/grpc.js";
import type { WorkerConfig } from "./config.js";
import { DurableWorkerRuntime, type OAuthLoginUpdate } from "./runtime.js";
import { InvalidAgentMessage } from "./messages.js";

function hasValidToken(metadata: grpc.Metadata, expected: string): boolean {
  const value = metadata.get("authorization")[0];
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return false;
  const actual = Buffer.from(value.slice("Bearer ".length));
  const expectedBuffer = Buffer.from(expected);
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function safeErrorDetail(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current !== undefined; depth++) {
    if (current instanceof Error) {
      messages.push(`${current.name}: ${current.message}`);
      current = current.cause;
    } else {
      messages.push(String(current));
      break;
    }
  }
  return messages
    .join(" | ")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /([?&](?:access_token|refresh_token|id_token|client_secret|api_key|token|code|state)=)[^&#\s]+/gi,
      "$1[redacted]",
    )
    .replace(
      /(["']?(?:access_token|refresh_token|id_token|client_secret|api_key|authorization|password)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      "$1[redacted]",
    )
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{8,})\b/g, "[redacted]")
    .slice(0, 600);
}

function serializeOAuthLoginUpdate(sessionId: string, update: OAuthLoginUpdate): OAuthLoginEvent {
  switch (update.type) {
    case "started":
      return { sessionId, started: {} };
    case "auth_url":
      return { sessionId, authUrl: { url: update.url, instructions: update.instructions ?? "" } };
    case "device_code":
      return {
        sessionId,
        deviceCode: {
          userCode: update.userCode,
          verificationUri: update.verificationUri,
          intervalSeconds: update.intervalSeconds ?? 0,
          expiresInSeconds: update.expiresInSeconds ?? 0,
        },
      };
    case "info":
      return { sessionId, info: { message: update.message, links: update.links?.map((link) => link.url) ?? [] } };
    case "progress":
      return { sessionId, progress: { message: update.message } };
    case "text":
    case "secret":
    case "manual_code":
    case "select":
      return {
        sessionId,
        prompt: {
          promptType: update.type,
          message: update.message,
          placeholder: "placeholder" in update ? update.placeholder ?? "" : "",
          options: update.type === "select" ? [...update.options] : [],
        },
      };
    case "completed":
      return { sessionId, completed: {} };
    case "failed":
      return { sessionId, failed: { message: update.message } };
  }
}

export async function startWorkerServer(config: WorkerConfig): Promise<{
  close(): Promise<void>;
}> {
  const runtime = await DurableWorkerRuntime.open(config);
  const server = new grpc.Server({
    "grpc.max_receive_message_length": 32 * 1024 * 1024,
    "grpc.max_send_message_length": 64 * 1024 * 1024,
    interceptors: [(_method, call) => new grpc.ServerInterceptingCall(call, {
      start(next) {
        next({
          onReceiveMetadata(metadata, forward) {
            if (hasValidToken(metadata, config.authToken)) forward(metadata);
            else call.sendStatus({ code: grpc.status.UNAUTHENTICATED, details: "Unauthenticated" });
          },
        });
      },
    })],
  });

  const implementation: WorkerHandlers = {
    Health: (_call, callback) => {
      callback(null, { ready: true, version: WORKER_PROTOCOL_VERSION });
    },
    ControlConversation: async (call, callback) => {
      if (!isConversationAction(call.request.action)) {
        callback(null, {
          accepted: false,
          message: `Unsupported conversation action: ${call.request.action}`,
        });
        return;
      }
      try {
        const message = await runtime.controlConversation(
          call.request.conversationKey,
          call.request.action,
          call.request.instructions,
        );
        callback(null, { accepted: true, message });
      } catch (error) {
        callback(null, {
          accepted: false,
          message: error instanceof Error ? error.message : "The conversation action failed.",
        });
      }
    },
    GetModelSettings: async (call, callback) => {
      try {
        callback(null, await runtime.getModelSettings(call.request.conversationKey));
      } catch {
        callback({ code: grpc.status.INTERNAL, message: "Could not read model settings." });
      }
    },
    StartOAuthLogin: (call) => {
      const sessionId = randomUUID();
      void runtime
        .startOAuthLogin(sessionId, call.request.providerId, (update) => {
          if (!call.destroyed) call.write(serializeOAuthLoginUpdate(sessionId, update));
        })
        .finally(() => {
          if (!call.destroyed) call.end();
        });
      call.on("cancelled", () => runtime.cancelOAuthLogin(sessionId));
    },
    RespondOAuthLogin: (call, callback) => {
      const accepted = runtime.respondOAuthLogin(call.request.sessionId, call.request.input);
      callback(null, { accepted, message: accepted ? "Login input received." : "No login is waiting for input." });
    },
    CancelOAuthLogin: (call, callback) => {
      const accepted = runtime.cancelOAuthLogin(call.request.sessionId);
      callback(null, { accepted, message: accepted ? "Login cancelled." : "Login is no longer active." });
    },
    StartGoogleLogin: async (call, callback) => {
      try {
        const result = await runtime.startGoogleLogin(call.request.email);
        callback(null, { accepted: true, error: "", ...result });
      } catch (error) {
        callback(null, {
          accepted: false,
          error: error instanceof Error ? error.message : "Could not start Google sign in.",
          sessionId: "",
          email: "",
          authUrl: "",
        });
      }
    },
    CompleteGoogleLogin: async (call, callback) => {
      try {
        await runtime.completeGoogleLogin(call.request.sessionId, call.request.authUrl);
        callback(null, { accepted: true, error: "" });
      } catch (error) {
        console.error(`Google sign-in completion failed: ${safeErrorDetail(error)}`);
        callback(null, {
          accepted: false,
          error: error instanceof Error ? error.message : "Could not finish Google sign in.",
        });
      }
    },
    CancelGoogleLogin: (call, callback) => {
      callback(null, { status: runtime.cancelGoogleLogin(call.request.sessionId) });
    },
    WatchIntegrationRequests: (call) => {
      const detach = runtime.watchIntegrationRequests((request) => {
        if (!call.destroyed) call.write(request);
      });
      let detached = false;
      const stop = () => {
        if (detached) return;
        detached = true;
        detach();
      };
      call.on("cancelled", stop);
      call.on("close", stop);
    },
    ResolveIntegrationRequest: (call, callback) => {
      callback(null, { accepted: runtime.resolveIntegrationRequest(call.request) });
    },
    ExecuteIntegration: (call, callback) => {
      const controller = new AbortController();
      call.on("cancelled", () => controller.abort(new Error("Integration request cancelled.")));
      void runtime
        .executeIntegration(
          call.request.integrationId,
          call.request.operation,
          call.request.payloadJson,
          controller.signal,
        )
        .then((payloadJson) => callback(null, { accepted: true, error: "", payloadJson }))
        .catch((error: unknown) => {
          const detail = safeErrorDetail(error);
          console.error(`Integration request failed: ${detail}`);
          callback(null, {
            accepted: false,
            error: detail || "The integration request could not be completed.",
            payloadJson: "",
          });
        });
    },
    AdmitMessage: async (call, callback) => {
      const { message, onlyIfIdle } = call.request;
      if (!message?.requestId || !message.conversationKey) {
        callback({ code: grpc.status.INVALID_ARGUMENT, message: "A message and its request and conversation IDs are required." });
        return;
      }
      try {
        callback(null, await runtime.messages.admit(message, onlyIfIdle));
      } catch (error) {
        callback({
          code: error instanceof InvalidAgentMessage ? grpc.status.INVALID_ARGUMENT : grpc.status.INTERNAL,
          message: safeErrorDetail(error),
        });
      }
    },
    InspectMessage: async (call, callback) => {
      try { callback(null, await runtime.messages.inspect(call.request)); }
      catch (error) { callback({ code: grpc.status.INTERNAL, message: safeErrorDetail(error) }); }
    },
    CancelMessage: async (call, callback) => {
      try { callback(null, { accepted: await runtime.messages.cancel(call.request, call.request.queuedOnly) }); }
      catch (error) { callback({ code: grpc.status.INTERNAL, message: safeErrorDetail(error) }); }
    },
    WatchMessage: (call) => {
      const requestId = call.request.requestId;
      const controller = new AbortController();
      const emit = (event: AgentEvent) => { if (!call.destroyed) call.write(event); };
      call.on("cancelled", () => controller.abort(new Error("Response observer disconnected.")));
      emit({ requestId, started: {} });
      void runtime.messages
        .watch(call.request, (text) => emit({ requestId, textUpdate: { text } }), controller.signal)
        .then((result) => {
          for (const attachment of result.attachments) emit({ requestId, attachment });
          emit({ requestId, completed: { text: result.text } });
        })
        .catch((error: unknown) => {
          if (!call.destroyed) {
            const detail = safeErrorDetail(error);
            console.error(`Agent submission ${requestId} failed: ${detail}`);
            emit({
              requestId,
              failed: {
                message: detail
                  ? `The agent could not complete this request. ${detail}`
                  : "The agent could not complete this request.",
                code: "agent_error",
              },
            });
          }
        })
        .finally(() => {
          if (!call.destroyed) call.end();
        });
    },
  };

  server.addService(workerServiceDefinition, implementation);
  await new Promise<void>((resolve, reject) => {
    server.bindAsync(
      `0.0.0.0:${config.port}`,
      grpc.ServerCredentials.createInsecure(),
      (error) => (error ? reject(error) : resolve()),
    );
  });
  return {
    async close() {
      // Long-lived integration/response observers must not hold shutdown open.
      server.forceShutdown();
      await runtime.close();
    },
  };
}
