import http from "node:http";

// The Playwright MCP server never writes to an idle standalone SSE stream, and
// both Bun's fetch (~6 minutes) and Node's undici (5 minutes) abort response
// bodies that receive no bytes for that long. Agent turns routinely leave the
// browser idle past those limits, so every session's listening stream dies and
// reconnects in a loop against a server that allows only one stream per
// session. This proxy keeps such streams alive by writing SSE comments while
// they are idle. Comments are only legal between events, so injection waits
// until the stream is at an event boundary and has been quiet.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const LF = 0x0a;
const CR = 0x0d;

const isEventStream = (headers) =>
  String(headers["content-type"] ?? "").toLowerCase().includes("text/event-stream");

function trackEventBoundary(chunk, state) {
  let index = chunk.length - 1;
  let run = 0;
  while (index >= 0) {
    const byte = chunk[index];
    if (byte === LF) run += 1;
    else if (byte !== CR) break;
    index -= 1;
  }
  // A chunk ending mid-line replaces the count; one that is all newlines
  // extends whatever the previous chunk ended with.
  state.trailingNewlines =
    index >= 0 ? run : state.trailingNewlines + run;
}

function pipeWithKeepalive(upstream, response, heartbeatMs) {
  const state = { trailingNewlines: 2 };
  let lastByteAt = Date.now();
  const stop = () => clearInterval(heartbeat);
  const heartbeat = setInterval(() => {
    if (response.writableEnded || response.destroyed) {
      stop();
      return;
    }
    if (Date.now() - lastByteAt < heartbeatMs || state.trailingNewlines < 2) return;
    state.trailingNewlines = 2;
    response.write(": keepalive\n\n");
  }, Math.max(1, Math.round(heartbeatMs / 3)));
  upstream.on("data", (chunk) => {
    lastByteAt = Date.now();
    trackEventBoundary(chunk, state);
  });
  upstream.on("end", stop);
  cutClientOnUpstreamDeath(upstream, response, stop);
  response.on("close", stop);
  upstream.pipe(response);
}

/**
 * A mid-stream upstream death (a socket reset, or a close that arrives before
 * the response's 'end') is signalled on the response object, never on the
 * ClientRequest — so the request-level error handler cannot see it. Without
 * this, the client side stays half-open: an SSE listener idles on a dead
 * stream until its own HTTP timeout instead of reconnecting promptly. A plain
 * destroy() closes the socket without emitting an 'error' on our response.
 */
function cutClientOnUpstreamDeath(upstreamResponse, response, onDeath = () => {}) {
  const die = () => {
    onDeath();
    if (!response.writableEnded && !response.destroyed) response.destroy();
  };
  upstreamResponse.on("error", die);
  upstreamResponse.on("aborted", die);
  // The safety net: 'close' always fires, and 'complete' is false exactly when
  // the response ended before its body was through, whatever event sequence
  // the socket failure produced.
  upstreamResponse.on("close", () => {
    if (!upstreamResponse.complete) die();
  });
}

export function createMcpProxy({ upstreamHost = "127.0.0.1", upstreamPort, heartbeatMs = 45_000 }) {
  const agent = new http.Agent({ keepAlive: true });
  return http.createServer(
    // The SSE streams this proxy exists to keep open outlive the default
    // request deadline, and the MCP handshake answers long before it matters.
    { requestTimeout: 0, headersTimeout: 0 },
    (request, response) => {
      const headers = { ...request.headers };
      for (const header of Object.keys(headers)) if (HOP_BY_HOP.has(header)) delete headers[header];
      const upstream = http.request({
        host: upstreamHost,
        port: upstreamPort,
        method: request.method,
        path: request.url,
        headers,
        agent,
      });
      upstream.on("error", (error) => {
        if (response.headersSent) {
          response.destroy(error);
          return;
        }
        response.writeHead(502, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: `preview mcp proxy: upstream unavailable (${error.code ?? error.message})` },
          }),
        );
      });
      upstream.on("response", (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        if (isEventStream(upstreamResponse.headers)) {
          pipeWithKeepalive(upstreamResponse, response, heartbeatMs);
          return;
        }
        cutClientOnUpstreamDeath(upstreamResponse, response);
        upstreamResponse.pipe(response);
      });
      response.on("close", () => {
        if (!response.writableEnded) upstream.destroy();
      });
      request.pipe(upstream);
    },
  );
}
