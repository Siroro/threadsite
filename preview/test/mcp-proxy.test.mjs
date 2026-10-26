import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createMcpProxy } from "../mcp-proxy.mjs";

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("condition not met in time"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function withProxy(upstreamHandler, heartbeatMs) {
  const upstream = http.createServer(upstreamHandler);
  const upstreamPort = await listen(upstream);
  const proxy = createMcpProxy({ upstreamPort, heartbeatMs });
  const proxyPort = await listen(proxy);
  return {
    proxyPort,
    upstreamPort,
    async dispose() {
      await close(proxy);
      await close(upstream);
    },
  };
}

function request(port, { method = "GET", path = "/mcp", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, method, path, headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ response, body: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    if (body !== undefined) request.end(body);
    else request.end();
  });
}

function openStream(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/mcp" }, (response) => {
      let text = "";
      let ended = false;
      let closed = false;
      response.on("data", (chunk) => (text += chunk.toString("utf8")));
      response.on("end", () => (ended = true));
      response.on("close", () => (closed = true));
      resolve({
        response,
        getText: () => text,
        hasEnded: () => ended,
        finished: () =>
          new Promise((done) => {
            if (ended) return done();
            response.once("end", () => done());
          }),
        whenClosed: () =>
          new Promise((done) => {
            if (closed) return done();
            response.once("close", () => done());
          }),
      });
    });
    request.on("error", reject);
  });
}

test("idle SSE streams receive keepalive comments and stay open", async () => {
  const { proxyPort, dispose } = await withProxy((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: ready\ndata: {}\n\n");
  }, 40);
  try {
    const stream = await openStream(proxyPort);
    await waitFor(() => (stream.getText().match(/: keepalive/g) ?? []).length >= 3);
    assert.ok(!stream.hasEnded(), "stream must still be open");
    assert.match(stream.getText(), /^event: ready\ndata: {}\n/);
    stream.response.destroy();
  } finally {
    await dispose();
  }
});

test("keepalive is never injected in the middle of an SSE event", async () => {
  const { proxyPort, dispose } = await withProxy(async (request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: result\ndata: {\"a\":");
    // Far longer than the heartbeat window: an injection here would corrupt
    // the pending event.
    await new Promise((resolve) => setTimeout(resolve, 250));
    response.write("1}\n\n");
    // Idle at a boundary: keepalives are expected again from here on.
    await new Promise((resolve) => setTimeout(resolve, 250));
    response.end();
  }, 40);
  try {
    const { body } = await request(proxyPort);
    const dataLines = body
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"));
    assert.deepEqual(
      dataLines.map((line) => JSON.parse(line.slice(5))),
      [{ a: 1 }],
    );
    assert.match(body, /: keepalive/);
  } finally {
    await dispose();
  }
});

test("non-SSE responses pass through with status, headers, and body intact", async () => {
  const { proxyPort, dispose } = await withProxy((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.writeHead(201, {
        "content-type": "application/json",
        "mcp-session-id": "ses_123",
      });
      response.end(`{"echo":${body.length}}`);
    });
  });
  try {
    const payload = '{"method":"tools/list"}';
    const { response, body } = await request(proxyPort, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": "ses_123" },
      body: payload,
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.headers["content-type"], "application/json");
    assert.equal(response.headers["mcp-session-id"], "ses_123");
    assert.equal(body, `{"echo":${payload.length}}`);
  } finally {
    await dispose();
  }
});

test("unreachable upstream answers 502 with a JSON-RPC error", async () => {
  const grave = http.createServer(() => {});
  const gravePort = await listen(grave);
  await close(grave);
  const proxy = createMcpProxy({ upstreamPort: gravePort });
  const proxyPort = await listen(proxy);
  try {
    const { response, body } = await request(proxyPort, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.statusCode, 502);
    assert.equal(JSON.parse(body).error.code, -32001);
  } finally {
    await close(proxy);
  }
});

test("aborting an SSE client releases the upstream stream", async () => {
  let upstreamClosed = false;
  const { proxyPort, dispose } = await withProxy((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: ready\ndata: {}\n\n");
    response.on("close", () => (upstreamClosed = true));
  }, 40);
  try {
    const stream = await openStream(proxyPort);
    await waitFor(() => stream.getText().includes("event: ready"));
    stream.response.destroy();
    await waitFor(() => upstreamClosed, 2000).catch(() =>
      assert.fail("upstream stream was not released after client abort"),
    );
  } finally {
    await dispose();
  }
});

test("an upstream that dies mid-stream cuts the SSE client instead of hanging it", async () => {
  const { proxyPort, dispose } = await withProxy((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: ready\ndata: {}\n\n");
    // Kill the connection without 'end': the proxy must tear the client side
    // down so its listener reconnects rather than idling on a dead stream.
    setTimeout(() => response.destroy(), 50);
  }, 40);
  try {
    const stream = await openStream(proxyPort);
    await waitFor(() => stream.getText().includes("event: ready"));
    await Promise.race([
      stream.whenClosed(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("client stream hung after upstream death")), 3000)),
    ]);
  } finally {
    await dispose();
  }
});

test("an upstream that dies mid-body cuts the plain client response", async () => {
  const { proxyPort, dispose } = await withProxy((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"partial":');
    setTimeout(() => response.destroy(), 50);
  });
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        const request = http.get({ host: "127.0.0.1", port: proxyPort, path: "/mcp" }, (res) => {
          res.on("end", resolve);
          res.on("close", resolve);
          res.on("error", resolve);
        });
        request.on("error", reject);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("client response hung after upstream death")), 3000)),
    ]);
  } finally {
    await dispose();
  }
});
