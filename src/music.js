const fs = require("node:fs");
const path = require("node:path");
const { createCanvas, loadImage } = require("@napi-rs/canvas");

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
let clientUserIdFallback = "vyne";
let lavalinkEventsAttached = false;

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
  const defaults = {
    autoplay: false,
    fairplay: false,
    always247: false,
    ownerId: null,
    voiceChannelId: null,
    volume: 75
  };
  if (!persistent[guildId] || typeof persistent[guildId] !== "object") persistent[guildId] = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (persistent[guildId][key] === undefined) persistent[guildId][key] = value;
  }
  return persistent[guildId];
}

function sessionFor(guildId) {
  let session = sessions.get(guildId);
  if (session) return session;
  session = {
    player: null,
    voiceChannelId: null,
    queue: [],
    current: null,
    volume: stateFor(guildId).volume ?? 75,
    loop: "off",
    history: [],
    lastRequester: null,
    advancing: false,
    idleTimer: null,
    nowPlayingMessage: null,
    cardTimer: null,
    lastCardSecond: null,
    client: null,
    suppressNextEnd: false
  };
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

function lavaError(err, fallback = "Lavalink could not process this track.") {
  const raw = [err?.message, err?.stack, err?.cause?.message, err?.payload?.message, err?.payload?.error]
    .filter(Boolean).map(String).join(" ").trim();
  if (/node.*(connect|connection|offline)|ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(raw)) {
    return "The Lavalink music node is currently unavailable. Try again in a moment.";
  }
  if (/no matches|no track|not found/i.test(raw)) return "No playable track was found for that query.";
  return raw.slice(0, 1200) || fallback;
}

function getPlayer(client, guildId) {
  return client?.lavalink?.getPlayer(guildId) || null;
}

async function resolveTrack(query, requester, player) {
  const input = String(query || "").trim();
  if (!input) throw new Error("Enter a song name or URL.");
  if (!player) throw new Error("The Lavalink music node is not connected.");

  try {
    const result = await player.search(
      isYouTubeUrl(input) ? { query: input } : { query: input, source: "ytmsearch" },
      requester
    );
    const lavaTrack = result?.tracks?.[0];
    if (!lavaTrack) throw new Error("No playable track was found for that query.");

    const info = lavaTrack.info || {};
    const duration = durationSeconds(info.duration || info.durationString);
    if (info.isStream || info.isLive || info.liveStatus === "is_live") {
      throw new Error("Live streams are not supported by Vyne Music.");
    }

    return {
      id: info.identifier || info.uri || lavaTrack.encoded,
      url: info.uri || input,
      title: cleanTitle(info.title),
      duration,
      durationText: formatDuration(duration),
      thumbnail: info.artworkUrl || info.thumbnail || null,
      artist: cleanTitle(info.author || info.artist || "Unknown artist"),
      channel: cleanTitle(info.author || "YouTube"),
      uploader: cleanTitle(info.author || "YouTube"),
      requesterId: requester.id,
      requesterTag: requester.tag || requester.username || requester.id,
      addedAt: Date.now(),
      lavaTrack
    };
  } catch (err) {
    console.error("[Music] Lavalink resolve error:", err);
    throw new Error(lavaError(err));
  }
}

function queuePositionFor(session, requesterId) {
  return session.queue.filter(t => t.requesterId === requesterId).length;
}

function selectNext(session, settings) {
  if (!session.queue.length) return null;
  if (!settings.fairplay) return session.queue.shift();
  const different = session.queue.findIndex(t => t.requesterId !== session.lastRequester);
  const index = different >= 0 ? different : 0;
  return session.queue.splice(index, 1)[0];
}

async function connectToChannel(client, guild, channel) {
  if (!channel || channel.type !== 2) throw new Error("Join a voice channel first.");

  const session = sessionFor(guild.id);
  const existing = getPlayer(client, guild.id);
  if (existing && existing.voiceChannelId && existing.voiceChannelId !== channel.id) {
    await existing.destroy("Moved to another music channel").catch(() => {});
    session.player = null;
  }

  let player = getPlayer(client, guild.id);
  if (!player) {
    player = client.lavalink.createPlayer({
      guildId: guild.id,
      voiceChannelId: channel.id,
      textChannelId: null,
      selfDeaf: true,
      selfMute: false,
      node: process.env.LAVALINK_ID || "TripleN",
      volume: session.volume
    });
  } else if (player.voiceChannelId !== channel.id) {
    await player.changeVoiceState({ voiceChannelId: channel.id, selfDeaf: true, selfMute: false });
  }

  await player.connect();
  session.player = player;
  session.client = client;
  session.voiceChannelId = channel.id;
  return session;
}

function cancelIdleDisconnect(session) {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

function scheduleIdleDisconnect(client, guildId) {
  const session = sessionFor(guildId);
  const settings = stateFor(guildId);
  cancelIdleDisconnect(session);
  if (settings.always247) return;

  session.idleTimer = setTimeout(async () => {
    if (session.current || session.queue.length) return;
    const player = getPlayer(client, guildId);
    if (player) await player.destroy("Idle music disconnect").catch(() => {});
    session.player = null;
    session.voiceChannelId = null;
  }, 60_000);
}

async function startCurrent(client, guildId, track, seekSeconds = 0) {
  const session = sessionFor(guildId);
  const settings = stateFor(guildId);
  const player = getPlayer(client, guildId) || session.player;
  if (!player) throw new Error("Vyne is not connected to a voice channel.");

  const seek = Math.max(0, Number(seekSeconds) || 0);
  await player.play({
    clientTrack: track.lavaTrack,
    volume: session.volume,
    position: Math.floor(seek * 1000)
  });

  session.player = player;
  session.client = client;
  session.current = { ...track, guildId, startedAt: Date.now(), seek };
  session.lastRequester = track.requesterId;
  session.history.push(track.id);
  session.history = session.history.slice(-25);
  cancelIdleDisconnect(session);

  if (session.nowPlayingMessage) {
    session.lastCardSecond = null;
    void updateNowPlayingCard(guildId, true);
  }
  return settings;
}

async function autoplayTrack(client, guildId) {
  const session = sessionFor(guildId);
  const current = session.current;
  const player = getPlayer(client, guildId) || session.player;
  if (!current || !player) return null;

  try {
    const result = await player.search(
      { query: `${current.title} ${current.channel}`, source: "ytmsearch" },
      { id: clientUserIdFallback, tag: "Vyne Autoplay", username: "Vyne Autoplay" }
    );
    const candidate = (result?.tracks || []).find(track => {
      const id = track?.info?.identifier;
      return id && !session.history.includes(id) && !track.info?.isStream && !track.info?.isLive;
    });
    if (!candidate) return null;
    const info = candidate.info || {};
    const duration = durationSeconds(info.duration);
    return {
      id: info.identifier || info.uri || candidate.encoded,
      url: info.uri || "",
      title: cleanTitle(info.title),
      duration,
      durationText: formatDuration(duration),
      thumbnail: info.artworkUrl || info.thumbnail || null,
      artist: cleanTitle(info.author || "Unknown artist"),
      channel: cleanTitle(info.author || "YouTube"),
      uploader: cleanTitle(info.author || "YouTube"),
      requesterId: "autoplay",
      requesterTag: "Vyne Autoplay",
      addedAt: Date.now(),
      lavaTrack: candidate
    };
  } catch (err) {
    throw new Error(lavaError(err, "Autoplay search failed."));
  }
}

async function advance(client, guildId, reason = "finished") {
  const session = sessionFor(guildId);
  const settings = stateFor(guildId);

  if (session.advancing) return;
  session.advancing = true;
  try {
    if (session.loop === "track" && session.current && reason === "finished") {
      const same = { ...session.current };
      await startCurrent(client, guildId, same, 0);
      return;
    }

    if (session.loop === "queue" && session.current && reason === "finished") {
      session.queue.push({ ...session.current });
    }

    session.current = null;
    let next = selectNext(session, settings);

    if (!next && settings.autoplay) {
      try { next = await autoplayTrack(client, guildId); } catch (err) {
        console.error(`[Music:${guildId}] autoplay error:`, err?.message || err);
      }
    }

    if (!next) {
      scheduleIdleDisconnect(client, guildId);
      return;
    }

    try {
      await startCurrent(client, guildId, next);
    } catch (err) {
      console.error(`[Music:${guildId}] stream error:`, err?.message || err);
      await advance(client, guildId, "error");
    }
  } finally {
    session.advancing = false;
  }
}

function setupLavalink(client) {
  if (lavalinkEventsAttached || !client?.lavalink) return;
  lavalinkEventsAttached = true;
  clientUserIdFallback = client.user?.id || "vyne";

  client.lavalink.on("trackEnd", (player) => {
    if (!player?.guildId) return;
    const session = sessions.get(player.guildId);
    if (!session || session.advancing) return;
    if (session.suppressNextEnd) {
      session.suppressNextEnd = false;
      return;
    }
    void advance(client, player.guildId, "finished");
  });

  client.lavalink.on("trackError", (player, track, payload) => {
    console.error(`[Music:${player?.guildId}] Lavalink track error:`, payload || track);
    if (!player?.guildId) return;
    void advance(client, player.guildId, "error");
  });

  client.lavalink.on("trackStuck", (player, track, payload) => {
    console.error(`[Music:${player?.guildId}] Lavalink track stuck:`, payload || track);
    if (!player?.guildId) return;
    void advance(client, player.guildId, "error");
  });

  client.lavalink.nodeManager.on("connect", node => {
    console.log(`[Music] Lavalink node connected: ${node.id}`);
  });
  client.lavalink.nodeManager.on("error", (node, error) => {
    console.error(`[Music] Lavalink node error (${node.id}):`, error?.message || error);
  });
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
  const requester = /^\d{17,20}$/.test(String(track.requesterId || "")) ? `<@${track.requesterId}>` : "Vyne Autoplay";
  return `${prefix} [${cleanTitle(track.title)}](${track.url}) • \`${track.durationText}\` • ${requester}`;
}

function currentElapsed(track) {
  if (!track) return 0;
  const session = sessions.get(track.guildId || "");
  const player = session?.player;
  if (player && Number.isFinite(player.position)) return Math.max(0, Math.floor(player.position / 1000));
  return Math.max(0, Math.floor((Date.now() - (track.startedAt || Date.now())) / 1000) + (track.seek || 0));
}

function fitText(ctx, text, maxWidth) {
  let value = String(text || "");
  if (ctx.measureText(value).width <= maxWidth) return value;
  while (value.length > 1 && ctx.measureText(value + "…").width > maxWidth) value = value.slice(0, -1);
  return value + "…";
}

async function renderNowPlayingCard(track, elapsed = 0, volume = 75, loop = "off") {
  const width = 1200;
  const height = 520;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, "#11111a");
  bg.addColorStop(0.55, "#17172a");
  bg.addColorStop(1, "#09090f");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Subtle accent glow.
  const glow = ctx.createRadialGradient(1040, 70, 10, 1040, 70, 360);
  glow.addColorStop(0, "rgba(124,92,255,0.34)");
  glow.addColorStop(1, "rgba(124,92,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(650, 0, 550, 360);

  let thumbnail = null;
  if (track?.thumbnail) {
    try { thumbnail = await loadImage(track.thumbnail); } catch {}
  }

  const imageX = 45;
  const imageY = 45;
  const imageSize = 330;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(imageX, imageY, imageSize, imageSize, 24);
  ctx.clip();
  if (thumbnail) {
    ctx.drawImage(thumbnail, imageX, imageY, imageSize, imageSize);
  } else {
    ctx.fillStyle = "#252535";
    ctx.fillRect(imageX, imageY, imageSize, imageSize);
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 72px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("♪", imageX + imageSize / 2, imageY + 205);
  }
  ctx.restore();

  const x = 420;
  ctx.textAlign = "left";
  ctx.fillStyle = "#7c5cff";
  ctx.font = "700 24px sans-serif";
  ctx.fillText("VYNE  •  NOW PLAYING", x, 78);

  ctx.fillStyle = "#ffffff";
  ctx.font = "700 38px sans-serif";
  ctx.fillText(fitText(ctx, track?.title || "Unknown track", 720), x, 132);

  ctx.fillStyle = "#b8b8c8";
  ctx.font = "500 24px sans-serif";
  ctx.fillText(fitText(ctx, `Artist • ${track?.artist || track?.channel || "Unknown artist"}`, 720), x, 174);

  ctx.fillStyle = "#88889a";
  ctx.font = "500 20px sans-serif";
  ctx.fillText(fitText(ctx, `YouTube • ${track?.uploader || track?.channel || "Unknown channel"}`, 720), x, 210);

  const total = Math.max(1, Number(track?.duration) || 1);
  const progress = Math.max(0, Math.min(1, elapsed / total));
  const barX = x;
  const barY = 290;
  const barW = 720;
  const barH = 12;
  ctx.fillStyle = "#303041";
  ctx.roundRect(barX, barY, barW, barH, 6);
  ctx.fill();
  ctx.fillStyle = "#7c5cff";
  ctx.roundRect(barX, barY, Math.max(8, barW * progress), barH, 6);
  ctx.fill();

  ctx.fillStyle = "#e7e7ef";
  ctx.font = "600 19px sans-serif";
  ctx.fillText(formatDuration(elapsed), barX, 330);
  ctx.textAlign = "right";
  ctx.fillStyle = "#9d9daf";
  ctx.fillText(formatDuration(total), barX + barW, 330);

  ctx.textAlign = "left";
  ctx.fillStyle = "#8f8fa2";
  ctx.font = "500 18px sans-serif";
  ctx.fillText(`Volume ${volume}%  •  Loop ${loop}  •  Requested by ${track?.requesterTag || "Vyne"}`, x, 382);

  ctx.fillStyle = "#5d5d70";
  ctx.font = "500 16px sans-serif";
  ctx.fillText("Vyne Music  •  YouTube", x, 430);

  return canvas.toBuffer("image/png");
}

async function updateNowPlayingCard(guildId, force = false) {
  const session = sessionFor(guildId);
  const message = session.nowPlayingMessage;
  if (!message || !session.current) return;
  const elapsed = currentElapsed(session.current);
  if (!force && session.lastCardSecond !== null && Math.abs(elapsed - session.lastCardSecond) < 5) return;
  try {
    const buffer = await renderNowPlayingCard(session.current, elapsed, session.volume, session.loop);
    await message.edit({
      content: "",
      files: [{ attachment: buffer, name: "vyne-now-playing.png" }]
    });
    session.lastCardSecond = elapsed;
  } catch (err) {
    console.error(`[Music:${guildId}] now-playing card update error:`, err?.message || err);
  }
}

function startNowPlayingUpdater(guildId) {
  const session = sessionFor(guildId);
  if (session.cardTimer) return;
  session.cardTimer = setInterval(() => {
    if (!session.current || !session.nowPlayingMessage) {
      clearInterval(session.cardTimer);
      session.cardTimer = null;
      return;
    }
    void updateNowPlayingCard(guildId);
  }, 5000);
}

function stopNowPlayingUpdater(session) {
  if (session.cardTimer) clearInterval(session.cardTimer);
  session.cardTimer = null;
  session.nowPlayingMessage = null;
  session.lastCardSecond = null;
}

async function sendNowPlayingCard(interaction, guildId) {
  const session = sessionFor(guildId);
  if (!session.current) return payloadEmbed("🎵 Now Playing", "Nothing is currently playing.", COLORS.info);
  const buffer = await renderNowPlayingCard(session.current, currentElapsed(session.current), session.volume, session.loop);
  const payload = { files: [{ attachment: buffer, name: "vyne-now-playing.png" }] };
  if (interaction.replied || interaction.deferred) {
    const message = await interaction.editReply(payload);
    session.nowPlayingMessage = message;
  } else {
    const message = await interaction.reply({ ...payload, fetchReply: true });
    session.nowPlayingMessage = message;
  }
  session.lastCardSecond = currentElapsed(session.current);
  startNowPlayingUpdater(guildId);
  return null;
}

async function forceFixMusic(guild, requesterId) {
  const guildId = guild.id;
  const session = sessionFor(guildId);
  const settings = stateFor(guildId);
  const player = session.player || getPlayer(session.client, guildId);
  if (!session.current || !player) throw new Error("There is no active track to force-fix.");

  const channelId = session.voiceChannelId || settings.voiceChannelId || player.voiceChannelId;
  const channel = guild.channels.cache.get(channelId);
  if (!channel || channel.type !== 2) throw new Error("The saved music voice channel no longer exists.");

  const track = { ...session.current };
  const elapsed = currentElapsed(track);
  settings.voiceChannelId = channel.id;
  settings.ownerId = settings.ownerId || requesterId;
  savePersistent();

  stopNowPlayingUpdater(session);
  await player.destroy("Vyne force-fix music").catch(() => {});
  session.player = null;
  session.voiceChannelId = null;
  await new Promise(resolve => setTimeout(resolve, 700));
  await connectToChannel(session.client, guild, channel);
  await startCurrent(session.client, guildId, track, Math.min(elapsed, Math.max(0, track.duration - 1)));
  return { track, elapsed, channelId: channel.id };
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
  const client = interaction.client;
  setupLavalink(client);

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
    const existing = getPlayer(client, guildId);
    if (existing?.voiceChannelId && existing.voiceChannelId !== channel.id) {
      return payloadEmbed("🎵 Already playing elsewhere", `Vyne is already connected to <#${existing.voiceChannelId}>. Join that channel or use \`/music disconnect\` first.`, COLORS.warning));
    }

    await connectToChannel(client, interaction.guild, channel);
    const track = await resolveTrack(query, interaction.user, session.player);

    if (session.current) {
      if (settings.fairplay && queuePositionFor(session, interaction.user.id) >= 2) {
        return payloadEmbed("⚖️ Fair Play", "You already have two tracks waiting in the queue. Let other listeners have a turn.", COLORS.warning));
      }
      session.queue.push(track);
      return payloadEmbed("➕ Added to queue", `${trackLine(track)}\\n\\nPosition: **#${session.queue.length}**`, COLORS.success));
    }

    await startCurrent(client, guildId, track);
    return sendNowPlayingCard(interaction, guildId);
  }

  if (sub === "pause") {
    if (!session.current || !session.player) throw new Error("Nothing is currently playing.");
    if (session.player.paused) return payloadEmbed("⏸️ Already paused", "The current track is already paused.", COLORS.warning);
    await session.player.pause();
    return payloadEmbed("⏸️ Paused", `Paused **${session.current.title}**.`, COLORS.success);
  }

  if (sub === "resume") {
    if (!session.current || !session.player) throw new Error("Nothing is currently playing.");
    if (!session.player.paused) return payloadEmbed("▶️ Already playing", "The current track is not paused.", COLORS.warning);
    await session.player.resume();
    return payloadEmbed("▶️ Resumed", `Resumed **${session.current.title}**.`, COLORS.success);
  }

  if (sub === "skip") {
    if (!session.current || !session.player) throw new Error("Nothing is currently playing.");
    session.suppressNextEnd = true;
    await session.player.stopPlaying(false, false);
    await advance(client, guildId, "skipped");
    return payloadEmbed("⏭️ Skipped", session.current ? `Now playing **${session.current.title}**.` : "The queue is empty.");
  }

  if (sub === "stop") {
    session.suppressNextEnd = true;
    if (session.player) await session.player.stopPlaying(true, false).catch(() => {});
    session.queue = [];
    session.current = null;
    session.lastRequester = null;
    session.loop = "off";
    stopNowPlayingUpdater(session);
    if (!settings.always247) scheduleIdleDisconnect(client, guildId);
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
    return sendNowPlayingCard(interaction, guildId);
  }

  if (sub === "volume") {
    const volume = interaction.options.getInteger("percent", true);
    session.volume = volume;
    settings.volume = volume;
    savePersistent();
    if (session.player) await session.player.setVolume(volume);
    return payloadEmbed("🔊 Volume updated", `Volume is now **${volume}%**.`, COLORS.success);
  }

  if (sub === "seek") {
    if (!session.current || !session.player) throw new Error("Nothing is currently playing.");
    const seconds = interaction.options.getInteger("seconds", true);
    if (seconds >= session.current.duration) throw new Error("That seek position is beyond the track length.");
    await session.player.seek(seconds * 1000);
    session.current.seek = seconds;
    session.current.startedAt = Date.now();
    return payloadEmbed("⏩ Seeked", `Jumped to **${formatDuration(seconds)}** in **${session.current.title}**.`, COLORS.success);
  }

  if (sub === "loop") {
    const mode = interaction.options.getString("mode", true);
    session.loop = mode;
    if (session.player) await session.player.setRepeatMode("off").catch(() => {});
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
    await connectToChannel(client, interaction.guild, channel);
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
    stopNowPlayingUpdater(session);
    if (session.player) await session.player.destroy("Music disconnect").catch(() => {});
    session.player = null;
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
        const channel = requireVoice(interaction);
        await connectToChannel(client, interaction.guild, channel);
        settings.voiceChannelId = channel.id;
        settings.ownerId = interaction.user.id;
      } else {
        settings.voiceChannelId = null;
        settings.ownerId = null;
        if (!session.current && session.player) {
          await session.player.destroy("24/7 disabled").catch(() => {});
          session.player = null;
          session.voiceChannelId = null;
        }
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
  setupLavalink(client);
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
      await connectToChannel(client, guild, channel);
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
  forceFixMusic,
  flushMusicData,
  setupLavalink
};
