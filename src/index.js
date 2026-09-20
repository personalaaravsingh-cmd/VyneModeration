require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
  MessageFlags
} = require("discord.js");

const fs = require("fs");
const path = require("path");

// ============================================================
// ENVIRONMENT
// ============================================================

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  BOT_HOSTING_API_KEY,
  VYNE_OWNER_ID
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("❌ Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID.");
  process.exit(1);
}

const HOSTING_API = "https://bot-hosting.net/api/v1";

// ============================================================
// CLIENT
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [
    Partials.Channel,
    Partials.Message
  ]
});

// ============================================================
// STORAGE
// ============================================================

const DATA_DIR = path.join(__dirname, "..", "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const files = {
  config: path.join(DATA_DIR, "config.json"),
  warnings: path.join(DATA_DIR, "warnings.json"),
  cases: path.join(DATA_DIR, "cases.json"),
  levels: path.join(DATA_DIR, "levels.json"),
  economy: path.join(DATA_DIR, "economy.json"),
  reminders: path.join(DATA_DIR, "reminders.json"),
  giveaways: path.join(DATA_DIR, "giveaways.json")
};

for (const file of Object.values(files)) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "{}");
  }
}

function load(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function save(file, data) {
  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2)
  );
}

// ============================================================
// VYNE THEME
// ============================================================

const COLORS = {
  primary: 0x7c5cff,
  success: 0x57f287,
  danger: 0xed4245,
  warning: 0xfee75c,
  info: 0x5865f2,
  dark: 0x18191c
};

const BRAND = "Vyne";

function embed(title, description = "", color = COLORS.primary) {
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name: BRAND
    })
    .setTitle(title)
    .setDescription(description)
    .setTimestamp()
    .setFooter({
      text: "Vyne • Moderation & Community"
    });
}

function success(title, description) {
  return embed(
    `✓ ${title}`,
    description,
    COLORS.success
  );
}

function danger(title, description) {
  return embed(
    `✕ ${title}`,
    description,
    COLORS.danger
  );
}

function warning(title, description) {
  return embed(
    `! ${title}`,
    description,
    COLORS.warning
  );
}

function info(title, description) {
  return embed(
    title,
    description,
    COLORS.primary
  );
}

function truncate(value, length = 1000) {
  const text = String(value ?? "");

  return text.length > length
    ? text.slice(0, length - 3) + "..."
    : text;
}

// ============================================================
// CONFIG
// ============================================================

const DEFAULT_CONFIG = {
  logChannelId: null,
  modRoleId: null,

  automod: {
    enabled: true,
    spam: true,
    links: false,
    invites: true,
    mentions: true,
    duplicates: true,
    caps: false,
    badWords: true,
    emoji: true,

    spamMessages: 6,
    spamWindow: 7000,
    maxMentions: 5,

    blockedWords: [
      "scamword",
      "malicious"
    ],

    timeout: 60000
  },

  raid: {
    enabled: false,
    joinLimit: 8,
    window: 10000,
    accountAge: 86400000
  },

  verification: {
    enabled: false,
    channelId: null,
    roleId: null
  },

  tickets: {
    enabled: false,
    categoryId: null,
    staffRoleId: null
  },

  leveling: {
    enabled: false,
    xpPerMessage: 5
  },

  economy: {
    enabled: false
  },

  notifications: {
    channelId: null
  },

  nextCase: 1
};

function clone(object) {
  return JSON.parse(JSON.stringify(object));
}

function merge(base, override) {
  const result = {
    ...base,
    ...override
  };

  for (const key of Object.keys(base)) {
    if (
      base[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      result[key] = merge(
        base[key],
        override?.[key] || {}
      );
    }
  }

  return result;
}

function getConfig(guildId) {
  const all = load(files.config);

  const config = merge(
    clone(DEFAULT_CONFIG),
    all[guildId] || {}
  );

  all[guildId] = config;

  save(files.config, all);

  return config;
}

function setConfig(guildId, config) {
  const all = load(files.config);

  all[guildId] = config;

  save(files.config, all);
}

// ============================================================
// MODERATION HELPERS
// ============================================================

function isStaff(member) {
  if (!member) return false;

  if (
    member.permissions.has(
      PermissionFlagsBits.Administrator
    ) ||
    member.permissions.has(
      PermissionFlagsBits.ManageGuild
    ) ||
    member.permissions.has(
      PermissionFlagsBits.ManageMessages
    ) ||
    member.permissions.has(
      PermissionFlagsBits.ModerateMembers
    )
  ) {
    return true;
  }

  const config = getConfig(member.guild.id);

  return Boolean(
    config.modRoleId &&
    member.roles.cache.has(config.modRoleId)
  );
}

function hierarchyCheck(
  moderator,
  target,
  botMember
) {
  if (!target) {
    return "That member could not be found.";
  }

  if (target.id === moderator.id) {
    return "You cannot moderate yourself.";
  }

  if (target.id === target.guild.ownerId) {
    return "You cannot moderate the server owner.";
  }

  if (
    moderator.id !== target.guild.ownerId &&
    target.roles.highest.position >=
      moderator.roles.highest.position
  ) {
    return "That member has an equal or higher role.";
  }

  if (
    botMember &&
    target.roles.highest.position >=
      botMember.roles.highest.position
  ) {
    return "My highest role must be above the target.";
  }

  return null;
}

function createCase(guildId, data) {
  const config = getConfig(guildId);

  const id = config.nextCase++;

  setConfig(guildId, config);

  const all = load(files.cases);

  all[guildId] ??= {};

  all[guildId][id] = {
    id,
    ...data,
    createdAt: Date.now()
  };

  save(files.cases, all);

  return id;
}

function getWarnings(guildId, userId) {
  const all = load(files.warnings);

  return all[guildId]?.[userId] || [];
}

function addWarning(guildId, userId, data) {
  const all = load(files.warnings);

  all[guildId] ??= {};
  all[guildId][userId] ??= [];

  all[guildId][userId].push(data);

  save(files.warnings, all);

  return all[guildId][userId];
}

function clearWarnings(guildId, userId) {
  const all = load(files.warnings);

  all[guildId] ??= {};
  all[guildId][userId] = [];

  save(files.warnings, all);
}

// ============================================================
// LOGGING
// ============================================================

async function log(guild, messageEmbed) {
  try {
    const config = getConfig(guild.id);

    if (!config.logChannelId) return;

    const channel = guild.channels.cache.get(
      config.logChannelId
    );

    if (!channel?.isTextBased()) return;

    await channel.send({
      embeds: [messageEmbed]
    });
  } catch (error) {
    console.error(
      "Logging error:",
      error.message
    );
  }
}

async function dm(member, title, description) {
  try {
    await member.send({
      embeds: [
        info(title, description)
      ]
    });
  } catch {}
}

// ============================================================
// DURATION
// ============================================================

function durationMs(input) {
  const match = String(input || "")
    .toLowerCase()
    .trim()
    .match(/^(\d+)(s|m|h|d|w)$/);

  if (!match) return null;

  const multipliers = {
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
    w: 604800000
  };

  return Number(match[1]) *
    multipliers[match[2]];
}

// ============================================================
// BOT HOSTING
// ============================================================

async function hosting(endpoint, options = {}) {
  if (!BOT_HOSTING_API_KEY) {
    throw new Error(
      "BOT_HOSTING_API_KEY is not configured."
    );
  }

  const response = await fetch(
    HOSTING_API + endpoint,
    {
      ...options,
      headers: {
        Authorization:
          `Bearer ${BOT_HOSTING_API_KEY}`,
        "Content-Type":
          "application/json",
        ...(options.headers || {})
      }
    }
  );

  const raw = await response.text();

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    data = {
      raw
    };
  }

  if (!response.ok) {
    let message;

    if (typeof data === "string") {
      message = data;
    } else if (
      typeof data.message === "string"
    ) {
      message = data.message;
    } else if (
      typeof data.error === "string"
    ) {
      message = data.error;
    } else {
      message = JSON.stringify(
        data,
        null,
        2
      );
    }

    throw new Error(
      `Bot-Hosting API ${response.status}\n${message}`
    );
  }

  return data;
}

async function deployment() {
  const result = await hosting(
    `/deployments?name=${encodeURIComponent(
      "Vyne Moderation"
    )}&brief=true`
  );

  const deployments =
    result.deployments || [];

  const found =
    deployments.find(
      x => x.name === "Vyne Moderation"
    ) ||
    deployments[0];

  if (!found) {
    throw new Error(
      "Vyne Moderation deployment was not found."
    );
  }

  return found;
}

// ============================================================
// COMPONENTS
// ============================================================

