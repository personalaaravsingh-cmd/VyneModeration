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
    ChannelType
} = require("discord.js");

const fs = require("fs");
const path = require("path");

// ============================================================
// VYNE MODERATION BOT
// ============================================================

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN) {
    console.error("❌ DISCORD_TOKEN is missing from .env");
    process.exit(1);
}

if (!CLIENT_ID) {
    console.error("❌ CLIENT_ID is missing from .env");
    process.exit(1);
}

if (!GUILD_ID) {
    console.error("❌ GUILD_ID is missing from .env");
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
// DATA
// ============================================================

const dataDir = path.join(__dirname, "..", "data");

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const warningsFile = path.join(dataDir, "warnings.json");
const configFile = path.join(dataDir, "config.json");

if (!fs.existsSync(warningsFile)) {
    fs.writeFileSync(warningsFile, "{}");
}

if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, "{}");
}

function readJSON(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return {};
    }
}

function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ============================================================
// CONFIG
// ============================================================

function getGuildConfig(guildId) {
    const configs = readJSON(configFile);

    if (!configs[guildId]) {
        configs[guildId] = {
            logChannelId: null,
            modRoleId: null,

            automod: {
                enabled: true,
                antiSpam: true,
                antiLinks: false,
                antiInvites: true,
                antiMentionSpam: true,
                maxMentions: 5,

                spamMessages: 6,
                spamWindow: 7000,

                warnThreshold: 3
            }
        };

        writeJSON(configFile, configs);
    }

    return configs[guildId];
}

function saveGuildConfig(guildId, config) {
    const configs = readJSON(configFile);
    configs[guildId] = config;
    writeJSON(configFile, configs);
}

// ============================================================
// WARNINGS
// ============================================================

function getWarnings(guildId, userId) {
    const warnings = readJSON(warningsFile);

    if (!warnings[guildId]) {
        warnings[guildId] = {};
    }

    if (!warnings[guildId][userId]) {
        warnings[guildId][userId] = [];
    }

    return warnings[guildId][userId];
}

function addWarning(guildId, userId, warning) {
    const warnings = readJSON(warningsFile);

    if (!warnings[guildId]) {
        warnings[guildId] = {};
    }

    if (!warnings[guildId][userId]) {
        warnings[guildId][userId] = [];
    }

    warnings[guildId][userId].push(warning);

    writeJSON(warningsFile, warnings);

    return warnings[guildId][userId];
}

function clearWarnings(guildId, userId) {
    const warnings = readJSON(warningsFile);

    if (!warnings[guildId]) {
        warnings[guildId] = {};
    }

    warnings[guildId][userId] = [];

    writeJSON(warningsFile, warnings);
}

// ============================================================
// HELPERS
// ============================================================

function truncate(text, length = 1000) {
    if (!text) return "None";

    if (text.length <= length) {
        return text;
    }

    return text.slice(0, length - 3) + "...";
}

function successEmbed(title, description) {
    return new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle(`✅ ${title}`)
        .setDescription(description)
        .setTimestamp();
}

function errorEmbed(description) {
    return new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle("❌ Error")
        .setDescription(description)
        .setTimestamp();
}

function infoEmbed(title, description) {
    return new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(title)
        .setDescription(description)
        .setTimestamp();
}

// ============================================================
// MODERATOR CHECK
// ============================================================

function isModerator(member) {
    if (!member) return false;

    if (member.permissions.has(PermissionFlagsBits.Administrator)) {
        return true;
    }

    if (member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return true;
    }

    const config = getGuildConfig(member.guild.id);

    if (
        config.modRoleId &&
        member.roles.cache.has(config.modRoleId)
    ) {
        return true;
    }

    return false;
}

// ============================================================
// HIERARCHY CHECK
// ============================================================

