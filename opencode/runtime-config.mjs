/** Apply deployment settings without changing the checked-in agent defaults. */
export function applyRuntimeConfig(config, env = process.env) {
  const raw = env.OPENCODE_MAX_STEPS?.trim();
  const maxSteps = raw ? Number(raw) : 200;
  if ((raw && !/^\d+$/.test(raw)) || !Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
    throw new Error("OPENCODE_MAX_STEPS must be a positive integer (default: 200).");
  }
  config.agent ||= {};
  config.agent.sitebuilder ||= {};
  config.agent.sitebuilder.maxSteps = maxSteps;
  return config;
}
