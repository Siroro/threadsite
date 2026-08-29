# Upgrade from ThreadSite V2 to V2.1

V2.1 is a drop-in code/config upgrade. Existing Docker volumes, `data/workspaces`, project state, Forgejo repositories, and your `.env` can be kept.

## Recommended upgrade

Back up the current directory first, then copy/extract V2.1 over the application files while preserving your existing `.env`, `data/`, and `secrets/`.

Two new settings are optional; if omitted the bot uses these defaults:

```dotenv
OPENCODE_RECONCILE_TIMEOUT_MS=1800000
OPENCODE_RECONCILE_POLL_MS=1500
```

Then rebuild the changed services:

```bash
docker compose build --pull bot
docker compose up -d --force-recreate bot
```

The OpenCode image itself does not require a V2.1 rebuild for transport recovery, although rebuilding both is harmless:

```bash
docker compose build --pull opencode bot
docker compose up -d --force-recreate opencode bot
```

Follow logs with:

```bash
docker compose logs -f bot opencode
```

A recovered transport interruption should now produce log/progress events similar to:

```text
opencode.prompt_transport_lost
🔄 Lost the live OpenCode connection — reconciling
🟢 Reconnected — checking the running turn
opencode.reconcile_found_completion
opencode.prompt_recovered
```

It should **not** create a public failure incident when the original OpenCode turn subsequently completes successfully.

For private diagnostics, `/site-admin errors` now includes serialized cause details, and Docker warn/error lines are emitted as JSON so nested socket/DNS/TLS codes remain visible.
