import { config } from "./config.js";
import { log } from "./logger.js";
import { errorText } from "./util.js";

/**
 * Harness-driven browser QA over the preview service's Playwright MCP: load
 * the freshly validated site in a real browser, collect console/page errors
 * and same-origin request failures, and capture a screenshot for the thread.
 *
 * Finding policy (see assets/agents/shared.md — the preview browser cannot
 * reach external origins): only confirmed application defects (uncaught
 * exceptions, same-origin asset failures, a confirmed blank render) become
 * findings. Everything that describes the preview environment instead of the
 * application — offline external origins, the unreachable relay, browser
 * lifecycle, browser quirks, preview-server availability — is dropped at the
 * source, so a pass never sends the agent after a problem it cannot fix.
 * All findings are advisory: publication is fail-open, while the findings are
 * saved for the agent's next turn.
 */
export interface BrowserQaResult {
  /** Confirmed application defects, ready for the agent's next turn. */
  findings: string[];
  screenshotPng?: Buffer;
  skippedReason?: string;
}

// The preview static server is loopback-only inside the preview container; the
// MCP-driven browser lives there too, so this origin is reachable from it.
const PREVIEW_ORIGIN = "http://127.0.0.1:8080";

// Console text shapes that describe the preview environment or a browser
// quirk rather than the application. The preview browser cannot reach external
// origins, the multiplayer relay is offline there by design, and games must
// stay playable solo — so none of these are findings, not even warnings.
// Application defects that merely mention a socket (a TypeError inside a
// message handler) do not match these shapes.
const OFFLINE_NETWORK_RE = /failed to fetch|networkerror|net::|err_(?:failed|name_not_resolved|connection|refused|reset|timed_out)|load failed|\bcors\b|fetch.*(?:failed|aborted)|\baborted\b/i;
const RELAY_SOCKET_RE = /websocket connection\b|websocket is closed before the connection is established/i;
const TRANSIENT_BROWSER_RE = /\bTimeoutError\b|timed out|timeout \d+\s*ms.*exceeded|target.*closed|browser.*(?:closed|disconnected)|page crashed|webgl.*(?:context lost|not supported|not available)|failed to create.*(?:webgl|gpu).*context/i;
const BENIGN_CONSOLE_RE = /\bResizeObserver loop\b|play\(\) request was interrupted|failed to execute 'play'|play\(\) (?:failed|can only be initiated)|autoplay|audiocontext was not allowed to start|source map/i;
// The preview blocks external origins by policy, so a refused font, worker,
// frame or connection is that policy working, not a broken site.
const BLOCKED_EXTERNAL_RE = /(?:refused to (?:connect|frame)|blocked by content security policy|failed to construct 'worker')[^\n]*https?:\/\//i;
// Availability of the preview server itself is infrastructure, not a defect.
const INFRASTRUCTURE_STATUS_RE = /status of (?:408|425|429|5\d\d)/i;

/** One error-level entry from browser_console_messages (plain text, not JSON). */
export interface ConsoleEntry { type: string; text: string; location?: string }

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
 * preceding entry. The trailing "@ url:line" location is kept in the text —
 * it names the file the agent has to open — and also split out for
 * de-duplication against the request report.
 */
