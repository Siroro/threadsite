// Probe both listeners without creating an MCP/browser session.
try {
  const [assets, mcp] = await Promise.all([
    fetch("http://127.0.0.1:8080/health", { signal: AbortSignal.timeout(2500) }),
    fetch("http://127.0.0.1:8931/mcp", { signal: AbortSignal.timeout(2500) }),
  ]);
  process.exit(assets.ok && mcp.status === 400 ? 0 : 1);
} catch { process.exit(1); }
