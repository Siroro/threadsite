try {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const headers = password ? { Authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") } : {};
  const response = await fetch("http://127.0.0.1:4096/api/info", { headers, signal: AbortSignal.timeout(3000) });
  const data = response.ok ? await response.json() : {};
  process.exit(response.ok && /^2\./.test(data.version) ? 0 : 1);
} catch { process.exit(1); }
