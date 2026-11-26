import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AbortController as AbortControllerPolyfill } from "abort-controller";
import { BotError, GrammyError } from "grammy";
import type { Update } from "grammy/types";
import { defineExtension } from "@earendil-works/pi-durable";
import type { TandoorConfig } from "../../shared/src/config.js";
import { ContextWebService } from "./context-web.js";
import { GatewayWorkStore } from "./gateway-work-store.js";
import { createResponseDeliveryTask } from "./response-delivery.js";
import { ScheduleService } from "./schedule-service.js";
import { TELEGRAM_COMMANDS, TelegramCommands } from "./telegram-commands.js";
import { TelegramDelivery } from "./telegram-delivery.js";
import { TelegramGoogleAuth } from "./telegram-google-auth.js";
import { TelegramLoginCoordinator } from "./telegram-login-coordinator.js";
import { TelegramMessageHandler, TelegramReceiptWriteFailed } from "./telegram-message-handler.js";
import { TelegramModelPickers } from "./telegram-model-pickers.js";
import { TelegramProviderAuth } from "./telegram-provider-auth.js";
import { createTelegramReplyTask } from "./telegram-replies.js";
import { createTelegramAdmissionTask, TelegramInbox } from "./telegram-inbox.js";
import { createScheduledWorkTask } from "./scheduled-work-task.js";
import { TelegramScheduledWorkAdapter } from "./telegram-scheduled-work-adapter.js";
import { TelegramSchedulingIntegration } from "./telegram-scheduling-integration.js";
import { TelegramUI } from "./telegram-ui.js";
import { enableTelegramTopics } from "./telegram-topics.js";
import { WorkerIntegrationBridge, type ServiceIntegration } from "./worker-integration-bridge.js";
import type { PodmanWorkerManager } from "./worker-manager.js";
import type { ConnectWorker } from "./worker-client.js";

/** Composition and lifecycle only: features communicate through explicit dependencies, not this object. */
export class TelegramGateway {
  private pollingController: AbortControllerPolyfill | undefined;
  private polling: Promise<void> | undefined;
  private stopping = false;

  private constructor(
    private readonly ui: TelegramUI,
    private readonly workers: PodmanWorkerManager,
    private readonly bridge: WorkerIntegrationBridge,
    private readonly google: TelegramGoogleAuth,
    private readonly providers: TelegramProviderAuth,
    private readonly messages: TelegramMessageHandler,
    private readonly schedules: ScheduleService,
    private readonly store: GatewayWorkStore,
  ) {}

  static async open(config: TandoorConfig, workers: PodmanWorkerManager): Promise<TelegramGateway> {
    const ui = new TelegramUI(config.telegramBotToken, config.allowedUserIds);
    const services = new Map<string, ServiceIntegration>();
    const bridge = new WorkerIntegrationBridge(services);
    const connectWorker: ConnectWorker = async (scope) => {
      const worker = await workers.get(scope);
      bridge.watchWorker(scope, worker);
      return worker;
    };
    const logins = new TelegramLoginCoordinator();
    const providers = new TelegramProviderAuth(ui, connectWorker, logins);
    const google = new TelegramGoogleAuth(ui, config, connectWorker, logins);
    const models = new TelegramModelPickers(ui, connectWorker, (identity, worker) => providers.showLoginPicker(identity, worker));
    const delivery = new TelegramDelivery(ui);
    const deliveryTask = createResponseDeliveryTask(new Map([["telegram", delivery]]), await legacyDeliveryIds(config.dataDir));
    const scheduleAdapter = new TelegramScheduledWorkAdapter({
      connectWorker,
      isAllowed: (identity) => ui.isAllowed(identity),
      ensurePrivateChat: async (actorId) => {
        try { await ui.bot.api.sendChatAction(Number(actorId), "typing"); }
        catch { throw new Error("Open Tandoor's private chat and tap Start before creating a reminder."); }
      },
    });
    const scheduleTask = createScheduledWorkTask(scheduleAdapter, deliveryTask);
    const web = new ContextWebService(config.contextDevApiKey);
    services.set("context_web", (_scope, request, signal) => web.execute(request.integrationId, request.operation, request.payloadJson, signal));
    const replyTask = createTelegramReplyTask(ui, connectWorker, deliveryTask);
    const admissionTask = createTelegramAdmissionTask(ui, connectWorker, replyTask, deliveryTask);
    const store = await GatewayWorkStore.open(config.dataDir, [defineExtension({
      name: "tandoor-gateway-work", tasks: [scheduleTask, admissionTask, replyTask, deliveryTask],
    })]);
    try {
      const schedules = new ScheduleService(store, scheduleTask, scheduleAdapter);
      const scheduling = new TelegramSchedulingIntegration({ service: schedules, prepareTarget: (target) => scheduleAdapter.prepare(target) });
      services.set("tandoor_scheduling", async (scope, request) => {
        if (!config.allowedUserIds.has(scope.id)) throw new Error("This schedule owner is no longer allowed.");
        return JSON.stringify(await scheduling.execute(scope, request));
      });
      const inbox = new TelegramInbox(store, admissionTask);
      const commands = new TelegramCommands({
        ui, connectWorker, providers, google, models, scheduling,
        googleLoginEnabled: Boolean(config.googleOAuthWebClientFile),
      });
      const messages = new TelegramMessageHandler({
        ui, token: config.telegramBotToken, providers, google, commands, inbox,
      });
      return new TelegramGateway(ui, workers, bridge, google, providers, messages, schedules, store);
    } catch (error) {
      bridge.stop();
      await store.close().catch(() => undefined);
      throw error;
    }
  }

