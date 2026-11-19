import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ModelReference {
  provider: string;
  modelId: string;
}

interface ModelSettingsDocument {
  version: 1;
  scopedModels: Record<string, ModelReference[]>;
}

function isModelReference(value: unknown): value is ModelReference {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    typeof value.provider === "string" &&
    "modelId" in value &&
    typeof value.modelId === "string"
  );
}

export class ConversationModelSettingsStore {
  private document: ModelSettingsDocument | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async getScopedModels(conversationKey: string): Promise<ModelReference[]> {
    return this.withDocument(async (document) => (document.scopedModels[conversationKey] ?? []).map((model) => ({ ...model })));
  }

  async setScopedModels(conversationKey: string, models: readonly ModelReference[]): Promise<ModelReference[]> {
    return this.withDocument(async (document) => {
      const unique = new Map<string, ModelReference>();
      for (const model of models) unique.set(`${model.provider}/${model.modelId}`, { ...model });
      const scopedModels = [...unique.values()];
      document.scopedModels[conversationKey] = scopedModels;
      await this.writeDocument(document);
      return scopedModels.map((model) => ({ ...model }));
    });
  }

  private async withDocument<T>(fn: (document: ModelSettingsDocument) => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const loaded = await this.readDocument();
      const document: ModelSettingsDocument = {
        version: 1,
        scopedModels: Object.fromEntries(
          Object.entries(loaded.scopedModels).map(([key, models]) => [key, models.map((model) => ({ ...model }))]),
        ),
      };
      const result = await fn(document);
      this.document = document;
      return result;
    } finally {
      release();
    }
  }

  private async readDocument(): Promise<ModelSettingsDocument> {
    if (this.document) return this.document;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.document = { version: 1, scopedModels: {} };
        return this.document;
      }
      throw error;
    }

    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("scopedModels" in parsed) ||
      typeof parsed.scopedModels !== "object" ||
      parsed.scopedModels === null ||
      Array.isArray(parsed.scopedModels)
    ) {
      throw new Error(`Invalid Tandoor model settings: ${this.path}`);
    }

    const scopedModels: Record<string, ModelReference[]> = {};
    for (const [conversationKey, models] of Object.entries(parsed.scopedModels)) {
      if (!Array.isArray(models) || !models.every(isModelReference)) {
        throw new Error(`Invalid scoped models for conversation "${conversationKey}" in ${this.path}`);
      }
      scopedModels[conversationKey] = models.map((model) => ({ ...model }));
    }
    this.document = { version: 1, scopedModels };
    return this.document;
  }

  private async writeDocument(document: ModelSettingsDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}
