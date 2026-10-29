import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { GameConflict, type ResetScope } from "./game-lifecycle.js";

interface AdminOperations {
  tokenFile: string;
  games(): Iterable<string>;
  delete(gameId: string): Promise<void>;
  reset(gameId: string, scope: ResetScope): Promise<void>;
  resetAll(scope: ResetScope): Promise<number>;
  rename(from: string, to: string): Promise<void>;
}

type AdminRoute =
  | { kind: "inventory" }
  | { kind: "delete"; gameId: string }
  | { kind: "reset"; gameId: string }
  | { kind: "resetAll" }
  | { kind: "rename"; gameId: string };

function route(method: string | undefined, path: string): AdminRoute | undefined {
  if (method === "GET" && path === "/admin/games") return { kind: "inventory" };
  if (method === "POST" && path === "/admin/reset") return { kind: "resetAll" };
  const match = /^\/admin\/games\/([a-z0-9][a-z0-9-]{2,63})(?:\/(reset|rename))?$/.exec(path);
  if (!match) return undefined;
  const gameId = match[1]!;
  if (method === "DELETE" && !match[2]) return { kind: "delete", gameId };
  if (method === "POST" && match[2] === "reset") return { kind: "reset", gameId };
  if (method === "POST" && match[2] === "rename") return { kind: "rename", gameId };
  return undefined;
}

function parseResetScope(params: URLSearchParams): ResetScope | undefined {
  // Ambiguous destructive requests must never silently select the first value.
  if (params.getAll("scope").length > 1) return undefined;
  switch ((params.get("scope") ?? "all").trim().toLowerCase()) {
    case "all": return { world: true, scores: true };
    case "world": return { world: true, scores: false };
    case "scores": return { world: false, scores: true };
    default: return undefined;
  }
}

/** HTTP authentication, routing and validation; operations own game lifecycle rules. */
export function createAdminApi(operations: AdminOperations) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const request = route(req.method, url.pathname);
    if (!request) return false;
    const end = (status: number) => { res.writeHead(status); res.end(); };
    const json = (body: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      const token = (await fs.readFile(operations.tokenFile, "utf8")).trim();
      const actual = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (!token || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        end(403); return true;
      }
      switch (request.kind) {
        case "inventory": json([...operations.games()].sort()); break;
        case "delete": await operations.delete(request.gameId); end(204); break;
        case "rename": {
          const to = (url.searchParams.get("to") ?? "").trim();
          if (url.searchParams.getAll("to").length !== 1 || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(to)) {
            end(400); break;
          }
          await operations.rename(request.gameId, to);
          end(204); break;
        }
        case "reset":
        case "resetAll": {
          const scope = parseResetScope(url.searchParams);
          if (!scope) { end(400); break; }
          if (request.kind === "resetAll") json({ ok: true, games: await operations.resetAll(scope) });
          else { await operations.reset(request.gameId, scope); end(204); }
          break;
        }
      }
    } catch (error) {
      if (error instanceof GameConflict) end(409);
      else {
        console.warn(`[threadsite-gameserver] admin_api failed: ${String((error as Error).message)}`);
        if (!res.headersSent) res.writeHead(503);
        res.end();
      }
    }
    return true;
  };
}
