import type { WorkerClient } from "../../shared/src/grpc.js";
import type { TelegramMessageIdentity } from "../../shared/src/scope.js";
import { conversationKey, workerScope } from "../../shared/src/scope.js";
import { getModelSettings, unary, type ConnectWorker } from "./worker-client.js";
import {
  modelReference,
  providerDisplayName,
} from "./telegram-base.js";
import type { TelegramUI } from "./telegram-ui.js";

type ModelPickerAction =
  | { type: "show_model_providers" }
  | { type: "show_model_provider"; provider: string; page: number }
  | { type: "select_model"; provider: string; modelId: string }
  | { type: "show_scoped_models" }
  | { type: "select_scoped_model"; provider: string; modelId: string }
  | { type: "edit_scoped_models"; page: number }
  | { type: "toggle_scoped_model"; provider: string; modelId: string; page: number }
  | { type: "save_scoped_models" }
  | { type: "clear_scoped_models" }
  | { type: "select_thinking"; level: string; source: "model" | "settings" | "scoped" }
  | { type: "show_login" };

export class TelegramModelPickers {
  private readonly pendingScopedModels = new Map<string, Set<string>>();

  constructor(
    private readonly gateway: TelegramUI,
    private readonly connectWorker: ConnectWorker,
    private readonly showLogin: (identity: TelegramMessageIdentity, worker: WorkerClient) => Promise<void>,
  ) {}

  private button(text: string, action: ModelPickerAction) {
    return this.gateway.pickerButton(text, async (identity, messageId) => {
      await this.handlePickerAction(identity, messageId, conversationKey(identity), await this.connectWorker(workerScope(identity)), action);
    });
  }

  async showModelProviders(
    identity: TelegramMessageIdentity,
    worker: WorkerClient,
    conversationKeyValue: string,
    messageId?: number,
  ): Promise<void> {
    const settings = await getModelSettings(worker, conversationKeyValue);
    const providers = [...new Set(settings.availableModels.map((model) => model.provider))].sort();
    const rows = this.gateway.buttonRows(
      providers.map((provider) =>
        this.button(
          providerDisplayName(provider),
          { type: "show_model_provider", provider, page: 0 },
        ),
      ),
      2,
    );
    if (providers.length === 0) {
      rows.push([this.button("Connect An Account", { type: "show_login" })]);
    }
    await this.gateway.sendOrEditPicker(
      identity,
      messageId,
      [
        "Model Selector",
        "",
        "Step 1 Of 3: Choose A Provider",
  ...(providers.length === 0 ? ["", "Sign in with /login_provider to see available providers."] : []),
      ].join("\n"),
      { inline_keyboard: rows },
    );
  }

  private async showModelProvider(
    identity: TelegramMessageIdentity,
    worker: WorkerClient,
    conversationKeyValue: string,
    provider: string,
    messageId: number,
    page: number,
  ): Promise<void> {
    const settings = await getModelSettings(worker, conversationKeyValue);
    const models = settings.availableModels.filter((model) => model.provider === provider);
    const pageSize = 8;
    const maxPage = Math.max(Math.ceil(models.length / pageSize) - 1, 0);
    const safePage = Math.min(Math.max(page, 0), maxPage);
    const pageModels = models.slice(safePage * pageSize, safePage * pageSize + pageSize);
    const rows = pageModels.map((model) => [
      this.button(
        `${modelReference(model) === modelReference(settings.currentModel) ? "✓ " : ""}${model.name}`,
        { type: "select_model", provider: model.provider, modelId: model.modelId },
      ),
    ]);
    if (maxPage > 0) {
      rows.push([
        this.button("Previous", {
          type: "show_model_provider",
          provider,
          page: Math.max(safePage - 1, 0),
        }),
        this.button("Next", {
          type: "show_model_provider",
          provider,
          page: Math.min(safePage + 1, maxPage),
        }),
      ]);
    }
    rows.push([this.button("Back To Providers", { type: "show_model_providers" })]);
    await this.gateway.sendOrEditPicker(
      identity,
      messageId,
      [
        "Model Selector",
        "",
        "Step 2 Of 3: Choose A Model",
        ...(maxPage > 0 ? [`Page ${safePage + 1} Of ${maxPage + 1}`] : []),
        ...(models.length === 0 ? ["", "No models are available for this provider."] : []),
      ].join("\n"),
      { inline_keyboard: rows },
    );
  }