function canModerate(moderator, target, botMember) {
    if (!target) {
        return {
            allowed: false,
            reason: "That member could not be found."
        };
    }

    if (target.id === moderator.id) {
        return {
            allowed: false,
            reason: "You cannot moderate yourself."
        };
    }

    if (target.id === botMember.id) {
        return {
            allowed: false,
            reason: "I cannot moderate myself."
        };
    }

    if (target.id === target.guild.ownerId) {
        return {
            allowed: false,
            reason: "You cannot moderate the server owner."
        };
    }

    if (
        moderator.id !== target.guild.ownerId &&
        target.roles.highest.position >= moderator.roles.highest.position
    ) {
        return {
            allowed: false,
            reason: "That member has an equal or higher role than you."
        };
    }

    if (
        target.roles.highest.position >= botMember.roles.highest.position
    ) {
        return {
            allowed: false,
            reason: "My highest role must be above the target's highest role."
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
        const config = getGuildConfig(guild.id);

        if (!config.logChannelId) return;

        const channel = guild.channels.cache.get(config.logChannelId);

        if (!channel) return;

        await channel.send({
            embeds: [embed]
        });
    } catch (error) {
        console.log("Logging error:", error.message);
    }
}

// ============================================================
// DURATION
// ============================================================

function parseDuration(input) {
    if (!input) return null;

    const match = input
        .toLowerCase()
        .trim()
        .match(/^(\d+)\s*(s|m|h|d|w)$/);

    if (!match) return null;

    const amount = Number(match[1]);
    const unit = match[2];

    const multipliers = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000
    };

    return amount * multipliers[unit];
}

function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);

    if (seconds < 60) {
        return `${seconds}s`;
    }

    const minutes = Math.floor(seconds / 60);

    if (minutes < 60) {
        return `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);

    if (hours < 24) {
        return `${hours}h`;
    }

    const days = Math.floor(hours / 24);

    return `${days}d`;
}

// ============================================================
// SLASH COMMANDS
// ============================================================

const commands = [

    new SlashCommandBuilder()
        .setName("ban")
        .setDescription("Ban a member.")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Member to ban.")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("reason")
                .setDescription("Reason for the ban.")
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("unban")
        .setDescription("Unban a user.")
        .addStringOption(option =>
            option
                .setName("user_id")
                .setDescription("User ID.")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("reason")
                .setDescription("Reason.")
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("kick")
        .setDescription("Kick a member.")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Member to kick.")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("reason")
                .setDescription("Reason.")
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("timeout")
        .setDescription("Timeout a member.")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Member to timeout.")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("duration")
                .setDescription("Example: 10m, 1h, 1d.")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("reason")
                .setDescription("Reason.")
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("untimeout")
        .setDescription("Remove a member's timeout.")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Member.")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("reason")
                .setDescription("Reason.")
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("warn")
        .setDescription("Warn a member.")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Member.")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("reason")
                .setDescription("Warning reason.")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("warnings")
        .setDescription("View a member's warnings.")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Member.")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("clearwarnings")
        .setDescription("Clear a member's warnings.")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Member.")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("purge")
        .setDescription("Delete messages.")
        .addIntegerOption(option =>
            option
                .setName("amount")
                .setDescription("Number of messages, 1-100.")
                .setMinValue(1)
                .setMaxValue(100)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("lock")
        .setDescription("Lock the current channel."),

    new SlashCommandBuilder()
        .setName("unlock")
        .setDescription("Unlock the current channel."),

    new SlashCommandBuilder()
        .setName("slowmode")
        .setDescription("Set channel slowmode.")
        .addIntegerOption(option =>
            option
                .setName("seconds")
                .setDescription("0-21600 seconds.")
                .setMinValue(0)
                .setMaxValue(21600)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("userinfo")
        .setDescription("View user information.")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("User.")
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("serverinfo")
        .setDescription("View server information."),

    new SlashCommandBuilder()
        .setName("avatar")
        .setDescription("View a user's avatar.")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("User.")
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("ping")
        .setDescription("Check Vyne's latency."),

    new SlashCommandBuilder()
        .setName("help")
        .setDescription("Show Vyne's commands."),

    new SlashCommandBuilder()
        .setName("logchannel")
        .setDescription("Set the moderation log channel.")
        .addChannelOption(option =>
            option
                .setName("channel")
                .setDescription("Log channel.")
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("modrole")
        .setDescription("Set the moderation role.")
        .addRoleOption(option =>
            option
                .setName("role")
                .setDescription("Moderator role.")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("automod")
        .setDescription("Configure Vyne AutoMod.")
        .addBooleanOption(option =>
            option
                .setName("enabled")
                .setDescription("Enable or disable AutoMod.")
                .setRequired(true)
        )
        .addBooleanOption(option =>
            option
                .setName("anti_spam")
                .setDescription("Anti-spam.")
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option
                .setName("anti_links")
                .setDescription("Block links.")
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option
                .setName("anti_invites")
                .setDescription("Block Discord invites.")
                .setRequired(false)
        )
        .addIntegerOption(option =>
            option
                .setName("max_mentions")
                .setDescription("Maximum mentions per message.")
                .setMinValue(1)
                .setMaxValue(20)
                .setRequired(false)
        )

].map(command => command.toJSON());

// ============================================================
// REGISTER COMMANDS
// ============================================================

async function registerCommands() {
    const rest = new REST({
        version: "10"
    }).setToken(TOKEN);

    try {
        console.log("🔄 Registering Vyne commands...");

        await rest.put(
            Routes.applicationGuildCommands(
                CLIENT_ID,
                GUILD_ID
            ),
            {
                body: commands
            }
        );

        console.log("✅ Vyne commands registered.");
    } catch (error) {
        console.error("❌ Command registration failed:", error);
    }
}

// ============================================================
// READY
// ============================================================

client.once("ready", () => {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`🛡️ Vyne is online as ${client.user.tag}`);
    console.log(`🏠 Servers: ${client.guilds.cache.size}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    client.user.setActivity("/help | Moderation");
});

