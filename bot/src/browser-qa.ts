import { config } from "./config.js";
import { log } from "./logger.js";

/**
 * Harness-driven browser QA over the preview service's Playwright MCP: load
 * the freshly validated site in a real browser, collect console/page errors
 * and same-origin request failures, and capture a screenshot for the thread.
 *
 * Error policy (see assets/agents/shared.md — the preview browser cannot
 * reach external origins): failures on the preview origin itself and
 * non-network console/page errors are HARD (they feed the repair round-trip);
 * network-shaped errors caused by unavailable external APIs/fonts/relays are
 * SOFT notes. Any transport/timeout failure of this module returns undefined
 * — QA is best-effort and must never block a publish.
 */
export interface BrowserQaResult {
  hardErrors: string[];
  softNotes: string[];
  screenshotPng?: Buffer;
}

// The preview static server is loopback-only inside the preview container; the
// MCP-driven browser lives there too, so this origin is reachable from it.
const PREVIEW_ORIGIN = "http://127.0.0.1:8080";

// Console text shapes caused by the preview's offline external-origin policy.
const NETWORK_ERROR_RE = /failed to fetch|networkerror|net::|err_(?:failed|name_not_resolved|connection|timed_out)|load failed|\bcors\b|fetch.*(?:failed|aborted)|aborted/i;

/** One error-level entry from browser_console_messages (plain text, not JSON). */
export interface ConsoleEntry { type: string; text: string }

/** One failed same-origin request from browser_network_requests (plain text). */
export interface NetworkFailure { url: string; status?: number; error?: string }

/** What the page actually rendered, probed with browser_evaluate. */
export interface RenderSanity {
  textLength: number;
  canvases: number;
  visibleElements: number;
  /** Images/SVG/video/iframes count as content even without text. */
  mediaElements?: number;
  title?: string;
}

// Returns JSON because the MCP tool serializes the resolved value. Inline so
// the probe has no imports and works on any page the preview can serve.
const RENDER_PROBE = `() => {
  const body = document.body;
  const text = ((body && body.innerText) || "").replace(/\\s+/g, " ").trim();
  let visibleElements = 0;
  for (const element of document.querySelectorAll("body *")) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
    visibleElements += 1;
  }
  return {
    textLength: text.length,
    canvases: document.querySelectorAll("canvas").length,
    visibleElements,
    mediaElements: document.querySelectorAll("img, svg, video, iframe, picture").length,
    title: document.title.slice(0, 120),
  };
}`;

/**
 * Parse browser_console_messages text. The tool returns a header
 * ("Total messages: …") followed by "[ERROR] text @ url:line" entries and,
 * for uncaught exceptions, a raw stack whose continuation lines belong to the
 * preceding entry.
 */
export function parseConsoleEntries(text: string): ConsoleEntry[] {
  const entries: ConsoleEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (/^Total messages:|^Returning \d+ messages? /.test(line.trim())) continue;
    const match = /^\s*\[([^\]]+)\]\s?(.*)$/.exec(line);
    if (match) {
      entries.push({ type: match[1].toUpperCase(), text: match[2] });
    } else if (/^(?:Uncaught\s+)?(?:Error|TypeError|ReferenceError|RangeError|SyntaxError|DOMException)\b/.test(line.trim())
      && entries.at(-1)?.type !== "PAGEERROR") {
      // A page error (uncaught exception) has no "[LEVEL]" prefix; its stack
      // lines are appended below.
      entries.push({ type: "PAGEERROR", text: line.trim() });
    } else if (entries.length) {
      entries[entries.length - 1].text += `\n${line.trim()}`;
    } else {
      entries.push({ type: "PAGEERROR", text: line.trim() });
    }
  }
  return entries;
}

/**
 * Parse browser_network_requests text. Each line is
 * `N. [METHOD] url => [status] text` or `=> [FAILED] errorText`; numbering is
 * preserved so browser_network_request can inspect the same entry.
 */
export function parseNetworkFailures(text: string, origin = PREVIEW_ORIGIN): NetworkFailure[] {
  const failures: NetworkFailure[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*\d+\.\s+\[[A-Z]+\]\s+(\S+?)(?:\s+=>\s+\[([^\]]+)\]\s*(.*))?$/.exec(raw);
    if (!match) continue;
    const url = match[1];
    if (!url.startsWith(origin)) continue;
    if (!match[2]) continue; // still pending when the list was read
    if (match[2].toUpperCase() === "FAILED") {
      failures.push({ url, error: match[3].trim() || "request failed" });
      continue;
    }
    const status = Number(match[2]);
    if (Number.isFinite(status) && status >= 400) failures.push({ url, status });
  }
  return failures;
}

/** Parse the JSON value returned by RENDER_PROBE; undefined when the probe failed. */
export function parseRenderSanity(text: string): RenderSanity | undefined {
  try {
    const value = JSON.parse(text.trim()) as Partial<RenderSanity>;
    if (typeof value.textLength !== "number" || typeof value.canvases !== "number" || typeof value.visibleElements !== "number") return undefined;
    return value as RenderSanity;
  } catch {
    return undefined;
  }
}

/**
 * The blank-page catch: a page whose module graph produced neither text nor a
 * canvas is the most common agent failure that emits no console error at all.
 * Returns a hard-error description, or undefined when the page has content.
 */
export function renderSanityProblem(state: RenderSanity | undefined): string | undefined {
  if (!state) return undefined;
  if (state.textLength > 0 || state.canvases > 0 || (state.mediaElements ?? 0) > 0) return undefined;
  // Allow a shell of layout wrappers; an empty #app with nothing inside is blank.
  if (state.visibleElements > 2) return undefined;
  return `preview rendered a blank page — no visible text or canvas${state.title ? ` (title: "${state.title}")` : ""}`;
}