function helpMenu() {
  return new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("vyne_help")
        .setPlaceholder(
          "Choose a category"
        )
        .addOptions([
          {
            label: "Moderation",
            value: "moderation",
            emoji: "🛡️"
          },
          {
            label: "Security",
            value: "security",
            emoji: "🔐"
          },
          {
            label: "Community",
            value: "community",
            emoji: "🎫"
          },
          {
            label: "Information",
            value: "information",
            emoji: "📊"
          },
          {
            label: "Economy",
            value: "economy",
            emoji: "💰"
          },
          {
            label: "System",
            value: "system",
            emoji: "⚙️"
          }
        ])
    );
}

function automodMenu() {
  return new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("vyne_automod")
        .setPlaceholder(
          "Configure AutoMod"
        )
        .addOptions([
          {
            label: "Master Switch",
            value: "enabled",
            emoji: "🛡️"
          },
          {
            label: "Anti Spam",
            value: "spam",
            emoji: "🚫"
          },
          {
            label: "Anti Links",
            value: "links",
            emoji: "🔗"
          },
          {
            label: "Anti Invites",
            value: "invites",
            emoji: "📨"
          },
          {
            label: "Mention Protection",
            value: "mentions",
            emoji: "📢"
          },
          {
            label: "Duplicate Messages",
            value: "duplicates",
            emoji: "📋"
          },
          {
            label: "Bad Words",
            value: "badWords",
            emoji: "🤬"
          }
        ])
    );
}

function ticketButton() {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          "vyne_ticket_create"
        )
        .setLabel("Create Ticket")
        .setEmoji("🎫")
        .setStyle(
          ButtonStyle.Primary
        )
    );
}

function verifyButton() {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          "vyne_verify"
        )
        .setLabel("Verify")
        .setEmoji("✓")
        .setStyle(
          ButtonStyle.Success
        )
    );
}

function closeTicketButton() {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          "vyne_ticket_close"
        )
        .setLabel("Close Ticket")
        .setEmoji("🔒")
        .setStyle(
          ButtonStyle.Danger
        )
    );
}

// ============================================================
// COMMANDS
// ============================================================

const commands = [

  // ---------------- MODERATION ----------------

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Member")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason")
        .setDescription("Reason")
    ),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a user")
    .addStringOption(o =>
      o.setName("user_id")
        .setDescription("User ID")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason")
        .setDescription("Reason")
    ),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Member")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason")
        .setDescription("Reason")
    ),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a member")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Member")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("duration")
        .setDescription("10m, 1h, 1d")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason")
        .setDescription("Reason")
    ),

  new SlashCommandBuilder()
    .setName("untimeout")
    .setDescription("Remove a timeout")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Member")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Member")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason")
        .setDescription("Reason")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("View member warnings")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Member")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("clearwarnings")
    .setDescription("Clear member warnings")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Member")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete messages")
    .addIntegerOption(o =>
      o.setName("amount")
        .setDescription("1-100")
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Lock this channel"),

  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlock this channel"),

  new SlashCommandBuilder()
    .setName("slowmode")
    .setDescription("Set slowmode")
    .addIntegerOption(o =>
      o.setName("seconds")
        .setDescription("0-21600")
        .setMinValue(0)
        .setMaxValue(21600)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("nick")
    .setDescription("Change a member nickname")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Member")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("nickname")
        .setDescription("Nickname")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("role")
    .setDescription("Manage roles")
    .addSubcommand(s =>
      s.setName("add")
        .setDescription("Add a role")
        .addUserOption(o =>
          o.setName("user")
            .setDescription("Member")
            .setRequired(true)
        )
        .addRoleOption(o =>
          o.setName("role")
            .setDescription("Role")
            .setRequired(true)
        )
    )
    .addSubcommand(s =>
      s.setName("remove")
        .setDescription("Remove a role")
        .addUserOption(o =>
          o.setName("user")
            .setDescription("Member")
            .setRequired(true)
        )
        .addRoleOption(o =>
          o.setName("role")
            .setDescription("Role")
            .setRequired(true)
        )
    )
    .addSubcommand(s =>
      s.setName("create")
        .setDescription("Create a role")
        .addStringOption(o =>
          o.setName("name")
            .setDescription("Role name")
            .setRequired(true)
        )
    ),

  // ---------------- INFORMATION ----------------

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Open the Vyne help center"),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Show bot latency"),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("View user information")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("User")
    ),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("View server information"),

  new SlashCommandBuilder()
    .setName("channelinfo")
    .setDescription("View channel information"),

  new SlashCommandBuilder()
    .setName("roleinfo")
    .setDescription("View role information")
    .addRoleOption(o =>
      o.setName("role")
        .setDescription("Role")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("View a user's avatar")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("User")
    ),

  // ---------------- SECURITY ----------------

  new SlashCommandBuilder()
    .setName("automod")
    .setDescription("Open AutoMod controls"),

  new SlashCommandBuilder()
    .setName("raid")
    .setDescription("Manage raid protection")
    .addSubcommand(s =>
      s.setName("on")
        .setDescription("Enable")
    )
    .addSubcommand(s =>
      s.setName("off")
        .setDescription("Disable")
    )
    .addSubcommand(s =>
      s.setName("status")
        .setDescription("View status")
    ),

  new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Manage verification")
    .addSubcommand(s =>
      s.setName("setup")
        .setDescription("Create verification panel")
        .addChannelOption(o =>
          o.setName("channel")
            .setDescription("Panel channel")
            .addChannelTypes(
              ChannelType.GuildText
            )
            .setRequired(true)
        )
        .addRoleOption(o =>
          o.setName("role")
            .setDescription("Verified role")
            .setRequired(true)
        )
    )
    .addSubcommand(s =>
      s.setName("disable")
        .setDescription("Disable verification")
    ),

  // ---------------- COMMUNITY ----------------

  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Manage tickets")
    .addSubcommand(s =>
      s.setName("setup")
        .setDescription("Configure tickets")
        .addRoleOption(o =>
          o.setName("staff_role")
            .setDescription("Staff role")
            .setRequired(true)
        )
        .addChannelOption(o =>
          o.setName("category")
            .setDescription("Ticket category")
            .addChannelTypes(
              ChannelType.GuildCategory
            )
            .setRequired(true)
        )
    )
    .addSubcommand(s =>
      s.setName("panel")
        .setDescription("Send ticket panel")
    )
    .addSubcommand(s =>
      s.setName("close")
        .setDescription("Close current ticket")
    ),

  new SlashCommandBuilder()
    .setName("remind")
    .setDescription("Create a reminder")
    .addStringOption(o =>
      o.setName("duration")
        .setDescription("10m, 1h, 1d")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("text")
        .setDescription("Reminder")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Create an announcement")
    .addStringOption(o =>
      o.setName("message")
        .setDescription("Announcement")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Manage giveaways")
    .addSubcommand(s =>
      s.setName("start")
        .setDescription("Start giveaway")
        .addIntegerOption(o =>
          o.setName("minutes")
            .setDescription("Duration")
            .setMinValue(1)
            .setRequired(true)
        )
        .addStringOption(o =>
          o.setName("prize")
            .setDescription("Prize")
            .setRequired(true)
        )
    ),

  // ---------------- ECONOMY ----------------

  new SlashCommandBuilder()
    .setName("balance")
    .setDescription("View balance")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("User")
    ),

  new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Claim your daily reward"),

  new SlashCommandBuilder()
    .setName("pay")
    .setDescription("Pay another member")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("User")
        .setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName("amount")
        .setDescription("Amount")
        .setMinValue(1)
        .setRequired(true)
    ),

  // ---------------- LEVELING ----------------

  new SlashCommandBuilder()
    .setName("level")
    .setDescription("View a user's level")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("User")
    ),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("View the XP leaderboard"),

  // ---------------- CONFIG ----------------

  new SlashCommandBuilder()
    .setName("config")
    .setDescription("View server configuration"),

  new SlashCommandBuilder()
    .setName("logchannel")
    .setDescription("Set moderation log channel")
    .addChannelOption(o =>
      o.setName("channel")
        .setDescription("Channel")
        .addChannelTypes(
          ChannelType.GuildText
        )
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("modrole")
    .setDescription("Set moderator role")
    .addRoleOption(o =>
      o.setName("role")
        .setDescription("Role")
        .setRequired(true)
    ),

  // ---------------- SYSTEM ----------------

  new SlashCommandBuilder()
    .setName("sys")
    .setDescription("Vyne system controls")
    .addSubcommand(s =>
      s.setName("pull")
        .setDescription("Pull latest GitHub code")
    )
    .addSubcommand(s =>
      s.setName("restart")
        .setDescription("Restart the deployment")
    )
    .addSubcommand(s =>
      s.setName("status")
        .setDescription("View deployment status")
    )
    .addSubcommand(s =>
      s.setName("logs")
        .setDescription("View deployment logs")
    )
    .addSubcommand(s =>
      s.setName("info")
        .setDescription("View deployment information")
    )

].map(command => command.toJSON());

