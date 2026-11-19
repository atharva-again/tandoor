import { loadWorkerConfig } from "./config.js";
import { startWorkerServer } from "./server.js";

const worker = await startWorkerServer(loadWorkerConfig());
let closing = false;

async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await worker.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
