# Vyne Moderation 🛡️

Vyne is a modern Discord moderation, security and server-management bot built with Discord.js.

## Features

- 🛡️ Moderation — bans, kicks, timeouts, warnings, purges, locks and role management
- ☢️ Security — AutoMod, Anti-Nuke, raid protection and verification
- 🎫 Tickets — free ticket tools with Premium customization
- 👋 Welcome & VoiceMaster — server onboarding and temporary voice channels
- 📊 Analytics & leveling
- 🤖 Optional Gemini-powered AI
- 💰 Economy, giveaways, polls and reminders
- 🚨 Member reports sent privately to the configured staff log channel
- ◆ Premium and ⚡ No-Prefix access systems
- ⚙️ Hosting/deployment controls through Bot-Hosting

## Setup

1. Install dependencies:
   `npm install`
2. Create a `.env` file with the required Discord credentials.
3. Start the bot:
   `npm start`

For AI features, configure `GEMINI_API_KEY`.

## Useful commands

- `/help` — interactive command center
- `/ping` — bot/WebSocket latency
- `/report @user reason` — privately report a member to staff
- `/logchannel #channel` — configure the staff log channel
- `/sys status` — view hosting status

## Development

Run the built-in syntax check with:

```bash
npm test
```

Vyne — moderation, security and server tools in one place.