// ============================================================
// HELP PAGES
// ============================================================

const HELP_PAGES = {
  moderation: {
    title: "Moderation",
    description:
      "Tools for keeping your server clean and manageable.",
    commands: [
      "`/ban` — Ban a member",
      "`/unban` — Unban a user",
      "`/kick` — Kick a member",
      "`/timeout` — Timeout a member",
      "`/untimeout` — Remove timeout",
      "`/warn` — Warn a member",
      "`/warnings` — View warnings",
      "`/clearwarnings` — Clear warnings",
      "`/purge` — Delete messages",
      "`/lock` — Lock a channel",
      "`/unlock` — Unlock a channel",
      "`/slowmode` — Configure slowmode",
      "`/nick` — Change nickname",
      "`/role` — Manage roles"
    ]
  },

  security: {
    title: "Security",
    description:
      "Protection systems for your community.",
    commands: [
      "`/automod` — AutoMod dashboard",
      "`/raid` — Raid protection",
      "`/verify` — Verification system",
      "Anti-spam",
      "Anti-invite",
      "Mention protection",
      "Duplicate message detection"
    ]
  },

  community: {
    title: "Community",
    description:
      "Tools for running your community.",
    commands: [
      "`/ticket` — Ticket system",
      "`/giveaway` — Giveaways",
      "`/announce` — Announcements",
      "`/remind` — Reminders"
    ]
  },

  information: {
    title: "Information",
    description:
      "Useful server and member information.",
    commands: [
      "`/userinfo`",
      "`/serverinfo`",
      "`/channelinfo`",
      "`/roleinfo`",
      "`/avatar`",
      "`/ping`"
    ]
  },

  economy: {
    title: "Economy & Levels",
    description:
      "Community progression and economy.",
    commands: [
      "`/balance` — View balance",
      "`/daily` — Daily reward",
      "`/pay` — Transfer coins",
      "`/level` — View level",
      "`/leaderboard` — XP leaderboard"
    ]
  },

  system: {
    title: "System",
    description:
      "Owner-only deployment controls.",
    commands: [
      "`/sys pull` — Pull GitHub changes",
      "`/sys restart` — Restart deployment",
      "`/sys status` — Deployment status",
      "`/sys logs` — Deployment logs",
      "`/sys info` — Deployment information"
    ]
  }
};

// ============================================================
// INTERACTION HANDLER
// ============================================================

