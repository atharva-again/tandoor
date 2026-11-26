import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import type { TandoorConfig } from "../../shared/src/config.js";
import { createWorkerClient, WORKER_PROTOCOL_VERSION, type HealthResponse, type WorkerClient } from "../../shared/src/grpc.js";
import { scopeSlug, type WorkerScope } from "../../shared/src/scope.js";
import { unary } from "./worker-client.js";

const execFileAsync = promisify(execFile);

interface ScopeRecord {
  scope: WorkerScope;
  authToken: string;
  gogKeyringPassword: string;
  credentialGeneration: string;
}

export class PodmanWorkerManager {
  private readonly clients = new Map<string, WorkerClient>();
  private readonly starting = new Map<string, Promise<WorkerClient>>();
  private readonly preparedSecrets = new Map<string, Promise<void>>();
  private readonly metadataDir: string;
  private readonly scopesDir: string;
  private closed = false;

  constructor(private readonly config: TandoorConfig) {
    this.metadataDir = join(config.dataDir, "gateway", "scopes");
    this.scopesDir = join(config.dataDir, "scopes");
  }

  async startKnownWorkers(onWorker: (scope: WorkerScope, worker: WorkerClient) => void): Promise<void> {
    await mkdir(this.metadataDir, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.metadataDir)).filter((name) => name.endsWith(".json"));
    await Promise.all(files.map(async (file) => {
      if (this.closed) return;
      try {
        const record = await this.readRecord(join(this.metadataDir, file));
        if (!record || !this.config.allowedUserIds.has(record.scope.id)) return;
        const worker = await this.get(record.scope);
        if (!this.closed) onWorker(record.scope, worker);
      } catch (error) {
        if (!this.closed) console.warn(`Could not warm up worker ${file}:`, error);
      }
    }));
  }

  async get(scope: WorkerScope): Promise<WorkerClient> {
    if (this.closed) throw new Error("The worker manager is closed.");
    const slug = scopeSlug(scope);
    const current = this.clients.get(slug);
    if (current) return current;
    const pending = this.starting.get(slug);
    if (pending) return pending;

    const start = this.startWorker(scope, slug).then((client) => {
      if (this.closed) {
        client.close();
        throw new Error("The worker manager is closed.");
      }
      this.clients.set(slug, client);
      return client;
    });
    this.starting.set(slug, start);
    try {
      return await start;
    } finally {
      this.starting.delete(slug);
    }
  }

  closeClients(): void {
    this.closed = true;
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }

  private async startWorker(scope: WorkerScope, slug: string): Promise<WorkerClient> {
    await mkdir(this.metadataDir, { recursive: true, mode: 0o700 });
    const metadataPath = join(this.metadataDir, `${slug}.json`);
    const existingRecord = await this.readRecord(metadataPath);
    const webOAuthClientHash = this.config.googleOAuthWebClientFile
      ? createHash("sha256")
          .update(await readFile(this.config.googleOAuthWebClientFile))
          .digest("hex")
      : "";
    const webOAuthSecretName = webOAuthClientHash
      ? `tandoor-google-web-oauth-${webOAuthClientHash.slice(0, 20)}`
      : undefined;
    const record = existingRecord ?? {
      scope,
      authToken: randomBytes(32).toString("hex"),
      gogKeyringPassword: randomBytes(32).toString("hex"),
      credentialGeneration: randomUUID(),
    };
    record.gogKeyringPassword ||= randomBytes(32).toString("hex");
    record.credentialGeneration ||= randomUUID();

    // Persist the worker identity before creating or updating anything outside
    // the gateway. Retries must reuse these credentials if startup is interrupted.
    await this.writeRecord(metadataPath, record);
    const workerConfigHash = createHash("sha256")
      .update(
        JSON.stringify([
          scope,
          this.config.modelProvider,
          this.config.modelId,
          Boolean(this.config.contextDevApiKey),
          this.config.googleOAuthClientFile ?? "",
          webOAuthClientHash,
          this.config.googleOAuthRedirectUri,
          this.config.workerContainerPrefix,
          record.credentialGeneration,
        ]),
      )
      .digest("hex");

    const scopeDir = join(this.scopesDir, slug);
    await mkdir(join(scopeDir, "workspace"), { recursive: true, mode: 0o700 });
    const secretsPath = join(this.metadataDir, `${slug}.env`);
    await this.writeSecrets(secretsPath, record.authToken, record.gogKeyringPassword);

    const containerName = `${this.config.workerContainerPrefix}-${slug}`;
    const exists = await this.containerExists(containerName);
    const running = exists && (await this.containerRunning(containerName));
    const containerIsCurrent = running &&
      await this.containerMatchesConfiguration(containerName, workerConfigHash);
    if (!containerIsCurrent) {
      if (webOAuthSecretName && this.config.googleOAuthWebClientFile) {
        await this.ensurePodmanSecret(webOAuthSecretName, this.config.googleOAuthWebClientFile);
      }
      if (exists) {
        await this.podman(["rm", "--force", containerName]);
        if (await this.containerExists(containerName)) {
          throw new Error(`Podman did not remove the outdated worker ${containerName}.`);
        }
      }
      const runArgs = [
        "run",
        "--detach",
        "--name",
        containerName,
        "--label",
        `io.tandoor.config-hash=${workerConfigHash}`,
        "--restart=unless-stopped",
        "--publish",
        "127.0.0.1::50051/tcp",
        "--volume",
        `${scopeDir}:/tandoor:Z`,
        ...(this.config.googleOAuthClientFile
          ? [
              "--volume",
              `${this.config.googleOAuthClientFile}:/run/secrets/tandoor-google-oauth-client.json:ro,z`,
            ]
          : []),
        ...(webOAuthSecretName
          ? [
              "--secret",
              `source=${webOAuthSecretName},target=tandoor-google-web-oauth-client.json,type=mount,uid=1000,gid=1000,mode=0400`,
            ]
          : []),
        "--userns=keep-id:uid=1000,gid=1000",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=256m",
        "--cap-drop=all",
        "--security-opt=no-new-privileges",
        "--pids-limit=256",
        "--memory=2g",
        "--cpus=2",
        "--env-file",
        secretsPath,
        "--env",
        "TANDOOR_DATA_DIR=/tandoor",
        "--env",
        `TANDOOR_SCOPE_KIND=${scope.kind}`,
        "--env",
        `TANDOOR_SCOPE_ID=${scope.id}`,
        ...(this.config.contextDevApiKey
          ? ["--env", "TANDOOR_CONTEXT_WEB_ENABLED=true"]
          : []),
        "--env",
        "GOG_HOME=/tandoor/workspace/.gogcli",
        "--env",
        "GOG_KEYRING_BACKEND=file",
        "--env",
        "DBUS_SESSION_BUS_ADDRESS=disabled:",
        ...(this.config.googleOAuthClientFile
          ? [
              "--env",
              "TANDOOR_GOOGLE_OAUTH_CLIENT_FILE=/run/secrets/tandoor-google-oauth-client.json",
            ]
          : []),
        ...(this.config.googleOAuthWebClientFile
          ? [
              "--env",
              "TANDOOR_GOOGLE_OAUTH_WEB_CLIENT_FILE=/run/secrets/tandoor-google-web-oauth-client.json",
            ]
          : []),
        "--env",
        `TANDOOR_GOOGLE_OAUTH_REDIRECT_URI=${this.config.googleOAuthRedirectUri}`,
        "--env",
        "TANDOOR_WORKER_PORT=50051",
        "--env",
        `TANDOOR_MODEL_PROVIDER=${this.config.modelProvider}`,
        "--env",
        `TANDOOR_MODEL_ID=${this.config.modelId}`,
        this.config.workerImage,
      ];
      await this.podman(runArgs);
    }

    const hostPort = await this.getHostPort(containerName);
    const client = createWorkerClient(`127.0.0.1:${hostPort}`, record.authToken);
    await this.waitUntilReady(client);
    return client;
  }

  private async writeSecrets(path: string, authToken: string, gogKeyringPassword: string): Promise<void> {
    const values = [
      `TANDOOR_WORKER_AUTH_TOKEN=${authToken}`,
      `TANDOOR_GOG_KEYRING_PASSWORD=${gogKeyringPassword}`,
    ];
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${values.join("\n")}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  }

  private async ensurePodmanSecret(name: string, sourceFile: string): Promise<void> {
    const existing = this.preparedSecrets.get(name);
    if (existing) return existing;

    const preparation = (async () => {
      try {
        await this.podman(["secret", "inspect", name]);
      } catch {
        await this.podman(["secret", "create", name, sourceFile]);
      }
    })();
    this.preparedSecrets.set(name, preparation);
    try {
      await preparation;
    } catch (error) {
      this.preparedSecrets.delete(name);
      throw error;
    }
  }

  private async readRecord(path: string): Promise<ScopeRecord | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (
        typeof value === "object" &&
        value !== null &&
        "scope" in value &&
        typeof value.scope === "object" &&
        value.scope !== null &&
        "kind" in value.scope &&
        value.scope.kind !== "user"
      ) {
        // Remove the obsolete container, but leave its persistent data untouched.
        const containerName = `tandoor-${basename(path, ".json")}`;
        if (await this.containerExists(containerName)) {
          await this.podman(["rm", "--force", containerName]);
        }
        return undefined;
      }
      if (
        typeof value === "object" &&
        value !== null &&
        "scope" in value &&
        "authToken" in value &&
        typeof value.authToken === "string" &&
        (!("gogKeyringPassword" in value) || typeof value.gogKeyringPassword === "string") &&
          (!("credentialGeneration" in value) || typeof value.credentialGeneration === "string") &&
        typeof value.scope === "object" &&
        value.scope !== null &&
        "kind" in value.scope &&
        "id" in value.scope &&
        value.scope.kind === "user" &&
        typeof value.scope.id === "string"
      ) {
        return {
          scope: { kind: value.scope.kind, id: value.scope.id },
          authToken: value.authToken,
          gogKeyringPassword:
            "gogKeyringPassword" in value && typeof value.gogKeyringPassword === "string"
              ? value.gogKeyringPassword
              : randomBytes(32).toString("hex"),
          credentialGeneration:
            "credentialGeneration" in value && typeof value.credentialGeneration === "string"
              ? value.credentialGeneration
              : randomUUID(),
        };
      }
      throw new Error(`Invalid worker scope record: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeRecord(path: string, record: ScopeRecord): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  }

  private async containerExists(name: string): Promise<boolean> {
    try {
      await this.podman(["container", "exists", name]);
      return true;
    } catch {
      return false;
    }
  }

  private async containerRunning(name: string): Promise<boolean> {
    try {
      const result = await this.podman(["inspect", "--format", "{{.State.Running}}", name]);
      return result.trim() === "true";
    } catch {
      return false;
    }
  }

  private async containerMatchesConfiguration(name: string, configHash: string): Promise<boolean> {
    const [containerImage, configuredImage, containerConfigHash] = await Promise.all([
      this.podman(["inspect", "--format", "{{.Image}}", name]),
      this.podman(["image", "inspect", "--format", "{{.Id}}", this.config.workerImage]),
      this.podman([
        "inspect",
        "--format",
        '{{ index .Config.Labels "io.tandoor.config-hash" }}',
        name,
      ]),
    ]);
    return containerImage.trim() === configuredImage.trim() &&
      containerConfigHash.trim() === configHash;
  }

  private async getHostPort(name: string): Promise<number> {
    const result = await this.podman(["port", name, "50051/tcp"]);
    const match = result.match(/127\.0\.0\.1:(\d+)/);
    if (!match) throw new Error(`Podman did not publish ${name} on host loopback.`);
    return Number(match[1]);
  }

  private async waitUntilReady(client: WorkerClient): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 40; attempt++) {
      let response: HealthResponse | undefined;
      try {
        response = await unary(client, "health", {}, { timeoutMs: 1_000 });
      } catch (error) {
        lastError = error;
      }
      if (response?.ready) {
        if (response.version !== WORKER_PROTOCOL_VERSION) {
          client.close();
          throw new Error("The worker image uses an incompatible protocol. Rebuild the worker image and restart the gateway.");
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    client.close();
    throw new Error(`Worker did not become ready: ${String(lastError ?? "health check timed out")}`);
  }

  private async podman(args: string[]): Promise<string> {
    const result = await execFileAsync(this.config.podman, args, {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return result.stdout;
  }
}
