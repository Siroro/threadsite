import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface IncidentRecord {
  id: string;
  timestamp: string;
  message: string;
  stack?: string;
  details?: unknown;
  context: Record<string, unknown>;
}

export interface SerializedError {
  name?: string;
  message: string;
  stack?: string;
  details?: unknown;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = normalizeLevel(process.env.LOG_LEVEL);
const logFile = path.resolve(process.env.LOG_FILE?.trim() || "/data/threadsite.log");
const knownSecrets = Object.entries(process.env)
  .filter(([key, value]) => /(?:TOKEN|KEY|PASSWORD|SECRET|AUTH)/i.test(key) && (value?.length ?? 0) >= 6)
  .map(([, value]) => value!)
  .sort((a, b) => b.length - a.length);

let writeQueue = Promise.resolve();

function normalizeLevel(value: string | undefined): LogLevel {
  const level = value?.trim().toLowerCase();
  return level === "debug" || level === "warn" || level === "error" ? level : "info";
}

export function redactText(input: string): string {
  let value = input;
  for (const secret of knownSecrets) value = value.split(secret).join("[REDACTED]");
  value = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:token|api[_ -]?key|password|secret)\s*[:=]\s*[^\s,;]+/gi, (match) => {
      const separator = match.includes("=") ? "=" : ":";
      return `${match.split(/[:=]/, 1)[0]}${separator}[REDACTED]`;
    });
  return value;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 7) return "[MAX_DEPTH]";
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (value instanceof Error) return serializeError(value, depth + 1);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      output[key] = /(?:token|key|password|secret|authorization|cookie)/i.test(key)
        ? "[REDACTED]"
        : sanitize(child, depth + 1);
    }
    return output;
  }
  return redactText(String(value));
}

export function serializeError(error: unknown, depth = 0): SerializedError {
  if (depth > 6) return { message: "[MAX_ERROR_DEPTH]" };
  if (error instanceof Error) {
    const details: Record<string, unknown> = {};
    const keys = new Set([...Object.getOwnPropertyNames(error), ...Object.keys(error)]);
    for (const key of keys) {
      if (["name", "message", "stack", "cause"].includes(key)) continue;
      details[key] = sanitize((error as unknown as Record<string, unknown>)[key], depth + 1);
    }
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause !== undefined) details.cause = serializeError(cause, depth + 1);
    return {
      name: error.name || undefined,
      message: redactText(error.message),
      stack: error.stack ? redactText(error.stack) : undefined,
      details: Object.keys(details).length ? details : undefined,
    };
  }
  return { message: redactText(typeof error === "string" ? error : JSON.stringify(sanitize(error, depth + 1))) };
}

function append(record: Record<string, unknown>): void {
  writeQueue = writeQueue
    .then(async () => {
      await fs.mkdir(path.dirname(logFile), { recursive: true });
      await fs.appendFile(logFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    })
    .catch((error) => console.error("[threadsite] failed to write log file", error));
}

export function log(level: LogLevel, event: string, context: Record<string, unknown> = {}): void {
  if (LEVELS[level] < LEVELS[configuredLevel]) return;
  const timestamp = new Date().toISOString();
  const sanitized = sanitize(context);
  const record = { timestamp, level, event, context: sanitized };
  append(record);
  const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  // Warn/error records are emitted as JSON strings so Docker logs do not collapse nested Error.cause values to "[Object]".
  if (level === "warn" || level === "error") method(`[threadsite] ${timestamp} ${level.toUpperCase()} ${event} ${JSON.stringify(sanitized)}`);
  else method(`[threadsite] ${timestamp} ${level.toUpperCase()} ${event}`, sanitized);
}

export function logError(event: string, error: unknown, context: Record<string, unknown> = {}): void {
  const serialized = serializeError(error);
  log("error", event, { ...context, error: serialized });
}

export async function recordIncident(error: unknown, context: Record<string, unknown> = {}): Promise<IncidentRecord> {
  const serialized = serializeError(error);
  const incident: IncidentRecord = {
    id: `ERR-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
    timestamp: new Date().toISOString(),
    message: serialized.message,
    stack: serialized.stack,
    details: serialized.details,
    context: sanitize(context) as Record<string, unknown>,
  };
  const record = { timestamp: incident.timestamp, level: "error", event: "incident", incident };
  append(record);
  console.error(`[threadsite] ${incident.id} ${incident.message} ${JSON.stringify({ context: incident.context, details: incident.details })}`);
  await writeQueue;
  return incident;
}

export async function recentIncidents(limit = 5): Promise<IncidentRecord[]> {
  try {
    const data = await fs.readFile(logFile, "utf8");
    const lines = data.trimEnd().split("\n");
    const incidents: IncidentRecord[] = [];
    for (let i = lines.length - 1; i >= 0 && incidents.length < limit; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed?.event === "incident" && parsed?.incident?.id) incidents.push(parsed.incident as IncidentRecord);
      } catch {
        // Ignore malformed historical log lines instead of making the admin command fail.
      }
    }
    return incidents;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function getLogFile(): string {
  return logFile;
}
