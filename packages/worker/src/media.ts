import { realpath, stat, readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { TelegramAttachment } from "../../shared/src/grpc.js";
import { RESPONSE_LIMITS } from "../../shared/src/agent-response.js";

const MEDIA_MARKER =
  /(?<!\S)([`"'*]{0,3})MEDIA:\s*(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|[^\s`"'<>*]+)([`"'*]{0,3})/g;

export interface WorkspaceMediaResult {
  text: string;
  attachments: TelegramAttachment[];
  errors: string[];
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120) || "attachment.bin";
}

function mimeTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".avif":
      return "image/avif";
    case ".gif":
      return "image/gif";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".mp3":
      return "audio/mpeg";
    case ".mp4":
      return "video/mp4";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

function cleanCandidate(value: string): string {
  return value
    .replace(/^([`"'])|([`"'])$/g, "")
    .replace(/[),.;!?*]+$/g, "");
}

export function removeWorkspaceMediaMarkers(text: string): { text: string; count: number } {
  let count = 0;
  const cleaned = text.replace(
    MEDIA_MARKER,
    (match, prefix: string, _rawPath: string, suffix: string) => {
      if (prefix && suffix !== prefix) return match;
      count++;
      return prefix ? "" : suffix;
    },
  );
  return { text: cleaned, count };
}

function isWithinWorkspace(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

async function resolveWorkspaceFile(root: string, candidate: string): Promise<string> {
  const path =
    candidate.startsWith("~/")
      ? resolve(root, candidate.slice(2))
      : isAbsolute(candidate)
        ? resolve(candidate)
        : resolve(root, candidate);
  const canonical = await realpath(path);
  if (!isWithinWorkspace(root, canonical)) {
    throw new Error("Only files inside Tandoor's workspace can be sent.");
  }
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error("A MEDIA path must refer to a regular file.");
  if (info.size > RESPONSE_LIMITS.fileBytes) throw new Error("A file is larger than Telegram's 50 MB upload limit.");
  return canonical;
}

export async function extractWorkspaceMedia(text: string, workspacePath: string): Promise<WorkspaceMediaResult> {
  const candidates: string[] = [];
  const cleaned = text.replace(
    MEDIA_MARKER,
    (match, prefix: string, rawPath: string, suffix: string) => {
      if (prefix && suffix !== prefix) return match;
      const candidate = cleanCandidate(rawPath);
      if (candidate) candidates.push(candidate);
      return prefix ? "" : suffix;
    },
  );
  const cleanedText = cleaned;
  if (candidates.length === 0) return { text: cleanedText, attachments: [], errors: [] };

  const errors: string[] = [];
  const root = await realpath(workspacePath);
  const resolvedFiles = new Map<string, string>();
  for (const candidate of candidates) {
    try {
      const path = await resolveWorkspaceFile(root, candidate);
      resolvedFiles.set(path, safeFilename(basename(path)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "A marked file could not be accessed.";
      if (!errors.includes(message)) errors.push(message);
    }
  }

  if (resolvedFiles.size > RESPONSE_LIMITS.fileCount) {
    errors.push(`A response can contain at most ${RESPONSE_LIMITS.fileCount} files.`);
    return { text: cleanedText, attachments: [], errors };
  }

  let totalBytes = 0;
  const attachments: TelegramAttachment[] = [];
  for (const [path, filename] of resolvedFiles) {
    try {
      const data = await readFile(path);
      if (data.byteLength > RESPONSE_LIMITS.fileBytes) throw new Error("A file is larger than Telegram's 50 MB upload limit.");
      totalBytes += data.byteLength;
      if (totalBytes > RESPONSE_LIMITS.totalBytes) {
        errors.push("The files in one response exceed Telegram's 100 MB combined upload limit.");
        return { text: cleanedText, attachments: [], errors };
      }
      attachments.push({
        filename,
        mimeType: mimeTypeForPath(filename),
        data,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "A marked file could not be read.";
      if (!errors.includes(message)) errors.push(message);
    }
  }
  return { text: cleanedText, attachments, errors };
}