  async start(): Promise<void> {
    await this.ui.bot.init();
    await this.google.startGoogleOAuthCallbackServer();
    this.ui.bot.on("message", (ctx) => this.messages.handleMessageUpdate(ctx));
    this.ui.bot.on("callback_query:data", (ctx) => this.ui.handleCallback(ctx));
    await enableTelegramTopics(this.ui.bot)
      .catch((error: unknown) => console.warn("Could not enable Telegram topics:", error instanceof Error ? error.message : error));
    await this.ui.bot.api.setMyCommands(TELEGRAM_COMMANDS);
    await this.schedules.initialize();
    this.store.start();
    await this.ui.bot.api.deleteWebhook();
    if (this.stopping) return;
    console.log(`Tandoor is listening as @${this.ui.bot.botInfo.username}.`);
    const controller = new AbortControllerPolyfill();
    this.pollingController = controller;
    const polling = this.pollUpdates(controller);
    this.polling = polling;
    void this.workers.startKnownWorkers((scope, worker) => this.bridge.watchWorker(scope, worker)).catch((error: unknown) =>
      console.warn("Could not enumerate existing workers:", error));
    try {
      await polling;
    } finally {
      if (this.polling === polling) {
        this.polling = undefined;
        this.pollingController = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.pollingController?.abort();
    await this.polling?.catch(() => undefined);
    const results = await Promise.allSettled([this.store.close(), this.google.stop(), this.providers.stop()]);
    this.bridge.stop();
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Gateway shutdown did not finish cleanly.");
  }

  /** Acknowledge updates only on the next poll, after their handlers have finished successfully. */
  private async pollUpdates(controller: AbortControllerPolyfill): Promise<void> {
    let offset: number | undefined;
    const allowedUpdates = ["message", "callback_query"] as const;

    while (!controller.signal.aborted) {
      let updates: Update[];
      try {
        updates = await this.ui.bot.api.getUpdates(
          { ...(offset === undefined ? {} : { offset }), timeout: 30, allowed_updates: allowedUpdates },
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof GrammyError && [401, 409].includes(error.error_code)) throw error;
        const retryAfter = error instanceof GrammyError ? error.parameters.retry_after : undefined;
        const delayMs = typeof retryAfter === "number" ? retryAfter * 1_000 : 3_000;
        console.warn("Telegram polling failed:", error instanceof Error ? error.message : error);
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, delayMs);
          controller.signal.addEventListener("abort", finish, { once: true });
          if (controller.signal.aborted) finish();
        });
        continue;
      }

      for (const update of updates) {
        if (controller.signal.aborted) return;
        try {
          await this.ui.bot.handleUpdate(update);
        } catch (error) {
          if (!(error instanceof BotError)) throw error;
          console.error("Telegram update failed:", error.message);
          if (error.error instanceof TelegramReceiptWriteFailed) {
            // Only the gateway store can block acknowledgement. Keep this offset
            // and retry instead of exiting or discarding the unconfirmed update.
            await delay(3_000);
            break;
          }
        }
        offset = update.update_id + 1;
      }
    }
  }
}

async function legacyDeliveryIds(dataDir: string): Promise<ReadonlySet<string>> {
  let value: unknown;
  try { value = JSON.parse(await readFile(join(dataDir, "gateway", "scheduled-deliveries.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  if (!Array.isArray(value) || !value.every((id: unknown) => typeof id === "string")) {
    throw new Error("The legacy Telegram delivery receipt store is invalid.");
  }
  return new Set(value);
}
