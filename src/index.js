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
  MessageFlags,
  ChannelType,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

const fs = require("fs");
const path = require("path");

// ============================================================
// ENV
// ============================================================

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const BOT_HOSTING_API_KEY = process.env.BOT_HOSTING_API_KEY;
const VYNE_OWNER_ID = process.env.VYNE_OWNER_ID;

const BOT_HOSTING_API = "https://bot-hosting.net/api/v1";

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("❌ Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID");
  process.exit(1);
}

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
    Partials.Message,
    Partials.Channel
  ]
});

// ============================================================
// DATABASE
// ============================================================

const dataDir = path.join(__dirname, "..", "data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const DB = {
  config: path.join(dataDir, "config.json"),
  warnings: path.join(dataDir, "warnings.json"),
  cases: path.join(dataDir, "cases.json"),
  levels: path.join(dataDir, "levels.json"),
  economy: path.join(dataDir, "economy.json"),
  reminders: path.join(dataDir, "reminders.json"),
  giveaways: path.join(dataDir, "giveaways.json"),
  tickets: path.join(dataDir, "tickets.json"),
  reactionRoles: path.join(dataDir, "reaction-roles.json")
};

for (const file of Object.values(DB)) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "{}");
  }
}

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ============================================================
// HELPERS
// ============================================================

function success(title, description) {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`✅ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

function errorEmbed(description) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("❌ Error")
    .setDescription(description)
    .setTimestamp();
}

function info(title, description) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

function warning(title, description) {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`⚠️ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

function truncate(value, max = 1000) {
  value = String(value ?? "None");

  if (value.length <= max) {
    return value;
  }

  return value.slice(0, max - 3) + "...";
}

function parseDuration(value) {
  const match = String(value || "")
    .trim()
    .toLowerCase()
    .match(/^(\d+)\s*(s|m|h|d|w)$/);

  if (!match) return null;

  const amount = Number(match[1]);

  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000
  };

  return amount * multipliers[match[2]];
}

function formatDuration(ms) {
  if (!ms) return "0s";

  if (ms >= 604800000) {
    return `${Math.floor(ms / 604800000)}w`;
  }

  if (ms >= 86400000) {
    return `${Math.floor(ms / 86400000)}d`;
  }

  if (ms >= 3600000) {
    return `${Math.floor(ms / 3600000)}h`;
  }

  if (ms >= 60000) {
    return `${Math.floor(ms / 60000)}m`;
  }

  return `${Math.floor(ms / 1000)}s`;
}

// ============================================================
// SERVER CONFIG
// ============================================================

const defaultConfig = {
  logChannelId: null,
  modRoleId: null,

  automod: {
    enabled: true,

    antiSpam: true,
    antiLinks: false,
    antiInvites: true,
    antiMentionSpam: true,
    duplicateMessages: true,
    excessiveCaps: false,
    badWords: true,
    massEmoji: true,
    attachments: false,

    spamMessages: 6,
    spamWindow: 7000,
    maxMentions: 5,

    timeoutDuration: 60000,

    blockedWords: [
      "scamword",
      "malicious"
    ]
  },

  raid: {
    enabled: false,
    joins: 8,
    window: 10000,
    accountAge: 86400000,
    lockdown: false
  },

  verification: {
    enabled: false,
    channelId: null,
    roleId: null
  },

  tickets: {
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

  caseNumber: 1
};

function mergeConfig(base, override) {
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
      result[key] = mergeConfig(
        base[key],
        override?.[key] || {}
      );
    }
  }

  return result;
}

function getConfig(guildId) {
  const all = read(DB.config);

  const config = mergeConfig(
    defaultConfig,
    all[guildId] || {}
  );

  all[guildId] = config;

  write(DB.config, all);

  return config;
}

function saveConfig(guildId, config) {
  const all = read(DB.config);

  all[guildId] = config;

  write(DB.config, all);
}

// ============================================================
// MODERATION DATA
// ============================================================

function getWarnings(guildId, userId) {
  const all = read(DB.warnings);

  return all[guildId]?.[userId] || [];
}

function addWarning(guildId, userId, data) {
  const all = read(DB.warnings);

  all[guildId] ??= {};
  all[guildId][userId] ??= [];

  all[guildId][userId].push(data);

  write(DB.warnings, all);

  return all[guildId][userId];
}

function clearWarnings(guildId, userId) {
  const all = read(DB.warnings);

  all[guildId] ??= {};
  all[guildId][userId] = [];

  write(DB.warnings, all);
}

function createCase(guildId, data) {
  const config = getConfig(guildId);

  const id = config.caseNumber;

  config.caseNumber++;

  saveConfig(guildId, config);

  const all = read(DB.cases);

  all[guildId] ??= {};

  all[guildId][id] = {
    id,
    ...data,
    timestamp: Date.now()
  };

  write(DB.cases, all);

  return id;
}

function getCases(guildId, userId) {
  const all = read(DB.cases);

  return Object.values(all[guildId] || {})
    .filter(x => !userId || x.userId === userId)
    .sort((a, b) => b.timestamp - a.timestamp);
}