// ============================================================
// INTERACTIONS
// ============================================================

client.on("interactionCreate", async interaction => {

    if (!interaction.isChatInputCommand()) return;

    const command = interaction.commandName;

    try {

        // ====================================================
        // PING
        // ====================================================

        if (command === "ping") {

            const latency = Date.now() - interaction.createdTimestamp;

            return interaction.reply({
                embeds: [
                    infoEmbed(
                        "🏓 Vyne Ping",
                        `**Latency:** ${latency}ms\n**API:** ${Math.round(client.ws.ping)}ms`
                    )
                ]
            });
        }

        // ====================================================
        // HELP
        // ====================================================

        if (command === "help") {

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle("🛡️ Vyne")
                .setDescription(
                    "A powerful moderation and server management bot."
                )
                .addFields(
                    {
                        name: "🛡️ Moderation",
                        value:
                            "`/ban` `/unban` `/kick` `/timeout` `/untimeout`\n" +
                            "`/warn` `/warnings` `/clearwarnings`\n" +
                            "`/purge` `/lock` `/unlock` `/slowmode`"
                    },
                    {
                        name: "🔧 Utility",
                        value:
                            "`/userinfo` `/serverinfo` `/avatar` `/ping`"
                    },
                    {
                        name: "⚙️ Configuration",
                        value:
                            "`/logchannel` `/modrole` `/automod`"
                    }
                )
                .setFooter({
                    text: "Vyne • Moderation"
                })
                .setTimestamp();

            return interaction.reply({
                embeds: [embed]
            });
        }

        // ====================================================
        // MODERATOR COMMANDS
        // ====================================================

        const moderatorCommands = [
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
            "logchannel",
            "modrole",
            "automod"
        ];

        if (
            moderatorCommands.includes(command) &&
            !isModerator(interaction.member)
        ) {
            return interaction.reply({
                embeds: [
                    errorEmbed(
                        "You need moderator permissions to use this command."
                    )
                ],
                flags: MessageFlags.Ephemeral
            });
        }

        // ====================================================
        // BAN
        // ====================================================

        if (command === "ban") {

            const user = interaction.options.getUser("user");
            const reason =
                interaction.options.getString("reason") ||
                "No reason provided";

            const member =
                await interaction.guild.members
                    .fetch(user.id)
                    .catch(() => null);

            if (member) {

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
            }

            await interaction.guild.members.ban(user.id, {
                reason: `${reason} | By ${interaction.user.tag}`
            });

            await interaction.reply({
                embeds: [
                    successEmbed(
                        "Member Banned",
                        `**User:** ${user.tag}\n**Reason:** ${reason}`
                    )
                ]
            });

            await sendLog(
                interaction.guild,
                new EmbedBuilder()
                    .setColor(0xED4245)
                    .setTitle("🔨 Member Banned")
                    .addFields(
                        {
                            name: "User",
                            value: `${user.tag} (${user.id})`
                        },
                        {
                            name: "Moderator",
                            value: interaction.user.tag
                        },
                        {
                            name: "Reason",
                            value: reason
                        }
                    )
                    .setTimestamp()
            );

            return;
        }

        // ====================================================
        // UNBAN
        // ====================================================

        if (command === "unban") {

            const userId =
                interaction.options.getString("user_id");

            const reason =
                interaction.options.getString("reason") ||
                "No reason provided";

            await interaction.guild.members.unban(
                userId,
                `${reason} | By ${interaction.user.tag}`
            );

            await interaction.reply({
                embeds: [
                    successEmbed(
                        "User Unbanned",
                        `**User ID:** ${userId}\n**Reason:** ${reason}`
                    )
                ]
            });

            return;
        }

        // ====================================================
        // KICK
        // ====================================================

        if (command === "kick") {

            const user =
                interaction.options.getUser("user");

            const reason =
                interaction.options.getString("reason") ||
                "No reason provided";

            const member =
                await interaction.guild.members
                    .fetch(user.id)
                    .catch(() => null);

            if (!member) {
                return interaction.reply({
                    embeds: [
                        errorEmbed(
                            "That user is not a member of this server."
                        )
                    ],
                    flags: MessageFlags.Ephemeral
                });
            }

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

            await member.kick(
                `${reason} | By ${interaction.user.tag}`
            );

            await interaction.reply({
                embeds: [
                    successEmbed(
                        "Member Kicked",
                        `**User:** ${user.tag}\n**Reason:** ${reason}`
                    )
                ]
            });

            return;
        }

        // ====================================================
        // TIMEOUT
        // ====================================================

        if (command === "timeout") {

            const user =
                interaction.options.getUser("user");

            const durationInput =
                interaction.options.getString("duration");

            const reason =
                interaction.options.getString("reason") ||
                "No reason provided";

            const duration =
                parseDuration(durationInput);

            if (!duration) {
                return interaction.reply({
                    embeds: [
                        errorEmbed(
                            "Invalid duration. Use formats like `10m`, `1h`, `1d` or `1w`."
                        )
                    ],
                    flags: MessageFlags.Ephemeral
                });
            }

            if (duration > 28 * 24 * 60 * 60 * 1000) {
                return interaction.reply({
                    embeds: [
                        errorEmbed(
                            "Discord allows a maximum timeout of 28 days."
                        )
                    ],
                    flags: MessageFlags.Ephemeral
                });
            }

            const member =
                await interaction.guild.members
                    .fetch(user.id)
                    .catch(() => null);

            if (!member) {
                return interaction.reply({
                    embeds: [
                        errorEmbed("That user is not in this server.")
                    ],
                    flags: MessageFlags.Ephemeral
                });
            }

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

            await member.timeout(
                duration,
                `${reason} | By ${interaction.user.tag}`
            );

            await interaction.reply({
                embeds: [
                    successEmbed(
                        "Member Timed Out",
                        `**User:** ${user.tag}\n**Duration:** ${formatDuration(duration)}\n**Reason:** ${reason}`
                    )
                ]
            });

            return;
        }

        // ====================================================
        // UNTIMEOUT
        // ====================================================

        if (command === "untimeout") {

            const user =
                interaction.options.getUser("user");

            const reason =
                interaction.options.getString("reason") ||
                "No reason provided";

            const member =
                await interaction.guild.members
                    .fetch(user.id)
                    .catch(() => null);

            if (!member) {
                return interaction.reply({
                    embeds: [
                        errorEmbed("That user is not in this server.")
                    ],
                    flags: MessageFlags.Ephemeral
                });
            }

            await member.timeout(
                null,
                `${reason} | By ${interaction.user.tag}`
            );

            return interaction.reply({
                embeds: [
                    successEmbed(
                        "Timeout Removed",
                        `**User:** ${user.tag}\n**Reason:** ${reason}`
                    )
                ]
            });
        }

        // ====================================================
        // WARN
        // ====================================================

        if (command === "warn") {

            const user =
                interaction.options.getUser("user");

            const reason =
                interaction.options.getString("reason");

            const member =
                await interaction.guild.members
                    .fetch(user.id)
                    .catch(() => null);

            if (!member) {
                return interaction.reply({
                    embeds: [
                        errorEmbed("That user is not in this server.")
                    ],
                    flags: MessageFlags.Ephemeral
                });
            }

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
                    reason,
                    moderatorId: interaction.user.id,
                    timestamp: Date.now()
                }
            );

            const config =
                getGuildConfig(interaction.guild.id);

            await interaction.reply({
                embeds: [
                    successEmbed(
                        "Warning Issued",
                        `**User:** ${user.tag}\n**Reason:** ${reason}\n**Total Warnings:** ${warnings.length}`
                    )
                ]
            });

            await sendLog(
                interaction.guild,
                new EmbedBuilder()
                    .setColor(0xFEE75C)
                    .setTitle("⚠️ Warning Issued")
                    .addFields(
                        {
                            name: "User",
                            value: `${user.tag} (${user.id})`
                        },
                        {
                            name: "Moderator",
                            value: interaction.user.tag
                        },
                        {
                            name: "Reason",
                            value: reason
                        },
                        {
                            name: "Total Warnings",
                            value: `${warnings.length}`
                        }
                    )
                    .setTimestamp()
            );

            if (
                warnings.length >= config.automod.warnThreshold
            ) {
                await member.timeout(
                    10 * 60 * 1000,
                    "Automatic timeout after warning threshold"
                ).catch(() => {});
            }

            return;
        }

        // ====================================================
        // WARNINGS
        // ====================================================

        if (command === "warnings") {

            const user =
                interaction.options.getUser("user");

            const warnings =
                getWarnings(
                    interaction.guild.id,
                    user.id
                );

            if (warnings.length === 0) {
                return interaction.reply({
                    embeds: [
                        infoEmbed(
                            "⚠️ Warnings",
                            `${user.tag} has no warnings.`
                        )
                    ]
                });
            }

            const text = warnings
                .map((warning, index) => {
                    const moderator =
                        `<@${warning.moderatorId}>`;

                    return (
                        `**${index + 1}.** ${truncate(warning.reason, 500)}\n` +
                        `Moderator: ${moderator}`
                    );
                })
                .join("\n\n");

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xFEE75C)
                        .setTitle(`⚠️ Warnings — ${user.tag}`)
                        .setDescription(text)
                        .setFooter({
                            text: `Total: ${warnings.length}`
                        })
                        .setTimestamp()
                ]
            });
        }

        // ====================================================
        // CLEAR WARNINGS
        // ====================================================

        if (command === "clearwarnings") {

            const user =
                interaction.options.getUser("user");

            clearWarnings(
                interaction.guild.id,
                user.id
            );

            return interaction.reply({
                embeds: [
                    successEmbed(
                        "Warnings Cleared",
                        `All warnings for **${user.tag}** have been cleared.`
                    )
                ]
            });
        }

        // ====================================================
        // PURGE
        // ====================================================

        if (command === "purge") {

            const amount =
                interaction.options.getInteger("amount");

            const deleted =
                await interaction.channel.bulkDelete(
                    amount,
                    true
                );

            return interaction.reply({
                embeds: [
                    successEmbed(
                        "Messages Purged",
                        `Deleted **${deleted.size}** messages.`
                    )
                ],
                flags: MessageFlags.Ephemeral
            });
        }

        // ====================================================
        // LOCK
        // ====================================================

        if (command === "lock") {

            await interaction.channel.permissionOverwrites.edit(
                interaction.guild.roles.everyone,
                {
                    SendMessages: false
                }
            );

            await interaction.reply({
                embeds: [
                    successEmbed(
                        "Channel Locked",
                        "This channel has been locked."
                    )
                ]
            });

            return;
        }

        // ====================================================
        // UNLOCK
        // ====================================================

        if (command === "unlock") {

            await interaction.channel.permissionOverwrites.edit(
                interaction.guild.roles.everyone,
                {
                    SendMessages: null
                }
            );

            await interaction.reply({
                embeds: [
                    successEmbed(
                        "Channel Unlocked",
                        "This channel has been unlocked."
                    )
                ]
            });

            return;
        }

        // ====================================================
        // SLOWMODE
        // ====================================================

        if (command === "slowmode") {

            const seconds =
                interaction.options.getInteger("seconds");

            await interaction.channel.setRateLimitPerUser(
                seconds
            );

            return interaction.reply({
                embeds: [
                    successEmbed(
                        "Slowmode Updated",
                        seconds === 0
                            ? "Slowmode has been disabled."
                            : `Slowmode is now **${seconds} seconds**.`
                    )
                ]
            });
        }

        // ====================================================
        // USERINFO
        // ====================================================

        if (command === "userinfo") {

            const user =
                interaction.options.getUser("user") ||
                interaction.user;

            const member =
                await interaction.guild.members
                    .fetch(user.id)
                    .catch(() => null);

            const warnings =
                getWarnings(
                    interaction.guild.id,
                    user.id
                );

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle(`👤 ${user.tag}`)
                .setThumbnail(
                    user.displayAvatarURL({
                        size: 512
                    })
                )
                .addFields(
                    {
                        name: "User ID",
                        value: user.id
                    },
                    {
                        name: "Account Created",
                        value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>`
                    },
                    {
                        name: "Warnings",
                        value: `${warnings.length}`,
                        inline: true
                    }
                )
                .setTimestamp();

            if (member) {
                embed.addFields(
                    {
                        name: "Joined Server",
                        value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>`,
                        inline: true
                    },
                    {
                        name: "Highest Role",
                        value: `${member.roles.highest}`,
                        inline: true
                    }
                );
            }

            return interaction.reply({
                embeds: [embed]
            });
        }

        // ====================================================
        // SERVERINFO
        // ====================================================

        if (command === "serverinfo") {

            const guild = interaction.guild;

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle(`🏠 ${guild.name}`)
                .setThumbnail(
                    guild.iconURL({
                        size: 512
                    })
                )
                .addFields(
                    {
                        name: "Owner",
                        value: `<@${guild.ownerId}>`,
                        inline: true
                    },
                    {
                        name: "Members",
                        value: `${guild.memberCount}`,
                        inline: true
                    },
                    {
                        name: "Channels",
                        value: `${guild.channels.cache.size}`,
                        inline: true
                    },
                    {
                        name: "Roles",
                        value: `${guild.roles.cache.size}`,
                        inline: true
                    },
                    {
                        name: "Server ID",
                        value: guild.id
                    }
                )
                .setTimestamp();

            return interaction.reply({
                embeds: [embed]
            });
        }

        // ====================================================
        // AVATAR
        // ====================================================

        if (command === "avatar") {

            const user =
                interaction.options.getUser("user") ||
                interaction.user;

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle(`🖼️ ${user.tag}'s Avatar`)
                .setImage(
                    user.displayAvatarURL({
                        size: 4096
                    })
                )
                .setTimestamp();

            return interaction.reply({
                embeds: [embed]
            });
        }

        // ====================================================
        // LOG CHANNEL
        // ====================================================

        if (command === "logchannel") {

            const channel =
                interaction.options.getChannel("channel");

            const config =
                getGuildConfig(interaction.guild.id);

            config.logChannelId = channel.id;

            saveGuildConfig(
                interaction.guild.id,
                config
            );

            return interaction.reply({
                embeds: [
                    successEmbed(
                        "Log Channel Set",
                        `Moderation logs will now be sent to ${channel}.`
                    )
                ]
            });
        }

        // ====================================================
        // MOD ROLE
        // ====================================================

        if (command === "modrole") {

            const role =
                interaction.options.getRole("role");

            const config =
                getGuildConfig(interaction.guild.id);

            config.modRoleId = role.id;

            saveGuildConfig(
                interaction.guild.id,
                config
            );

            return interaction.reply({
                embeds: [
                    successEmbed(
                        "Moderator Role Set",
                        `Members with ${role} can now use Vyne's moderation commands.`
                    )
                ]
            });
        }

        // ====================================================
        // AUTOMOD CONFIG
        // ====================================================

        if (command === "automod") {

            const config =
                getGuildConfig(interaction.guild.id);

            const enabled =
                interaction.options.getBoolean("enabled");

            const antiSpam =
                interaction.options.getBoolean("anti_spam");

            const antiLinks =
                interaction.options.getBoolean("anti_links");

            const antiInvites =
                interaction.options.getBoolean("anti_invites");

            const maxMentions =
                interaction.options.getInteger("max_mentions");

            config.automod.enabled = enabled;

            if (antiSpam !== null) {
                config.automod.antiSpam = antiSpam;
            }

            if (antiLinks !== null) {
                config.automod.antiLinks = antiLinks;
            }

            if (antiInvites !== null) {
                config.automod.antiInvites = antiInvites;
            }

            if (maxMentions !== null) {
                config.automod.maxMentions = maxMentions;
            }

            saveGuildConfig(
                interaction.guild.id,
                config
            );

            return interaction.reply({
                embeds: [
                    successEmbed(
                        "AutoMod Updated",
                        `**Enabled:** ${config.automod.enabled}\n` +
                        `**Anti-Spam:** ${config.automod.antiSpam}\n` +
                        `**Anti-Links:** ${config.automod.antiLinks}\n` +
                        `**Anti-Invites:** ${config.automod.antiInvites}\n` +
                        `**Max Mentions:** ${config.automod.maxMentions}`
                    )
                ]
            });
        }

    } catch (error) {

        console.error(
            `Command /${command} error:`,
            error
        );

        const response = {
            embeds: [
                errorEmbed(
                    "Something went wrong while executing that command."
                )
            ],
            flags: MessageFlags.Ephemeral
        };

        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(response).catch(() => {});
        } else {
            await interaction.reply(response).catch(() => {});
        }
    }
});