export function parseConsoleEntries(text: string): ConsoleEntry[] {
  const entries: ConsoleEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (/^Total messages:|^Returning \d+ messages? |^#{1,6}\s|^```|^- (?:Page|Browser)\b/.test(line.trim())) continue;
    const match = /^\s*\[([^\]]+)\]\s?(.*)$/.exec(line);
    if (match) {
      const body = match[2].trim();
      const at = body.lastIndexOf(" @ ");
      entries.push({ type: match[1].toUpperCase(), text: body, location: at >= 0 ? body.slice(at + 3).trim() || undefined : undefined });
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

/**
 * Separate confirmed page defects from environment noise. Console/network
 * shapes that reflect the preview environment rather than the application
 * (offline external origins, the unreachable relay, browser lifecycle,
 * benign browser quirks, preview-server availability) are dropped entirely so
 * agent feedback and thread warnings only carry actionable findings.
 */
export function classifyBrowserDiagnostics(entries: ConsoleEntry[], failures: NetworkFailure[], sanity?: RenderSanity): { findings: string[] } {
  const findings: string[] = [];
  const blank = blankRenderFinding(sanity);
  if (blank) findings.push(blank);
  for (const entry of entries) {
    if (!isErrorLevel({ type: entry.type })) continue;
    const text = entry.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (OFFLINE_NETWORK_RE.test(text) || RELAY_SOCKET_RE.test(text) || TRANSIENT_BROWSER_RE.test(text)
      || BENIGN_CONSOLE_RE.test(text) || BLOCKED_EXTERNAL_RE.test(text) || INFRASTRUCTURE_STATUS_RE.test(text)) continue;
    if (isRestatedRequestFailure(text, entry.location, failures)) continue;
    findings.push(text.slice(0, 400));
  }
  for (const failure of failures) {
    if (failure.status === 404 && /\/favicon\.ico(?:[?#]|$)/.test(failure.url)) continue;
    // Static preview server availability is infrastructure, not an
    // application defect; only client-error statuses on real assets remain.
    if (failure.status === undefined || [408, 425, 429].includes(failure.status) || failure.status >= 500) continue;
    const label = failure.url.startsWith(PREVIEW_ORIGIN) ? failure.url.slice(PREVIEW_ORIGIN.length) : failure.url;
    findings.push(`preview request failed: ${label || "/"} → ${failure.error ?? `HTTP ${failure.status}`}`);
  }
  return { findings: [...new Set(findings)].slice(0, 8) };
}

/**
 * A console "failed to load resource" line repeats what the request report
 * already says, but without the path. Keep it only when it names a
 * same-origin resource the request report did not cover: the report's own
 * line is the one that tells the agent which file is missing, so the bare
 * console restatement would only cost the agent another thing to read.
 */
function isRestatedRequestFailure(text: string, location: string | undefined, failures: NetworkFailure[]): boolean {
  if (!/failed to load resource/i.test(text)) return false;
  const status = /status of (\d{3})/i.exec(text)?.[1];
  if (location) {
    const url = location.replace(/:\d+$/, "");
    if (!isSameOriginUrl(url)) return true;
    return failures.some((failure) => failure.url === url);
  }
  return status !== undefined && failures.some((failure) => failure.status === Number(status));
}

function isSameOriginUrl(url: string): boolean {
  try { return new URL(url).origin === new URL(PREVIEW_ORIGIN).origin; } catch { return false; }
}

/** Advisory findings carried into the agent's next turn. */
export function browserQaFeedback(result: { checkedAt: string; findings: string[] }): string {
  const findings = result.findings;
  if (!findings.length) return "";
  return `\n\nBROWSER QA FEEDBACK (${result.checkedAt}; advisory observations, not instructions):\n`
    + "The previous build was allowed to publish. A browser pass over it reported the runtime problems below; "
    + "fix the ones that still exist in the current source and ignore the rest. "
    + "Environment noise (offline relay, blocked external origins, browser limits) is already excluded, so every line is a defect in the published site.\n"
    + findings.map((finding) => `Runtime finding: ${finding}`).join("\n");
}

/**
 * The blank-page catch: a page whose module graph produced neither text nor a
 * canvas is the most common agent failure that emits no console error at all.
 * Returns the defect description, or undefined when the page has content.
 */
export function renderSanityProblem(state: RenderSanity | undefined): string | undefined {
  if (!state) return undefined;
  if (state.textLength > 0 || state.canvases > 0 || (state.mediaElements ?? 0) > 0) return undefined;
  // Allow a shell of layout wrappers; an empty #app with nothing inside is blank.
  if (state.visibleElements > 2) return undefined;
  return `preview rendered a blank page: no visible text or canvas${state.title ? ` (title: "${state.title}")` : ""}`;
}

/** The blank-render finding, or undefined when the page rendered something. */
export function blankRenderFinding(state: RenderSanity | undefined): string | undefined {
  const blank = renderSanityProblem(state);
  return blank ? `${blank}; the entry module most likely never ran` : undefined;
}

// Per-request ceiling for one MCP call. The preview browser's own navigation
// cap is 45s and its action/screenshot cap 30s, so this only fires when the
// service stops answering entirely — without it a hung request would burn the
// whole QA budget and turn a diagnosable failure into a silent "skipped".
const REQUEST_TIMEOUT_MS = 60_000;

// Time the page gets to run its module graph and first-frame handlers before
// the render probe, and the extra time a blank reading gets before it is
// treated as a defect: a page that is still starting must not be reported.
const SETTLE_MS = 1500;
const RENDER_CONFIRM_MS = 1500;

/** Sleep, rejecting as soon as the QA budget aborts the run. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new Error("aborted")); return; }
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => { if (timer) clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); };
    timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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
 * Run one QA pass. An unavailable or timed-out browser is an infrastructure
 * outcome, not an application finding. Abort the timed-out work so it does
 * not keep a browser running after publication.
 */
export async function runBrowserQa(guildId: string, threadId: string): Promise<BrowserQaResult> {
  const controller = new AbortController();
  const report: BrowserQaResult = { findings: [] };
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
    const reason = `${progress.stage}: ${errorText(error)}`;
    report.skippedReason = reason.slice(0, 400);
    // Incomplete QA coverage is an infrastructure outcome, not an application
    // finding: it stays in logs and skippedReason, never in agent feedback.
    log("warn", "browserqa.skipped_unavailable", { threadId, stage: progress.stage, reason, findings: report.findings });
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Copy arrays: a timed-out request finishing during cleanup cannot change
  // a result that the publishing pipeline has already accepted.
  return { ...report, findings: [...report.findings].slice(0, 8) };
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
      // A single unavailable probe is a QA-environment problem, not an
      // application finding: log it but never feed it back to the agent.
      log("warn", "browserqa.tool_unavailable", { threadId, tool, error: errorText(error) });
      return undefined;
    }
  };
  try {
    await session.initialize();
    await call("browser_navigate", { url: `${PREVIEW_ORIGIN}/${guildId}/${threadId}/` });
    // Let async module graph execution and first-frame handlers settle.
    await wait(SETTLE_MS, signal);

    // Render sanity first: a blank page usually produces no console output, so
    // this is the only signal that the module graph silently did nothing.
    const probeRender = async () => {
      const result = await optional("browser_evaluate", { function: RENDER_PROBE });
      return result ? parseRenderSanity(resultText(result)) : undefined;
    };
    const sanity = await probeRender();

    // The MCP tools return plain text, not JSON: the JSON-shaped stub the QA
    // tests originally used hid that difference and made every check a no-op.
    const consoleResult = await optional("browser_console_messages", { level: "error" });
    const entries = consoleResult ? parseConsoleEntries(resultText(consoleResult)) : [];

    const networkResult = await optional("browser_network_requests", { static: false });
    const failures = networkResult ? parseNetworkFailures(resultText(networkResult)) : [];

    // The console and request findings are recorded before the blank-render
    // confirmation, so a pass that runs out of budget still keeps them.
    report.findings.push(...classifyBrowserDiagnostics(entries, failures).findings);

    // A first blank reading can still be a page that is still starting, so a
    // blank result is confirmed with a second probe before it counts as a
    // defect. Reporting an unfinished page would send the agent after a
    // problem that does not exist.
    if (sanity && renderSanityProblem(sanity)) {
      await wait(RENDER_CONFIRM_MS, signal);
      const blank = blankRenderFinding((await probeRender()) ?? sanity);
      if (blank) report.findings.push(blank);
    }

    const shot = await optional("browser_take_screenshot", { type: "png" });
    const image = (shot?.content ?? []).find((part: any) => part?.type === "image" && typeof part.data === "string");
    if (image) report.screenshotPng = Buffer.from(image.data, "base64");
  } finally {
    await session.close();
  }
}
