# ThreadSite

Build websites and browser games from Discord.

[![CI](https://github.com/Siroro/threadsite/actions/workflows/ci.yml/badge.svg)](https://github.com/Siroro/threadsite/actions/workflows/ci.yml)
[![Multiplayer checks](https://github.com/Siroro/threadsite/actions/workflows/multiplayer.yml/badge.svg)](https://github.com/Siroro/threadsite/actions/workflows/multiplayer.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Start a project with a slash command, then reply in its thread to make changes. The bot builds and publishes your site or game, with a live link and a source repository for every project.

![A ThreadSite project thread in Discord, with a request and live build progress](docs/screenshots/discord-thread.png)

## Install

You'll need a Linux server, a domain and a [Discord bot token](docs/discord.md). Enable **Message Content Intent** when creating the bot.

Point `sites.example.com` and `git.example.com` at your server, and open ports **80 and 443**. Then run this on the server, replacing `example.com` with your domain:

```bash
curl -fsSL https://raw.githubusercontent.com/Siroro/threadsite/main/scripts/caddy-quickstart.sh | bash -s -- \
  --domain example.com --install-docker
```

Follow the prompts for your bot token and AI model settings. The installer prints a Discord invite link, installs anything missing, sets up HTTPS with Caddy and waits for the bot to connect. Tokens are entered privately. When it's done, try `/site start` in your Discord server.

Have different hostnames? Use `--sites-domain lab.example.com --git-domain git.example.com` instead of `--domain example.com`. Multiplayer shares the sites address; `--games-domain` is optional.

See the [install guide](docs/deployment.md#caddy-quickstart) for custom domains, unattended installs and reruns. If you already run a web server or hosting panel, use the [existing server setup](docs/deployment.md#existing-server-setup).

## Usage

Create a website:

```text
/site start prompt: make a cosy recipe book for our server name: Server Cookbook
```

Or a game:

```text
/makegam dimension:2d prompt: make a top-down racing game for four players name: Tiny Racers
```

```text
/makegam dimension:3d prompt: make a hovercraft course with checkpoints name: Hover Yard
```

The bot opens a thread and shows its progress. When it's done, click **Open site** or **Play game**. Anyone with the link can open it in their browser.

To make changes, just reply:

> Add a night mode and make the text bigger.
>
> Give the hovercraft a boost button.

Attach images or files for reference, or reply while the bot is working to give it more instructions. The pinned card has the latest link, source code and project controls.

### Working together

Thread members can make changes by default. Use **Collaboration** on the pinned card to limit editing to chosen people or approve requests first.

**Queue** shows waiting requests. Use `/site stop` to stop the current work or `/site revert` to undo the last accepted update. See the [command guide](docs/commands.md) for all controls.

![A Discord game server with project threads and a pinned game card](docs/screenshots/discord-games.png)

## Multiplayer

Games can use a shared arena, invite-code rooms or singleplayer mode. For example:

```text
/makegam dimension:2d multiplayer:rooms prompt: make a co-op dungeon crawler
```

ThreadSite includes the multiplayer server. Games can also use saved progress and global leaderboards, and fall back to solo play if multiplayer is unavailable. Change an existing game's mode with `/site multiplayer`.

See [multiplayer](docs/multiplayer.md) for modes, saves and hosting.

## Gallery

Published projects appear in a shared gallery. Search, filter by game type, save favourites or pick something at random.

![ThreadSite's project gallery with browser games, websites, search, and filters](docs/screenshots/threadsite-gallery-desktop.png)

## Docs

- [Discord setup](docs/discord.md): bot token, permissions and server invite
- [Commands](docs/commands.md): project controls, collaboration and admin commands
- [Multiplayer](docs/multiplayer.md): game modes, saves and leaderboards
- [Gallery](docs/gallery.md): browsing and sharing projects
- [Maintenance](docs/maintenance.md): updates, cleanup and tests
- [Architecture](docs/architecture.md) and [OpenCode](docs/opencode-v2.md): how it works

For local development, use Node 24 and run the [checks](docs/maintenance.md#local-regression-checks) in the component you're changing. GitHub Actions runs the main checks on pushes and pull requests.

ThreadSite is [MIT licensed](LICENSE).
