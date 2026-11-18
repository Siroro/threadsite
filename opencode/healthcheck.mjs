try {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const headers = password ? { Authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") } : {};
  const options = { headers, signal: AbortSignal.timeout(4000) };
  const base = "http://127.0.0.1:4096";
  const info = await fetch(`${base}/api/info`, options);
  if (!info.ok || !/^2\./.test((await info.json()).version)) throw new Error("OpenCode v2 API is unavailable");

  const location = new URLSearchParams({ "location[directory]": "/workspace" });
  const plugins = await fetch(`${base}/api/plugin?${location}`, options);
  if (!plugins.ok) throw new Error(`OpenCode plugin inventory returned HTTP ${plugins.status}`);
  const { data } = await plugins.json();
  if (!data.some((plugin) => plugin.id === "threadsite.v2" && plugin.state.status === "active" && plugin.features.server)) {
    throw new Error("The ThreadSite server plugin has not activated");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
