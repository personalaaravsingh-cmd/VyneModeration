const fs = require("node:fs");
const path = require("node:path");
const play = require("@iamtraction/play-dl");
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  entersState
} = require("@discordjs/voice");

const DATA_FILE = path.join(__dirname, "..", "data", "music.json");
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

const COLORS = {
  primary: 0x7c5cff,
  success: 0x57f287,
  danger: 0xed4245,
  warning: 0xfee75c,
  info: 0x5865f2
};

const sessions = new Map();
let persistent = loadPersistent();

function loadPersistent() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
      return {};
    }
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    console.error("Music persistence read error:", err?.message || err);
    return {};
  }
}

function savePersistent() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(persistent, null, 2));
  } catch (err) {
    console.error("Music persistence write error:", err?.message || err);
  }
}

function stateFor(guildId) {
  if (!persistent[guildId]) {
    persistent[guildId] = {
      autoplay: false,
      fairplay: false,
      always247: false,
      ownerId: null,
      voiceChannelId: null,
      volume: 75
    };
  }
  return persistent[guildId];
}

function sessionFor(guildId) {
  let session = sessions.get(guildId);
  if (session) return session;

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause
    }
  });

  session = {
    player,
    connection: null,
    voiceChannelId: null,
    queue: [],
    current: null,
    volume: stateFor(guildId).volume ?? 75,
    loop: "off",
    history: [],
    lastRequester: null,
    advancing: false,
    idleTimer: null
  };

  player.on(AudioPlayerStatus.Idle, () => {
    if (session.advancing) return;
    void advance(guildId, "finished");
  });

  player.on("error", async error => {
    console.error(`[Music:${guildId}] player error:`, error?.message || error);
    if (session.advancing) return;
    session.advancing = true;
    try {
      await advance(guildId, "error");
    } finally {
      session.advancing = false;
    }
  });

  sessions.set(guildId, session);
  return session;
}

