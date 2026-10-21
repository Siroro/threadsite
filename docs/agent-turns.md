# Agent turn safeguards

`OPENCODE_MAX_STEPS` is a positive integer, default **200**. The bot sends a mandatory `[THREADSITE_FORCE_FINISH]` user steering message at 90% of that budget (normally **180/200**). It tells the running agent to stop expanding scope, finish current edits, run syntax/type checks, update todos and summarize remaining limitations. This is an instruction to finish the current task; it does not abort the agent or grant another budget. For very small custom budgets, the warning is as early as one completed step.

Live completed steps trigger the warning promptly. A five-second saved-history check catches missed events; restart recovery uses the pending turn's original start time. The count covers the root session, independently of subagent token/step totals. The steering message itself is the durable receipt that prevents another warning after a bot restart. Failed submissions can be retried; stopped, deleted or idle turns must not be restarted to deliver a warning. The running model and reasoning variant are preserved.

The step limit applies in OpenCode and the warning threshold applies in the bot, so recreate both services after changing `.env`:

```bash
docker compose up -d --build --no-deps bot opencode
```

Browser MCP tools are offered only when the selected model advertises image input. All `playwright_*` tools are hidden from text-only models, including snapshots and scratch inspection. Permissions are recalculated for each turn and model switch, including quota failover. Unknown model capabilities disable browser tools. The general/explore subagents keep browser tools disabled because they have independent model settings; the title agent has no tools.

Text-only agents inspect source, run syntax/type checks and use browser diagnostics supplied by the harness. The harness's own browser QA and Discord screenshots continue independently of the model and remain advisory. Vision agents retain the full and scratch preview workflows.

Generated game `AGENTS.md` rules and initial prompts require a concrete core action, genre-appropriate challenges, meaningful decisions/skill and a complete playable round before optional polish. A generic collect-N-pickups loop is not the default. Explicit collection-game and sandbox requests remain supported, and existing mechanics are preserved on revisions. Existing projects receive the refreshed rules when the harness next prepares their workspace.
