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
  ButtonStyle
} = require("discord.js");

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const BOT_HOSTING_API_KEY =
  process.env.BOT_HOSTING_API_KEY;

const VYNE_OWNER_ID =
  process.env.VYNE_OWNER_ID;

const BOT_HOSTING_API =
  "https://bot-hosting.net/api/v1";

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error(
    "❌ Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID"
  );
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
  partials: [
    Partials.Message,
    Partials.Channel
  ]
});

const dataDir = path.join(
  __dirname,
  "..",
  "data"
);

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, {
    recursive: true
  });
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
  reactionRoles: path.join(
    dataDir,
    "reaction-roles.json"
  )
};

for (const file of Object.values(DB)) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "{}");
  }
}

function read(file) {
  try {
    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );
  } catch {
    return {};
  }
}

function write(file, data) {
  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2)
  );
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
    return `${Math.floor(
      ms / 604800000
    )}w`;
  }

  if (ms >= 86400000) {
    return `${Math.floor(
      ms / 86400000
    )}d`;
  }

  if (ms >= 3600000) {
    return `${Math.floor(
      ms / 3600000
    )}h`;
  }

  if (ms >= 60000) {
    return `${Math.floor(
      ms / 60000
    )}m`;
  }

  return `${Math.floor(
    ms / 1000
  )}s`;
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

  return Object.values(
    all[guildId] || {}
  )
    .filter(
      x => !userId || x.userId === userId
    )
    .sort(
      (a, b) =>
        b.timestamp - a.timestamp
    );
}

function isModerator(member) {
  if (!member) return false;

  if (
    member.permissions.has(
      PermissionFlagsBits.Administrator
    ) ||
    member.permissions.has(
      PermissionFlagsBits.ManageGuild
    )
  ) {
    return true;
  }

  const config =
    getConfig(member.guild.id);

  return (
    config.modRoleId &&
    member.roles.cache.has(
      config.modRoleId
    )
  );
}

function canModerate(
  actor,
  target,
  botMember
) {
  if (!target) {
    return {
      allowed: false,
      reason: "Member not found."
    };
  }

  if (target.id === actor.id) {
    return {
      allowed: false,
      reason:
        "You cannot moderate yourself."
    };
  }

  if (
    target.id ===
    target.guild.ownerId
  ) {
    return {
      allowed: false,
      reason:
        "You cannot moderate the server owner."
    };
  }

  if (
    actor.id !== target.guild.ownerId &&
    target.roles.highest.position >=
      actor.roles.highest.position
  ) {
    return {
      allowed: false,
      reason:
        "That member has an equal or higher role than you."
    };
  }

  if (
    botMember &&
    target.roles.highest.position >=
      botMember.roles.highest.position
  ) {
    return {
      allowed: false,
      reason:
        "My highest role must be above the target."
    };
  }

  return {
    allowed: true
  };
}

async function sendLog(
  guild,
  embed
) {
  try {
    const config =
      getConfig(guild.id);

    if (!config.logChannelId) {
      return;
    }

    const channel =
      guild.channels.cache.get(
        config.logChannelId
      );

    if (channel?.isTextBased()) {
      await channel.send({
        embeds: [embed]
      });
    }
  } catch (err) {
    console.error(
      "Log error:",
      err.message
    );
  }
}

async function dmUser(
  member,
  text
) {
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

async function hostingRequest(
  endpoint,
  options = {}
) {
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

  const text =
    await response.text();

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
      x =>
        x.name ===
        "Vyne Moderation"
    ) ||
    deployments[0];

  if (!deployment) {
    throw new Error(
      "Vyne Moderation deployment was not found."
    );
  }

  return deployment;
}

