try {
  const username = process.env.OPENCODE_API_VERSION === "v2" ? "opencode" : process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const headers = password ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` } : {};
  const v2 = process.env.OPENCODE_API_VERSION === "v2";
  const response = await fetch(`http://127.0.0.1:4096${v2 ? "/api/info" : "/global/health"}`, { headers, signal: AbortSignal.timeout(3000) });
  const data = response.ok ? await response.json() : {};
  process.exit(response.ok && (v2 ? /^2\./.test(data.version) : data.healthy === true) ? 0 : 1);
} catch { process.exit(1); }
