/**
 * The bot↔agent-service vocabulary, in one place: the agent names both sides
 * route on, the subagents that may run in the background, the permission
 * actions the plugin tags browser tools with, and the plugin id the harness
 * waits for before prompting. The service side (opencode/v2/plugin.mjs,
 * opencode/opencode.json) keeps its own copies of these strings — the parity
 * test (bot/test/opencode-contract.test.ts) fails when the two drift.
 */

/** The builder agent every project turn runs as. */
export const BUILDER_AGENT = "sitebuilder";

/** Inspection-only browser QA subagent; runs in the background. */
export const BROWSER_QA_AGENT = "browser-qa";

/** Asset-forging subagent; runs in the background, results are load-bearing. */
export const ASSET_FORGE_AGENT = "asset-forge";

/** Subagents the bot keeps its turn open for until their report is handled. */
export const BACKGROUND_AGENTS: ReadonlySet<string> = new Set([BROWSER_QA_AGENT, ASSET_FORGE_AGENT]);

/** Permission action the plugin tags every browser (Playwright MCP) tool with. */
export const BROWSER_PERMISSION_ACTION = "threadsite_browser";

/** Tool-id wildcard the plugin and rulesets use for the Playwright MCP server's tools. */
export const BROWSER_TOOL_PATTERN = "playwright_*";

/** The native plugin the harness waits for before submitting any prompt. */
export const PLUGIN_ID = "threadsite.v2";
