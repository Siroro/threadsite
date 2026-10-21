try {
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const headers = password ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` } : {};
  const response = await fetch("http://127.0.0.1:4096/global/health", { headers, signal: AbortSignal.timeout(3000) });
  process.exit(response.ok && (await response.json()).healthy === true ? 0 : 1);
} catch { process.exit(1); }