client.on(
  "interactionCreate",
  async interaction => {

    try {

      // ======================================================
      // SELECT MENUS
      // ======================================================

      if (
        interaction.isStringSelectMenu()
      ) {

        // ---------------- HELP ----------------

        if (
          interaction.customId ===
          "vyne_help"
        ) {

          const page =
            HELP_PAGES[
              interaction.values[0]
            ];

          if (!page) return;

          return interaction.update({
            embeds: [
              embed(
                `Vyne • ${page.title}`,
                `${page.description}\n\n${page.commands.join("\n")}`
              )
            ],
            components: [
              helpMenu()
            ]
          });
        }

        // ---------------- AUTOMOD ----------------

        if (
          interaction.customId ===
          "vyne_automod"
        ) {

          if (
            !isStaff(
              interaction.member
            )
          ) {
            return interaction.reply({
              embeds: [
                danger(
                  "Permission Denied",
                  "You need moderation permissions to change AutoMod."
                )
              ],
              flags:
                MessageFlags.Ephemeral
            });
          }

          const config =
            getConfig(
              interaction.guild.id
            );

          const option =
            interaction.values[0];

          if (
            option === "enabled"
          ) {
            config.automod.enabled =
              !config.automod.enabled;
          }

          if (
            option === "spam"
          ) {
            config.automod.spam =
              !config.automod.spam;
          }

          if (
            option === "links"
          ) {
            config.automod.links =
              !config.automod.links;
          }

          if (
            option === "invites"
          ) {
            config.automod.invites =
              !config.automod.invites;
          }

          if (
            option === "mentions"
          ) {
            config.automod.mentions =
              !config.automod.mentions;
          }

          if (
            option === "duplicates"
          ) {
            config.automod.duplicates =
              !config.automod.duplicates;
          }

          if (
            option === "badWords"
          ) {
            config.automod.badWords =
              !config.automod.badWords;
          }

          setConfig(
            interaction.guild.id,
            config
          );

          return interaction.update({
            embeds: [
              automodEmbed(
                interaction.guild.id
              )
            ],
            components: [
              automodMenu()
            ]
          });
        }

        return;
      }

      // ======================================================
      // BUTTONS
      // ======================================================

      if (
        interaction.isButton()
      ) {

        // ---------------- VERIFY ----------------

        if (
          interaction.customId ===
          "vyne_verify"
        ) {

          const config =
            getConfig(
              interaction.guild.id
            );

          if (
            !config.verification.enabled ||
            !config.verification.roleId
          ) {
            return interaction.reply({
              embeds: [
                danger(
                  "Verification Unavailable",
                  "Verification is currently disabled."
                )
              ],
              flags:
                MessageFlags.Ephemeral
            });
          }

          const role =
            interaction.guild.roles.cache.get(
              config.verification.roleId
            );

          if (!role) {
            return interaction.reply({
              embeds: [
                danger(
                  "Configuration Error",
                  "The verification role no longer exists."
                )
              ],
              flags:
                MessageFlags.Ephemeral
            });
          }

          if (
            interaction.member.roles.cache.has(
              role.id
            )
          ) {
            return interaction.reply({
              embeds: [
                info(
                  "Already Verified",
                  "You already have access."
                )
              ],
              flags:
                MessageFlags.Ephemeral
            });
          }

          await interaction.member.roles.add(
            role,
            "Vyne verification"
          );

          return interaction.reply({
            embeds: [
              success(
                "Verification Complete",
                `You have been given ${role}.`
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        // ---------------- TICKET ----------------

        if (
          interaction.customId ===
          "vyne_ticket_create"
        ) {

          const config =
            getConfig(
              interaction.guild.id
            );

          if (
            !config.tickets.enabled ||
            !config.tickets.categoryId ||
            !config.tickets.staffRoleId
          ) {
            return interaction.reply({
              embeds: [
                danger(
                  "Tickets Disabled",
                  "The ticket system has not been configured."
                )
              ],
              flags:
                MessageFlags.Ephemeral
            });
          }

          const existing =
            interaction.guild.channels.cache.find(
              channel =>
                channel.type ===
                  ChannelType.GuildText &&
                channel.topic ===
                  `vyne-ticket:${interaction.user.id}`
            );

          if (existing) {
            return interaction.reply({
              embeds: [
                info(
                  "Ticket Already Open",
                  `You already have ${existing}.`
                )
              ],
              flags:
                MessageFlags.Ephemeral
            });
          }

          const channel =
            await interaction.guild.channels.create({
              name:
                `ticket-${interaction.user.username}`
                  .toLowerCase()
                  .replace(/[^a-z0-9-]/g, "")
                  .slice(0, 80),

              type:
                ChannelType.GuildText,

              parent:
                config.tickets.categoryId,

              topic:
                `vyne-ticket:${interaction.user.id}`,

              permissionOverwrites: [
                {
                  id:
                    interaction.guild
                      .roles.everyone.id,

                  deny: [
                    PermissionFlagsBits.ViewChannel
                  ]
                },

                {
                  id:
                    interaction.user.id,

                  allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory
                  ]
                },

                {
                  id:
                    config.tickets.staffRoleId,

                  allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.ManageMessages
                  ]
                }
              ]
            });

          await channel.send({
            content:
              `${interaction.user} <@&${config.tickets.staffRoleId}>`,

            embeds: [
              embed(
                "Support Ticket",
                "Thanks for contacting the staff team.\n\nPlease explain your issue clearly and someone will assist you shortly."
              )
            ],

            components: [
              closeTicketButton()
            ]
          });

          return interaction.reply({
            embeds: [
              success(
                "Ticket Created",
                `Your ticket is ${channel}.`
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        // ---------------- CLOSE TICKET ----------------

        if (
          interaction.customId ===
          "vyne_ticket_close"
        ) {

          if (
            !interaction.channel?.name?.startsWith(
              "ticket-"
            )
          ) {
            return interaction.reply({
              embeds: [
                danger(
                  "Invalid Channel",
                  "This is not a Vyne ticket."
                )
              ],
              flags:
                MessageFlags.Ephemeral
            });
          }

          await interaction.reply({
            embeds: [
              success(
                "Ticket Closed",
                "This ticket will be deleted in 5 seconds."
              )
            ]
          });

          setTimeout(() => {
            interaction.channel
              ?.delete()
              .catch(() => {});
          }, 5000);

          return;
        }

        return;
      }

      // ======================================================
      // CHAT COMMANDS
      // ======================================================

      if (
        !interaction.isChatInputCommand()
      ) {
        return;
      }

      const command =
        interaction.commandName;

      // ======================================================
      // HELP
      // ======================================================

      if (
        command === "help"
      ) {

        return interaction.reply({
          embeds: [
            embed(
              "Vyne • Help Center",
              "Everything you need to manage your community.\n\n**Select a category below to explore commands.**"
            )
          ],
          components: [
            helpMenu()
          ]
        });
      }

      // ======================================================
      // PING
      // ======================================================

      if (
        command === "ping"
      ) {

        return interaction.reply({
          embeds: [
            embed(
              "Vyne • System",
              [
                `**Gateway**  \`${client.ws.ping}ms\``,
                `**Response**  \`${Date.now() - interaction.createdTimestamp}ms\``,
                "",
                "Everything is operational."
              ].join("\n"),
              COLORS.success
            )
          ]
        });
      }

      // ======================================================
      // MODERATION PERMISSION
      // ======================================================

      const staffCommands = [
        "ban",
        "unban",
        "kick",
        "timeout",
        "untimeout",
        "warn",
        "clearwarnings",
        "purge",
        "lock",
        "unlock",
        "slowmode",
        "nick",
        "role",
        "automod",
        "raid",
        "verify",
        "ticket",
        "announce",
        "giveaway",
        "logchannel",
        "modrole"
      ];

      if (
        staffCommands.includes(
          command
        ) &&
        !isStaff(
          interaction.member
        )
      ) {
        return interaction.reply({
          embeds: [
            danger(
              "Permission Denied",
              "You need the required moderation permissions to use this command."
            )
          ],
          flags:
            MessageFlags.Ephemeral
        });
      }

      // ======================================================
      // BAN
      // ======================================================

      if (
        command === "ban"
      ) {

        const user =
          interaction.options.getUser(
            "user"
          );

        const reason =
          interaction.options.getString(
            "reason"
          ) ||
          "No reason provided.";

        const member =
          await interaction.guild.members
            .fetch(user.id)
            .catch(() => null);

        const hierarchy =
          hierarchyCheck(
            interaction.member,
            member,
            interaction.guild.members.me
          );

        if (hierarchy) {
          return interaction.reply({
            embeds: [
              danger(
                "Cannot Ban",
                hierarchy
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        const caseId =
          createCase(
            interaction.guild.id,
            {
              type: "BAN",
              userId: user.id,
              moderatorId:
                interaction.user.id,
              reason
            }
          );

        await dm(
          member,
          "You were banned",
          `You were banned from **${interaction.guild.name}**.\n\n**Reason**\n${reason}\n\n**Case** \`#${caseId}\``
        );

        await member.ban({
          reason:
            `Case #${caseId}: ${reason}`
        });

        await log(
          interaction.guild,
          danger(
            "Member Banned",
            [
              `**User** ${user}`,
              `**Moderator** ${interaction.user}`,
              `**Reason** ${reason}`,
              `**Case** \`#${caseId}\``
            ].join("\n")
          )
        );

        return interaction.reply({
          embeds: [
            success(
              "Member Banned",
              [
                `**User** ${user}`,
                `**Reason** ${reason}`,
                `**Case** \`#${caseId}\``
              ].join("\n")
            )
          ]
        });
      }

      // ======================================================
      // UNBAN
      // ======================================================

      if (
        command === "unban"
      ) {

        const userId =
          interaction.options.getString(
            "user_id"
          );

        const reason =
          interaction.options.getString(
            "reason"
          ) ||
          "No reason provided.";

        const caseId =
          createCase(
            interaction.guild.id,
            {
              type: "UNBAN",
              userId,
              moderatorId:
                interaction.user.id,
              reason
            }
          );

        await interaction.guild.members.unban(
          userId,
          `Case #${caseId}: ${reason}`
        );

        return interaction.reply({
          embeds: [
            success(
              "User Unbanned",
              [
                `**User ID** \`${userId}\``,
                `**Reason** ${reason}`,
                `**Case** \`#${caseId}\``
              ].join("\n")
            )
          ]
        });
      }

      // ======================================================
      // KICK
      // ======================================================

      if (
        command === "kick"
      ) {

        const user =
          interaction.options.getUser(
            "user"
          );

        const reason =
          interaction.options.getString(
            "reason"
          ) ||
          "No reason provided.";

        const member =
          await interaction.guild.members
            .fetch(user.id)
            .catch(() => null);

        const hierarchy =
          hierarchyCheck(
            interaction.member,
            member,
            interaction.guild.members.me
          );

        if (hierarchy) {
          return interaction.reply({
            embeds: [
              danger(
                "Cannot Kick",
                hierarchy
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        const caseId =
          createCase(
            interaction.guild.id,
            {
              type: "KICK",
              userId: user.id,
              moderatorId:
                interaction.user.id,
              reason
            }
          );

        await dm(
          member,
          "You were kicked",
          `You were kicked from **${interaction.guild.name}**.\n\n**Reason** ${reason}\n**Case** \`#${caseId}\``
        );

        await member.kick(
          `Case #${caseId}: ${reason}`
        );

        return interaction.reply({
          embeds: [
            success(
              "Member Kicked",
              `${user} has been removed.\n\n**Case** \`#${caseId}\``
            )
          ]
        });
      }

      // ======================================================
      // TIMEOUT
      // ======================================================

      if (
        command === "timeout"
      ) {

        const user =
          interaction.options.getUser(
            "user"
          );

        const duration =
          interaction.options.getString(
            "duration"
          );

        const reason =
          interaction.options.getString(
            "reason"
          ) ||
          "No reason provided.";

        const milliseconds =
          durationMs(duration);

        if (
          !milliseconds ||
          milliseconds >
            28 * 86400000
        ) {
          return interaction.reply({
            embeds: [
              danger(
                "Invalid Duration",
                "Use values such as `10m`, `1h`, `1d`. Maximum is 28 days."
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        const member =
          await interaction.guild.members
            .fetch(user.id)
            .catch(() => null);

        const hierarchy =
          hierarchyCheck(
            interaction.member,
            member,
            interaction.guild.members.me
          );

        if (hierarchy) {
          return interaction.reply({
            embeds: [
              danger(
                "Cannot Timeout",
                hierarchy
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        const caseId =
          createCase(
            interaction.guild.id,
            {
              type: "TIMEOUT",
              userId: user.id,
              moderatorId:
                interaction.user.id,
              reason,
              duration
            }
          );

        await member.timeout(
          milliseconds,
          `Case #${caseId}: ${reason}`
        );

        await dm(
          member,
          "You were timed out",
          `**Duration** ${duration}\n**Reason** ${reason}\n**Case** \`#${caseId}\``
        );

        return interaction.reply({
          embeds: [
            success(
              "Member Timed Out",
              [
                `**User** ${user}`,
                `**Duration** ${duration}`,
                `**Reason** ${reason}`,
                `**Case** \`#${caseId}\``
              ].join("\n")
            )
          ]
        });
      }

      // ======================================================
      // UNTIMEOUT
      // ======================================================

      if (
        command === "untimeout"
      ) {

        const user =
          interaction.options.getUser(
            "user"
          );

        const member =
          await interaction.guild.members
            .fetch(user.id)
            .catch(() => null);

        const hierarchy =
          hierarchyCheck(
            interaction.member,
            member,
            interaction.guild.members.me
          );

        if (hierarchy) {
          return interaction.reply({
            embeds: [
              danger(
                "Cannot Remove Timeout",
                hierarchy
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        await member.timeout(
          null,
          `Removed by ${interaction.user.tag}`
        );

        return interaction.reply({
          embeds: [
            success(
              "Timeout Removed",
              `${user} can speak again.`
            )
          ]
        });
      }

      // ======================================================
      // WARN
      // ======================================================

      if (
        command === "warn"
      ) {

        const user =
          interaction.options.getUser(
            "user"
          );

        const reason =
          interaction.options.getString(
            "reason"
          );

        const member =
          await interaction.guild.members
            .fetch(user.id)
            .catch(() => null);

        const hierarchy =
          hierarchyCheck(
            interaction.member,
            member,
            interaction.guild.members.me
          );

        if (hierarchy) {
          return interaction.reply({
            embeds: [
              danger(
                "Cannot Warn",
                hierarchy
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        const warnings =
          addWarning(
            interaction.guild.id,
            user.id,
            {
              moderatorId:
                interaction.user.id,
              reason,
              createdAt:
                Date.now()
            }
          );

        const caseId =
          createCase(
            interaction.guild.id,
            {
              type: "WARN",
              userId: user.id,
              moderatorId:
                interaction.user.id,
              reason
            }
          );

        const config =
          getConfig(
            interaction.guild.id
          );

        if (
          warnings.length >=
          3
        ) {
          await member.timeout(
            config.automod.timeout,
            "Automatic warning escalation"
          ).catch(() => {});
        }

        await dm(
          member,
          "Warning issued",
          `**Reason** ${reason}\n**Warnings** ${warnings.length}\n**Case** \`#${caseId}\``
        );

        return interaction.reply({
          embeds: [
            warning(
              "Warning Issued",
              [
                `**User** ${user}`,
                `**Reason** ${reason}`,
                `**Warnings** ${warnings.length}`,
                `**Case** \`#${caseId}\``
              ].join("\n")
            )
          ]
        });
      }

      // ======================================================
      // WARNINGS
      // ======================================================

      if (
        command === "warnings"
      ) {

        const user =
          interaction.options.getUser(
            "user"
          );

        const warnings =
          getWarnings(
            interaction.guild.id,
            user.id
          );

        if (!warnings.length) {
          return interaction.reply({
            embeds: [
              info(
                "Warnings",
                `${user} has no recorded warnings.`
              )
            ]
          });
        }

        const text =
          warnings
            .slice(-10)
            .map(
              (w, i) =>
                `**${i + 1}.** ${truncate(w.reason, 180)}\n> Moderator <@${w.moderatorId}>`
            )
            .join("\n\n");

        return interaction.reply({
          embeds: [
            warning(
              `${user.username} • Warnings`,
              text
            )
          ]
        });
      }

      // ======================================================
      // CLEAR WARNINGS
      // ======================================================

      if (
        command === "clearwarnings"
      ) {

        const user =
          interaction.options.getUser(
            "user"
          );

        clearWarnings(
          interaction.guild.id,
          user.id
        );

        return interaction.reply({
          embeds: [
            success(
              "Warnings Cleared",
              `All warnings for ${user} have been cleared.`
            )
          ]
        });
      }

      // ======================================================
      // PURGE
      // ======================================================

      if (
        command === "purge"
      ) {

        const amount =
          interaction.options.getInteger(
            "amount"
          );

        if (
          !interaction.channel?.isTextBased()
        ) {
          return interaction.reply({
            embeds: [
              danger(
                "Invalid Channel",
                "This command requires a text channel."
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        const messages =
          await interaction.channel.bulkDelete(
            amount,
            true
          );

        return interaction.reply({
          embeds: [
            success(
              "Messages Purged",
              `Deleted **${messages.size}** messages.`
            )
          ],
          flags:
            MessageFlags.Ephemeral
        });
      }

      // ======================================================
      // LOCK / UNLOCK
      // ======================================================

      if (
        command === "lock" ||
        command === "unlock"
      ) {

        const locked =
          command === "lock";

        await interaction.channel
          .permissionOverwrites.edit(
            interaction.guild.roles.everyone,
            {
              SendMessages:
                !locked
            }
          );

        return interaction.reply({
          embeds: [
            success(
              locked
                ? "Channel Locked"
                : "Channel Unlocked",
              locked
                ? "Members can no longer send messages here."
                : "Members can send messages again."
            )
          ]
        });
      }

      // ======================================================
      // SLOWMODE
      // ======================================================

      if (
        command === "slowmode"
      ) {

        const seconds =
          interaction.options.getInteger(
            "seconds"
          );

        await interaction.channel.setRateLimitPerUser(
          seconds
        );

        return interaction.reply({
          embeds: [
            success(
              "Slowmode Updated",
              seconds === 0
                ? "Slowmode has been disabled."
                : `Slowmode is now **${seconds}s**.`
            )
          ]
        });
      }

      // ======================================================
      // NICK
      // ======================================================

      if (
        command === "nick"
      ) {

        const user =
          interaction.options.getUser(
            "user"
          );

        const nickname =
          interaction.options.getString(
            "nickname"
          );

        const member =
          await interaction.guild.members
            .fetch(user.id);

        const hierarchy =
          hierarchyCheck(
            interaction.member,
            member,
            interaction.guild.members.me
          );

        if (hierarchy) {
          return interaction.reply({
            embeds: [
              danger(
                "Cannot Change Nickname",
                hierarchy
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        await member.setNickname(
          nickname
        );

        return interaction.reply({
          embeds: [
            success(
              "Nickname Updated",
              `${user}'s nickname is now **${nickname}**.`
            )
          ]
        });
      }

      // ======================================================
      // ROLE
      // ======================================================

      if (
        command === "role"
      ) {

        const sub =
          interaction.options.getSubcommand();

        if (
          sub === "create"
        ) {

          const name =
            interaction.options.getString(
              "name"
            );

          const role =
            await interaction.guild.roles.create({
              name,
              reason:
                `Created by ${interaction.user.tag}`
            });

          return interaction.reply({
            embeds: [
              success(
                "Role Created",
                `Created ${role}.`
              )
            ]
          });
        }

        const user =
          interaction.options.getUser(
            "user"
          );

        const role =
          interaction.options.getRole(
            "role"
          );

        const member =
          await interaction.guild.members
            .fetch(user.id);

        if (
          role.position >=
            interaction.guild.members.me
              .roles.highest.position
        ) {
          return interaction.reply({
            embeds: [
              danger(
                "Cannot Manage Role",
                "That role is above my highest role."
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        if (
          interaction.user.id !==
            interaction.guild.ownerId &&
          role.position >=
            interaction.member.roles
              .highest.position
        ) {
          return interaction.reply({
            embeds: [
              danger(
                "Cannot Manage Role",
                "That role is equal to or higher than your highest role."
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        if (
          sub === "add"
        ) {
          await member.roles.add(
            role
          );
        } else {
          await member.roles.remove(
            role
          );
        }

        return interaction.reply({
          embeds: [
            success(
              "Role Updated",
              `${role} was ${sub === "add" ? "added to" : "removed from"} ${user}.`
            )
          ]
        });
      }

      // ======================================================
      // USER INFO
      // ======================================================

      if (
        command === "userinfo"
      ) {

        const user =
          interaction.options.getUser(
            "user"
          ) ||
          interaction.user;

        const member =
          await interaction.guild.members
            .fetch(user.id)
            .catch(() => null);

        const userEmbed =
          embed(
            `User • ${user.username}`,
            [
              `**ID** \`${user.id}\``,
              `**Created** <t:${Math.floor(user.createdTimestamp / 1000)}:R>`,
              member
                ? `**Joined** <t:${Math.floor(member.joinedTimestamp / 1000)}:R>`
                : "**Member** Not in server"
            ].join("\n")
          )
          .setThumbnail(
            user.displayAvatarURL({
              size: 512
            })
          );

        if (member) {
          userEmbed.addFields({
            name: "Roles",
            value:
              member.roles.cache
                .filter(
                  role =>
                    role.id !==
                    interaction.guild.id
                )
                .map(role => role.toString())
                .slice(0, 15)
                .join(" ") ||
              "None"
          });
        }

        return interaction.reply({
          embeds: [
            userEmbed
          ]
        });
      }

      // ======================================================
      // SERVER INFO
      // ======================================================

      if (
        command === "serverinfo"
      ) {

        const guild =
          interaction.guild;

        return interaction.reply({
          embeds: [
            embed(
              `Server • ${guild.name}`,
              [
                `**Owner** <@${guild.ownerId}>`,
                `**Members** ${guild.memberCount}`,
                `**Channels** ${guild.channels.cache.size}`,
                `**Roles** ${guild.roles.cache.size}`,
                `**Created** <t:${Math.floor(guild.createdTimestamp / 1000)}:R>`
              ].join("\n")
            )
              .setThumbnail(
                guild.iconURL({
                  size: 512
                }) || null
              )
          ]
        });
      }

      // ======================================================
      // CHANNEL INFO
      // ======================================================

      if (
        command === "channelinfo"
      ) {

        const channel =
          interaction.channel;

        return interaction.reply({
          embeds: [
            embed(
              `Channel • #${channel.name}`,
              [
                `**ID** \`${channel.id}\``,
                `**Type** ${channel.type}`,
                `**Created** <t:${Math.floor(channel.createdTimestamp / 1000)}:R>`
              ].join("\n")
            )
          ]
        });
      }

      // ======================================================
      // ROLE INFO
      // ======================================================

      if (
        command === "roleinfo"
      ) {

        const role =
          interaction.options.getRole(
            "role"
          );

        return interaction.reply({
          embeds: [
            embed(
              `Role • ${role.name}`,
              [
                `**ID** \`${role.id}\``,
                `**Position** ${role.position}`,
                `**Members** ${role.members.size}`,
                `**Mentionable** ${role.mentionable}`,
                `**Managed** ${role.managed}`
              ].join("\n")
            )
          ]
        });
      }

      // ======================================================
      // AVATAR
      // ======================================================

      if (
        command === "avatar"
      ) {

        const user =
          interaction.options.getUser(
            "user"
          ) ||
          interaction.user;

        return interaction.reply({
          embeds: [
            embed(
              `${user.username} • Avatar`
            )
              .setImage(
                user.displayAvatarURL({
                  size: 1024
                })
              )
          ]
        });
      }

      // ======================================================
      // AUTOMOD
      // ======================================================

      if (
        command === "automod"
      ) {

        return interaction.reply({
          embeds: [
            automodEmbed(
              interaction.guild.id
            )
          ],
          components: [
            automodMenu()
          ]
        });
      }

      // ======================================================
      // RAID
      // ======================================================

      if (
        command === "raid"
      ) {

        const config =
          getConfig(
            interaction.guild.id
          );

        const sub =
          interaction.options.getSubcommand();

        if (
          sub === "on"
        ) {
          config.raid.enabled =
            true;
        }

        if (
          sub === "off"
        ) {
          config.raid.enabled =
            false;
        }

        setConfig(
          interaction.guild.id,
          config
        );

        return interaction.reply({
          embeds: [
            info(
              "Raid Protection",
              `Status: **${config.raid.enabled ? "Enabled" : "Disabled"}**`
            )
          ]
        });
      }

      // ======================================================
      // VERIFICATION
      // ======================================================

      if (
        command === "verify"
      ) {

        const sub =
          interaction.options.getSubcommand();

        const config =
          getConfig(
            interaction.guild.id
          );

        if (
          sub === "disable"
        ) {

          config.verification.enabled =
            false;

          setConfig(
            interaction.guild.id,
            config
          );

          return interaction.reply({
            embeds: [
              success(
                "Verification Disabled",
                "The verification system has been disabled."
              )
            ]
          });
        }

        const channel =
          interaction.options.getChannel(
            "channel"
          );

        const role =
          interaction.options.getRole(
            "role"
          );

        config.verification.enabled =
          true;

        config.verification.channelId =
          channel.id;

        config.verification.roleId =
          role.id;

        setConfig(
          interaction.guild.id,
          config
        );

        await channel.send({
          embeds: [
            embed(
              "Server Verification",
              "Click the button below to verify your account and receive access."
            )
          ],
          components: [
            verifyButton()
          ]
        });

        return interaction.reply({
          embeds: [
            success(
              "Verification Ready",
              `The verification panel has been sent to ${channel}.`
            )
          ]
        });
      }

      // ======================================================
      // TICKETS
      // ======================================================

      if (
        command === "ticket"
      ) {

        const sub =
          interaction.options.getSubcommand();

        const config =
          getConfig(
            interaction.guild.id
          );

        if (
          sub === "setup"
        ) {

          const staffRole =
            interaction.options.getRole(
              "staff_role"
            );

          const category =
            interaction.options.getChannel(
              "category"
            );

          config.tickets.enabled =
            true;

          config.tickets.staffRoleId =
            staffRole.id;

          config.tickets.categoryId =
            category.id;

          setConfig(
            interaction.guild.id,
            config
          );

          return interaction.reply({
            embeds: [
              success(
                "Ticket System Ready",
                [
                  `**Staff** ${staffRole}`,
                  `**Category** ${category}`
                ].join("\n")
              )
            ]
          });
        }

        if (
          sub === "panel"
        ) {

          await interaction.channel.send({
            embeds: [
              embed(
                "Support Center",
                "Need help? Open a private ticket and our staff team will assist you."
              )
            ],
            components: [
              ticketButton()
            ]
          });

          return interaction.reply({
            embeds: [
              success(
                "Panel Sent",
                "The ticket panel is now active."
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        if (
          sub === "close"
        ) {

          if (
            !interaction.channel.name.startsWith(
              "ticket-"
            )
          ) {
            return interaction.reply({
              embeds: [
                danger(
                  "Not a Ticket",
                  "This channel is not a Vyne ticket."
                )
              ],
              flags:
                MessageFlags.Ephemeral
            });
          }

          await interaction.reply({
            embeds: [
              success(
                "Ticket Closed",
                "Deleting this channel in 5 seconds."
              )
            ]
          });

          setTimeout(() => {
            interaction.channel
              .delete()
              .catch(() => {});
          }, 5000);

          return;
        }
      }

      // ======================================================
      // REMINDER
      // ======================================================

      if (
        command === "remind"
      ) {

        const duration =
          interaction.options.getString(
            "duration"
          );

        const text =
          interaction.options.getString(
            "text"
          );

        const ms =
          durationMs(duration);

        if (!ms) {
          return interaction.reply({
            embeds: [
              danger(
                "Invalid Duration",
                "Use `10m`, `1h`, `1d`, etc."
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        const reminders =
          load(files.reminders);

        const id =
          `${interaction.user.id}-${Date.now()}`;

        reminders[id] = {
          userId:
            interaction.user.id,
          channelId:
            interaction.channel.id,
          text,
          executeAt:
            Date.now() + ms
        };

        save(
          files.reminders,
          reminders
        );

        return interaction.reply({
          embeds: [
            success(
              "Reminder Set",
              `I'll remind you in **${duration}**.`
            )
          ],
          flags:
            MessageFlags.Ephemeral
        });
      }

      // ======================================================
      // ANNOUNCE
      // ======================================================

      if (
        command === "announce"
      ) {

        const message =
          interaction.options.getString(
            "message"
          );

        await interaction.channel.send({
          embeds: [
            embed(
              "Announcement",
              message
            )
              .setFooter({
                text:
                  `Posted by ${interaction.user.tag}`
              })
          ]
        });

        return interaction.reply({
          embeds: [
            success(
              "Announcement Posted",
              "Your announcement has been sent."
            )
          ],
          flags:
            MessageFlags.Ephemeral
        });
      }

      // ======================================================
      // BALANCE
      // ======================================================

      if (
        command === "balance"
      ) {

        const user =
          interaction.options.getUser(
            "user"
          ) ||
          interaction.user;

        const economy =
          load(files.economy);

        economy[interaction.guild.id] ??= {};

        economy[interaction.guild.id][user.id] ??= {
          balance: 0,
          daily: 0
        };

        save(
          files.economy,
          economy
        );

        return interaction.reply({
          embeds: [
            embed(
              `Economy • ${user.username}`,
              `**Balance**\n${economy[interaction.guild.id][user.id].balance} coins`
            )
          ]
        });
      }

      // ======================================================
      // DAILY
      // ======================================================

      if (
        command === "daily"
      ) {

        const economy =
          load(files.economy);

        economy[interaction.guild.id] ??= {};

        economy[interaction.guild.id][interaction.user.id] ??= {
          balance: 0,
          daily: 0
        };

        const account =
          economy[
            interaction.guild.id
          ][
            interaction.user.id
          ];

        if (
          Date.now() -
            account.daily <
          86400000
        ) {
          return interaction.reply({
            embeds: [
              warning(
                "Daily Already Claimed",
                "Come back tomorrow."
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        account.balance += 500;
        account.daily =
          Date.now();

        save(
          files.economy,
          economy
        );

        return interaction.reply({
          embeds: [
            success(
              "Daily Reward",
              "You received **500 coins**."
            )
          ]
        });
      }

      // ======================================================
      // PAY
      // ======================================================

      if (
        command === "pay"
      ) {

        const user =
          interaction.options.getUser(
            "user"
          );

        const amount =
          interaction.options.getInteger(
            "amount"
          );

        if (
          user.id ===
          interaction.user.id
        ) {
          return interaction.reply({
            embeds: [
              danger(
                "Invalid Payment",
                "You cannot pay yourself."
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        const economy =
          load(files.economy);

        economy[interaction.guild.id] ??= {};

        for (
          const id of [
            interaction.user.id,
            user.id
          ]
        ) {
          economy[
            interaction.guild.id
          ][id] ??= {
            balance: 0,
            daily: 0
          };
        }

        const sender =
          economy[
            interaction.guild.id
          ][
            interaction.user.id
          ];

        const receiver =
          economy[
            interaction.guild.id
          ][
            user.id
          ];

        if (
          sender.balance <
          amount
        ) {
          return interaction.reply({
            embeds: [
              danger(
                "Insufficient Funds",
                "You don't have enough coins."
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        sender.balance -=
          amount;

        receiver.balance +=
          amount;

        save(
          files.economy,
          economy
        );

        return interaction.reply({
          embeds: [
            success(
              "Payment Sent",
              `Transferred **${amount} coins** to ${user}.`
            )
          ]
        });
      }

      // ======================================================
      // LEVEL
      // ======================================================

      if (
        command === "level"
      ) {

        const user =
          interaction.options.getUser(
            "user"
          ) ||
          interaction.user;

        const levels =
          load(files.levels);

        const data =
          levels[
            interaction.guild.id
          ]?.[user.id] || {
            xp: 0,
            level: 0
          };

        const progress =
          data.xp % 100;

        const filled =
          Math.floor(
            progress / 10
          );

        const bar =
          "█".repeat(filled) +
          "░".repeat(
            10 - filled
          );

        return interaction.reply({
          embeds: [
            embed(
              `Level • ${user.username}`,
              [
                `**Level** ${data.level}`,
                `**XP** ${data.xp}`,
                "",
                `${bar}  ${progress}/100`
              ].join("\n")
            )
          ]
        });
      }

      // ======================================================
      // LEADERBOARD
      // ======================================================

      if (
        command === "leaderboard"
      ) {

        const levels =
          load(files.levels);

        const data =
          levels[
            interaction.guild.id
          ] || {};

        const rows =
          Object.entries(data)
            .sort(
              (a, b) =>
                (b[1].xp || 0) -
                (a[1].xp || 0)
            )
            .slice(0, 10);

        if (!rows.length) {
          return interaction.reply({
            embeds: [
              info(
                "Leaderboard",
                "There is no XP data yet."
              )
            ]
          });
        }

        const text =
          rows
            .map(
              ([id, value], index) =>
                `**${index + 1}.** <@${id}> — Level **${value.level || 0}** • ${value.xp || 0} XP`
            )
            .join("\n");

        return interaction.reply({
          embeds: [
            embed(
              "XP Leaderboard",
              text
            )
          ]
        });
      }

      // ======================================================
      // CONFIG
      // ======================================================

      if (
        command === "config"
      ) {

        const config =
          getConfig(
            interaction.guild.id
          );

        return interaction.reply({
          embeds: [
            embed(
              "Vyne • Configuration",
              [
                `**Logs** ${config.logChannelId ? `<#${config.logChannelId}>` : "Not configured"}`,
                `**Moderator Role** ${config.modRoleId ? `<@&${config.modRoleId}>` : "Not configured"}`,
                "",
                `**AutoMod** ${config.automod.enabled ? "Enabled" : "Disabled"}`,
                `**Raid Protection** ${config.raid.enabled ? "Enabled" : "Disabled"}`,
                `**Verification** ${config.verification.enabled ? "Enabled" : "Disabled"}`,
                `**Tickets** ${config.tickets.enabled ? "Enabled" : "Disabled"}`
              ].join("\n")
            )
          ]
        });
      }

      // ======================================================
      // LOG CHANNEL
      // ======================================================

      if (
        command === "logchannel"
      ) {

        const channel =
          interaction.options.getChannel(
            "channel"
          );

        const config =
          getConfig(
            interaction.guild.id
          );

        config.logChannelId =
          channel.id;

        setConfig(
          interaction.guild.id,
          config
        );

        return interaction.reply({
          embeds: [
            success(
              "Logs Configured",
              `Moderation logs will be sent to ${channel}.`
            )
          ]
        });
      }

      // ======================================================
      // MOD ROLE
      // ======================================================

      if (
        command === "modrole"
      ) {

        const role =
          interaction.options.getRole(
            "role"
          );

        const config =
          getConfig(
            interaction.guild.id
          );

        config.modRoleId =
          role.id;

        setConfig(
          interaction.guild.id,
          config
        );

        return interaction.reply({
          embeds: [
            success(
              "Moderator Role Set",
              `Vyne will recognize ${role} as a moderator role.`
            )
          ]
        });
      }

      // ======================================================
      // SYS
      // ======================================================

      if (
        command === "sys"
      ) {

        if (
          !VYNE_OWNER_ID ||
          interaction.user.id !==
            VYNE_OWNER_ID
        ) {
          return interaction.reply({
            embeds: [
              danger(
                "Owner Only",
                "This command is restricted to the bot owner."
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        const sub =
          interaction.options.getSubcommand();

        await interaction.deferReply({
          flags:
            MessageFlags.Ephemeral
        });

        try {

          const deploy =
            await deployment();

          if (
            sub === "pull"
          ) {

            const result =
              await hosting(
                `/deployments/${deploy.id}/sync`,
                {
                  method: "POST"
                }
              );

            return interaction.editReply({
              embeds: [
                success(
                  "GitHub Sync Started",
                  [
                    `**Deployment** ${deploy.name}`,
                    "",
                    "The latest GitHub commit has been requested."
                  ].join("\n")
                )
              ]
            });
          }

          if (
            sub === "restart"
          ) {

            const result =
              await hosting(
                `/deployments/${deploy.id}/power`,
                {
                  method: "POST",
                  body:
                    JSON.stringify({
                      action: "restart",
                      waitSeconds: 10
                    })
                }
              );

            return interaction.editReply({
              embeds: [
                success(
                  "Restart Requested",
                  "Vyne is restarting."
                )
              ]
            });
          }

          if (
            sub === "status"
          ) {

            const result =
              await hosting(
                `/deployments/${deploy.id}/diagnose`
              );

            return interaction.editReply({
              embeds: [
                embed(
                  "Vyne • Deployment Status",
                  `\`\`\`json\n${truncate(
                    JSON.stringify(
                      result,
                      null,
                      2
                    ),
                    3500
                  )}\n\`\`\``
                )
              ]
            });
          }

          if (
            sub === "logs"
          ) {

            const result =
              await hosting(
                `/deployments/${deploy.id}/logs?size=1000`
              );

            return interaction.editReply({
              embeds: [
                embed(
                  "Vyne • Deployment Logs",
                  `\`\`\`\n${truncate(
                    JSON.stringify(
                      result,
                      null,
                      2
                    ),
                    3500
                  )}\n\`\`\``
                )
              ]
            });
          }

          if (
            sub === "info"
          ) {

            const result =
              await hosting(
                `/deployments/${deploy.id}`
              );

            return interaction.editReply({
              embeds: [
                embed(
                  "Vyne • Deployment",
                  `\`\`\`json\n${truncate(
                    JSON.stringify(
                      result,
                      null,
                      2
                    ),
                    3500
                  )}\n\`\`\``
                )
              ]
            });
          }

        } catch (error) {

          return interaction.editReply({
            embeds: [
              danger(
                "System Error",
                `\`\`\`\n${truncate(
                  error.message,
                  3000
                )}\n\`\`\``
              )
            ]
          });
        }
      }

    } catch (error) {

      console.error(
        "Interaction error:",
        error
      );

      const response = {
        embeds: [
          danger(
            "Something Went Wrong",
            "Vyne encountered an unexpected error while processing that command."
          )
        ],
        flags:
          MessageFlags.Ephemeral
      };

      if (
        interaction.replied ||
        interaction.deferred
      ) {
        await interaction
          .followUp(response)
          .catch(() => {});
      } else {
        await interaction
          .reply(response)
          .catch(() => {});
      }
    }
  }
);

// ============================================================
// AUTOMOD
// ============================================================

const spamMap = new Map();
const duplicateMap = new Map();

client.on(
  "messageCreate",
  async message => {

    if (
      !message.guild ||
      message.author.bot
    ) {
      return;
    }

    const config =
      getConfig(
        message.guild.id
      );

    // ---------------- LEVEL XP ----------------

    if (
      config.leveling.enabled
    ) {

      const levels =
        load(files.levels);

      levels[message.guild.id] ??= {};

      levels[
        message.guild.id
      ][
        message.author.id
      ] ??= {
        xp: 0,
        level: 0
      };

      const user =
        levels[
          message.guild.id
        ][
          message.author.id
        ];

      user.xp +=
        config.leveling.xpPerMessage;

      const newLevel =
        Math.floor(
          user.xp / 100
        );

      if (
        newLevel >
        user.level
      ) {

        user.level =
          newLevel;

        await message.channel
          .send({
            embeds: [
              success(
                "Level Up",
                `${message.author} reached **Level ${newLevel}**.`
              )
            ]
          })
          .catch(() => {});
      }

      save(
        files.levels,
        levels
      );
    }

    // ---------------- AUTOMOD ----------------

    if (
      !config.automod.enabled ||
      isStaff(message.member)
    ) {
      return;
    }

    const content =
      message.content || "";

    const now =
      Date.now();

    // Links

    if (
      config.automod.links &&
      /https?:\/\/\S+/i.test(
        content
      )
    ) {

      await message.delete()
        .catch(() => {});

      return;
    }

    // Invites

    if (
      config.automod.invites &&
      /discord\.gg\/|discord\.com\/invite\//i.test(
        content
      )
    ) {

      await message.delete()
        .catch(() => {});

      return;
    }

    // Mentions

    if (
      config.automod.mentions &&
      message.mentions.users.size >=
        config.automod.maxMentions
    ) {

      await message.delete()
        .catch(() => {});

      await message.member
        .timeout(
          config.automod.timeout,
          "Vyne AutoMod: mention spam"
        )
        .catch(() => {});

      return;
    }

    // Bad words

    if (
      config.automod.badWords &&
      config.automod.blockedWords.some(
        word =>
          content
            .toLowerCase()
            .includes(
              word.toLowerCase()
            )
      )
    ) {

      await message.delete()
        .catch(() => {});

      return;
    }

    // Excessive caps

    if (
      config.automod.caps &&
      content.length >= 12
    ) {

      const letters =
        content.replace(
          /[^a-z]/gi,
          ""
        );

      const uppercase =
        letters.replace(
          /[^A-Z]/g,
          ""
        );

      if (
        letters.length >= 8 &&
        uppercase.length /
          letters.length >=
          0.8
      ) {

        await message.delete()
          .catch(() => {});

        return;
      }
    }

    // Emoji spam

    if (
      config.automod.emoji
    ) {

      const emojiCount =
        (
          content.match(
            /\p{Extended_Pictographic}/gu
          ) || []
        ).length;

      if (
        emojiCount >= 12
      ) {

        await message.delete()
          .catch(() => {});

        return;
      }
    }

    // Duplicate messages

    if (
      config.automod.duplicates &&
      content.length > 5
    ) {

      const key =
        `${message.guild.id}:${message.author.id}`;

      const previous =
        duplicateMap.get(key);

      if (
        previous &&
        previous.content ===
          content &&
        now -
          previous.time <
          10000
      ) {

        await message.delete()
          .catch(() => {});

        return;
      }

      duplicateMap.set(
        key,
        {
          content,
          time: now
        }
      );
    }

    // Spam

    if (
      config.automod.spam
    ) {

      const key =
        `${message.guild.id}:${message.author.id}`;

      const entries =
        spamMap.get(key) || [];

      entries.push(now);

      const filtered =
        entries.filter(
          timestamp =>
            now -
              timestamp <=
            config.automod.spamWindow
        );

      spamMap.set(
        key,
        filtered
      );

      if (
        filtered.length >=
        config.automod.spamMessages
      ) {

        await message.member
          .timeout(
            config.automod.timeout,
            "Vyne AutoMod: spam"
          )
          .catch(() => {});

        spamMap.delete(
          key
        );

        await log(
          message.guild,
          warning(
            "AutoMod • Spam",
            `${message.author} was automatically timed out for spam.`
          )
        );
      }
    }
  }
);

// ============================================================
// RAID PROTECTION
// ============================================================

const joins = new Map();

client.on(
  "guildMemberAdd",
  async member => {

    const config =
      getConfig(
        member.guild.id
      );

    if (
      !config.raid.enabled
    ) {
      return;
    }

    const now =
      Date.now();

    const list =
      joins.get(
        member.guild.id
      ) || [];

    list.push(now);

    const filtered =
      list.filter(
        time =>
          now - time <=
          config.raid.window
      );

    joins.set(
      member.guild.id,
      filtered
    );

    if (
      filtered.length >=
      config.raid.joinLimit
    ) {

      await log(
        member.guild,
        danger(
          "Raid Detection",
          `Detected **${filtered.length} joins** in the configured window.`
        )
      );
    }
  }
);

// ============================================================
// MEMBER LOGGING
// ============================================================

client.on(
  "guildMemberRemove",
  async member => {

    await log(
      member.guild,
      info(
        "Member Left",
        `${member.user.tag} left the server.`
      )
    );
  }
);

// ============================================================
// MESSAGE LOGGING
// ============================================================

client.on(
  "messageDelete",
  async message => {

    if (
      !message.guild ||
      message.author?.bot
    ) {
      return;
    }

    await log(
      message.guild,
      warning(
        "Message Deleted",
        [
          `**Author** ${message.author}`,
          `**Channel** ${message.channel}`,
          `**Content** ${truncate(
            message.content ||
              "[No content]",
            700
          )}`
        ].join("\n")
      )
    );
  }
);

client.on(
  "messageUpdate",
  async (
    oldMessage,
    newMessage
  ) => {

    if (
      !newMessage.guild ||
      newMessage.author?.bot ||
      oldMessage.content ===
        newMessage.content
    ) {
      return;
    }

    await log(
      newMessage.guild,
      info(
        "Message Edited",
        [
          `**Author** ${newMessage.author}`,
          `**Channel** ${newMessage.channel}`,
          "",
          `**Before** ${truncate(
            oldMessage.content,
            350
          )}`,
          `**After** ${truncate(
            newMessage.content,
            350
          )}`
        ].join("\n")
      )
    );
  }
);

// ============================================================
// VOICE LOGGING
// ============================================================

client.on(
  "voiceStateUpdate",
  async (
    oldState,
    newState
  ) => {

    if (
      oldState.channelId ===
      newState.channelId
    ) {
      return;
    }

    const member =
      newState.member ||
      oldState.member;

    let description;

    if (
      !oldState.channelId &&
      newState.channelId
    ) {
      description =
        `${member.user.tag} joined <#${newState.channelId}>.`;
    } else if (
      oldState.channelId &&
      !newState.channelId
    ) {
      description =
        `${member.user.tag} left <#${oldState.channelId}>.`;
    } else {
      description =
        `${member.user.tag} moved from <#${oldState.channelId}> to <#${newState.channelId}>.`;
    }

    await log(
      newState.guild ||
        oldState.guild,
      info(
        "Voice Activity",
        description
      )
    );
  }
);

// ============================================================
// REMINDERS
// ============================================================

setInterval(
  async () => {

    const reminders =
      load(files.reminders);

    let changed =
      false;

    for (
      const [
        id,
        reminder
      ] of Object.entries(
        reminders
      )
    ) {

      if (
        Date.now() <
        reminder.executeAt
      ) {
        continue;
      }

      const channel =
        client.channels.cache.get(
          reminder.channelId
        );

      if (
        channel?.isTextBased()
      ) {

        await channel.send({
          content:
            `<@${reminder.userId}>`,
          embeds: [
            embed(
              "Reminder",
              reminder.text
            )
          ]
        }).catch(() => {});
      }

      delete reminders[id];

      changed =
        true;
    }

    if (changed) {
      save(
        files.reminders,
        reminders
      );
    }

  },
  10000
);

// ============================================================
// AUTOMOD EMBED
// ============================================================

function automodEmbed(
  guildId
) {

  const config =
    getConfig(guildId);

  const status =
    value =>
      value
        ? "Enabled"
        : "Disabled";

  return embed(
    "Vyne • AutoMod",
    [
      `**Master**  ${status(config.automod.enabled)}`,
      "",
      `**Anti Spam**  ${status(config.automod.spam)}`,
      `**Anti Links**  ${status(config.automod.links)}`,
      `**Anti Invites**  ${status(config.automod.invites)}`,
      `**Mention Protection**  ${status(config.automod.mentions)}`,
      `**Duplicate Detection**  ${status(config.automod.duplicates)}`,
      `**Bad Words**  ${status(config.automod.badWords)}`,
      "",
      "Use the menu below to change a module."
    ].join("\n")
  );
}

// ============================================================
// READY
// ============================================================

client.once(
  "clientReady",
  async () => {

    console.log(
      `✅ Logged in as ${client.user.tag}`
    );

    console.log(
      `📌 Client ID: ${CLIENT_ID}`
    );

    console.log(
      `📌 Guild ID: ${GUILD_ID}`
    );

    try {

      const rest =
        new REST({
          version: "10"
        }).setToken(
          DISCORD_TOKEN
        );

      const registered =
        await rest.put(
          Routes.applicationGuildCommands(
            CLIENT_ID,
            GUILD_ID
          ),
          {
            body: commands
          }
        );

      console.log(
        `✅ Registered ${registered.length} guild commands.`
      );

    } catch (error) {

      console.error(
        "❌ Command registration failed:",
        error
      );
    }
  }
);

// ============================================================
// ERROR HANDLING
// ============================================================

client.on(
  "error",
  error => {
    console.error(
      "Discord client error:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "Unhandled rejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);

// ============================================================
// LOGIN
// ============================================================

client.login(
  DISCORD_TOKEN
).catch(error => {

  console.error(
    "❌ Discord login failed:"
  );

  console.error(
    error
  );

  process.exit(1);
});
