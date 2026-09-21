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

async function ytInfo(url, extra = {}) {
  try {
    return await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noPlaylist: true,
      skipDownload: true,
      ...extra
    });
  } catch (err) {
    const message = String(err?.stderr || err?.message || err || "");
    if (/sign in to confirm|not a bot|LOGIN_REQUIRED/i.test(message)) {
      throw new Error("YouTube is blocking this server's IP. Try again later or configure YouTube cookies/PO-token support on the host.");
    }
    throw new Error(message.split("\n").filter(Boolean).slice(-1)[0] || "YouTube could not be read.");
  }
}

async function ytSearch(query, limit = 8) {
  const data = await ytInfo(`ytsearch${limit}:${query}`, {
    flatPlaylist: true,
    extractFlat: true
  });
  return Array.isArray(data?.entries) ? data.entries : [];
}

async function resolveTrack(query, requester) {
  const input = String(query || "").trim();
  if (!input) throw new Error("Enter a YouTube URL or song name.");

  let url = input;
  let info;

  if (isYouTubeUrl(input)) {
    const id = youtubeVideoId(input);
    if (!id) throw new Error("That YouTube URL does not contain a playable video.");
    info = await ytInfo(input);
  } else {
    const results = await ytSearch(input, 8);
    const result = results.find(v => v?.url && !v.live) || results.find(v => v?.url);
    if (!result?.url) throw new Error("No YouTube results found for that song.");
    url = result.url;
    info = await ytInfo(url);
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

