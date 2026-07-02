# BeReal Discord Bot

A self-hosted Discord bot that pings your friend group at a random time each day and collects photo
check-ins, mirroring the BeReal mechanic: post within the time limit or get flagged "late." Posts stay
hidden until the deadline, then everything reveals at once. Tracks streaks too.

## How it works

- Once a day, at a random time within a window you configure, the bot posts `@everyone` in your chosen
  channel asking for a photo.
- Friends just attach an image to any message in that channel — no slash command needed.
- After the time limit, the bot reveals everyone's photos together, flags late posts, and updates streaks.
- `/bereal` — manually fire the ping early (good for testing)
- `/status` — see who's posted today
- `/streaks` — leaderboard of current/longest streaks

## 1. Create the Discord bot

1. Go to https://discord.com/developers/applications and click **New Application**. Name it whatever
   you want ("BeReal Bot" works).
2. In the left sidebar, go to **Bot** → click **Reset Token** (or **Add Bot** if it's new) → copy the
   token. This is your `DISCORD_TOKEN`. Keep it secret.
3. On the same Bot page, scroll to **Privileged Gateway Intents** and turn ON **Message Content Intent**.
   The bot needs this to see image attachments.
4. In the left sidebar, go to **OAuth2 → URL Generator**:
   - Scopes: check `bot` and `applications.commands`
   - Bot Permissions: check `Send Messages`, `Read Message History`, `Attach Files`, `Mention Everyone`,
     `Use Slash Commands`, `Add Reactions`
   - Copy the generated URL at the bottom, open it in your browser, and add the bot to your server.
5. Grab your **Application/Client ID** from the **General Information** page → this is `CLIENT_ID`.
6. Get your **Guild ID** (server ID): in Discord, enable Developer Mode (User Settings → Advanced),
   then right-click your server icon → **Copy Server ID**. This is `GUILD_ID`.
7. Get your **Channel ID**: right-click the channel you want the bot posting in → **Copy Channel ID**.
   This is `CHANNEL_ID`.

## 2. Configure environment variables

Copy `.env.example` to `.env` and fill in the values from step 1:

```
cp .env.example .env
```

Adjust `PING_WINDOW_START_HOUR`, `PING_WINDOW_END_HOUR`, `POST_TIME_LIMIT_MINUTES`, and `TIMEZONE`
to taste.

## 3. Install dependencies

```
npm install
```

The bot registers its slash commands (`/bereal`, `/status`, `/streaks`) automatically every time it
starts up, so there's no separate registration step. If `GUILD_ID` is set, commands appear in your
server instantly; without it they're registered globally and can take up to an hour to show up.

(`npm run register` still exists if you ever want to push the commands without starting the bot.)

## 4. Run it locally (to test)

```
npm start
```

Try `/bereal` in your server to trigger an immediate ping without waiting for the random time, then
post a test image and watch it get revealed after the time limit (lower `POST_TIME_LIMIT_MINUTES` to
something small like `2` while testing).

## 5. Deploy to Railway (recommended, free tier works fine)

1. Push this project to a GitHub repo (the `.gitignore` already keeps your `.env` and database out of
   it — don't commit those).
2. Go to https://railway.app, sign in with GitHub, click **New Project → Deploy from GitHub repo**, and
   pick this repo.
3. In the Railway project, go to **Variables** and add every variable from your `.env` file (same
   names, same values) — Railway injects these instead of reading the `.env` file in production.
4. Railway will detect it's a Node app and run `npm start` automatically. Confirm under
   **Settings → Deploy** that the start command is `npm start`.
5. Add a **Volume** mounted at `/app/data` (or wherever your working directory lands) so the SQLite
   database persists across redeploys — without this, streaks reset every time you redeploy.
6. Once deployed, check the logs to confirm `Logged in as YourBot#1234` appears.

That's it — the bot now runs continuously and will ping your server daily at a random time.

## Notes

- The bot stores everything in a local SQLite file (`data/bereal.db`) — no external database needed.
- If the bot restarts mid-day after it already pinged, it won't double-ping (sessions are keyed by
  date), and it re-arms the deadline timer for the existing session on startup.
- Want a smaller friend group only, not the whole server? Replace `@everyone` in `index.js`'s
  `sendPing()` function with a specific role mention like `<@&ROLE_ID>`.
