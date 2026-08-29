# Upgrading V2.1 → V2.1.1

V2.1.1 removes the file-extension and MIME allowlists from `asset_download`. It also changes publication from a narrow static-extension allowlist to a server-executable denylist, so uncommon static/data/vendor formats are publishable.

Your `.env`, `data/`, `secrets/`, Forgejo volume, and existing project workspaces do not need to change.

Replace the V2.1 application files with V2.1.1, preserving `.env`, `data/`, and `secrets/`, then rebuild both OpenCode (custom downloader changed) and the bot (publisher changed):

```bash
docker compose build --pull opencode bot
docker compose up -d --force-recreate opencode bot
```

Then verify:

```bash
docker compose logs -f opencode bot
```

The downloader still enforces public HTTP(S)-only targets, private-network/SSRF blocking, path containment beneath `site/assets/`, redirect limits, timeout, and `ASSET_MAX_BYTES`. The publisher still rejects dotfiles, symlinks, and obvious server-executable extensions such as PHP/CGI/server-side scripts.