// ============================================================
// AUTOMOD
// ============================================================

const spamTracker = new Map();

const duplicateTracker = new Map();

client.on("messageCreate", async message => {

    if (!message.guild) return;

    if (message.author.bot) return;

    if (!message.member) return;

    if (
        message.member.permissions.has(
            PermissionFlagsBits.Administrator
        ) ||
        message.member.permissions.has(
            PermissionFlagsBits.ManageMessages
        )
    ) {
        return;
    }

    const config =
        getGuildConfig(message.guild.id);

    if (!config.automod.enabled) return;

    // ========================================================
    // INVITE DETECTION
    // ========================================================

    const inviteRegex =
        /(discord\.gg\/|discord\.com\/invite\/)/i;

    if (
        config.automod.antiInvites &&
        inviteRegex.test(message.content)
    ) {

        await message.delete().catch(() => {});

        await message.channel.send({
            embeds: [
                errorEmbed(
                    `${message.author}, Discord invites are not allowed here.`
                )
            ]
        }).then(msg => {
            setTimeout(() => {
                msg.delete().catch(() => {});
            }, 5000);
        }).catch(() => {});

        await sendLog(
            message.guild,
            new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle("🤖 AutoMod — Invite")
                .addFields(
                    {
                        name: "User",
                        value: `${message.author.tag}`
                    },
                    {
                        name: "Channel",
                        value: `${message.channel}`
                    },
                    {
                        name: "Content",
                        value: truncate(message.content)
                    }
                )
                .setTimestamp()
        );

        return;
    }

    // ========================================================
    // LINK DETECTION
    // ========================================================

    const linkRegex =
        /https?:\/\/[^\s]+/i;

    if (
        config.automod.antiLinks &&
        linkRegex.test(message.content)
    ) {

        await message.delete().catch(() => {});

        await message.channel.send({
            embeds: [
                errorEmbed(
                    `${message.author}, links are not allowed here.`
                )
            ]
        }).then(msg => {
            setTimeout(() => {
                msg.delete().catch(() => {});
            }, 5000);
        }).catch(() => {});

        return;
    }

    // ========================================================
    // MENTION SPAM
    // ========================================================

    if (
        config.automod.antiMentionSpam &&
        message.mentions.users.size >=
        config.automod.maxMentions
    ) {

        await message.delete().catch(() => {});

        await message.member.timeout(
            60 * 1000,
            "AutoMod: mention spam"
        ).catch(() => {});

        await sendLog(
            message.guild,
            new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle("🤖 AutoMod — Mention Spam")
                .setDescription(
                    `${message.author} triggered mention spam protection.`
                )
                .setTimestamp()
        );

        return;
    }

    // ========================================================
    // SPAM
    // ========================================================

    if (config.automod.antiSpam) {

        const key =
            `${message.guild.id}:${message.author.id}`;

        const now = Date.now();

        if (!spamTracker.has(key)) {
            spamTracker.set(key, []);
        }

        const messages =
            spamTracker.get(key);

        messages.push(now);

        while (
            messages.length &&
            now - messages[0] >
            config.automod.spamWindow
        ) {
            messages.shift();
        }

        if (
            messages.length >=
            config.automod.spamMessages
        ) {

            spamTracker.set(key, []);

            await message.member.timeout(
                60 * 1000,
                "AutoMod: spam"
            ).catch(() => {});

            await sendLog(
                message.guild,
                new EmbedBuilder()
                    .setColor(0xED4245)
                    .setTitle("🤖 AutoMod — Spam")
                    .setDescription(
                        `${message.author} was automatically timed out for spam.`
                    )
                    .setTimestamp()
            );

            return;
        }
    }

    // ========================================================
    // DUPLICATE MESSAGES
    // ========================================================

    if (message.content.length > 5) {

        const key =
            `${message.guild.id}:${message.author.id}`;

        const now = Date.now();

        if (!duplicateTracker.has(key)) {
            duplicateTracker.set(key, []);
        }

        const messages =
            duplicateTracker.get(key);

        messages.push({
            content: message.content,
            timestamp: now
        });

        while (
            messages.length &&
            now - messages[0].timestamp >
            10000
        ) {
            messages.shift();
        }

        const duplicateCount =
            messages.filter(
                msg =>
                    msg.content ===
                    message.content
            ).length;

        if (duplicateCount >= 3) {

            await message.delete().catch(() => {});

            await message.member.timeout(
                60 * 1000,
                "AutoMod: duplicate messages"
            ).catch(() => {});

            duplicateTracker.set(key, []);

            await sendLog(
                message.guild,
                new EmbedBuilder()
                    .setColor(0xED4245)
                    .setTitle("🤖 AutoMod — Duplicate Messages")
                    .setDescription(
                        `${message.author} triggered duplicate-message protection.`
                    )
                    .setTimestamp()
            );
        }
    }
});