function isYouTubeUrl(input) {
  try {
    const url = new URL(input);
    return ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function youtubeVideoId(input) {
  try {
    const url = new URL(input);
    if (url.hostname.toLowerCase() === "youtu.be") return url.pathname.slice(1).split("/")[0] || null;
    return url.searchParams.get("v") || url.pathname.match(/\/(?:shorts|embed)\/([^/?]+)/)?.[1] || null;
  } catch {
    return null;
  }
}

function durationSeconds(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (!raw || typeof raw !== "string") return 0;
  const parts = raw.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return "LIVE";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

function cleanTitle(title) {
  return String(title || "Unknown track").replace(/\s+/g, " ").trim().slice(0, 256);
}

async function resolveTrack(query, requester) {
  const input = String(query || "").trim();
  if (!input) throw new Error("Enter a YouTube URL or song name.");

  let info;
  let url = input;

  if (isYouTubeUrl(input)) {
    const id = youtubeVideoId(input);
    if (!id) throw new Error("That YouTube URL does not contain a playable video.");
    info = await play.video_basic_info(input);
  } else {
    const results = await play.search(input, { limit: 8, source: { youtube: "video" } });
    const result = results.find(v => v?.url && !v.live) || results.find(v => v?.url);
    if (!result) throw new Error("No YouTube results found for that song.");
    url = result.url;
    info = await play.video_basic_info(url).catch(() => null);
  }

  const details = info?.video_details || {};
  const duration = durationSeconds(details.duration || details.lengthSeconds);
  if (details.is_live_content || details.isLiveContent) {
    throw new Error("Live YouTube streams are not supported by Vyne Music yet.");
  }

  return {
    id: youtubeVideoId(url) || details.id || url,
    url,
    title: cleanTitle(details.title || "YouTube track"),
    duration,
    durationText: formatDuration(duration),
    thumbnail: details.thumbnails?.[0]?.url || null,
    channel: cleanTitle(details.author?.name || details.author?.title || "YouTube"),
    requesterId: requester.id,
    requesterTag: requester.tag || requester.username || requester.id,
    addedAt: Date.now()
  };
}

function queuePositionFor(session, requesterId) {
  return session.queue.filter(t => t.requesterId === requesterId).length;
}

function selectNext(session, settings) {
  if (!session.queue.length) return null;

  if (!settings.fairplay) {
    return session.queue.shift();
  }

  const different = session.queue.findIndex(t => t.requesterId !== session.lastRequester);
  const index = different >= 0 ? different : 0;
  return session.queue.splice(index, 1)[0];
}

async function connectToChannel(guild, channel) {
  if (!channel || channel.type !== 2) throw new Error("Join a voice channel first.");

  const session = sessionFor(guild.id);
  let connection = getVoiceConnection(guild.id);

  if (connection && session.voiceChannelId !== channel.id) {
    connection.destroy();
    connection = null;
  }

  if (!connection) {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false
    });
  }

  session.connection = connection;
  session.voiceChannelId = channel.id;
  connection.subscribe(session.player);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch {
    throw new Error("I couldn't connect to that voice channel. Check my Connect and Speak permissions.");
  }

  return session;
}

function cancelIdleDisconnect(session) {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

function scheduleIdleDisconnect(guildId) {
  const session = sessionFor(guildId);
  const settings = stateFor(guildId);
  cancelIdleDisconnect(session);
  if (settings.always247) return;

  session.idleTimer = setTimeout(() => {
    if (session.current || session.queue.length) return;
    const connection = getVoiceConnection(guildId);
    if (connection) connection.destroy();
    session.connection = null;
    session.voiceChannelId = null;
  }, 60_000);
}

async function startCurrent(guildId, track, seekSeconds = 0) {
  const session = sessionFor(guildId);
  const settings = stateFor(guildId);
  if (!session.connection) throw new Error("Vyne is not connected to a voice channel.");

  const stream = await play.stream(track.url, {
    quality: 2,
    seek: Math.max(0, Number(seekSeconds) || 0)
  });

  const resource = createAudioResource(stream.stream, {
    inputType: stream.type,
    inlineVolume: true,
    metadata: track
  });

  resource.volume.setVolume(Math.max(0, Math.min(100, session.volume)) / 100);
  session.current = { ...track, startedAt: Date.now(), seek: Math.max(0, Number(seekSeconds) || 0) };
  session.lastRequester = track.requesterId;
  session.history.push(track.id);
  session.history = session.history.slice(-25);
  session.player.play(resource);
  cancelIdleDisconnect(session);

  return settings;
}

async function autoplayTrack(guildId) {
  const session = sessionFor(guildId);
  const current = session.current;
  if (!current) return null;

  const query = `${current.title} ${current.channel}`;
  const results = await play.search(query, { limit: 10, source: { youtube: "video" } });
  const candidate = results.find(v =>
    v?.url &&
    !v.live &&
    youtubeVideoId(v.url) &&
    !session.history.includes(youtubeVideoId(v.url))
  );

  if (!candidate) return null;
  const track = await resolveTrack(candidate.url, {
    id: clientUserIdFallback,
    tag: "Vyne Autoplay",
    username: "Vyne Autoplay"
  });
  track.requesterId = "autoplay";
  track.requesterTag = "Vyne Autoplay";
  return track;
}

let clientUserIdFallback = "vyne";

async function advance(guildId, reason = "finished") {
  const session = sessionFor(guildId);
  const settings = stateFor(guildId);

  if (session.loop === "track" && session.current && reason === "finished") {
    const same = { ...session.current };
    await startCurrent(guildId, same, 0).catch(err => console.error(`[Music:${guildId}] loop error:`, err?.message || err));
    return;
  }

  if (session.loop === "queue" && session.current && reason === "finished") {
    session.queue.push({ ...session.current, requesterId: session.current.requesterId, requesterTag: session.current.requesterTag });
  }

  session.current = null;

  let next = selectNext(session, settings);

  if (!next && settings.autoplay) {
    try {
      next = await autoplayTrack(guildId);
    } catch (err) {
      console.error(`[Music:${guildId}] autoplay error:`, err?.message || err);
    }
  }

  if (!next) {
    scheduleIdleDisconnect(guildId);
    return;
  }

  try {
    await startCurrent(guildId, next);
  } catch (err) {
    console.error(`[Music:${guildId}] stream error:`, err?.message || err);
    await advance(guildId, "error");
  }
}

function payloadEmbed(title, description, color = COLORS.primary) {
  return {
    embeds: [{
      title,
      description,
      color,
      timestamp: new Date().toISOString(),
      footer: { text: "Vyne • Music" }
    }]
  };
}

function trackLine(track, index = null) {
  const prefix = index === null ? "🎵" : `**${index}.**`;
  return `${prefix} [${cleanTitle(track.title)}](${track.url}) • \`${track.durationText}\` • <@${track.requesterId}>`;
}

function requireVoice(interaction) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) throw new Error("Join a voice channel first.");
  if (channel.type !== 2) throw new Error("You must be in a normal voice channel.");
  return channel;
}

