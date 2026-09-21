const fs = require("node:fs");
const path = require("node:path");
const youtubedl = require("youtube-dl-exec");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  entersState,
  StreamType
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
    idleTimer: null,
    nowPlayingMessage: null,
    cardTimer: null,
    lastCardSecond: null
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

function ytDlpOptions(extra = {}) {
  return {
    noWarnings: true,
    noPlaylist: true,
    // Use the exact Node executable running Vyne instead of relying on PATH.
    jsRuntimes: `node:${process.execPath}`,
    remoteComponents: "ejs:github",
    ...extra
  };
}

function ytDlpError(err, fallback = "YouTube could not be read.") {
  const raw = [
    err?.stderr,
    err?.stdout,
    err?.message,
    err?.code ? `code=${err.code}` : "",
    err?.cause?.message ? `cause=${err.cause.message}` : ""
  ].filter(Boolean).map(String).join("\n").trim();

  if (/python3.*not found|python.*not found|could not find.*python/i.test(raw)) {
    return "The host is missing Python 3, which youtube-dl-exec currently requires during installation.";
  }
  if (/sign in to confirm|not a bot|LOGIN_REQUIRED|http error 429|too many requests/i.test(raw)) {
    return "YouTube is blocking this server's IP right now. Try again later or configure YouTube cookies/PO-token support.";
  }
  if (/no supported javascript runtime|javascript runtime.*not found/i.test(raw)) {
    return "yt-dlp could not access Node.js for YouTube's JavaScript challenge solver.";
  }
  if (/remote component.*(ejs|github)|unable to download.*ejs|ejs.*not found/i.test(raw)) {
    return "yt-dlp could not load the YouTube EJS challenge scripts from GitHub.";
  }

  const useful = raw.split("\n")
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => !/^warning:/i.test(x))
    .slice(-4)
    .join(" ");

  return useful || fallback;
}

