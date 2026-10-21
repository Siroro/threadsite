import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { log, logError } from "./logger.js";

/** The slice of a Forgejo push-event body the bot cares about. */
export interface ForgejoPushEvent {
  ref?: string;
  after?: string;
  repository?: { name?: string };
}

const MAX_BODY_BYTES = 1024 * 1024;

// Forgejo (like Gitea) signs webhook bodies with hex HMAC-SHA256 of the raw
// body under the hook secret; both header spellings are accepted.
function verifySignature(raw: Buffer, secret: string, headers: IncomingMessage["headers"]): boolean {
  const provided = headers["x-forgejo-signature"] ?? headers["x-gitea-signature"];
  if (typeof provided !== "string" || !provided) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Body reader with distinguishable failures. A client reset is not an
 * oversize body, and an oversize body must answer before the socket is torn
 * down — writing a 413 to a destroyed socket throws inside the handler.
 */
function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.on("error", fail);
  });
}

class BodyTooLargeError extends Error {}

/**
 * Tiny HTTP surface for Forgejo push webhooks plus a health check. The only
 * mutating route is POST /hooks/forgejo, HMAC-verified against the persisted
 * secret; everything else is a 404. Nothing here touches Discord — events are
 * handed to the caller's async handlers.
 *
 * `listening` settles once the port is actually bound; a bind failure
 * (EADDRINUSE, …) rejects it, so callers can tell a live listener from a
 * dead one and fall back instead of silently going deaf.
 */
export function startWebhookServer(options: {
  port: number;
  secret: string;
  onPush: (event: ForgejoPushEvent) => Promise<void>;
  health: () => Record<string, unknown>;
}): { close: () => void; listening: Promise<number> } {
  // Delivery ids already dispatched. Forgejo retries a hook when the response
  // is slow or lost; without this the retry re-announces the same push. The
  // list is bounded because a long-lived process sees every push forever.
  const seenDeliveries = new Set<string>();
  const deliveryOrder: string[] = [];
  const rememberDelivery = (id: string): boolean => {
    if (seenDeliveries.has(id)) return false;
    seenDeliveries.add(id);
    deliveryOrder.push(id);
    if (deliveryOrder.length > 500) {
      const oldest = deliveryOrder.shift();
      if (oldest) seenDeliveries.delete(oldest);
    }
    return true;
  };

  const server = createServer((request, response) => {
    // A client that opens a connection and never sends headers would otherwise
    // hold a socket for the process lifetime.
    request.setTimeout(15_000, () => request.destroy());
    void (async () => {
      const urlPath = (request.url ?? "").split("?")[0];
      if (request.method === "GET" && urlPath === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, ...options.health() }));
        return;
      }
      if (request.method === "POST" && urlPath === "/hooks/forgejo") {
        let raw: Buffer;
        try {
          raw = await readBody(request);
        } catch (error) {
          const tooLarge = error instanceof BodyTooLargeError;
          log("warn", "webhook.body_rejected", { path: urlPath, tooLarge });
          if (!response.headersSent) {
            response.writeHead(tooLarge ? 413 : 400);
            // Flush the answer before dropping the connection: destroying the
            // socket first loses the status line, and the caller sees a reset
            // instead of the real reason.
            response.end(tooLarge ? "body too large" : "body read failed", () => {
              if (tooLarge) request.destroy();
            });
          } else if (tooLarge) {
            request.destroy();
          }
          return;
        }
        if (!verifySignature(raw, options.secret, request.headers)) {
          log("warn", "webhook.signature_rejected", { path: urlPath });
          response.writeHead(401);
          response.end("bad signature");
          return;
        }
        let event: ForgejoPushEvent;
        try {
          event = JSON.parse(raw.toString("utf8")) as ForgejoPushEvent;
        } catch {
          log("warn", "webhook.body_unparseable", { path: urlPath });
          response.writeHead(400);
          response.end("invalid json");
          return;
        }
        const delivery = request.headers["x-forgejo-delivery"] ?? request.headers["x-gitea-delivery"];
        const deliveryId = typeof delivery === "string" && delivery ? delivery : undefined;
        if (deliveryId && !rememberDelivery(deliveryId)) {
          log("info", "webhook.delivery_duplicate", { deliveryId });
          response.writeHead(202);
          response.end("duplicate");
          return;
        }
        // Answer before dispatching: onPush waits on Discord (and on the agent
        // status check), which can outlast Forgejo's delivery timeout and turn
        // one push into a retry storm.
        response.writeHead(202);
        response.end("accepted");
        void options.onPush(event).catch((error) => logError("webhook.dispatch_failed", error, { deliveryId }));
        return;
      }
      response.writeHead(404);
      response.end();
    })();
  });
  let markListening: (port: number) => void = () => undefined;
  let markListenFailed: (error: Error) => void = () => undefined;
  const listening = new Promise<number>((resolve, reject) => {
    markListening = resolve;
    markListenFailed = reject;
  });
  server.on("error", (error) => {
    logError("webhook.server_error", error, {});
    // No-op once listening has resolved; only a bind-time failure rejects.
    markListenFailed(error);
  });
  server.listen(options.port, "0.0.0.0", () => {
    // The bound port is reported so callers (and tests) know where it landed
    // when the configured port was 0.
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port;
    log("info", "webhook.listening", { port });
    markListening(port);
  });
  return {
    close: () => {
      server.close();
      server.closeAllConnections?.();
    },
    listening,
  };
}
