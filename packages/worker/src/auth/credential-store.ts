import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { lock } from "proper-lockfile";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

interface CredentialDocument {
  version: 1;
  credentials: Record<string, Credential>;
}

export function tandoorAuthDirectory(dataDir: string): string {
  return join(dataDir, "auth");
}

export function tandoorCredentialFile(dataDir: string): string {
  return join(tandoorAuthDirectory(dataDir), "credentials.json");
}

function isCredential(value: unknown): value is Credential {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  if (value.type === "oauth") {
    return (
      "access" in value &&
      typeof value.access === "string" &&
      "refresh" in value &&
      typeof value.refresh === "string" &&
      "expires" in value &&
      typeof value.expires === "number"
    );
  }
  return false;
}

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly path: string) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.readDocument()).credentials[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const document = await this.readDocument();
    return Object.entries(document.credentials).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lock(this.path, {
      realpath: false,
      stale: 120_000,
      update: 10_000,
      retries: { retries: 120, minTimeout: 100, maxTimeout: 1_000 },
    });
    try {
      const document = await this.readDocument();
      const current = document.credentials[providerId];
      const next = await fn(current);
      if (next === undefined) return current;
      document.credentials[providerId] = next;
      await this.writeDocument(document);
      return next;
    } finally {
      await release();
    }
  }

  async delete(providerId: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lock(this.path, {
      realpath: false,
      stale: 120_000,
      update: 10_000,
      retries: { retries: 120, minTimeout: 100, maxTimeout: 1_000 },
    });
    try {
      const document = await this.readDocument();
      if (!Object.hasOwn(document.credentials, providerId)) return;
      delete document.credentials[providerId];
      await this.writeDocument(document);
    } finally {
      await release();
    }
  }

  private async readDocument(): Promise<CredentialDocument> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, credentials: {} };
      }
      throw error;
    }

    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("credentials" in parsed) ||
      typeof parsed.credentials !== "object" ||
      parsed.credentials === null ||
      Array.isArray(parsed.credentials)
    ) {
      throw new Error(`Invalid Tandoor credential store: ${this.path}`);
    }

    const credentials: Record<string, Credential> = {};
    for (const [providerId, credential] of Object.entries(parsed.credentials)) {
      if (!isCredential(credential)) {
        throw new Error(`Invalid credential for provider "${providerId}" in ${this.path}`);
      }
      credentials[providerId] = credential;
    }
    return { version: 1, credentials };
  }

  private async writeDocument(document: CredentialDocument): Promise<void> {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}
