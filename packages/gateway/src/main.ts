import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { loadConfig } from "../../shared/src/config.js";
import { TelegramGateway } from "./telegram.js";
import { PodmanWorkerManager } from "./worker-manager.js";

if (existsSync(".env")) loadEnvFile(".env");

const config = loadConfig();
const workers = new PodmanWorkerManager(config);
const gateway = await TelegramGateway.open(config, workers);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await gateway.stop().catch(() => {});
  workers.closeClients();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  await gateway.start();
} catch (error) {
  await shutdown();
  throw error;
}