  async showThinkingPicker(
    identity: TelegramMessageIdentity,
    worker: WorkerClient,
    conversationKeyValue: string,
    messageId?: number,
    source: "model" | "settings" | "scoped" = "settings",
    notice?: string,
  ): Promise<void> {
    const settings = await getModelSettings(worker, conversationKeyValue);
    const levels = settings.currentModel.thinkingLevels;
    const currentLevel = settings.thinkingLevel;
    const buttons = levels.map((level) => this.button(
      `${level === currentLevel ? "✓ " : ""}${this.thinkingLevelLabel(level)}`,
      { type: "select_thinking", level, source },
    ));
    const backAction: ModelPickerAction =
      source === "scoped"
        ? { type: "show_scoped_models" }
        : { type: "show_model_provider", provider: settings.currentModel.provider, page: 0 };
    await this.gateway.sendOrEditPicker(
      identity,
      messageId,
      [
        source === "model"
          ? "Model Selector"
          : source === "scoped"
            ? "Scoped Model Selector"
            : "Thinking Level",
        "",
        ...(source === "model"
          ? ["Step 3 Of 3: Choose A Thinking Level"]
          : source === "scoped"
            ? ["Step 2 Of 2: Choose A Thinking Level"]
            : ["Choose A Thinking Level"]),
        "",
        `Current Model: ${modelReference(settings.currentModel)}`,
        `Current Thinking Level: ${currentLevel}`,
        ...(notice ? ["", notice] : []),
      ].join("\n"),
      {
        inline_keyboard: [
          ...this.gateway.buttonRows(buttons, 3),
          [this.button(
            source === "scoped" ? "Back To Scoped Models" : "Back To Models",
            backAction,
          )],
        ],
      },
    );
  }

  private thinkingLevelLabel(level: string): string {
    if (level === "xhigh") return "Extra High";
    if (level === "max") return "Maximum";
    return level.length > 0 ? level[0]!.toUpperCase() + level.slice(1) : level;
  }

  async showScopedModels(
    identity: TelegramMessageIdentity,
    worker: WorkerClient,
    conversationKeyValue: string,
    messageId?: number,
  ): Promise<void> {
    const settings = await getModelSettings(worker, conversationKeyValue);
    const rows = settings.scopedModels.map((model) => [
      this.button(
        `${modelReference(model) === modelReference(settings.currentModel) ? "✓ " : ""}${model.name}`,
        { type: "select_scoped_model", provider: model.provider, modelId: model.modelId },
      ),
    ]);
    rows.push([this.button("Edit Scoped Models", { type: "edit_scoped_models", page: 0 })]);
    rows.push([this.button("Back To Providers", { type: "show_model_providers" })]);
    await this.gateway.sendOrEditPicker(
      identity,
      messageId,
      [
        "Scoped Model Selector",
        "",
        "Choose A Model From This Conversation's Scoped List.",
        ...(settings.scopedModels.length === 0 ? ["", "No scoped models configured yet."] : []),
      ].join("\n"),
      { inline_keyboard: rows },
    );
  }

  private async showScopedModelEditor(
    identity: TelegramMessageIdentity,
    worker: WorkerClient,
    conversationKeyValue: string,
    messageId: number,
    page: number,
  ): Promise<void> {
    const settings = await getModelSettings(worker, conversationKeyValue);
    let selected = this.pendingScopedModels.get(conversationKeyValue);
    if (!selected) {
      selected = new Set(settings.scopedModels.map(modelReference));
      this.pendingScopedModels.set(conversationKeyValue, selected);
    }
    const pageSize = 8;
    const maxPage = Math.max(Math.ceil(settings.availableModels.length / pageSize) - 1, 0);
    const safePage = Math.min(Math.max(page, 0), maxPage);
    const models = settings.availableModels.slice(safePage * pageSize, safePage * pageSize + pageSize);
    const rows = models.map((model) => [
      this.button(
        `${selected.has(modelReference(model)) ? "✓ " : ""}${model.name}`,
        {
          type: "toggle_scoped_model",
          provider: model.provider,
          modelId: model.modelId,
          page: safePage,
        },
      ),
    ]);
    rows.push([
      this.button("Previous", { type: "edit_scoped_models", page: Math.max(safePage - 1, 0) }),
      this.button("Next", { type: "edit_scoped_models", page: Math.min(safePage + 1, maxPage) }),
    ]);
    rows.push([
      this.button("Save", { type: "save_scoped_models" }),
      this.button("Clear", { type: "clear_scoped_models" }),
    ]);
    rows.push([this.button("Cancel", { type: "show_scoped_models" })]);
    await this.gateway.sendOrEditPicker(
      identity,
      messageId,
      [
        "Edit Scoped Models",
        "",
        `Selected ${selected.size} Model(s). Tap To Toggle, Then Save.`,
        `Page ${safePage + 1} Of ${maxPage + 1}`,
      ].join("\n"),
      { inline_keyboard: rows },
    );
  }