async function handleMusicCommand(interaction, premiumActive) {
  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();
  const settings = stateFor(guildId);
  const session = sessionFor(guildId);

  if (["autoplay", "fairplay", "247"].includes(sub) && !premiumActive(interaction.user.id, guildId)) {
    return {
      embeds: [{
        title: "💎 Premium required",
        description: "This music feature is Premium-only. Your Premium subscription is required to use it.",
        color: COLORS.warning
      }],
      flags: 64
    };
  }

  if (sub === "play") {
    const channel = requireVoice(interaction);
    const query = interaction.options.getString("query", true);
    await interaction.deferReply();

    const track = await resolveTrack(query, interaction.user);

    const connection = getVoiceConnection(guildId);
    if (connection && session.voiceChannelId && session.voiceChannelId !== channel.id) {
      return interaction.editReply(payloadEmbed("🎵 Already playing elsewhere", `Vyne is already connected to <#${session.voiceChannelId}>. Join that channel or use \`/music disconnect\` first.`, COLORS.warning));
    }

    await connectToChannel(interaction.guild, channel);

    if (session.current || session.player.state.status === AudioPlayerStatus.Playing) {
      if (settings.fairplay && queuePositionFor(session, interaction.user.id) >= 2) {
        return interaction.editReply(payloadEmbed("⚖️ Fair Play", "You already have two tracks waiting in the queue. Let other listeners have a turn.", COLORS.warning));
      }
      session.queue.push(track);
      return interaction.editReply(payloadEmbed("➕ Added to queue", `${trackLine(track)}\n\nPosition: **#${session.queue.length}**`, COLORS.success));
    }

    await startCurrent(guildId, track);
    return interaction.editReply({
      embeds: [{
        title: "▶️ Now playing",
        description: trackLine(track),
        color: COLORS.success,
        thumbnail: track.thumbnail ? { url: track.thumbnail } : undefined,
        timestamp: new Date().toISOString(),
        footer: { text: `Vyne • Requested by ${interaction.user.tag}` }
      }]
    });
  }

  if (sub === "pause") {
    if (!session.current) throw new Error("Nothing is currently playing.");
    if (!session.player.pause()) return payloadEmbed("⏸️ Already paused", "The current track is already paused.", COLORS.warning);
    return payloadEmbed("⏸️ Paused", `Paused **${session.current.title}**.`, COLORS.success);
  }

  if (sub === "resume") {
    if (!session.current) throw new Error("Nothing is currently playing.");
    if (!session.player.unpause()) return payloadEmbed("▶️ Already playing", "The current track is not paused.", COLORS.warning);
    return payloadEmbed("▶️ Resumed", `Resumed **${session.current.title}**.`, COLORS.success);
  }

  if (sub === "skip") {
    if (!session.current) throw new Error("Nothing is currently playing.");
    session.advancing = true;
    try {
      session.player.stop(true);
      await advance(guildId, "skipped");
    } finally {
      session.advancing = false;
    }
    return payloadEmbed("⏭️ Skipped", session.current ? `Now playing **${session.current.title}**.` : "The queue is empty.");
  }

  if (sub === "stop") {
    session.advancing = true;
    session.player.stop(true);
    session.queue = [];
    session.current = null;
    session.lastRequester = null;
    session.loop = "off";
    session.advancing = false;
    if (!settings.always247) scheduleIdleDisconnect(guildId);
    return payloadEmbed("⏹️ Stopped", settings.always247 ? "Playback stopped. 24/7 is still keeping Vyne in the voice channel." : "Playback stopped and the queue was cleared.", COLORS.success);
  }

  if (sub === "queue") {
    const lines = [];
    if (session.current) lines.push(`**Now:** ${trackLine(session.current)}`);
    session.queue.slice(0, 20).forEach((track, i) => lines.push(trackLine(track, i + 1)));
    return payloadEmbed("📜 Music Queue", lines.length ? lines.join("\n") : "The queue is empty.", COLORS.info);
  }

  if (sub === "nowplaying") {
    if (!session.current) return payloadEmbed("🎵 Now Playing", "Nothing is currently playing.", COLORS.info);
    const elapsed = Math.max(0, Math.floor((Date.now() - session.current.startedAt) / 1000) + (session.current.seek || 0));
    return {
      embeds: [{
        title: "🎵 Now Playing",
        description: `${trackLine(session.current)}\n\n**Progress:** \`${formatDuration(elapsed)} / ${session.current.durationText}\`\n**Volume:** \`${session.volume}%\`\n**Loop:** \`${session.loop}\``,
        color: COLORS.info,
        thumbnail: session.current.thumbnail ? { url: session.current.thumbnail } : undefined
      }]
    };
  }

  if (sub === "volume") {
    const volume = interaction.options.getInteger("percent", true);
    session.volume = volume;
    settings.volume = volume;
    savePersistent();
    const resource = session.player.state.resource;
    if (resource?.volume) resource.volume.setVolume(volume / 100);
    return payloadEmbed("🔊 Volume updated", `Volume is now **${volume}%**.`, COLORS.success);
  }

  if (sub === "seek") {
    if (!session.current) throw new Error("Nothing is currently playing.");
    const seconds = interaction.options.getInteger("seconds", true);
    if (seconds >= session.current.duration) throw new Error("That seek position is beyond the track length.");
    const current = { ...session.current };
    session.advancing = true;
    try {
      session.player.stop(true);
      await startCurrent(guildId, current, seconds);
    } finally {
      session.advancing = false;
    }
    return payloadEmbed("⏩ Seeked", `Jumped to **${formatDuration(seconds)}** in **${current.title}**.`, COLORS.success);
  }

  if (sub === "loop") {
    const mode = interaction.options.getString("mode", true);
    session.loop = mode;
    return payloadEmbed("🔁 Loop updated", `Loop mode: **${mode}**.`, COLORS.success);
  }

  if (sub === "shuffle") {
    for (let i = session.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [session.queue[i], session.queue[j]] = [session.queue[j], session.queue[i]];
    }
    return payloadEmbed("🔀 Queue shuffled", session.queue.length ? `Shuffled **${session.queue.length}** queued tracks.` : "The queue is empty.", COLORS.success);
  }

  if (sub === "remove") {
    const position = interaction.options.getInteger("position", true);
    if (position < 1 || position > session.queue.length) throw new Error("That queue position does not exist.");
    const removed = session.queue.splice(position - 1, 1)[0];
    return payloadEmbed("🗑️ Removed", `Removed **${removed.title}** from the queue.`, COLORS.success);
  }

  if (sub === "clear") {
    const count = session.queue.length;
    session.queue = [];
    return payloadEmbed("🧹 Queue cleared", `Removed **${count}** queued track(s).`, COLORS.success);
  }

  if (sub === "join") {
    const channel = requireVoice(interaction);
    await connectToChannel(interaction.guild, channel);
    settings.voiceChannelId = channel.id;
    settings.ownerId = interaction.user.id;
    savePersistent();
    return payloadEmbed("🔊 Joined voice", `Connected to <#${channel.id}>.`, COLORS.success);
  }

  if (sub === "disconnect") {
    settings.always247 = false;
    settings.voiceChannelId = null;
    settings.ownerId = null;
    savePersistent();
    session.queue = [];
    session.current = null;
    session.player.stop(true);
    const connection = getVoiceConnection(guildId);
    if (connection) connection.destroy();
    session.connection = null;
    session.voiceChannelId = null;
    return payloadEmbed("👋 Disconnected", "Vyne left the voice channel and cleared the music session.", COLORS.success);
  }

  if (sub === "lyrics") {
    const title = session.current?.title;
    if (!title) throw new Error("Nothing is currently playing.");
    const artist = session.current.channel || "";
    const params = new URLSearchParams({ track_name: title, artist_name: artist });
    const response = await fetch(`https://lrclib.net/api/get?${params.toString()}`);
    if (!response.ok) throw new Error("Lyrics were not found for the current track.");
    const data = await response.json();
    const lyrics = String(data.plainLyrics || data.syncedLyrics || "").trim();
    if (!lyrics) throw new Error("Lyrics were not found for the current track.");
    return payloadEmbed(`🎤 Lyrics • ${title}`, lyrics.slice(0, 3800), COLORS.info);
  }

  if (sub === "autoplay" || sub === "fairplay" || sub === "247") {
    const enabled = interaction.options.getBoolean("enabled", true);
    if (sub === "autoplay") settings.autoplay = enabled;
    if (sub === "fairplay") settings.fairplay = enabled;
    if (sub === "247") {
      settings.always247 = enabled;
      if (enabled) {
        const channel = interaction.member?.voice?.channel;
        if (!channel) throw new Error("Join the voice channel you want Vyne to stay in, then enable 24/7.");
        await connectToChannel(interaction.guild, channel);
        settings.voiceChannelId = channel.id;
        settings.ownerId = interaction.user.id;
      } else {
        settings.voiceChannelId = null;
        settings.ownerId = null;
      }
    }
    savePersistent();
    return payloadEmbed(
      sub === "247" ? "♾️ 24/7 updated" : sub === "autoplay" ? "🔄 Autoplay updated" : "⚖️ Fair Play updated",
      `${sub === "247" ? "24/7" : sub === "autoplay" ? "Autoplay" : "Fair Play"} is now **${enabled ? "enabled" : "disabled"}**.`,
      COLORS.success
    );
  }

  throw new Error("Unknown music command.");
}

async function restore247(client, premiumActive) {
  clientUserIdFallback = client.user?.id || "vyne";
  for (const [guildId, settings] of Object.entries(persistent)) {
    if (!settings?.always247 || !settings.voiceChannelId || !settings.ownerId) continue;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    if (!premiumActive(settings.ownerId, guildId)) {
      settings.always247 = false;
      settings.voiceChannelId = null;
      settings.ownerId = null;
      continue;
    }
    const channel = guild.channels.cache.get(settings.voiceChannelId);
    if (!channel || channel.type !== 2) continue;
    try {
      await connectToChannel(guild, channel);
      console.log(`[Music] Restored 24/7 connection in ${guild.name}.`);
    } catch (err) {
      console.error(`[Music] Failed to restore 24/7 in ${guild.name}:`, err?.message || err);
    }
  }
  savePersistent();
}

function flushMusicData() {
  savePersistent();
}

module.exports = {
  handleMusicCommand,
  restore247,
  flushMusicData
};
