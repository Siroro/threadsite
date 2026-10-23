# Discord setup

You need two values from Discord: a **bot token** and an **application ID**. The token is the secret ThreadSite uses to log in as your bot. The application ID identifies the app and is used to register its slash commands.

## 1. Create the bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and choose **New Application**.
2. Give it a name, such as ThreadSite, and create it.
3. On **General Information**, copy the **Application ID**.
4. Open **Bot**. Under **Token**, choose **Reset Token** and copy the token. Save it somewhere private; Discord only shows it when you generate it.

ThreadSite needs the bot token, not the OAuth2 client secret or the application's public key. If you lose the token or share it accidentally, reset it and update ThreadSite with the replacement. See [Discord's credential instructions](https://docs.discord.com/developers/quick-start/getting-started#fetching-your-credentials).

## 2. Enable message access

On the **Bot** page, find **Privileged Gateway Intents**. Turn on **Message Content Intent** and save your changes. This lets ThreadSite read requests and attachments posted in project threads. Leave **Presence Intent** and **Server Members Intent** off; ThreadSite does not use them.

This setting is separate from channel permissions. A bot can have permission to see a channel and still be unable to read ordinary message content. [Discord explains message access here](https://docs.discord.com/developers/events/gateway#message-content-intent).

## 3. Invite it to your server

1. Open **Installation** in the Developer Portal. Enable **Guild Install** so the bot can join a server.
2. Under **Install Link**, select **Discord Provided Link**.
3. Under **Default Install Settings**, find **Guild Install** and select both `bot` and `applications.commands` as scopes.
4. Select the bot permissions below.
5. Copy the install link, open it in your browser, choose **Add to server**, and select your Discord server. The account installing it needs **Manage Server**.

If you use **OAuth2 → URL Generator** instead, choose the same scopes and permissions, then open the generated URL. ThreadSite needs a server installation. Adding it only to your personal apps will not let it create project threads. See [Discord's installation guide](https://docs.discord.com/developers/quick-start/getting-started#install-to-server) and [bot authorization](https://docs.discord.com/developers/topics/oauth2#bot-authorization-flow).

### Bot permissions

Grant these in the channels where you want people to create projects:

| Permission | Used for |
| --- | --- |
| View Channels | Finding project channels and threads |
| Send Messages | Posting in the parent channel |
| Create Public Threads | Opening a thread for each project |
| Send Messages in Threads | Replying with progress and results |
| Read Message History | Loading existing project cards and conversations |
| Embed Links | Showing linked previews |
| Attach Files | Sending screenshots and report files |
| Pin Messages | Pinning the project card |

Also grant **Manage Threads** if you want the cleanup tools to delete project threads or the bot to rename threads it did not create. The bot does not need Administrator.

In Discord, open the project channel's **Edit Channel → Permissions** and check the bot's role. Channel or category overrides can block permissions granted by the invite. Discord documents [permissions and channel overrides here](https://docs.discord.com/developers/topics/permissions).

### Member permissions

People using ThreadSite need **View Channels**, **Send Messages**, **Send Messages in Threads**, **Read Message History**, and **Use Application Commands** in the project channel. Allow **Attach Files** if they should be able to upload references.

Choose a normal text channel, such as `#build-a-site`. The bot creates public project threads there. Access to edits within a project can then be controlled with **Collaboration** on its pinned card.

## 4. Connect ThreadSite

With the [Caddy quickstart](deployment.md#caddy-quickstart), paste the token when asked. The script discovers the application ID, checks Message Content Intent and prints a server invite link. It also asks for an optional server ID, extra admin IDs, and your model and provider key. It saves the configuration and waits for the bot to connect.

For a manual setup, put them in the `.env` file in your ThreadSite checkout:

```dotenv
DISCORD_BOT_TOKEN=paste_your_bot_token_here
DISCORD_APPLICATION_ID=paste_your_application_id_here
DISCORD_GUILD_ID=
```

Use the raw token without a `Bot ` prefix. Keep it in `.env`, which is ignored by Git, and never paste it into a Discord channel, issue or screenshot.

For a bot that will only be used in your own server, you can set `DISCORD_GUILD_ID` to that server's ID. This registers commands directly in that server. Leave it blank to register global commands.

To copy a server ID, enable **User Settings → Advanced → Developer Mode** in Discord. Right-click your server's icon and choose **Copy Server ID**. This is different from the application ID. [Discord's ID guide](https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID) has the desktop and mobile steps.

Once the rest of ThreadSite is set up, start or recreate the bot from your checkout:

```bash
docker compose up -d --force-recreate bot
docker compose logs --tail=100 bot
```

The bot registers its commands at startup. Look for `discord.commands_registered` and `discord.ready` in the logs. ThreadSite connects to Discord itself, so leave **Interactions Endpoint URL** blank in the Developer Portal. No Discord redirect URL or public bot endpoint is needed.

## 5. Try a project

In your project channel, run:

```text
/site start prompt: make a simple page for our server name: Server Page
```

The bot should open a thread and post a project card and progress message. After it publishes, reply in the thread with another change to check that message access works too.

Server members with **Manage Server** can use `/site-admin`. You can also add user IDs to `DISCORD_ADMIN_USER_IDS`, but Discord's command permissions must still allow those users to invoke the command. See the [admin command guide](commands.md#admin-commands).

## If it doesn't work

| Problem | What to check |
| --- | --- |
| The bot is offline | Check the bot logs and token. Inviting it adds the account; the ThreadSite service must be running for it to come online. |
| Token rejected or command registration fails | Copy a fresh bot token and check that the application ID belongs to the same app. Recreate the bot after editing `.env`. |
| Disallowed intents or close code 4014 | Enable Message Content Intent on the app's Bot page, then restart the bot. |
| Slash commands are missing | Check the `applications.commands` scope, member command permissions, startup logs and `DISCORD_GUILD_ID`. If global commands have not appeared yet, reload Discord and give them time to update. |
| A thread cannot be created or updated | Check the bot's permissions in the parent channel, especially Create Public Threads and Send Messages in Threads. |
| The project card is not pinned | Check Pin Messages. |
| Thread replies are ignored | Check Message Content Intent, member access and the project's Collaboration setting. |
