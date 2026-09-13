import { DiscordSDK } from "./discord-sdk.js";

const PRESETS = {
  ultra: { width: 1920, height: 1080, fps: 60, bitrate: 12_000_000, label: "Ultra 1080p60" },
  high: { width: 1920, height: 1080, fps: 30, bitrate: 8_000_000, label: "Alta 1080p30" },
  balanced: { width: 1280, height: 720, fps: 30, bitrate: 4_000_000, label: "720p30" },
};

const els = {
  title: document.getElementById("title"),
  meta: document.getElementById("meta"),
  status: document.getElementById("status"),
  overlay: document.getElementById("overlay"),
  preview: document.getElementById("preview"),
  view: document.getElementById("view"),
  mainBtn: document.getElementById("mainBtn"),
  quality: document.getElementById("quality"),
};

let discordSdk = null;
let auth = null;
let ws = null;
let roomId = "local-demo";
let publishing = false;
let mediaStream = null;
let videoTrack = null;
let encoder = null;
let decoder = null;
let frameTimer = null;
let canvas = null;
let ctx2d = null;
let encoderConfigSent = false;

function setStatus(text, hideOverlay = false) {
  els.status.textContent = text;
  els.overlay.classList.toggle("hidden", hideOverlay);
}

function setMeta(text) {
  els.meta.textContent = text;
}

function currentPreset() {
  return PRESETS[els.quality.value] || PRESETS.ultra;
}

function inDiscordActivity() {
  return (
    location.hostname.endsWith(".discordsays.com") ||
    new URLSearchParams(location.search).has("frame_id")
  );
}

async function activityFetch(path, init) {
  const attempts = inDiscordActivity()
    ? [`/.proxy${path}`, path]
    : [path, `/.proxy${path}`];
  for (const url of attempts) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
    } catch {}
  }
  return fetch(attempts[0], init);
}

async function loadConfig() {
  const res = await activityFetch("/api/activity/config");
  if (!res.ok) throw new Error("Activity sem DISCORD_CLIENT_ID no servidor");
  return res.json();
}

async function setupDiscord(clientId) {
  const params = new URLSearchParams(window.location.search);
  const inDiscord =
    inDiscordActivity() && params.has("frame_id") && params.has("instance_id");

  if (!inDiscord) {
    els.title.textContent = "Modo demo local";
    roomId = "demo-local";
    setStatus("Pronto para testar fora do Discord");
    els.mainBtn.disabled = false;
    els.mainBtn.textContent = "Transmitir tela";
    connectWs();
    return;
  }

  discordSdk = new DiscordSDK(clientId);
  await discordSdk.ready();

  const authz = await discordSdk.commands.authorize({
    client_id: clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify", "guilds", "applications.commands"],
  });
  const code = authz.code || authz?.data?.code;
  if (!code) throw new Error("Authorize não retornou code");

  const tokenRes = await activityFetch("/api/activity/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.json().catch(() => ({}));
    throw new Error(err.error || "Falha no token OAuth");
  }
  const { access_token } = await tokenRes.json();
  auth = await discordSdk.commands.authenticate({ access_token });

  const channelId = discordSdk.channelId || "unknown";
  const guildId = discordSdk.guildId || "dm";
  roomId = `${guildId}:${channelId}`;
  els.title.textContent = "Assembly Share";
  setStatus("Conectado. Um toque para transmitir.");
  els.mainBtn.disabled = false;
  els.mainBtn.textContent = "Transmitir tela";
  connectWs();
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const prefix = inDiscordActivity() ? "/.proxy" : "";
  return `${proto}//${location.host}${prefix}/ws/share?room=${encodeURIComponent(roomId)}`;
}

function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  ws = new WebSocket(wsUrl());
  ws.binaryType = "arraybuffer";

  ws.onopen = () => setMeta(`Sala ${roomId}`);
  ws.onclose = () => {
    setMeta("Reconectando…");
    setTimeout(connectWs, 1200);
  };
  ws.onmessage = async (ev) => {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data);
      if (msg.t === "roster") {
        setMeta(`${msg.live ? "AO VIVO" : "Aguardando"} · ${msg.viewers} na sala`);
        if (!publishing && !msg.live) {
          setStatus("Ninguém transmitindo. Toque para começar.");
          els.preview.hidden = true;
          els.view.hidden = true;
          els.overlay.classList.remove("hidden");
        }
      } else if (msg.t === "config" && !publishing) {
        await ensureDecoder(msg);
      } else if (msg.t === "ended" && !publishing) {
        setStatus("Transmissão encerrada");
        els.view.hidden = true;
        els.overlay.classList.remove("hidden");
        if (decoder) {
          try { decoder.close(); } catch {}
          decoder = null;
        }
      } else if (msg.t === "error") {
        setStatus(msg.message || "Erro");
      }
      return;
    }

    if (publishing) return;
    await handleVideoPacket(ev.data);
  };
}

function sendJson(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

async function pickCodec() {
  const candidates = [
    "avc1.640028", // H.264 High@4.0
    "avc1.42E01F",
    "vp09.00.10.08",
    "vp8",
  ];
  for (const codec of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width: 1280,
        height: 720,
        bitrate: 4_000_000,
        framerate: 30,
        avc: { format: "annexb" },
      });
      if (support.supported) return codec;
    } catch {}
  }
  throw new Error("WebCodecs VideoEncoder indisponível neste cliente");
}

