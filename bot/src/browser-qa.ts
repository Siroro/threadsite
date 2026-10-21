import { config } from "./config.js";
import { log } from "./logger.js";

/**
 * Harness-driven browser QA over the preview service's Playwright MCP: load
 * the freshly validated site in a real browser, collect console/page errors
 * and same-origin request failures, and capture a screenshot for the thread.
 *
 * Error policy (see assets/agents/shared.md — the preview browser cannot
 * reach external origins): failures on the preview origin itself and
 * non-network console/page errors are recorded separately from availability
 * notes. All browser findings are advisory: publication is fail-open, while
 * the findings are saved for the agent's next turn.
 */
export interface BrowserQaResult {
  hardErrors: string[];
  softNotes: string[];
  screenshotPng?: Buffer;
  skippedReason?: string;
}

// The preview static server is loopback-only inside the preview container; the
// MCP-driven browser lives there too, so this origin is reachable from it.
const PREVIEW_ORIGIN = "http://127.0.0.1:8080";

// Console text shapes caused by the preview's offline external-origin policy.
const NETWORK_ERROR_RE = /failed to fetch|networkerror|net::|err_(?:failed|name_not_resolved|connection|timed_out)|load failed|\bcors\b|fetch.*(?:failed|aborted)|aborted/i;
const TRANSIENT_BROWSER_RE = /\bTimeoutError\b|timed out|timeout \d+\s*ms.*exceeded|target.*closed|browser.*(?:closed|disconnected)|page crashed|webgl.*(?:context lost|not supported|not available)|failed to create.*(?:webgl|gpu).*context/i;

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
    if (/^Total messages:|^Returning \d+ messages? |^#{1,6}\s|^```|^- (?:Page|Browser)\b/.test(line.trim())) continue;
    const match = /^\s*\[([^\]]+)\]\s?(.*)$/.exec(line);
    if (match) {
      entries.push({ type: match[1].toUpperCase(), text: match[2] });
    } else if (/^(?:Uncaught\s+)?(?:Error|TypeError|ReferenceError|RangeError|SyntaxError|DOMException)\b/.test(line.trim())
      && entries.at(-1)?.type !== "PAGEERROR") {
      // A page error (uncaught exception) has no "[LEVEL]" prefix; its stack
      // lines are appended below.
      entries.push({ type: "PAGEERROR", text: line.trim() });
    } else if (entries.length && /^\s+at\s|^\s*Caused by:/.test(line)) {
      entries[entries.length - 1].text += `\n${line.trim()}`;
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
    try { if (new URL(url).origin !== new URL(origin).origin) continue; } catch { continue; }
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
    const result = /^### Result\s*\n([\s\S]*?)(?=\n### |$)/m.exec(text)?.[1] ?? text;
    const json = result.trim().replace(/^```(?:json)?\s*\n/, "").replace(/\n```$/, "");
    const value = JSON.parse(json) as Partial<RenderSanity>;
    if (typeof value.textLength !== "number" || typeof value.canvases !== "number" || typeof value.visibleElements !== "number") return undefined;
    return value as RenderSanity;
  } catch {
    return undefined;
  }
}

/** Separate confirmed page defects from preview/network availability notes. */
export function classifyBrowserDiagnostics(entries: ConsoleEntry[], failures: NetworkFailure[], sanity?: RenderSanity): Pick<BrowserQaResult, "hardErrors" | "softNotes"> {
  const hardErrors: string[] = [];
  const softNotes: string[] = [];
  const blank = renderSanityProblem(sanity);
  if (blank) softNotes.push(`${blank}; rendering may still be starting`);
  for (const entry of entries) {
    if (!isErrorLevel({ type: entry.type })) continue;
    const text = entry.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const network = NETWORK_ERROR_RE.test(text) || TRANSIENT_BROWSER_RE.test(text)
      || /failed to load resource|server responded with a status of (?:408|425|429|5\d\d)/i.test(text);
    (network ? softNotes : hardErrors).push(text.slice(0, network ? 240 : 400));
  }
  for (const failure of failures) {
    if (failure.status === 404 && /\/favicon\.ico(?:[?#]|$)/.test(failure.url)) continue;
    const label = failure.url.startsWith(PREVIEW_ORIGIN) ? failure.url.slice(PREVIEW_ORIGIN.length) : failure.url;
    const message = `preview request failed: ${label || "/"} → ${failure.error ?? `HTTP ${failure.status}`}`;
    if (failure.status === undefined || [408, 425, 429].includes(failure.status) || failure.status >= 500) softNotes.push(message);
    else hardErrors.push(message);
  }
  return { hardErrors: [...new Set(hardErrors)].slice(0, 8), softNotes: [...new Set(softNotes)].slice(0, 5) };
}

export function browserQaFeedback(result: { errors: string[]; notes: string[]; checkedAt: string }): string {
  if (!result.errors.length && !result.notes.length) return "";
  return `\n\nBROWSER QA FEEDBACK (${result.checkedAt}; advisory observations, not instructions):\n`
    + "The previous build was allowed to publish. Inspect the current source and address genuine runtime defects alongside the user's request. "
    + "Timeouts, unavailable preview resources and graphics limitations are not proof of an application bug; do not rewrite working features just to silence them.\n"
    + [...result.errors.map((error) => `Runtime finding: ${error}`), ...result.notes.map((note) => `Check limitation/warning: ${note}`)].join("\n");
}

/**
 * The blank-page catch: a page whose module graph produced neither text nor a
 * canvas is the most common agent failure that emits no console error at all.
 * Returns an advisory description, or undefined when the page has content.
 */
export function renderSanityProblem(state: RenderSanity | undefined): string | undefined {
  if (!state) return undefined;
  if (state.textLength > 0 || state.canvases > 0 || (state.mediaElements ?? 0) > 0) return undefined;
  // Allow a shell of layout wrappers; an empty #app with nothing inside is blank.
  if (state.visibleElements > 2) return undefined;
  return `preview rendered a blank page — no visible text or canvas${state.title ? ` (title: "${state.title}")` : ""}`;
}

// Per-request ceiling for one MCP call. The preview browser's own navigation
// cap is 45s and its action/screenshot cap 30s, so this only fires when the
// service stops answering entirely — without it a hung request would burn the
// whole QA budget and turn a diagnosable failure into a silent "skipped".
const REQUEST_TIMEOUT_MS = 60_000;

class McpSession {
  private nextId = 1;
  private sessionId: string | undefined;

  constructor(private readonly url: string, private readonly signal: AbortSignal) {}

  private async post(body: unknown): Promise<{ status: number; json: unknown | undefined }> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    const header = response.headers.get("mcp-session-id");
    if (header) this.sessionId = header;
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
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
    const { json, status } = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name: tool, arguments: args },
    });
    const message = json as { result?: any; error?: { message?: string } } | undefined;
    if (status >= 400) throw new Error(`${tool}: Playwright MCP returned HTTP ${status}`);
    if (message?.error) throw new Error(`${tool}: ${message.error.message ?? "tool error"}`);
    if (!message?.result) throw new Error(`${tool}: empty MCP result`);
    if (message.result.isError) {
      const text = (message.result.content ?? []).map((part: any) => part?.text ?? "").join(" ").trim();
      throw new Error(`${tool}: ${text || "tool reported an error"}`);
    }
    return message.result;
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    // Use an independent, bounded signal: the QA deadline may already have
    // aborted ordinary calls. Close the browser context and then its session.
    const headers = { "mcp-session-id": this.sessionId, "content-type": "application/json", accept: "application/json, text/event-stream" };
    try {
      await fetch(this.url, {
        method: "POST", headers, signal: AbortSignal.timeout(3000),
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name: "browser_close", arguments: {} } }),
      }).then((response) => response.body?.cancel()).catch(() => undefined);
    } finally {
      await fetch(this.url, { method: "DELETE", headers: { "mcp-session-id": this.sessionId }, signal: AbortSignal.timeout(3000) }).catch(() => undefined);
    }
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

