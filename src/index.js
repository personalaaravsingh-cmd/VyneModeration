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
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder
} = require("discord.js");
const fs = require("fs");
const path = require("path");
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const BOT_HOSTING_API_KEY = process.env.BOT_HOSTING_API_KEY;
const VYNE_OWNER_ID = process.env.VYNE_OWNER_ID;
const BOT_HOSTING_API = "https://bot-hosting.net/api/v1";
if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("❌ Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID.");
  process.exit(1);
}
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Message, Partials.Channel]
});
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
  tickets: path.join(dataDir, "tickets.json")
};
for (const file of Object.values(DB)) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, "{}");
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
  const text = String(value ?? "None");
  return text.length <= max ? text : text.slice(0, max - 3) + "...";
}
function parseDuration(value) {
  const match = String(value || "")
    .trim()
    .toLowerCase()
    .match(/^(\d+)\s*(s|m|h|d|w)$/);
  if (!match) return null;
  const multipliers = {
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
    w: 604800000
  };
  return Number(match[1]) * multipliers[match[2]];
}
function formatDuration(ms) {
  if (ms >= 604800000) return `${Math.floor(ms / 604800000)}w`;
  if (ms >= 86400000) return `${Math.floor(ms / 86400000)}d`;
  if (ms >= 3600000) return `${Math.floor(ms / 3600000)}h`;
  if (ms >= 60000) return `${Math.floor(ms / 60000)}m`;
  return `${Math.max(1, Math.floor(ms / 1000))}s`;
}
function mergeConfig(base, override) {
  const result = { ...base, ...override };
  for (const key of Object.keys(base)) {
    if (
      base[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      result[key] = mergeConfig(base[key], override?.[key] || {});
    }
  }
  return result;
}
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
    warnThreshold: 3,
    timeoutDuration: 60000,
    blockedWords: ["scamword", "malicious"]
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
function getConfig(guildId) {
  const all = read(DB.config);
  const config = mergeConfig(defaultConfig, all[guildId] || {});
  all[guildId] = config;
  write(DB.config, all);
  return config;
}
function saveConfig(guildId, config) {
  const all = read(DB.config);
  all[guildId] = config;
  write(DB.config, all);
}
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
  const id = config.caseNumber++;
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
function isModerator(member) {
  if (!member) return false;
  if (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions.has(PermissionFlagsBits.ModerateMembers) ||
    member.permissions.has(PermissionFlagsBits.ManageMessages)
  ) {
    return true;
  }
  const config = getConfig(member.guild.id);
  return Boolean(
    config.modRoleId && member.roles.cache.has(config.modRoleId)
  );
}
function canModerate(actor, target, botMember) {
  if (!target) return { allowed: false, reason: "Member not found." };
  if (target.id === actor.id) {
    return { allowed: false, reason: "You cannot moderate yourself." };
  }
  if (target.id === target.guild.ownerId) {
    return { allowed: false, reason: "You cannot moderate the server owner." };
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
  return { allowed: true };
}
async function sendLog(guild, embed) {
  try {
    const config = getConfig(guild.id);
    if (!config.logChannelId) return;
    const channel = guild.channels.cache.get(config.logChannelId);
    if (channel?.isTextBased()) {
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error("Log error:", err.message);
  }
}
async function dmUser(member, title, text) {
  try {
    await member.send({
      embeds: [info(title, text)]
    });
  } catch {}
}
async function hostingRequest(endpoint, options = {}) {
  if (!BOT_HOSTING_API_KEY) {
    throw new Error("BOT_HOSTING_API_KEY is not configured.");
  }
  const response = await fetch(BOT_HOSTING_API + endpoint, {
    ...options,
    headers: {
      Authorization: `Bearer ${BOT_HOSTING_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
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
  const data = await hostingRequest(
    `/deployments?name=${encodeURIComponent("Vyne Moderation")}&brief=true`
  );
  const deployments = data.deployments || [];
  const deployment =
    deployments.find(x => x.name === "Vyne Moderation") ||
    deployments[0];
  if (!deployment) {
    throw new Error("Vyne Moderation deployment was not found.");
  }
  return deployment;
}
const commands = [
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member")
    .addUserOption(o =>
      o.setName("user").setDescription("Member").setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason")
    ),
  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a user")
    .addStringOption(o =>
      o.setName("user_id").setDescription("User ID").setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason")
    ),
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member")
    .addUserOption(o =>
      o.setName("user").setDescription("Member").setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason")
    ),
  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a member")
    .addUserOption(o =>
      o.setName("user").setDescription("Member").setRequired(true)
    )
    .addStringOption(o =>
      o.setName("duration")
        .setDescription("10m, 1h, 1d")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason")
    ),
  new SlashCommandBuilder()
    .setName("untimeout")
    .setDescription("Remove a timeout")
    .addUserOption(o =>
      o.setName("user").setDescription("Member").setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason")
    ),
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member")
    .addUserOption(o =>
      o.setName("user").setDescription("Member").setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason").setDescription("Reason").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("View warnings")
    .addUserOption(o =>
      o.setName("user").setDescription("Member").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("clearwarnings")
    .setDescription("Clear warnings")
    .addUserOption(o =>
      o.setName("user").setDescription("Member").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("cases")
    .setDescription("View moderation cases")
    .addUserOption(o =>
      o.setName("user").setDescription("Member").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("case")
    .setDescription("View a moderation case")
    .addIntegerOption(o =>
      o.setName("id").setDescription("Case ID").setRequired(true)
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
      o.setName("user").setDescription("Only this user")
    ),
  new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Lock current channel"),
  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlock current channel"),
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
    .setDescription("Change nickname")
    .addUserOption(o =>
      o.setName("user").setDescription("Member").setRequired(true)
    )
    .addStringOption(o =>
      o.setName("nickname").setDescription("New nickname").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("role")
    .setDescription("Manage roles")
    .addSubcommand(s =>
      s.setName("add")
        .setDescription("Add a role")
        .addUserOption(o =>
          o.setName("user").setDescription("Member").setRequired(true)
        )
        .addRoleOption(o =>
          o.setName("role").setDescription("Role").setRequired(true)
        )
    )
    .addSubcommand(s =>
      s.setName("remove")
        .setDescription("Remove a role")
        .addUserOption(o =>
          o.setName("user").setDescription("Member").setRequired(true)
        )
        .addRoleOption(o =>
          o.setName("role").setDescription("Role").setRequired(true)
        )
    )
    .addSubcommand(s =>
      s.setName("create")
        .setDescription("Create a role")
        .addStringOption(o =>
          o.setName("name").setDescription("Role name").setRequired(true)
        )
    ),
  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("User information")
    .addUserOption(o =>
      o.setName("user").setDescription("User")
    ),
  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Server information"),
  new SlashCommandBuilder()
    .setName("channelinfo")
    .setDescription("Channel information"),
  new SlashCommandBuilder()
    .setName("roleinfo")
    .setDescription("Role information")
    .addRoleOption(o =>
      o.setName("role").setDescription("Role").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("View avatar")
    .addUserOption(o =>
      o.setName("user").setDescription("User")
    ),
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Show bot latency"),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show Vyne help"),
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
      o.setName("role").setDescription("Moderator role").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Show Vyne configuration"),
  new SlashCommandBuilder()
    .setName("automod")
    .setDescription("Open AutoMod controls"),
  new SlashCommandBuilder()
    .setName("raid")
    .setDescription("Raid protection")
    .addSubcommand(s =>
      s.setName("on").setDescription("Enable raid protection")
    )
    .addSubcommand(s =>
      s.setName("off").setDescription("Disable raid protection")
    )
    .addSubcommand(s =>
      s.setName("status").setDescription("Show raid status")
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
      s.setName("disable").setDescription("Disable verification")
    ),
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
      s.setName("panel").setDescription("Send ticket panel")
    )
    .addSubcommand(s =>
      s.setName("close").setDescription("Close current ticket")
    ),
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
            .setRequired(true)
        )
    )
    .addSubcommand(s =>
      s.setName("end")
        .setDescription("End giveaway")
        .addStringOption(o =>
          o.setName("message_id")
            .setDescription("Giveaway message ID")
            .setRequired(true)
        )
    )
    .addSubcommand(s =>
      s.setName("reroll")
        .setDescription("Reroll giveaway")
        .addStringOption(o =>
          o.setName("message_id")
            .setDescription("Giveaway message ID")
            .setRequired(true)
        )
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
      o.setName("text").setDescription("Reminder text").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("notify")
    .setDescription("Notification settings")
    .addSubcommand(s =>
      s.setName("set")
        .setDescription("Set notification channel")
        .addChannelOption(o =>
          o.setName("channel")
            .setDescription("Channel")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand(s =>
      s.setName("test").setDescription("Test notifications")
    ),
  new SlashCommandBuilder()
    .setName("level")
    .setDescription("Show your level")
    .addUserOption(o =>
      o.setName("user").setDescription("User")
    ),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show XP leaderboard"),
  new SlashCommandBuilder()
    .setName("balance")
    .setDescription("Show balance")
    .addUserOption(o =>
      o.setName("user").setDescription("User")
    ),
  new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Claim daily coins"),
  new SlashCommandBuilder()
    .setName("pay")
    .setDescription("Pay another user")
    .addUserOption(o =>
      o.setName("user").setDescription("User").setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName("amount")
        .setDescription("Amount")
        .setMinValue(1)
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Send an announcement")
    .addStringOption(o =>
      o.setName("message").setDescription("Announcement").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("sys")
    .setDescription("Owner-only system controls")
    .addSubcommand(s =>
      s.setName("pull").setDescription("Pull latest GitHub code")
    )
    .addSubcommand(s =>
      s.setName("restart").setDescription("Restart deployment")
    )
    .addSubcommand(s =>
      s.setName("status").setDescription("Show deployment status")
    )
    .addSubcommand(s =>
      s.setName("logs").setDescription("Show deployment logs")
    )
    .addSubcommand(s =>
      s.setName("info").setDescription("Show deployment information")
    )
].map(command => command.toJSON());
client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === "vyne_verify") {
        const config = getConfig(interaction.guild.id);
        if (!config.verification.enabled || !config.verification.roleId) {
          return interaction.reply({
            embeds: [errorEmbed("Verification is not enabled.")],
            flags: MessageFlags.Ephemeral
          });
        }
        const role = interaction.guild.roles.cache.get(
          config.verification.roleId
        );
        if (!role) {
          return interaction.reply({
            embeds: [errorEmbed("The verification role no longer exists.")],
            flags: MessageFlags.Ephemeral
          });
        }
        if (interaction.member.roles.cache.has(role.id)) {
          return interaction.reply({
            embeds: [info("Already Verified", "You already have the verified role.")],
            flags: MessageFlags.Ephemeral
          });
        }
        await interaction.member.roles.add(role, "Vyne verification");
        return interaction.reply({
          embeds: [success("Verified", `You now have ${role}.`)],
          flags: MessageFlags.Ephemeral
        });
      }
      if (interaction.customId === "vyne_ticket_create") {
        const config = getConfig(interaction.guild.id);
        if (!config.tickets.categoryId || !config.tickets.staffRoleId) {
          return interaction.reply({
            embeds: [errorEmbed("Tickets are not configured yet.")],
            flags: MessageFlags.Ephemeral
          });
        }
        const existing = interaction.guild.channels.cache.find(
          c =>
            c.type === ChannelType.GuildText &&
            c.topic === `vyne-ticket:${interaction.user.id}`
        );
        if (existing) {
          return interaction.reply({
            embeds: [
              info("Ticket Already Open", `You already have ${existing}.`)
            ],
            flags: MessageFlags.Ephemeral
          });
        }
        const channel = await interaction.guild.channels.create({
          name: `ticket-${interaction.user.username}`.toLowerCase().slice(0, 90),
          type: ChannelType.GuildText,
          parent: config.tickets.categoryId,
          topic: `vyne-ticket:${interaction.user.id}`,
          permissionOverwrites: [
            {
              id: interaction.guild.roles.everyone.id,
              deny: [PermissionFlagsBits.ViewChannel]
            },
            {
              id: interaction.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory
              ]
            },
            {
              id: config.tickets.staffRoleId,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageMessages
              ]
            }
          ]
        });
        const closeRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("vyne_ticket_close")
            .setLabel("Close Ticket")
            .setStyle(ButtonStyle.Danger)
        );
        await channel.send({
          content: `${interaction.user}`,
          embeds: [
            info(
              "Vyne Ticket",
              "A staff member will be with you shortly.\n\nUse the button below to close this ticket."
            )
          ],
          components: [closeRow]
        });
        return interaction.reply({
          embeds: [success("Ticket Created", `Your ticket is ${channel}.`)],
          flags: MessageFlags.Ephemeral
        });
      }
      if (interaction.customId === "vyne_ticket_close") {
        if (!interaction.channel.name.startsWith("ticket-")) {
          return interaction.reply({
            embeds: [errorEmbed("This is not a ticket channel.")],
            flags: MessageFlags.Ephemeral
          });
        }
        await interaction.reply({
          embeds: [
            success("Ticket Closed", "This channel will be deleted in 5 seconds.")
          ]
        });
        setTimeout(() => {
          interaction.channel?.delete().catch(() => {});
        }, 5000);
        return;
      }
      return;
    }
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "vyne_automod_select") {
        if (!isModerator(interaction.member)) {
          return interaction.reply({
            embeds: [errorEmbed("You need moderation permissions.")],
            flags: MessageFlags.Ephemeral
          });
        }
        const config = getConfig(interaction.guild.id);
        const choice = interaction.values[0];
        if (choice === "toggle") {
          config.automod.enabled = !config.automod.enabled;
        }
        if (choice === "links") {
          config.automod.antiLinks = !config.automod.antiLinks;
        }
        if (choice === "spam") {
          config.automod.antiSpam = !config.automod.antiSpam;
        }
        if (choice === "words") {
          config.automod.badWords = !config.automod.badWords;
        }
        if (choice === "mentions") {
          config.automod.antiMentionSpam =
            !config.automod.antiMentionSpam;
        }
        if (choice === "duplicate") {
          config.automod.duplicateMessages =
            !config.automod.duplicateMessages;
        }
        saveConfig(interaction.guild.id, config);
        return interaction.update({
          embeds: [
            info(
              "AutoMod Updated",
              [
                `Enabled: **${config.automod.enabled}**`,
                `Anti-spam: **${config.automod.antiSpam}**`,
                `Anti-links: **${config.automod.antiLinks}**`,
                `Bad words: **${config.automod.badWords}**`,
                `Mention spam: **${config.automod.antiMentionSpam}**`,
                `Duplicate messages: **${config.automod.duplicateMessages}**`
              ].join("\n")
            )
          ],
          components: [automodMenu()]
        });
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    const command = interaction.commandName;
    const moderationCommands = [
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
      "logchannel",
      "modrole",
      "automod",
      "raid",
      "verify",
      "ticket",
      "giveaway",
      "notify",
      "announce"
    ];
    if (
      moderationCommands.includes(command) &&
      !isModerator(interaction.member)
    ) {
      return interaction.reply({
        embeds: [errorEmbed("You need moderation permissions.")],
        flags: MessageFlags.Ephemeral
      });
    }
    if (command === "ban") {
      const user = interaction.options.getUser("user");
      const reason =
        interaction.options.getString("reason") || "No reason provided.";
      const member = await interaction.guild.members
        .fetch(user.id)
        .catch(() => null);
      const check = canModerate(
        interaction.member,
        member,
        interaction.guild.members.me
      );
      if (!check.allowed) {
        return interaction.reply({
          embeds: [errorEmbed(check.reason)],
          flags: MessageFlags.Ephemeral
        });
      }
      const caseId = createCase(interaction.guild.id, {
        type: "BAN",
        userId: user.id,
        moderatorId: interaction.user.id,
        reason
      });
      await dmUser(
        member,
        "You were banned",
        `You were banned from **${interaction.guild.name}**.\nReason: **${reason}**\nCase: **#${caseId}**`
      );
      await member.ban({ reason: `Case #${caseId}: ${reason}` });
      await sendLog(
        interaction.guild,
        info(
          "Member Banned",
          `User: ${user} (${user.id})\nModerator: ${interaction.user}\nReason: ${reason}\nCase: #${caseId}`
        )
      );
      return interaction.reply({
        embeds: [
          success("Member Banned", `${user} has been banned.\nCase: **#${caseId}**`)
        ]
      });
    }
    if (command === "unban") {
      const userId = interaction.options.getString("user_id");
      const reason =
        interaction.options.getString("reason") || "No reason provided.";
      const caseId = createCase(interaction.guild.id, {
        type: "UNBAN",
        userId,
        moderatorId: interaction.user.id,
        reason
      });
      await interaction.guild.members.unban(
        userId,
        `Case #${caseId}: ${reason}`
      );
      return interaction.reply({
        embeds: [
          success("User Unbanned", `${userId} has been unbanned.\nCase: **#${caseId}**`)
        ]
      });
    }
    if (command === "kick") {
      const user = interaction.options.getUser("user");
      const reason =
        interaction.options.getString("reason") || "No reason provided.";
      const member = await interaction.guild.members
        .fetch(user.id)
        .catch(() => null);
      const check = canModerate(
        interaction.member,
        member,
        interaction.guild.members.me
      );
      if (!check.allowed) {
        return interaction.reply({
          embeds: [errorEmbed(check.reason)],
          flags: MessageFlags.Ephemeral
        });
      }
      const caseId = createCase(interaction.guild.id, {
        type: "KICK",
        userId: user.id,
        moderatorId: interaction.user.id,
        reason
      });
      await dmUser(
        member,
        "You were kicked",
        `You were kicked from **${interaction.guild.name}**.\nReason: **${reason}**\nCase: **#${caseId}**`
      );
      await member.kick(`Case #${caseId}: ${reason}`);
      return interaction.reply({
        embeds: [
          success("Member Kicked", `${user} has been kicked.\nCase: **#${caseId}**`)
        ]
      });
    }
    if (command === "timeout") {
      const user = interaction.options.getUser("user");
      const durationText = interaction.options.getString("duration");
      const reason =
        interaction.options.getString("reason") || "No reason provided.";
      const duration = parseDuration(durationText);
      if (!duration || duration > 28 * 86400000) {
        return interaction.reply({
          embeds: [
            errorEmbed("Invalid duration. Maximum Discord timeout is 28 days.")
          ],
          flags: MessageFlags.Ephemeral
        });
      }
      const member = await interaction.guild.members
        .fetch(user.id)
        .catch(() => null);
      const check = canModerate(
        interaction.member,
        member,
        interaction.guild.members.me
      );
      if (!check.allowed) {
        return interaction.reply({
          embeds: [errorEmbed(check.reason)],
          flags: MessageFlags.Ephemeral
        });
      }
      const caseId = createCase(interaction.guild.id, {
        type: "TIMEOUT",
        userId: user.id,
        moderatorId: interaction.user.id,
        reason,
        duration: durationText
      });
      await dmUser(
        member,
        "You were timed out",
        `You were timed out in **${interaction.guild.name}** for **${durationText}**.\nReason: **${reason}**\nCase: **#${caseId}**`
      );
      await member.timeout(
        duration,
        `Case #${caseId}: ${reason}`
      );
      return interaction.reply({
        embeds: [
          success(
            "Member Timed Out",
            `${user} was timed out for **${durationText}**.\nCase: **#${caseId}**`
          )
        ]
      });
    }
    if (command === "untimeout") {
      const user = interaction.options.getUser("user");
      const reason =
        interaction.options.getString("reason") || "No reason provided.";
      const member = await interaction.guild.members
        .fetch(user.id)
        .catch(() => null);
      const check = canModerate(
        interaction.member,
        member,
        interaction.guild.members.me
      );
      if (!check.allowed) {
        return interaction.reply({
          embeds: [errorEmbed(check.reason)],
          flags: MessageFlags.Ephemeral
        });
      }
      await member.timeout(null, reason);
      return interaction.reply({
        embeds: [success("Timeout Removed", `${user} is no longer timed out.`)]
      });
    }
    if (command === "warn") {
      const user = interaction.options.getUser("user");
      const reason = interaction.options.getString("reason");
      const member = await interaction.guild.members
        .fetch(user.id)
        .catch(() => null);
      const check = canModerate(
        interaction.member,
        member,
        interaction.guild.members.me
      );
      if (!check.allowed) {
        return interaction.reply({
          embeds: [errorEmbed(check.reason)],
          flags: MessageFlags.Ephemeral
        });
      }
      const warnings = addWarning(
        interaction.guild.id,
        user.id,
        {
          moderatorId: interaction.user.id,
          reason,
          timestamp: Date.now()
        }
      );
      const caseId = createCase(interaction.guild.id, {
        type: "WARN",
        userId: user.id,
        moderatorId: interaction.user.id,
        reason
      });
      await dmUser(
        member,
        "You received a warning",
        `You received a warning in **${interaction.guild.name}**.\nReason: **${reason}**\nTotal warnings: **${warnings.length}**\nCase: **#${caseId}**`
      );
      const config = getConfig(interaction.guild.id);
      if (warnings.length >= config.automod.warnThreshold) {
        await member.timeout(
          config.automod.timeoutDuration,
          `Automatic escalation after ${warnings.length} warnings`
        ).catch(() => {});
      }
      return interaction.reply({
        embeds: [
          warning(
            "Warning Added",
            `${user} now has **${warnings.length}** warning(s).\nCase: **#${caseId}**`
          )
        ]
      });
    }
    if (command === "warnings") {
      const user = interaction.options.getUser("user");
      const warnings = getWarnings(interaction.guild.id, user.id);
      if (!warnings.length) {
        return interaction.reply({
          embeds: [info("Warnings", `${user} has no warnings.`)]
        });
      }
      const text = warnings
        .slice(-15)
        .map(
          (w, i) =>
            `**${i + 1}.** ${w.reason} — <@${w.moderatorId}>`
        )
        .join("\n");
      return interaction.reply({
        embeds: [warning("Warnings", `${user}\n\n${text}`)]
      });
    }
    if (command === "clearwarnings") {
      const user = interaction.options.getUser("user");
      clearWarnings(interaction.guild.id, user.id);
      return interaction.reply({
        embeds: [success("Warnings Cleared", `Cleared warnings for ${user}.`)]
      });
    }
    if (command === "cases") {
      const user = interaction.options.getUser("user");
      const cases = getCases(interaction.guild.id, user.id);
      if (!cases.length) {
        return interaction.reply({
          embeds: [info("Cases", "No cases found.")]
        });
      }
      const text = cases
        .slice(0, 15)
        .map(
          c =>
            `**#${c.id}** • ${c.type} • <@${c.moderatorId}> • ${c.reason}`
        )
        .join("\n");
      return interaction.reply({
        embeds: [info("Moderation Cases", text)]
      });
    }
    if (command === "case") {
      const id = interaction.options.getInteger("id");
      const all = read(DB.cases);
      const data = all[interaction.guild.id]?.[id];
      if (!data) {
        return interaction.reply({
          embeds: [errorEmbed("Case not found.")],
          flags: MessageFlags.Ephemeral
        });
      }
      return interaction.reply({
        embeds: [
          info(
            `Case #${id}`,
            [
              `Type: **${data.type}**`,
              `User: <@${data.userId}>`,
              `Moderator: <@${data.moderatorId}>`,
              `Reason: **${data.reason}**`,
              `Date: <t:${Math.floor(data.timestamp / 1000)}:F>`
            ].join("\n")
          )
        ]
      });
    }
    if (command === "purge") {
      const amount = interaction.options.getInteger("amount");
      const user = interaction.options.getUser("user");
      if (!interaction.channel.isTextBased()) {
        return interaction.reply({
          embeds: [errorEmbed("This command can only be used in a text channel.")],
          flags: MessageFlags.Ephemeral
        });
      }
      const messages = await interaction.channel.messages.fetch({
        limit: 100
      });
      let selected = [...messages.values()].slice(0, amount);
      if (user) {
        selected = selected.filter(m => m.author.id === user.id).slice(0, amount);
      }
      const deletable = selected.filter(
        m => Date.now() - m.createdTimestamp < 14 * 86400000
      );
      await interaction.channel.bulkDelete(deletable, true);
      return interaction.reply({
        embeds: [
          success(
            "Messages Purged",
            `Deleted **${deletable.size || deletable.length}** message(s).`
          )
        ],
        flags: MessageFlags.Ephemeral
      });
    }
    if (command === "lock" || command === "unlock") {
      const everyone = interaction.guild.roles.everyone;
      await interaction.channel.permissionOverwrites.edit(
        everyone,
        {
          SendMessages: command === "unlock"
        },
        {
          reason: `Vyne ${command}`
        }
      );
      return interaction.reply({
        embeds: [
          success(
            command === "lock" ? "Channel Locked" : "Channel Unlocked",
            `${interaction.channel} has been ${command === "lock" ? "locked" : "unlocked"}.`
          )
        ]
      });
    }
    if (command === "slowmode") {
      const seconds = interaction.options.getInteger("seconds");
      await interaction.channel.setRateLimitPerUser(seconds);
      return interaction.reply({
        embeds: [
          success(
            "Slowmode Updated",
            `Slowmode is now **${seconds}s**.`
          )
        ]
      });
    }
    if (command === "nick") {
      const user = interaction.options.getUser("user");
      const nickname = interaction.options.getString("nickname");
      const member = await interaction.guild.members.fetch(user.id);
      const check = canModerate(
        interaction.member,
        member,
        interaction.guild.members.me
      );
      if (!check.allowed) {
        return interaction.reply({
          embeds: [errorEmbed(check.reason)],
          flags: MessageFlags.Ephemeral
        });
      }
      await member.setNickname(nickname);
      return interaction.reply({
        embeds: [success("Nickname Updated", `${user} is now **${nickname}**.`)]
      });
    }
    if (command === "role") {
      const sub = interaction.options.getSubcommand();
      if (sub === "create") {
        const name = interaction.options.getString("name");
        const role = await interaction.guild.roles.create({
          name,
          reason: `Created by ${interaction.user.tag}`
        });
        return interaction.reply({
          embeds: [success("Role Created", `${role} was created.`)]
        });
      }
      const user = interaction.options.getUser("user");
      const role = interaction.options.getRole("role");
      const member = await interaction.guild.members.fetch(user.id);
      if (role.position >= interaction.member.roles.highest.position &&
          interaction.guild.ownerId !== interaction.user.id) {
        return interaction.reply({
          embeds: [errorEmbed("You cannot manage a role equal to or higher than your highest role.")],
          flags: MessageFlags.Ephemeral
        });
      }
      if (role.position >= interaction.guild.members.me.roles.highest.position) {
        return interaction.reply({
          embeds: [errorEmbed("My highest role must be above that role.")],
          flags: MessageFlags.Ephemeral
        });
      }
      if (sub === "add") {
        await member.roles.add(role);
      } else {
        await member.roles.remove(role);
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
    if (command === "userinfo") {
      const user = interaction.options.getUser("user") || interaction.user;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      return interaction.reply({
        embeds: [
          info(
            `User Info • ${user.username}`,
            [
              `User: ${user}`,
              `ID: \`${user.id}\``,
              `Created: <t:${Math.floor(user.createdTimestamp / 1000)}:F>`,
              member
                ? `Joined: <t:${Math.floor(member.joinedTimestamp / 1000)}:F>`
                : "Member: Not in server"
            ].join("\n")
          ).setThumbnail(user.displayAvatarURL({ size: 512 }))
        ]
      });
    }
    if (command === "serverinfo") {
      const guild = interaction.guild;
      return interaction.reply({
        embeds: [
          info(
            guild.name,
            [
              `Owner: <@${guild.ownerId}>`,
              `Members: **${guild.memberCount}**`,
              `Channels: **${guild.channels.cache.size}**`,
              `Roles: **${guild.roles.cache.size}**`,
              `Created: <t:${Math.floor(guild.createdTimestamp / 1000)}:F>`
            ].join("\n")
          ).setThumbnail(guild.iconURL({ size: 512 }) || null)
        ]
      });
    }
    if (command === "channelinfo") {
      const channel = interaction.channel;
      return interaction.reply({
        embeds: [
          info(
            "Channel Info",
            [
              `Name: **${channel.name}**`,
              `ID: \`${channel.id}\``,
              `Type: **${channel.type}**`,
              `Created: <t:${Math.floor(channel.createdTimestamp / 1000)}:F>`
            ].join("\n")
          )
        ]
      });
    }
    if (command === "roleinfo") {
      const role = interaction.options.getRole("role");
      return interaction.reply({
        embeds: [
          info(
            `Role Info • ${role.name}`,
            [
              `ID: \`${role.id}\``,
              `Position: **${role.position}**`,
              `Members: **${role.members.size}**`,
              `Mentionable: **${role.mentionable}**`,
              `Managed: **${role.managed}**`
            ].join("\n")
          )
        ]
      });
    }
    if (command === "avatar") {
      const user = interaction.options.getUser("user") || interaction.user;
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`${user.username}'s Avatar`)
            .setImage(user.displayAvatarURL({ size: 1024 }))
            .setTimestamp()
        ]
      });
    }
    if (command === "ping") {
      return interaction.reply({
        embeds: [
          info(
            "Vyne Ping",
            `Bot latency: **${client.ws.ping}ms**\nAPI response: **${Date.now() - interaction.createdTimestamp}ms**`
          )
        ]
      });
    }
    if (command === "help") {
      return interaction.reply({
        embeds: [
          info(
            "Vyne Help",
            [
              "**Moderation**",
              "`/ban` `/unban` `/kick` `/timeout` `/untimeout`",
              "`/warn` `/warnings` `/clearwarnings` `/cases` `/case`",
              "`/purge` `/lock` `/unlock` `/slowmode` `/nick` `/role`",
              "",
              "**Security**",
              "`/automod` `/raid` `/verify`",
              "",
              "**Community**",
              "`/ticket` `/giveaway` `/remind` `/notify`",
              "`/level` `/leaderboard` `/balance` `/daily` `/pay`",
              "",
              "**Info**",
              "`/userinfo` `/serverinfo` `/channelinfo` `/roleinfo` `/avatar` `/ping`",
              "",
              "**System**",
              "`/sys pull` `/sys restart` `/sys status` `/sys logs` `/sys info`"
            ].join("\n")
          )
        ]
      });
    }
    if (command === "logchannel") {
      const channel = interaction.options.getChannel("channel");
      const config = getConfig(interaction.guild.id);
      config.logChannelId = channel.id;
      saveConfig(interaction.guild.id, config);
      return interaction.reply({
        embeds: [success("Log Channel Set", `Logs will be sent to ${channel}.`)]
      });
    }
    if (command === "modrole") {
      const role = interaction.options.getRole("role");
      const config = getConfig(interaction.guild.id);
      config.modRoleId = role.id;
      saveConfig(interaction.guild.id, config);
      return interaction.reply({
        embeds: [success("Moderator Role Set", `Moderator role: ${role}`)]
      });
    }
    if (command === "config") {
      const config = getConfig(interaction.guild.id);
      return interaction.reply({
        embeds: [
          info(
            "Vyne Configuration",
            [
              `Log channel: ${config.logChannelId ? `<#${config.logChannelId}>` : "Not set"}`,
              `Mod role: ${config.modRoleId ? `<@&${config.modRoleId}>` : "Not set"}`,
              `AutoMod: **${config.automod.enabled}**`,
              `Raid protection: **${config.raid.enabled}**`,
              `Verification: **${config.verification.enabled}**`,
              `Tickets: **${Boolean(config.tickets.categoryId)}**`,
              `Leveling: **${config.leveling.enabled}**`,
              `Economy: **${config.economy.enabled}**`
            ].join("\n")
          )
        ]
      });
    }
    if (command === "automod") {
      return interaction.reply({
        embeds: [
          info(
            "Vyne AutoMod",
            "Use the menu below to toggle AutoMod modules."
          )
        ],
        components: [automodMenu()],
        flags: MessageFlags.Ephemeral
      });
    }
    if (command === "raid") {
      const sub = interaction.options.getSubcommand();
      const config = getConfig(interaction.guild.id);
      if (sub === "on") config.raid.enabled = true;
      if (sub === "off") config.raid.enabled = false;
      saveConfig(interaction.guild.id, config);
      return interaction.reply({
        embeds: [
          info(
            "Raid Protection",
            `Raid protection is **${config.raid.enabled ? "enabled" : "disabled"}**.`
          )
        ]
      });
    }
    if (command === "verify") {
      const sub = interaction.options.getSubcommand();
      const config = getConfig(interaction.guild.id);
      if (sub === "disable") {
        config.verification.enabled = false;
        saveConfig(interaction.guild.id, config);
        return interaction.reply({
          embeds: [success("Verification Disabled", "Verification is now disabled.")]
        });
      }
      const channel = interaction.options.getChannel("channel");
      const role = interaction.options.getRole("role");
      config.verification.enabled = true;
      config.verification.channelId = channel.id;
      config.verification.roleId = role.id;
      saveConfig(interaction.guild.id, config);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("vyne_verify")
          .setLabel("Verify")
          .setStyle(ButtonStyle.Success)
      );
      await channel.send({
        embeds: [
          info(
            "Server Verification",
            "Click the button below to receive the verified role."
          )
        ],
        components: [row]
      });
      return interaction.reply({
        embeds: [success("Verification Setup", `Verification panel sent to ${channel}.`)]
      });
    }
    if (command === "ticket") {
      const sub = interaction.options.getSubcommand();
      const config = getConfig(interaction.guild.id);
      if (sub === "setup") {
        const staffRole = interaction.options.getRole("staff_role");
        const category = interaction.options.getChannel("category");
        config.tickets.staffRoleId = staffRole.id;
        config.tickets.categoryId = category.id;
        saveConfig(interaction.guild.id, config);
        return interaction.reply({
          embeds: [
            success(
              "Ticket System Configured",
              `Staff role: ${staffRole}\nCategory: ${category}`
            )
          ]
        });
      }
      if (sub === "panel") {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("vyne_ticket_create")
            .setLabel("Create Ticket")
            .setStyle(ButtonStyle.Primary)
        );
        await interaction.channel.send({
          embeds: [
            info(
              "Support Tickets",
              "Need help? Click **Create Ticket** to open a private support channel."
            )
          ],
          components: [row]
        });
        return interaction.reply({
          embeds: [success("Panel Sent", "Ticket panel created.")],
          flags: MessageFlags.Ephemeral
        });
      }
      if (sub === "close") {
        if (!interaction.channel.name.startsWith("ticket-")) {
          return interaction.reply({
            embeds: [errorEmbed("This is not a ticket channel.")],
            flags: MessageFlags.Ephemeral
          });
        }
        await interaction.reply({
          embeds: [success("Ticket Closed", "Deleting this channel in 5 seconds.")]
        });
        setTimeout(() => {
          interaction.channel.delete().catch(() => {});
        }, 5000);
        return;
      }
    }
    if (command === "giveaway") {
      const sub = interaction.options.getSubcommand();
      const giveaways = read(DB.giveaways);
      if (sub === "start") {
        const minutes = interaction.options.getInteger("minutes");
        const prize = interaction.options.getString("prize");
        const endAt = Date.now() + minutes * 60000;
        const message = await interaction.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xffd700)
              .setTitle("🎉 Giveaway")
              .setDescription(
                `**Prize:** ${prize}\n\nReact with 🎉 to enter.\nEnds <t:${Math.floor(endAt / 1000)}:R>`
              )
              .setTimestamp(endAt)
          ]
        });
        await message.react("🎉");
        giveaways[message.id] = {
          guildId: interaction.guild.id,
          channelId: interaction.channel.id,
          prize,
          endAt,
          ended: false
        };
        write(DB.giveaways, giveaways);
        return interaction.reply({
          embeds: [success("Giveaway Started", `Giveaway message: ${message}`)],
          flags: MessageFlags.Ephemeral
        });
      }
      const messageId = interaction.options.getString("message_id");
      const giveaway = giveaways[messageId];
      if (!giveaway) {
        return interaction.reply({
          embeds: [errorEmbed("Giveaway not found.")],
          flags: MessageFlags.Ephemeral
        });
      }
      const channel = interaction.guild.channels.cache.get(giveaway.channelId);
      const message = await channel?.messages.fetch(messageId).catch(() => null);
      if (!message) {
        return interaction.reply({
          embeds: [errorEmbed("Giveaway message not found.")],
          flags: MessageFlags.Ephemeral
        });
      }
      const reaction = message.reactions.cache.get("🎉");
      if (!reaction) {
        return interaction.reply({
          embeds: [errorEmbed("Nobody entered the giveaway.")],
          flags: MessageFlags.Ephemeral
        });
      }
      const users = await reaction.users.fetch();
      const eligible = users.filter(u => !u.bot);
      if (!eligible.size) {
        return interaction.reply({
          embeds: [errorEmbed("Nobody entered the giveaway.")],
          flags: MessageFlags.Ephemeral
        });
      }
      const winner = eligible.random();
      if (sub === "end") {
        giveaway.ended = true;
        write(DB.giveaways, giveaways);
      }
      return interaction.reply({
        embeds: [
          success(
            sub === "reroll" ? "Giveaway Rerolled" : "Giveaway Ended",
            `🎉 Winner: ${winner}\n**Prize:** ${giveaway.prize}`
          )
        ]
      });
    }
    if (command === "remind") {
      const durationText = interaction.options.getString("duration");
      const text = interaction.options.getString("text");
      const ms = parseDuration(durationText);
      if (!ms) {
        return interaction.reply({
          embeds: [errorEmbed("Invalid duration. Use `10m`, `1h`, `1d`, etc.")],
          flags: MessageFlags.Ephemeral
        });
      }
      const reminders = read(DB.reminders);
      const id = `${interaction.user.id}-${Date.now()}`;
      reminders[id] = {
        userId: interaction.user.id,
        channelId: interaction.channel.id,
        guildId: interaction.guild.id,
        text,
        executeAt: Date.now() + ms
      };
      write(DB.reminders, reminders);
      return interaction.reply({
        embeds: [
          success(
            "Reminder Created",
            `I'll remind you in **${formatDuration(ms)}**.`
          )
        ],
        flags: MessageFlags.Ephemeral
      });
    }
    if (command === "notify") {
      const sub = interaction.options.getSubcommand();
      const config = getConfig(interaction.guild.id);
      if (sub === "set") {
        const channel = interaction.options.getChannel("channel");
        config.notifications.channelId = channel.id;
        saveConfig(interaction.guild.id, config);
        return interaction.reply({
          embeds: [success("Notifications Set", `Notification channel: ${channel}`)]
        });
      }
      const channel = config.notifications.channelId
        ? interaction.guild.channels.cache.get(config.notifications.channelId)
        : null;
      if (!channel) {
        return interaction.reply({
          embeds: [errorEmbed("No notification channel is configured.")],
          flags: MessageFlags.Ephemeral
        });
      }
      await channel.send({
        embeds: [success("Vyne Notification Test", "Notifications are working.")]
      });
      return interaction.reply({
        embeds: [success("Notification Sent", `Test sent to ${channel}.`)],
        flags: MessageFlags.Ephemeral
      });
    }
    if (command === "level" || command === "leaderboard") {
      const levels = read(DB.levels);
      const guildData = levels[interaction.guild.id] || {};
      if (command === "level") {
        const user =
          interaction.options.getUser("user") || interaction.user;
        const data = guildData[user.id] || { xp: 0, level: 0 };
        return interaction.reply({
          embeds: [
            info(
              "Level",
              `${user} is **Level ${data.level}** with **${data.xp} XP**.`
            )
          ]
        });
      }
      const rows = Object.entries(guildData)
        .sort((a, b) => (b[1].xp || 0) - (a[1].xp || 0))
        .slice(0, 10)
        .map(
          ([id, data], i) =>
            `**${i + 1}.** <@${id}> — Level **${data.level || 0}**, XP **${data.xp || 0}**`
        );
      return interaction.reply({
        embeds: [
          info(
            "XP Leaderboard",
            rows.length ? rows.join("\n") : "No XP data yet."
          )
        ]
      });
    }
    if (command === "balance") {
      const user =
        interaction.options.getUser("user") || interaction.user;
      const economy = read(DB.economy);
      economy[interaction.guild.id] ??= {};
      economy[interaction.guild.id][user.id] ??= {
        balance: 0,
        lastDaily: 0
      };
      write(DB.economy, economy);
      return interaction.reply({
        embeds: [
          info(
            "Balance",
            `${user} has **${economy[interaction.guild.id][user.id].balance}** coins.`
          )
        ]
      });
    }
    if (command === "daily") {
      const economy = read(DB.economy);
      economy[interaction.guild.id] ??= {};
      economy[interaction.guild.id][interaction.user.id] ??= {
        balance: 0,
        lastDaily: 0
      };
      const data = economy[interaction.guild.id][interaction.user.id];
      if (Date.now() - data.lastDaily < 86400000) {
        return interaction.reply({
          embeds: [errorEmbed("You have already claimed your daily reward.")],
          flags: MessageFlags.Ephemeral
        });
      }
      data.balance += 500;
      data.lastDaily = Date.now();
      write(DB.economy, economy);
      return interaction.reply({
        embeds: [success("Daily Reward", "You received **500** coins.")]
      });
    }
    if (command === "pay") {
      const user = interaction.options.getUser("user");
      const amount = interaction.options.getInteger("amount");
      if (user.id === interaction.user.id) {
        return interaction.reply({
          embeds: [errorEmbed("You cannot pay yourself.")],
          flags: MessageFlags.Ephemeral
        });
      }
      const economy = read(DB.economy);
      economy[interaction.guild.id] ??= {};
      economy[interaction.guild.id][interaction.user.id] ??= {
        balance: 0,
        lastDaily: 0
      };
      economy[interaction.guild.id][user.id] ??= {
        balance: 0,
        lastDaily: 0
      };
      const sender = economy[interaction.guild.id][interaction.user.id];
      const receiver = economy[interaction.guild.id][user.id];
      if (sender.balance < amount) {
        return interaction.reply({
          embeds: [errorEmbed("You do not have enough coins.")],
          flags: MessageFlags.Ephemeral
        });
      }
      sender.balance -= amount;
      receiver.balance += amount;
      write(DB.economy, economy);
      return interaction.reply({
        embeds: [
          success("Payment Sent", `Sent **${amount}** coins to ${user}.`)
        ]
      });
    }
    if (command === "announce") {
      const message = interaction.options.getString("message");
      await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle("📢 Announcement")
            .setDescription(message)
            .setFooter({ text: `By ${interaction.user.tag}` })
            .setTimestamp()
        ]
      });
      return interaction.reply({
        embeds: [success("Announcement Sent", "Announcement posted.")],
        flags: MessageFlags.Ephemeral
      });
    }
    if (command === "sys") {
      if (!VYNE_OWNER_ID || interaction.user.id !== VYNE_OWNER_ID) {
        return interaction.reply({
          embeds: [errorEmbed("Owner only.")],
          flags: MessageFlags.Ephemeral
        });
      }
      const sub = interaction.options.getSubcommand();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const deployment = await getVyneDeployment();
        if (sub === "pull") {
          const result = await hostingRequest(
            `/deployments/${deployment.id}/sync`,
            { method: "POST" }
          );
          return interaction.editReply({
            embeds: [
              success(
                "GitHub Pull Requested",
                `Latest GitHub code was requested for **${deployment.name}**.\n\n\`\`\`json\n${truncate(
                  JSON.stringify(result, null, 2),
                  1500
                )}\n\`\`\``
              )
            ]
          });
        }
        if (sub === "restart") {
          const result = await hostingRequest(
            `/deployments/${deployment.id}/power`,
            {
              method: "POST",
              body: JSON.stringify({
                action: "restart",
                waitSeconds: 10
              })
            }
          );
          return interaction.editReply({
            embeds: [
              success(
                "Restart Requested",
                `Vyne restart requested.\n\n\`\`\`json\n${truncate(
                  JSON.stringify(result, null, 2),
                  1500
                )}\n\`\`\``
              )
            ]
          });
        }
        if (sub === "status") {
          const result = await hostingRequest(
            `/deployments/${deployment.id}/diagnose`
          );
          return interaction.editReply({
            embeds: [
              info(
                "Vyne Status",
                `\`\`\`json\n${truncate(
                  JSON.stringify(result, null, 2),
                  1800
                )}\n\`\`\``
              )
            ]
          });
        }
        if (sub === "logs") {
          const result = await hostingRequest(
            `/deployments/${deployment.id}/logs?size=1200`
          );
          return interaction.editReply({
            embeds: [
              info(
                "Vyne Logs",
                `\`\`\`\n${truncate(
                  JSON.stringify(result, null, 2),
                  1800
                )}\n\`\`\``
              )
            ]
          });
        }
        if (sub === "info") {
          const result = await hostingRequest(
            `/deployments/${deployment.id}`
          );
          return interaction.editReply({
            embeds: [
              info(
                "Vyne Deployment",
                `\`\`\`json\n${truncate(
                  JSON.stringify(result, null, 2),
                  1800
                )}\n\`\`\``
              )
            ]
          });
        }
      } catch (err) {
        return interaction.editReply({
          embeds: [errorEmbed(err.message)]
        });
      }
    }
  } catch (err) {
    console.error("Interaction error:", err);
    const reply = {
      embeds: [errorEmbed("An unexpected error occurred.")],
      flags: MessageFlags.Ephemeral
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});
const spamTracker = new Map();
const duplicateTracker = new Map();
const raidTracker = new Map();
client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;
  const config = getConfig(message.guild.id);
  if (config.leveling.enabled) {
    const levels = read(DB.levels);
    levels[message.guild.id] ??= {};
    levels[message.guild.id][message.author.id] ??= {
      xp: 0,
      level: 0
    };
    const data = levels[message.guild.id][message.author.id];
    data.xp += config.leveling.xpPerMessage;
    const newLevel = Math.floor(data.xp / 100);
    if (newLevel > data.level) {
      data.level = newLevel;
      message.channel.send({
        embeds: [
          success(
            "Level Up",
            `${message.author} reached **Level ${newLevel}**!`
          )
        ]
      }).catch(() => {});
    }
    write(DB.levels, levels);
  }
  if (!config.automod.enabled) return;
  if (isModerator(message.member)) return;
  const content = message.content || "";
  const now = Date.now();
  if (
    config.automod.antiLinks &&
    /https?:\/\/\S+/i.test(content)
  ) {
    await message.delete().catch(() => {});
    await message.channel.send({
      embeds: [
        warning(
          "AutoMod",
          `${message.author}, links are not allowed here.`
        )
      ]
    }).then(m => setTimeout(() => m.delete().catch(() => {}), 5000))
      .catch(() => {});
    return;
  }
  if (
    config.automod.antiInvites &&
    /(discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]+/i.test(content)
  ) {
    await message.delete().catch(() => {});
    return;
  }
  if (
    config.automod.antiMentionSpam &&
    message.mentions.users.size >= config.automod.maxMentions
  ) {
    await message.delete().catch(() => {});
    await message.member.timeout(
      config.automod.timeoutDuration,
      "Vyne AutoMod mention spam"
    ).catch(() => {});
    return;
  }
  if (
    config.automod.badWords &&
    config.automod.blockedWords.some(word =>
      content.toLowerCase().includes(word.toLowerCase())
    )
  ) {
    await message.delete().catch(() => {});
    return;
  }
  if (
    config.automod.excessiveCaps &&
    content.length >= 12
  ) {
    const letters = content.replace(/[^a-z]/gi, "");
    const upper = letters.replace(/[^A-Z]/g, "");
    if (letters.length >= 8 && upper.length / letters.length >= 0.8) {
      await message.delete().catch(() => {});
      return;
    }
  }
  if (
    config.automod.massEmoji &&
    (content.match(/\p{Extended_Pictographic}/gu) || []).length >= 12
  ) {
    await message.delete().catch(() => {});
    return;
  }
  if (config.automod.duplicateMessages && content.length > 5) {
    const key = `${message.guild.id}:${message.author.id}`;
    const previous = duplicateTracker.get(key);
    if (
      previous &&
      previous.content === content &&
      now - previous.time < 10000
    ) {
      await message.delete().catch(() => {});
      return;
    }
    duplicateTracker.set(key, {
      content,
      time: now
    });
  }
  if (config.automod.antiSpam) {
    const key = `${message.guild.id}:${message.author.id}`;
    const arr = spamTracker.get(key) || [];
    arr.push(now);
    const filtered = arr.filter(
      t => now - t <= config.automod.spamWindow
    );
    spamTracker.set(key, filtered);
    if (filtered.length >= config.automod.spamMessages) {
      await message.member.timeout(
        config.automod.timeoutDuration,
        "Vyne AutoMod spam"
      ).catch(() => {});
      spamTracker.delete(key);
      await sendLog(
        message.guild,
        warning(
          "AutoMod Action",
          `${message.author} was timed out for spam.`
        )
      );
    }
  }
});
client.on("guildMemberAdd", async member => {
  const config = getConfig(member.guild.id);
  if (!config.raid.enabled) return;
  const now = Date.now();
  const list = raidTracker.get(member.guild.id) || [];
  list.push(now);
  const filtered = list.filter(
    t => now - t <= config.raid.window
  );
  raidTracker.set(member.guild.id, filtered);
  const accountAge = now - member.user.createdTimestamp;
  if (accountAge < config.raid.accountAge) {
    await sendLog(
      member.guild,
      warning(
        "Raid Protection",
        `${member.user} joined with a young account.`
      )
    );
  }
  if (filtered.length >= config.raid.joins) {
    await sendLog(
      member.guild,
      warning(
        "Raid Detected",
        `Detected **${filtered.length}** joins within the configured window.`
      )
    );
    if (config.raid.lockdown) {
      const everyone = member.guild.roles.everyone;
      for (const channel of member.guild.channels.cache.values()) {
        if (!channel.isTextBased()) continue;
        channel.permissionOverwrites.edit(everyone, {
          SendMessages: false
        }).catch(() => {});
      }
    }
  }
});
client.on("guildMemberRemove", async member => {
  await sendLog(
    member.guild,
    info(
      "Member Left",
      `${member.user.tag} (${member.id}) left the server.`
    )
  );
});
client.on("messageDelete", async message => {
  if (!message.guild || message.author?.bot) return;
  await sendLog(
    message.guild,
    warning(
      "Message Deleted",
      `Author: ${message.author || "Unknown"}\nChannel: ${message.channel}\nContent: ${truncate(message.content || "[no content]", 700)}`
    )
  );
});
client.on("messageUpdate", async (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot) return;
  if (oldMessage.content === newMessage.content) return;
  await sendLog(
    newMessage.guild,
    info(
      "Message Edited",
      `Author: ${newMessage.author}\nChannel: ${newMessage.channel}\nBefore: ${truncate(oldMessage.content || "[none]", 400)}\nAfter: ${truncate(newMessage.content || "[none]", 400)}`
    )
  );
});
client.on("voiceStateUpdate", async (oldState, newState) => {
  if (oldState.channelId === newState.channelId) return;
  const member = newState.member || oldState.member;
  let text;
  if (!oldState.channelId && newState.channelId) {
    text = `${member.user.tag} joined <#${newState.channelId}>.`;
  } else if (oldState.channelId && !newState.channelId) {
    text = `${member.user.tag} left <#${oldState.channelId}>.`;
  } else {
    text = `${member.user.tag} moved from <#${oldState.channelId}> to <#${newState.channelId}>.`;
  }
  await sendLog(newState.guild || oldState.guild, info("Voice Update", text));
});
setInterval(async () => {
  const reminders = read(DB.reminders);
  let changed = false;
  for (const [id, reminder] of Object.entries(reminders)) {
    if (Date.now() < reminder.executeAt) continue;
    const channel = client.channels.cache.get(reminder.channelId);
    if (channel?.isTextBased()) {
      await channel.send({
        content: `<@${reminder.userId}>`,
        embeds: [
          info("⏰ Reminder", reminder.text)
        ]
      }).catch(() => {});
    }
    delete reminders[id];
    changed = true;
  }
  if (changed) write(DB.reminders, reminders);
}, 10000);
setInterval(async () => {
  const giveaways = read(DB.giveaways);
  let changed = false;
  for (const [messageId, giveaway] of Object.entries(giveaways)) {
    if (giveaway.ended || Date.now() < giveaway.endAt) continue;
    const guild = client.guilds.cache.get(giveaway.guildId);
    const channel = guild?.channels.cache.get(giveaway.channelId);
    const message = await channel?.messages
      .fetch(messageId)
      .catch(() => null);
    if (!message) {
      giveaway.ended = true;
      changed = true;
      continue;
    }
    const reaction = message.reactions.cache.get("🎉");
    if (!reaction) {
      giveaway.ended = true;
      changed = true;
      continue;
    }
    const users = await reaction.users.fetch();
    const eligible = users.filter(u => !u.bot);
    const winner = eligible.size ? eligible.random() : null;
    await channel.send({
      embeds: [
        success(
          "Giveaway Ended",
          winner
            ? `🎉 Winner: ${winner}\n**Prize:** ${giveaway.prize}`
            : `Nobody entered.\n**Prize:** ${giveaway.prize}`
        )
      ]
    }).catch(() => {});
    giveaway.ended = true;
    changed = true;
  }
  if (changed) write(DB.giveaways, giveaways);
}, 15000);
function automodMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("vyne_automod_select")
      .setPlaceholder("Choose an AutoMod module")
      .addOptions(
        {
          label: "Toggle AutoMod",
          value: "toggle",
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
          label: "Bad Words",
          value: "words",
          emoji: "🤬"
        },
        {
          label: "Mention Spam",
          value: "mentions",
          emoji: "📢"
        },
        {
          label: "Duplicate Messages",
          value: "duplicate",
          emoji: "📋"
        }
      )
  );
}
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📌 Client ID: ${CLIENT_ID}`);
  console.log(`📌 Guild ID: ${GUILD_ID}`);
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    const registered = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log(`✅ Registered ${registered.length} guild commands.`);
  } catch (err) {
    console.error("❌ Command registration failed:", err);
  }
});
client.on("error", error => {
  console.error("Discord client error:", error);
});
process.on("unhandledRejection", error => {
  console.error("Unhandled rejection:", error);
});
process.on("uncaughtException", error => {
  console.error("Uncaught exception:", error);
});
client.login(TOKEN).catch(error => {
  console.error("❌ Discord login failed:", error);
});