async function startPublish() {
  const preset = currentPreset();
  mediaStream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: preset.fps, max: preset.fps },
    },
    audio: false,
  });

  videoTrack = mediaStream.getVideoTracks()[0];
  videoTrack.addEventListener("ended", () => stopPublish());

  els.preview.srcObject = mediaStream;
  els.preview.hidden = false;
  els.view.hidden = true;
  els.overlay.classList.add("hidden");

  canvas = document.createElement("canvas");
  canvas.width = preset.width;
  canvas.height = preset.height;
  ctx2d = canvas.getContext("2d", { alpha: false, desynchronized: true });

  const codec = await pickCodec();
  encoderConfigSent = false;

  encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (!encoderConfigSent) {
        const cfg = {
          t: "config",
          codec,
          codedWidth: preset.width,
          codedHeight: preset.height,
          description: meta?.decoderConfig?.description
            ? bufferToBase64(meta.decoderConfig.description)
            : null,
        };
        sendJson(cfg);
        encoderConfigSent = true;
      }
      const buf = new ArrayBuffer(10 + chunk.byteLength);
      const view = new DataView(buf);
      view.setUint8(0, 1);
      view.setUint8(1, chunk.type === "key" ? 1 : 0);
      view.setBigUint64(2, BigInt(chunk.timestamp), true);
      chunk.copyTo(new Uint8Array(buf, 10));
      if (ws?.readyState === WebSocket.OPEN) ws.send(buf);
    },
    error: (e) => {
      console.error(e);
      setStatus(`Encoder: ${e.message}`);
    },
  });

  const encConfig = {
    codec,
    width: preset.width,
    height: preset.height,
    bitrate: preset.bitrate,
    framerate: preset.fps,
    latencyMode: "realtime",
    hardwareAcceleration: "prefer-hardware",
    avc: { format: "annexb" },
  };
  // VP9/VP8 não usam avc
  if (!codec.startsWith("avc")) delete encConfig.avc;

  await encoder.configure(encConfig);
  sendJson({ t: "publish" });

  const interval = Math.max(8, Math.floor(1000 / preset.fps));
  let frameNo = 0;
  frameTimer = setInterval(async () => {
    if (!encoder || encoder.state === "closed") return;
    const bmp = await createImageBitmap(videoTrack);
    try {
      // letterbox para manter aspecto sem distorcer
      ctx2d.fillStyle = "#000";
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      const scale = Math.min(canvas.width / bmp.width, canvas.height / bmp.height);
      const w = bmp.width * scale;
      const h = bmp.height * scale;
      const x = (canvas.width - w) / 2;
      const y = (canvas.height - h) / 2;
      ctx2d.drawImage(bmp, x, y, w, h);
      const frame = new VideoFrame(canvas, {
        timestamp: frameNo * (1_000_000 / preset.fps),
      });
      const keyFrame = frameNo % (preset.fps * 1) === 0;
      encoder.encode(frame, { keyFrame });
      frame.close();
      frameNo += 1;
    } finally {
      bmp.close();
    }
  }, interval);

  publishing = true;
  els.mainBtn.textContent = "Parar transmissão";
  els.mainBtn.classList.add("live");
  els.quality.disabled = true;
  setStatus(`${preset.label} · transmitindo`, true);
}

async function ensureDecoder(cfg) {
  if (decoder) {
    try { decoder.close(); } catch {}
  }
  els.view.hidden = false;
  els.preview.hidden = true;
  const vctx = els.view.getContext("2d", { alpha: false, desynchronized: true });
  els.view.width = cfg.codedWidth || 1920;
  els.view.height = cfg.codedHeight || 1080;

  decoder = new VideoDecoder({
    output: (frame) => {
      vctx.drawImage(frame, 0, 0, els.view.width, els.view.height);
      frame.close();
      els.overlay.classList.add("hidden");
    },
    error: (e) => {
      console.error(e);
      setStatus(`Decoder: ${e.message}`);
    },
  });

  const config = {
    codec: cfg.codec,
    codedWidth: cfg.codedWidth,
    codedHeight: cfg.codedHeight,
  };
  if (cfg.description) {
    config.description = base64ToBuffer(cfg.description);
  }
  await decoder.configure(config);
  setStatus("Recebendo stream…", true);
}

async function handleVideoPacket(buffer) {
  if (!decoder || decoder.state === "closed") return;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== 1) return;
  const key = view.getUint8(1) === 1;
  const ts = Number(view.getBigUint64(2, true));
  const data = new Uint8Array(buffer, 10);
  const chunk = new EncodedVideoChunk({
    type: key ? "key" : "delta",
    timestamp: ts,
    data,
  });
  try {
    decoder.decode(chunk);
  } catch (e) {
    console.warn(e);
  }
}

async function stopPublish() {
  publishing = false;
  els.mainBtn.classList.remove("live");
  els.mainBtn.textContent = "Transmitir tela";
  els.quality.disabled = false;
  sendJson({ t: "unpublish" });

  if (frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
  if (encoder) {
    try {
      await encoder.flush();
      encoder.close();
    } catch {}
    encoder = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  els.preview.srcObject = null;
  els.preview.hidden = true;
  setStatus("Transmissão parada");
  els.overlay.classList.remove("hidden");
}

function bufferToBase64(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer || buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBuffer(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

els.mainBtn.addEventListener("click", async () => {
  try {
    if (publishing) await stopPublish();
    else await startPublish();
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e));
    els.overlay.classList.remove("hidden");
  }
});

(async () => {
  try {
    const cfg = await loadConfig();
    await setupDiscord(cfg.client_id);
  } catch (e) {
    console.error(e);
    els.title.textContent = "Assembly Share";
    setStatus(e.message || String(e));
    // Ainda permite demo local se config falhar parcialmente
    els.mainBtn.disabled = false;
    els.mainBtn.textContent = "Transmitir tela";
    connectWs();
  }
})();
