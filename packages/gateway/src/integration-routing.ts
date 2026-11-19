import type { IntegrationRequest } from "../../shared/src/grpc.js";
import type { WorkerScope } from "../../shared/src/scope.js";

export function validateIntegrationRequest(
  sourceScope: WorkerScope,
  request: IntegrationRequest,
): void {
  const conversationPrefix = `telegram:user:${sourceScope.id}:`;
  if (!request.conversationKey.startsWith(conversationPrefix)) {
    throw new Error("The integration request does not match this conversation's worker.");
  }
  if (!/^\d{1,20}$/.test(request.actorId)) {
    throw new Error("The Telegram sender could not be verified.");
  }
  if (request.actorId !== sourceScope.id) throw new Error("The integration sender does not own this worker.");
  if (
    !/^[a-z][a-z0-9_-]{0,63}$/.test(request.integrationId) ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(request.operation) ||
    request.payloadJson.length > 2 * 1024 * 1024
  ) {
    throw new Error("The integration request is invalid.");
  }
  try {
    JSON.parse(request.payloadJson);
  } catch {
    throw new Error("The integration request payload is invalid.");
  }

  if (request.targetScope === "service") {
    const contextWebRequest =
      request.integrationId === "context_web" && ["find", "fetch"].includes(request.operation);
    const schedulingRequest =
      request.integrationId === "tandoor_scheduling" &&
      ["create", "list", "cancel", "pause", "resume", "set_timezone"].includes(request.operation);
    if (!contextWebRequest && !schedulingRequest) {
      throw new Error("The requested service integration is not available.");
    }
    return;
  }
  throw new Error("Only gateway-owned services use this integration channel.");
}