async function resolveTrack(query, requester) {
  const input = String(query || "").trim();
  if (!input) throw new Error("Enter a YouTube URL or song name.");

  let url = input;
  let info;

  try {
    if (isYouTubeUrl(input)) {
      const id = youtubeVideoId(input);
      if (!id) throw new Error("That YouTube URL does not contain a playable video.");
      info = await youtubedl(input, ytDlpOptions({
        dumpSingleJson: true,
        skipDownload: true
      }));
    } else {
      const data = await youtubedl(`ytsearch8:${input}`, ytDlpOptions({
        dumpSingleJson: true,
        flatPlaylist: true,
        extractFlat: true
      }));
      const results = Array.isArray(data?.entries) ? data.entries : [];
      const result = results.find(v => v?.url && !v.live) || results.find(v => v?.url);
      if (!result?.url) throw new Error("No YouTube results found for that song.");
      url = result.url;
      info = await youtubedl(url, ytDlpOptions({
        dumpSingleJson: true,
        skipDownload: true
      }));
    }
  } catch (err) {
    const diagnostic = ytDlpError(err);
    console.error("[Music] YouTube resolve error:", {
      message: err?.message || String(err),
      code: err?.code || null,
      stderr: String(err?.stderr || "").slice(-4000),
      stdout: String(err?.stdout || "").slice(-1000)
    });
    throw new Error(diagnostic);
  }

  const duration = durationSeconds(info?.duration || info?.duration_string);
  if (info?.is_live || info?.live_status === "is_live") {
    throw new Error("Live YouTube streams are not supported by Vyne Music yet.");
  }

  const artist = info?.artist || info?.creator || info?.uploader || info?.channel || "Unknown artist";
  const channel = info?.channel || info?.uploader || "YouTube";

  return {
    id: youtubeVideoId(url) || info?.id || url,
    url,
    title: cleanTitle(info?.title || "YouTube track"),
    duration,
    durationText: formatDuration(duration),
    thumbnail: info?.thumbnail || info?.thumbnails?.[0]?.url || null,
    artist: cleanTitle(artist),
    channel: cleanTitle(channel),
    uploader: cleanTitle(info?.uploader || info?.channel || "YouTube"),
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

  const seek = Math.max(0, Number(seekSeconds) || 0);
  const subprocess = youtubedl.exec(track.url, ytDlpOptions({
    format: "bestaudio[acodec=opus][ext=webm]/bestaudio[acodec=opus]",
    output: "-",
    quiet: true,
    ...(seek > 0 ? { downloadSections: `*${seek}-` } : {})
  }));

  subprocess.stderr?.on("data", chunk => {
    const message = String(chunk || "").trim();
    if (message && !/\[download\]/i.test(message)) {
      console.error(`[Music:${guildId}] yt-dlp:`, message.slice(-500));
    }
  });

  subprocess.on("error", error => {
    console.error(`[Music:${guildId}] yt-dlp process error:`, error?.message || error);
  });

  const resource = createAudioResource(subprocess.stdout, {
    inputType: StreamType.WebmOpus,
    inlineVolume: true,
    metadata: track
  });

  resource.volume.setVolume(Math.max(0, Math.min(100, session.volume)) / 100);
  session.current = { ...track, startedAt: Date.now(), seek };
  session.lastRequester = track.requesterId;
  session.history.push(track.id);
  session.history = session.history.slice(-25);
  session.player.play(resource);
  cancelIdleDisconnect(session);
  if (session.nowPlayingMessage) {
    session.lastCardSecond = null;
    void updateNowPlayingCard(guildId, true);
  }

  return settings;
}

async function autoplayTrack(guildId) {
  const session = sessionFor(guildId);
  const current = session.current;
  if (!current) return null;

  const query = `${current.title} ${current.channel}`;
  let data;
  try {
    data = await youtubedl(`ytsearch10:${query}`, ytDlpOptions({
      dumpSingleJson: true,
      flatPlaylist: true,
      extractFlat: true
    }));
  } catch (err) {
    const diagnostic = ytDlpError(err, "Autoplay search failed.");
    console.error(`[Music:${guildId}] autoplay search error:`, {
      message: err?.message || String(err),
      code: err?.code || null,
      stderr: String(err?.stderr || "").slice(-4000),
      stdout: String(err?.stdout || "").slice(-1000)
    });
    throw new Error(diagnostic);
  }

  const results = Array.isArray(data?.entries) ? data.entries : [];
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
  const requester = /^\d{17,20}$/.test(String(track.requesterId || "")) ? `<@${track.requesterId}>` : "Vyne Autoplay";
  return `${prefix} [${cleanTitle(track.title)}](${track.url}) • \`${track.durationText}\` • ${requester}`;
}

function currentElapsed(track) {
  if (!track) return 0;
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
  if (!session.current) throw new Error("There is no active track to force-fix.");
  const channelId = session.voiceChannelId || settings.voiceChannelId;
  const channel = guild.channels.cache.get(channelId);
  if (!channel || channel.type !== 2) throw new Error("The saved music voice channel no longer exists.");

  const track = { ...session.current };
  const elapsed = currentElapsed(track);
  settings.voiceChannelId = channel.id;
  settings.ownerId = settings.ownerId || requesterId;
  savePersistent();

  session.advancing = true;
  try {
    stopNowPlayingUpdater(session);
    session.player.stop(true);
    const old = getVoiceConnection(guildId);
    if (old) old.destroy();
    session.connection = null;
    session.voiceChannelId = null;

    await new Promise(resolve => setTimeout(resolve, 900));
    await connectToChannel(guild, channel);
    await startCurrent(guildId, track, Math.min(elapsed, Math.max(0, track.duration - 1)));
    return { track, elapsed, channelId: channel.id };
  } finally {
    session.advancing = false;
  }
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
    // All slash commands are acknowledged centrally by handleInteraction().
    // Do not call deferReply() here: doing so after the central ACK leaves the
    // interaction stuck in "Thinking..." and causes InteractionAlreadyReplied.
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
    return sendNowPlayingCard(interaction, guildId);
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
    stopNowPlayingUpdater(session);
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
    return sendNowPlayingCard(interaction, guildId);
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
    stopNowPlayingUpdater(session);
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
        if (!session.current) {
          const connection = getVoiceConnection(guildId);
          if (connection) connection.destroy();
          session.connection = null;
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
  forceFixMusic,
  flushMusicData
};