const commands = [

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription(
      "Ban a member"
    )
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
    .setDescription(
      "Unban a user"
    )
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
    .setDescription(
      "Kick a member"
    )
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
    .setDescription(
      "Timeout a member"
    )
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Member")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("duration")
        .setDescription(
          "10m, 1h, 1d"
        )
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason")
        .setDescription("Reason")
    ),

  new SlashCommandBuilder()
    .setName("untimeout")
    .setDescription(
      "Remove timeout"
    )
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
    .setDescription(
      "Warn a member"
    )
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
    .setDescription(
      "View member warnings"
    )
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Member")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("clearwarnings")
    .setDescription(
      "Clear member warnings"
    )
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Member")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("cases")
    .setDescription(
      "View member cases"
    )
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Member")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("case")
    .setDescription(
      "View a moderation case"
    )
    .addIntegerOption(o =>
      o.setName("id")
        .setDescription("Case ID")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("purge")
    .setDescription(
      "Delete messages"
    )
    .addIntegerOption(o =>
      o.setName("amount")
        .setDescription("1-100")
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true)
    )
    .addUserOption(o =>
      o.setName("user")
        .setDescription(
          "Only this user"
        )
    ),

  new SlashCommandBuilder()
    .setName("lock")
    .setDescription(
      "Lock the current channel"
    ),

  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription(
      "Unlock the current channel"
    ),

  new SlashCommandBuilder()
    .setName("slowmode")
    .setDescription(
      "Set channel slowmode"
    )
    .addIntegerOption(o =>
      o.setName("seconds")
        .setDescription(
          "0-21600"
        )
        .setMinValue(0)
        .setMaxValue(21600)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("nick")
    .setDescription(
      "Change a member nickname"
    )
    .addUserOption(o =>
      o.setName("user")
        .setDescription("Member")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("nickname")
        .setDescription(
          "New nickname"
        )
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("role")
    .setDescription(
      "Manage roles"
    )
    .addSubcommand(s =>
      s.setName("add")
        .setDescription(
          "Add a role"
        )
        .addUserOption(o =>
          o.setName("user")
            .setDescription(
              "Member"
            )
            .setRequired(true)
        )
        .addRoleOption(o =>
          o.setName("role")
            .setDescription(
              "Role"
            )
            .setRequired(true)
        )
    )
    .addSubcommand(s =>
      s.setName("remove")
        .setDescription(
          "Remove a role"
        )
        .addUserOption(o =>
          o.setName("user")
            .setDescription(
              "Member"
            )
            .setRequired(true)
        )
        .addRoleOption(o =>
          o.setName("role")
            .setDescription(
              "Role"
            )
            .setRequired(true)
        )
    )
    .addSubcommand(s =>
      s.setName("create")
        .setDescription(
          "Create a role"
        )
        .addStringOption(o =>
          o.setName("name")
            .setDescription(
              "Role name"
            )
            .setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription(
      "User information"
    )
    .addUserOption(o =>
      o.setName("user")
        .setDescription("User")
    ),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription(
      "Server information"
    ),

  new SlashCommandBuilder()
    .setName("channelinfo")
    .setDescription(
      "Current channel information"
    ),

  new SlashCommandBuilder()
    .setName("roleinfo")
    .setDescription(
      "Role information"
    )
    .addRoleOption(o =>
      o.setName("role")
        .setDescription("Role")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription(
      "View avatar"
    )
    .addUserOption(o =>
      o.setName("user")
        .setDescription("User")
    ),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription(
      "Show bot latency"
    ),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription(
      "Show Vyne help"
    ),

  new SlashCommandBuilder()
    .setName("logchannel")
    .setDescription(
      "Set moderation log channel"
    )
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
    .setDescription(
      "Set moderator role"
    )
    .addRoleOption(o =>
      o.setName("role")
        .setDescription(
          "Moderator role"
        )
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("config")
    .setDescription(
      "Open Vyne configuration"
    ),

  new SlashCommandBuilder()
    .setName("automod")
    .setDescription(
      "Open AutoMod control panel"
    ),

  new SlashCommandBuilder()
    .setName("raid")
    .setDescription(
      "Raid protection"
    )
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
        .setDescription(
          "Show status"
        )
    ),

  new SlashCommandBuilder()
    .setName("verify")
    .setDescription(
      "Verification system"
    )
    .addSubcommand(s =>
      s.setName("setup")
        .setDescription(
          "Create verification panel"
        )
        .addChannelOption(o =>
          o.setName("channel")
            .setDescription(
              "Panel channel"
            )
            .addChannelTypes(
              ChannelType.GuildText
            )
            .setRequired(true)
        )
        .addRoleOption(o =>
          o.setName("role")
            .setDescription(
              "Verified role"
            )
            .setRequired(true)
        )
    )
    .addSubcommand(s =>
      s.setName("disable")
        .setDescription(
          "Disable verification"
        )
    ),

  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription(
      "Ticket system"
    )
    .addSubcommand(s =>
      s.setName("setup")
        .setDescription(
          "Configure tickets"
        )
        .addRoleOption(o =>
          o.setName("staff_role")
            .setDescription(
              "Staff role"
            )
            .setRequired(true)
        )
        .addChannelOption(o =>
          o.setName("category")
            .setDescription(
              "Ticket category"
            )
            .addChannelTypes(
              ChannelType.GuildCategory
            )
            .setRequired(true)
        )
    )
    .addSubcommand(s =>
      s.setName("panel")
        .setDescription(
          "Send ticket panel"
        )
    )
    .addSubcommand(s =>
      s.setName("close")
        .setDescription(
          "Close current ticket"
        )
    ),

  new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription(
      "Giveaway system"
    )
    .addSubcommand(s =>
      s.setName("start")
        .setDescription(
          "Start giveaway"
        )
        .addIntegerOption(o =>
          o.setName("minutes")
            .setDescription(
              "Duration"
            )
            .setMinValue(1)
            .setRequired(true)
        )
        .addStringOption(o =>
          o.setName("prize")
            .setDescription(
              "Prize"
            )
            .setRequired(true)
        )
    )
    .addSubcommand(s =>
      s.setName("end")
        .setDescription(
          "End giveaway"
        )
        .addStringOption(o =>
          o.setName("message_id")
            .setDescription(
              "Giveaway message ID"
            )
            .setRequired(true)
        )
    )
    .addSubcommand(s =>
      s.setName("reroll")
           if (
          sub ===
          "close"
        ) {
          if (
            !interaction.channel.name.startsWith(
              "ticket-"
            )
          ) {
            return interaction.reply({
              embeds: [
                errorEmbed(
                  "This is not a ticket channel."
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
                "This channel will be deleted in 5 seconds."
              )
            ]
          });

          setTimeout(
            () => {
              interaction.channel
                ?.delete()
                .catch(() => {});
            },
            5000
          );
        }
      }

      if (
        command ===
        "giveaway"
      ) {
        const sub =
          interaction.options.getSubcommand();

        if (
          !isModerator(
            interaction.member
          )
        ) {
          return interaction.reply({
            embeds: [
              errorEmbed(
                "You need moderation permissions."
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        if (
          sub ===
          "start"
        ) {
          const minutes =
            interaction.options.getInteger(
              "minutes"
            );

          const prize =
            interaction.options.getString(
              "prize"
            );

          const endAt =
            Date.now() +
            minutes * 60000;

          const message =
            await interaction.channel.send({
              embeds: [
                new EmbedBuilder()
                  .setColor(
                    0xffd700
                  )
                  .setTitle(
                    "🎉 Giveaway!"
                  )
                  .setDescription(
                    `**Prize:** ${prize}\n\nReact with 🎉 to enter!\n\nEnds <t:${Math.floor(endAt / 1000)}:R>`
                  )
                  .setTimestamp(
                    endAt
                  )
              ]
            });

          await message.react(
            "🎉"
          );

          const giveaways =
            read(DB.giveaways);

          giveaways[
            message.id
          ] = {
            guildId:
              interaction.guild.id,
            channelId:
              interaction.channel.id,
            prize,
            endAt,
            ended:
              false
          };

          write(
            DB.giveaways,
            giveaways
          );

          return interaction.reply({
            embeds: [
              success(
                "Giveaway Started",
                `Giveaway message: ${message}`
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        if (
          sub ===
          "end"
        ) {
          const messageId =
            interaction.options.getString(
              "message_id"
            );

          const giveaways =
            read(DB.giveaways);

          const giveaway =
            giveaways[
              messageId
            ];

          if (!giveaway) {
            return interaction.reply({
              embeds: [
                errorEmbed(
                  "Giveaway not found."
                )
              ],
              flags:
                MessageFlags.Ephemeral
            });
          }

          giveaway.ended =
            true;

          write(
            DB.giveaways,
            giveaways
          );

          const channel =
            interaction.guild.channels.cache.get(
              giveaway.channelId
            );

          const message =
            await channel?.messages
              .fetch(messageId)
              .catch(() => null);

          if (!message) {
            return interaction.reply({
              embeds: [
                errorEmbed(
                  "Giveaway message not found."
                )
              ],
              flags:
                MessageFlags.Ephemeral
            });
          }

          const reaction =
            message.reactions.cache.get(
              "🎉"
            );

          if (!reaction) {
            return interaction.reply({
              embeds: [
                errorEmbed(
                  "Nobody entered the giveaway."
                )
              ]
            });
          }

          const users =
            await reaction.users.fetch();

          const eligible =
            users.filter(
              u => !u.bot
            );

          if (
            !eligible.size
          ) {
            return interaction.reply({
              embeds: [
                errorEmbed(
                  "Nobody entered the giveaway."
                )
              ]
            });
          }

          const winner =
            eligible.random();

          return interaction.reply({
            embeds: [
              success(
                "Giveaway Ended",
                `🎉 Winner: ${winner}\n**Prize:** ${giveaway.prize}`
              )
            ]
          });
        }

        if (
          sub ===
          "reroll"
        ) {
          const messageId =
            interaction.options.getString(
              "message_id"
            );

          const giveaways =
            read(DB.giveaways);

          const giveaway =
            giveaways[
              messageId
            ];

          if (!giveaway) {
            return interaction.reply({
              embeds: [
                errorEmbed(
                  "Giveaway not found."
                )
              ],
              flags:
                MessageFlags.Ephemeral
            });
          }

          const channel =
            interaction.guild.channels.cache.get(
              giveaway.channelId
            );

          const message =
            await channel?.messages
              .fetch(messageId)
              .catch(() => null);

          if (!message) {
            return interaction.reply({
              embeds: [
                errorEmbed(
                  "Giveaway message not found."
                )
              ],
              flags:
                MessageFlags.Ephemeral
            });
          }

          const reaction =
            message.reactions.cache.get(
              "🎉"
            );

          if (!reaction) {
            return interaction.reply({
              embeds: [
                errorEmbed(
                  "No entries found."
                )
              ]
            });
          }

          const users =
            await reaction.users.fetch();

          const eligible =
            users.filter(
              u => !u.bot
            );

          if (
            !eligible.size
          ) {
            return interaction.reply({
              embeds: [
                errorEmbed(
                  "No eligible users."
                )
              ]
            });
          }

          const winner =
            eligible.random();

          return interaction.reply({
            embeds: [
              success(
                "Giveaway Rerolled",
                `🎉 New winner: ${winner}`
              )
            ]
          });
        }
      }

      if (
        command ===
        "remind"
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
          parseDuration(
            duration
          );

        if (!ms) {
          return interaction.reply({
            embeds: [
              errorEmbed(
                "Invalid duration. Use `10m`, `1h`, `1d`, etc."
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        const reminders =
          read(DB.reminders);

        const id =
          `${interaction.user.id}-${Date.now()}`;

        reminders[id] = {
          userId:
            interaction.user.id,
          channelId:
            interaction.channel.id,
          guildId:
            interaction.guild.id,
          text,
          executeAt:
            Date.now() + ms
        };

        write(
          DB.reminders,
          reminders
        );

        return interaction.reply({
          embeds: [
            success(
              "Reminder Created",
              `I'll remind you in **${formatDuration(ms)}**.`
            )
          ],
          flags:
            MessageFlags.Ephemeral
        });
      }

      if (
        command ===
        "notify"
      ) {
        if (
          !isModerator(
            interaction.member
          )
        ) {
          return interaction.reply({
            embeds: [
              errorEmbed(
                "You need moderation permissions."
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        const sub =
          interaction.options.getSubcommand();

        const config =
          getConfig(
            interaction.guild.id
          );

        if (
          sub ===
          "set"
        ) {
          const channel =
            interaction.options.getChannel(
              "channel"
            );

          config.notifications.channelId =
            channel.id;

          saveConfig(
            interaction.guild.id,
            config
          );

          return interaction.reply({
            embeds: [
              success(
                "Notifications Set",
                `Notification channel: ${channel}`
              )
            ]
          });
        }

        if (
          sub ===
          "test"
        ) {
          const channel =
            config.notifications.channelId
              ? interaction.guild.channels.cache.get(
                  config.notifications.channelId
                )
              : null;

          if (!channel) {
            return interaction.reply({
              embeds: [
                errorEmbed(
                  "Notification channel is not configured."
                )
              ],
              flags:
                MessageFlags.Ephemeral
            });
          }

          await channel.send({
            embeds: [
              info(
                "🔔 Notification Test",
                "Vyne notifications are working."
              )
            ]
          });

          return interaction.reply({
            embeds: [
              success(
                "Notification Sent",
                "Test notification sent."
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }
      }

      if (
        command ===
        "level"
      ) {
        const user =
          interaction.options.getUser(
            "user"
          ) ||
          interaction.user;

        const levels =
          read(DB.levels);

        const data =
          levels[
            interaction.guild.id
          ]?.[user.id] ||
          {
            xp: 0,
            level: 0
          };

        return interaction.reply({
          embeds: [
            info(
              `⭐ ${user.username}`,
              `**Level:** ${data.level}\n**XP:** ${data.xp}`
            )
          ]
        });
      }

      if (
        command ===
        "leaderboard"
      ) {
        const levels =
          read(DB.levels);

        const guildLevels =
          levels[
            interaction.guild.id
          ] || {};

        const sorted =
          Object.entries(
            guildLevels
          )
            .sort(
              (a, b) =>
                (b[1].xp || 0) -
                (a[1].xp || 0)
            )
            .slice(0, 10);

        const description =
          sorted.length
            ? sorted
                .map(
                  ([id, data], index) =>
                    `**${index + 1}.** <@${id}> — Level ${data.level || 0} (${data.xp || 0} XP)`
                )
                .join("\n")
            : "No XP data yet.";

        return interaction.reply({
          embeds: [
            info(
              "🏆 XP Leaderboard",
              description
            )
          ]
        });
      }

      if (
        command ===
        "balance"
      ) {
        const user =
          interaction.options.getUser(
            "user"
          ) ||
          interaction.user;

        const economy =
          read(DB.economy);

        const balance =
          economy[
            interaction.guild.id
          ]?.[user.id]
            ?.balance || 0;

        return interaction.reply({
          embeds: [
            info(
              "💰 Balance",
              `${user} has **${balance}** coins.`
            )
          ]
        });
      }

      if (
        command ===
        "daily"
      ) {
        const economy =
          read(DB.economy);

        economy[
          interaction.guild.id
        ] ??= {};

        economy[
          interaction.guild.id
        ][
          interaction.user.id
        ] ??= {
          balance: 0,
          lastDaily: 0
        };

        const data =
          economy[
            interaction.guild.id
          ][
            interaction.user.id
          ];

        const now =
          Date.now();

        if (
          now -
            data.lastDaily <
          86400000
        ) {
          const remaining =
            86400000 -
            (now -
              data.lastDaily);

          return interaction.reply({
            embeds: [
              errorEmbed(
                `You already claimed your daily. Try again in **${formatDuration(remaining)}**.`
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        data.balance +=
          100;

        data.lastDaily =
          now;

        write(
          DB.economy,
          economy
        );

        return interaction.reply({
          embeds: [
            success(
              "Daily Claimed",
              "You received **100 coins**."
            )
          ]
        });
      }

      if (
        command ===
        "pay"
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
              errorEmbed(
                "You cannot pay yourself."
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        const economy =
          read(DB.economy);

        economy[
          interaction.guild.id
        ] ??= {};

        economy[
          interaction.guild.id
        ][
          interaction.user.id
        ] ??= {
          balance: 0,
          lastDaily: 0
        };

        economy[
          interaction.guild.id
        ][user.id] ??= {
          balance: 0,
          lastDaily: 0
        };

        const sender =
          economy[
            interaction.guild.id
          ][
            interaction.user.id
          ];

        const receiver =
          economy[
            interaction.guild.id
          ][user.id];

        if (
          sender.balance <
          amount
        ) {
          return interaction.reply({
            embeds: [
              errorEmbed(
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

        write(
          DB.economy,
          economy
        );

        return interaction.reply({
          embeds: [
            success(
              "Payment Sent",
              `Sent **${amount} coins** to ${user}.`
            )
          ]
        });
      }

      if (
        command ===
        "announce"
      ) {
        if (
          !isModerator(
            interaction.member
          )
        ) {
          return interaction.reply({
            embeds: [
              errorEmbed(
                "You need moderation permissions."
              )
            ],
            flags:
              MessageFlags.Ephemeral
          });
        }

        const channel =
          interaction.options.getChannel(
            "channel"
          );

        const message =
          interaction.options.getString(
            "message"
          );

        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(
                0x5865f2
              )
              .setTitle(
                "📢 Announcement"
              )
              .setDescription(
                message
              )
              .setFooter({
                text:
                  `Posted by ${interaction.user.tag}`
              })
              .setTimestamp()
          ]
        });

        return interaction.reply({
          embeds: [
            success(
              "Announcement Sent",
              `Announcement posted in ${channel}.`
            )
          ],
          flags:
            MessageFlags.Ephemeral
        });
      }

      if (
        command ===
        "sys"
      ) {
        if (
          interaction.user.id !==
          VYNE_OWNER_ID
        ) {
          return interaction.reply({
            embeds: [
              errorEmbed(
                "This command is owner-only."
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
          const deployment =
            await getVyneDeployment();

          if (
            sub ===
            "pull"
          ) {
            const result =
              await hostingRequest(
                `/deployments/${deployment.id}/sync`,
                {
                  method:
                    "POST"
                }
              );

            return interaction.editReply({
              embeds: [
                success(
                  "GitHub Pull",
                  `Latest GitHub code was pulled.\n\n\`\`\`json\n${truncate(
                    JSON.stringify(
                      result,
                      null,
                      2
                    ),
                    1500
                  )}\n\`\`\``
                )
              ]
            });
          }

          if (
            sub ===
            "restart"
          ) {
            const result =
              await hostingRequest(
                `/deployments/${deployment.id}/power`,
                {
                  method:
                    "POST",
                  body:
                    JSON.stringify(
                      {
                        action:
                          "restart",
                        waitSeconds:
                          10
                      }
                    )
                }
              );

            return interaction.editReply({
              embeds: [
                success(
                  "Restart Requested",
                  `Vyne restart requested.\n\n\`\`\`json\n${truncate(
                    JSON.stringify(
                      result,
                      null,
                      2
                    ),
          