// ============================================================
// PERMISSIONS
// ============================================================

function isModerator(member) {
  if (!member) return false;

  if (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }

  const config = getConfig(member.guild.id);

  return (
    config.modRoleId &&
    member.roles.cache.has(config.modRoleId)
  );
}

function canModerate(actor, target, botMember) {
  if (!target) {
    return {
      allowed: false,
      reason: "Member not found."
    };
  }

  if (target.id === actor.id) {
    return {
      allowed: false,
      reason: "You cannot moderate yourself."
    };
  }

  if (target.id === target.guild.ownerId) {
    return {
      allowed: false,
      reason: "You cannot moderate the server owner."
    };
  }

  if (
    actor.id !== target.guild.ownerId &&
    target.roles.highest.position >= actor.roles.highest.position
  ) {
    return {
      allowed: false,
      reason: "That member has an equal or higher role than you."
    };
  }

  if (
    botMember &&
    target.roles.highest.position >= botMember.roles.highest.position
  ) {
    return {
      allowed: false,
      reason: "My highest role must be above the target."
    };
  }

  return {
    allowed: true
  };
}

// ============================================================
// LOGGING
// ============================================================

async function sendLog(guild, embed) {
  try {
    const config = getConfig(guild.id);

    if (!config.logChannelId) return;

    const channel =
      guild.channels.cache.get(config.logChannelId);

    if (channel?.isTextBased()) {
      await channel.send({
        embeds: [embed]
      });
    }
  } catch (err) {
    console.error("Log error:", err.message);
  }
}

async function dmUser(member, text) {
  try {
    await member.send({
      embeds: [
        info(
          "Vyne Moderation",
          text
        )
      ]
    });
  } catch {}
}

// ============================================================
// BOT HOSTING API
// ============================================================

async function hostingRequest(endpoint, options = {}) {
  if (!BOT_HOSTING_API_KEY) {
    throw new Error(
      "BOT_HOSTING_API_KEY is not configured."
    );
  }

  const response = await fetch(
    BOT_HOSTING_API + endpoint,
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

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    throw new Error(
      data.message ||
      data.error ||
      `Bot-Hosting HTTP ${response.status}`
    );
  }

  return data;
}

async function getVyneDeployment() {
  const data =
    await hostingRequest(
      `/deployments?name=${encodeURIComponent(
        "Vyne Moderation"
      )}&brief=true`
    );

  const deployments =
    data.deployments || [];

  const deployment =
    deployments.find(
      x => x.name === "Vyne Moderation"
    ) || deployments[0];

  if (!deployment) {
    throw new Error(
      "Vyne Moderation deployment was not found."
    );
  }

  return deployment;
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
    .setDescription("Remove timeout")
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
    .setName("cases")
    .setDescription("View member cases")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Member")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("case")
    .setDescription("View a moderation case")
    .addIntegerOption(o =>
      o.setName("id")
        .setDescription("Case ID")
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
    )
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Only this user")
    ),

  new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Lock the current channel"),

  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlock the current channel"),

  new SlashCommandBuilder()
    .setName("slowmode")
    .setDescription("Set channel slowmode")
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
        .setDescription("New nickname")
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
    .setName("userinfo")
    .setDescription("User information")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("User")
    ),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Server information"),

  new SlashCommandBuilder()
    .setName("channelinfo")
    .setDescription("Current channel information"),

  new SlashCommandBuilder()
    .setName("roleinfo")
    .setDescription("Role information")
    .addRoleOption(o =>
      o.setName("role")
        .setDescription("Role")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("View avatar")
    .addUserOption(o =>
      o.setName("user")
        .setDescription("User")
    ),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Show bot latency"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show Vyne help"),

  // ---------------- CONFIG ----------------

  new SlashCommandBuilder()
    .setName("logchannel")
    .setDescription("Set moderation log channel")
    .addChannelOption(o =>
      o.setName("channel")
        .setDescription("Channel")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("modrole")
    .setDescription("Set moderator role")
    .addRoleOption(o =>
      o.setName("role")
        .setDescription("Moderator role")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Open Vyne configuration"),

  // ---------------- AUTOMOD ----------------

  new SlashCommandBuilder()
    .setName("automod")
    .setDescription("Open AutoMod control panel"),

  // ---------------- SECURITY ----------------

  new SlashCommandBuilder()
    .setName("raid")
    .setDescription("Raid protection")
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
        .setDescription("Show status")
    ),

  new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Verification system")
    .addSubcommand(s =>
      s.setName("setup")
        .setDescription("Create verification panel")
        .addChannelOption(o =>
          o.setName("channel")
            .setDescription("Panel channel")
            .addChannelTypes(ChannelType.GuildText)
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

  // ---------------- TICKETS ----------------

  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Ticket system")
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
            .addChannelTypes(ChannelType.GuildCategory)
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

  // ---------------- GIVEAWAYS ----------------

  new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Giveaway system")
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
           