class McpSession {
  private nextId = 1;
  private sessionId: string | undefined;

  constructor(private readonly url: string) {}

  private async post(body: unknown): Promise<{ status: number; json: unknown | undefined }> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    const header = response.headers.get("mcp-session-id");
    if (header) this.sessionId = header;
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text().catch(() => "");
    if (!text) return { status: response.status, json: undefined };
    if (contentType.includes("text/event-stream")) {
      // Take the last data: event; the JSON-RPC result for our request id is
      // the only meaningful payload for a fire-and-forget client like this.
      const events = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
      const last = events.at(-1)?.slice(5).trim();
      try {
        return { status: response.status, json: last ? JSON.parse(last) : undefined };
      } catch {
        return { status: response.status, json: undefined };
      }
    }
    try {
      return { status: response.status, json: JSON.parse(text) };
    } catch {
      return { status: response.status, json: undefined };
    }
  }

  async initialize(): Promise<void> {
    const { json, status } = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "threadsite-qa", version: "1.0.0" },
      },
    });
    if (status >= 400 || (json as { error?: unknown } | undefined)?.error) {
      throw new Error(`Playwright MCP initialize failed (HTTP ${status})`);
    }
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  /** tools/call; returns the parsed tool result or throws with its error text. */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<any> {
    const { json } = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name: tool, arguments: args },
    });
    const message = json as { result?: any; error?: { message?: string } } | undefined;
    if (message?.error) throw new Error(`${tool}: ${message.error.message ?? "tool error"}`);
    if (!message?.result) throw new Error(`${tool}: empty MCP result`);
    if (message.result.isError) {
      const text = (message.result.content ?? []).map((part: any) => part?.text ?? "").join(" ").trim();
      throw new Error(`${tool}: ${text || "tool reported an error"}`);
    }
    return message.result;
  }
}

/** The first text part of a tool result, when present. */
function resultText(result: any): string {
  return (result?.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n");
}

function isErrorLevel(entry: Record<string, unknown>): boolean {
  const level = String(entry.type ?? entry.level ?? entry.severity ?? entry.subtype ?? "").toLowerCase();
  return level === "error" || level === "pageerror" || level === "page error" || level === "assertion";
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(undefined); },
    );
  });
}

/**
 * Run one QA pass. Resolves undefined when the preview service is
 * unreachable, the browser misbehaves, or the pass exceeds the budget — QA
 * degrades to "skipped", never to "failed".
 */
export async function runBrowserQa(guildId: string, threadId: string): Promise<BrowserQaResult | undefined> {
  const outcome = await withTimeout(driveQa(guildId, threadId), config.browserQaTimeoutMs);
  if (!outcome) log("warn", "browserqa.skipped_unavailable", { threadId });
  return outcome;
}

async function driveQa(guildId: string, threadId: string): Promise<BrowserQaResult> {
  const session = new McpSession(config.previewMcpUrl);
  await session.initialize();
  const hardErrors: string[] = [];
  const softNotes: string[] = [];
  let screenshotPng: Buffer | undefined;
  try {
    await session.call("browser_navigate", { url: `${PREVIEW_ORIGIN}/${guildId}/${threadId}/` });
    // Let async module graph execution and first-frame handlers settle.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Render sanity first: a blank page usually produces no console output, so
    // this is the only signal that the module graph silently did nothing.
    const renderResult = await session.call("browser_evaluate", { function: RENDER_PROBE }).catch(() => undefined);
    const sanity = renderResult ? parseRenderSanity(resultText(renderResult)) : undefined;
    const blank = renderSanityProblem(sanity);
    if (blank) hardErrors.push(blank);

    // The MCP tools return plain text, not JSON: the JSON-shaped stub the QA
    // tests originally used hid that difference and made every check a no-op.
    const consoleResult = await session.call("browser_console_messages", { level: "error" }).catch(() => undefined);
    const entries = consoleResult ? parseConsoleEntries(resultText(consoleResult)) : [];
    for (const entry of entries) {
      if (!isErrorLevel({ type: entry.type })) continue;
      const text = entry.text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (NETWORK_ERROR_RE.test(text)) softNotes.push(text.slice(0, 200));
      else hardErrors.push(text.slice(0, 300));
    }

    const networkResult = await session.call("browser_network_requests", { static: false }).catch(() => undefined);
    const failures = networkResult ? parseNetworkFailures(resultText(networkResult)) : [];
    for (const failure of failures) {
      // Browsers opportunistically request /favicon.ico; a missing one is not
      // a site defect and must not fail the turn.
      if (failure.status === 404 && /favicon\.ico$/.test(failure.url)) continue;
      const label = failure.url.slice(PREVIEW_ORIGIN.length) || "/";
      hardErrors.push(`preview request failed: ${label} → ${failure.error ?? `HTTP ${failure.status}`}`);
    }

    const shot = await session.call("browser_take_screenshot", { type: "png" }).catch(() => undefined);
    const image = (shot?.content ?? []).find((part: any) => part?.type === "image" && typeof part.data === "string");
    if (image) screenshotPng = Buffer.from(image.data, "base64");
  } finally {
    await session.call("browser_close", {}).catch(() => undefined);
  }
  return {
    hardErrors: hardErrors.slice(0, 8),
    softNotes: softNotes.slice(0, 5),
    screenshotPng,
  };
}
