import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type ConversationId, type Extension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

/** Gateway orchestration shares one transaction boundary; execution order belongs to each worker's inbox. */
export class GatewayWorkStore {
  private constructor(readonly harness: Harness, readonly rootId: ConversationId) {}

  static async open(dataDir: string, extensions: Extension[]): Promise<GatewayWorkStore> {
    const directory = join(dataDir, "gateway");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const registry = createRegistry();
    for (const extension of extensions) registry.install(extension);
    // Retain the existing schedule database and task identities.
    const storage = await openNodeSqliteStorage(join(directory, "schedules.sqlite"));
    let harness: Harness | undefined;
    try {
      harness = await Harness.open(storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);
      return new GatewayWorkStore(harness, (await harness.root(BACKGROUND_CONTEXT)).id);
    } catch (error) {
      if (harness) await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
      else await storage.close(BACKGROUND_CONTEXT).catch(() => undefined);
      throw error;
    }
  }

  start(): void { this.harness.resume(); }
  close(): Promise<void> { return this.harness.close(BACKGROUND_CONTEXT); }
}