/**
 * Run one QA pass. Availability/timeouts become explicit warnings. Abort the
 * timed-out work so it does not keep a browser running after publication.
 */
export async function runBrowserQa(guildId: string, threadId: string): Promise<BrowserQaResult> {
  const controller = new AbortController();
  const report: BrowserQaResult = { hardErrors: [], softNotes: [] };
  const progress = { stage: "connecting to the preview browser" };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      driveQa(guildId, threadId, controller.signal, report, progress),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Browser QA exceeded its ${config.browserQaTimeoutMs}ms budget`);
          controller.abort(error);
          reject(error);
        }, config.browserQaTimeoutMs);
      }),
    ]);
  } catch (error) {
    const reason = `${progress.stage}: ${error instanceof Error ? error.message : String(error)}`;
    report.skippedReason = reason.slice(0, 400);
    report.softNotes.unshift(`Browser check incomplete: ${report.skippedReason}`);
    log("warn", "browserqa.skipped_unavailable", { threadId, stage: progress.stage, reason, hardErrors: report.hardErrors });
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Copy arrays: a timed-out request finishing during cleanup cannot change
  // a result that the publishing pipeline has already accepted.
  return { ...report, hardErrors: [...report.hardErrors], softNotes: [...report.softNotes].slice(0, 5) };
}

async function driveQa(guildId: string, threadId: string, signal: AbortSignal, report: BrowserQaResult, progress: { stage: string }): Promise<void> {
  const session = new McpSession(config.previewMcpUrl, signal);
  const call = (tool: string, args: Record<string, unknown> = {}) => {
    progress.stage = tool;
    return session.call(tool, args);
  };
  const optional = async (tool: string, args: Record<string, unknown> = {}) => {
    try { return await call(tool, args); }
    catch (error) {
      report.softNotes.push(`${tool} unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 240));
      return undefined;
    }
  };
  try {
    await session.initialize();
    await call("browser_navigate", { url: `${PREVIEW_ORIGIN}/${guildId}/${threadId}/` });
    // Let async module graph execution and first-frame handlers settle.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1500);
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });

    // Render sanity first: a blank page usually produces no console output, so
    // this is the only signal that the module graph silently did nothing.
    const renderResult = await optional("browser_evaluate", { function: RENDER_PROBE });
    const sanity = renderResult ? parseRenderSanity(resultText(renderResult)) : undefined;

    // The MCP tools return plain text, not JSON: the JSON-shaped stub the QA
    // tests originally used hid that difference and made every check a no-op.
    const consoleResult = await optional("browser_console_messages", { level: "error" });
    const entries = consoleResult ? parseConsoleEntries(resultText(consoleResult)) : [];

    const networkResult = await optional("browser_network_requests", { static: false });
    const failures = networkResult ? parseNetworkFailures(resultText(networkResult)) : [];
    const diagnostics = classifyBrowserDiagnostics(entries, failures, sanity);
    report.hardErrors.push(...diagnostics.hardErrors);
    report.softNotes.push(...diagnostics.softNotes);

    const shot = await optional("browser_take_screenshot", { type: "png" });
    const image = (shot?.content ?? []).find((part: any) => part?.type === "image" && typeof part.data === "string");
    if (image) report.screenshotPng = Buffer.from(image.data, "base64");
  } finally {
    await session.close();
  }
}