// ============================================================
// MESSAGE DELETE LOG
// ============================================================

client.on("messageDelete", async message => {

    if (!message.guild) return;

    if (!message.author) return;

    if (message.author.bot) return;

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle("🗑️ Message Deleted")
        .addFields(
            {
                name: "Author",
                value: `${message.author.tag}`
            },
            {
                name: "Channel",
                value: `${message.channel}`
            },
            {
                name: "Content",
                value: truncate(message.content)
            }
        )
        .setTimestamp();

    await sendLog(
        message.guild,
        embed
    );
});

// ============================================================
// MESSAGE EDIT LOG
// ============================================================

client.on("messageUpdate", async (oldMessage, newMessage) => {

    if (!oldMessage.guild) return;

    if (!oldMessage.author) return;

    if (oldMessage.author.bot) return;

    if (oldMessage.content === newMessage.content) {
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle("✏️ Message Edited")
        .addFields(
            {
                name: "Author",
                value: `${oldMessage.author.tag}`
            },
            {
                name: "Channel",
                value: `${oldMessage.channel}`
            },
            {
                name: "Before",
                value: truncate(oldMessage.content)
            },
            {
                name: "After",
                value: truncate(newMessage.content)
            }
        )
        .setTimestamp();

    await sendLog(
        oldMessage.guild,
        embed
    );
});

// ============================================================
// MEMBER JOIN
// ============================================================

client.on("guildMemberAdd", async member => {

    await sendLog(
        member.guild,
        new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle("📥 Member Joined")
            .setDescription(`${member} joined the server.`)
            .addFields(
                {
                    name: "Account",
                    value: member.user.tag
                },
                {
                    name: "ID",
                    value: member.id
                }
            )
            .setTimestamp()
    );
});

// ============================================================
// MEMBER LEAVE
// ============================================================

client.on("guildMemberRemove", async member => {

    await sendLog(
        member.guild,
        new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle("📤 Member Left")
            .setDescription(
                `**${member.user.tag}** left the server.`
            )
            .setTimestamp()
    );
});

// ============================================================
// ROLE / NICKNAME CHANGES
// ============================================================

client.on("guildMemberUpdate", async (oldMember, newMember) => {

    if (oldMember.nickname !== newMember.nickname) {

        await sendLog(
            newMember.guild,
            new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle("📝 Nickname Changed")
                .addFields(
                    {
                        name: "Member",
                        value: `${newMember.user.tag}`
                    },
                    {
                        name: "Before",
                        value: oldMember.nickname || "None"
                    },
                    {
                        name: "After",
                        value: newMember.nickname || "None"
                    }
                )
                .setTimestamp()
        );
    }

    const oldRoles =
        oldMember.roles.cache.map(role => role.id);

    const newRoles =
        newMember.roles.cache.map(role => role.id);

    if (
        oldRoles.length !== newRoles.length ||
        oldRoles.some(role => !newRoles.includes(role))
    ) {

        await sendLog(
            newMember.guild,
            new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle("🎭 Roles Updated")
                .setDescription(
                    `${newMember.user.tag}'s roles were changed.`
                )
                .setTimestamp()
        );
    }
});

// ============================================================
// VOICE LOGGING
// ============================================================

client.on("voiceStateUpdate", async (oldState, newState) => {

    if (oldState.channelId === newState.channelId) {
        return;
    }

    if (!oldState.channelId && newState.channelId) {

        await sendLog(
            newState.guild,
            new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle("🔊 Voice Join")
                .setDescription(
                    `<@${newState.id}> joined ${newState.channel}.`
                )
                .setTimestamp()
        );

    } else if (
        oldState.channelId &&
        !newState.channelId
    ) {

        await sendLog(
            oldState.guild,
            new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle("🔇 Voice Leave")
                .setDescription(
                    `<@${oldState.id}> left ${oldState.channel}.`
                )
                .setTimestamp()
        );

    } else if (
        oldState.channelId &&
        newState.channelId
    ) {

        await sendLog(
            newState.guild,
            new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle("🔀 Voice Move")
                .setDescription(
                    `<@${newState.id}> moved from ${oldState.channel} to ${newState.channel}.`
                )
                .setTimestamp()
        );
    }
});

// ============================================================
// ERROR HANDLERS
// ============================================================

client.on("error", error => {
    console.error("Discord client error:", error);
});

process.on("unhandledRejection", error => {
    console.error("Unhandled rejection:", error);
});

// ============================================================
// START
// ============================================================

(async () => {

    await registerCommands();

    await client.login(TOKEN);

})();