  async handlePickerAction(
    identity: TelegramMessageIdentity,
    messageId: number,
    conversationKeyValue: string,
    worker: WorkerClient,
    action: ModelPickerAction,
  ): Promise<void> {
    switch (action.type) {
      case "show_model_providers":
        await this.showModelProviders(identity, worker, conversationKeyValue, messageId);
        return;
      case "show_model_provider":
        await this.showModelProvider(identity, worker, conversationKeyValue, action.provider, messageId, action.page);
        return;
      case "show_login":
        await this.showLogin(identity, worker);
        return;
      case "select_thinking": {
        const response = await unary(
          worker,
          "controlConversation",
          {
            conversationKey: conversationKeyValue,
            action: "thinking",
            instructions: action.level,
          },
        );
        if (!response.accepted) {
          await this.gateway.sendOrEditPicker(identity, messageId, response.message, { inline_keyboard: [] });
          return;
        }
        const settings = await getModelSettings(worker, conversationKeyValue);
        const title =
          action.source === "model"
            ? "Model Selector"
            : action.source === "scoped"
              ? "Scoped Model Selector"
              : "Thinking Level";
        const confirmation =
          action.source === "model"
            ? "Model And Thinking Level Updated."
            : action.source === "scoped"
              ? "Current Model Updated."
              : `Thinking Level Set To ${action.level}.`;
        await this.gateway.sendOrEditPicker(
          identity,
          messageId,
          [
            title,
            "",
            confirmation,
            "",
            `Current Model: ${modelReference(settings.currentModel)}`,
            `Thinking Level: ${settings.thinkingLevel}`,
          ].join("\n"),
          { inline_keyboard: [] },
        );
        return;
      }
      case "select_model":
      case "select_scoped_model": {
        const response = await unary(
          worker,
          "controlConversation",
          {
            conversationKey: conversationKeyValue,
            action: "model",
            instructions: `${action.provider}/${action.modelId}`,
          },
        );
        if (!response.accepted) {
          const backButton = action.type === "select_scoped_model"
            ? this.button("Back To Scoped Models", { type: "show_scoped_models" })
            : this.button("Back To Providers", { type: "show_model_providers" });
          await this.gateway.sendOrEditPicker(identity, messageId, response.message, { inline_keyboard: [[backButton]] });
          return;
        }
        await this.showThinkingPicker(
          identity,
          worker,
          conversationKeyValue,
          messageId,
          action.type === "select_scoped_model" ? "scoped" : "model",
          "Model Selected.",
        );
        return;
      }
      case "show_scoped_models":
        this.pendingScopedModels.delete(conversationKeyValue);
        await this.showScopedModels(identity, worker, conversationKeyValue, messageId);
        return;
      case "edit_scoped_models":
        await this.showScopedModelEditor(identity, worker, conversationKeyValue, messageId, action.page);
        return;
      case "toggle_scoped_model": {
        const settings = await getModelSettings(worker, conversationKeyValue);
        const selected = this.pendingScopedModels.get(conversationKeyValue) ??
          new Set(settings.scopedModels.map(modelReference));
        const reference = `${action.provider}/${action.modelId}`;
        if (selected.has(reference)) selected.delete(reference);
        else selected.add(reference);
        this.pendingScopedModels.set(conversationKeyValue, selected);
        await this.showScopedModelEditor(identity, worker, conversationKeyValue, messageId, action.page);
        return;
      }
      case "save_scoped_models":
      case "clear_scoped_models": {
        const models = action.type === "clear_scoped_models"
          ? []
          : [...(this.pendingScopedModels.get(conversationKeyValue) ?? new Set<string>())].map((reference) => {
              const separator = reference.indexOf("/");
              return { provider: reference.slice(0, separator), modelId: reference.slice(separator + 1) };
            });
        const response = await unary(
          worker,
          "controlConversation",
          {
            conversationKey: conversationKeyValue,
            action: "set_scoped_models",
            instructions: JSON.stringify(models),
          },
        );
        this.pendingScopedModels.delete(conversationKeyValue);
        await this.gateway.sendOrEditPicker(
          identity,
          messageId,
          response.accepted ? response.message : `Tandoor: ${response.message}`,
          { inline_keyboard: [[this.button("Back To Scoped Models", { type: "show_scoped_models" })]] },
        );
        return;
      }
    }
  }
}
