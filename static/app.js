import { DiscordSDK } from "./discord-sdk.js";

const PRESETS = {
  ultra: { width: 1920, height: 1080, fps: 60, bitrate: 12_000_000, label: "Ultra 1080p60" },
  high: { width: 1920, height: 1080, fps: 30, bitrate: 8_000_000, label: "Alta 1080p30" },
  balanced: { width: 1280, height: 720, fps: 30, bitrate: 4_000_000, label: "720p30" },
};

const PACKET_WEBCODECS = 1;
const PACKET_MEDIARECORDER = 2;

const els = {
  title: document.getElementById("title"),
  meta: document.getElementById("meta"),
  status: document.getElementById("status"),
  overlay: document.getElementById("overlay"),
  preview: document.getElementById("preview"),
  remote: document.getElementById("remote"),
  view: document.getElementById("view"),
  mainBtn: document.getElementById("mainBtn"),
  quality: document.getElementById("quality"),
};

let discordSdk = null;
let auth = null;
let ws = null;
let roomId = "local-demo";
let publishKey = null;
// "activity" (dentro do Discord, só assiste e abre o transmissor externo)
// "publisher" (aba do navegador aberta pela Activity, captura e envia)
// "demo" (fora do Discord, tudo local)
let mode = "demo";
let roomLive = false;
let publishing = false;
let mediaStream = null;
let videoTrack = null;
let encoder = null;
let decoder = null;
let mediaRecorder = null;
let frameTimer = null;
let canvas = null;
let ctx2d = null;
let encoderConfigSent = false;
let publishMode = null; // "webcodecs" | "mediarecorder"
let mediaSource = null;
let sourceBuffer = null;
let mrQueue = [];
let mrMime = "";

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

// Backend (API + WebSocket) sempre na Discloud.
// - Dentro do Discord: proxy path mapping `/backend` -> assembly.discloud.app
// - Servido pela própria Discloud: mesma origem
// - Servido de outro host estático (GitHub Pages): URL absoluta + CORS
const BACKEND_HOST = "assembly.discloud.app";

function backendHttpBase() {
  if (inDiscordActivity()) return "/backend";
  if (location.hostname === BACKEND_HOST) return "";
  return `https://${BACKEND_HOST}`;
}

function backendWsBase() {
  if (inDiscordActivity()) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/backend`;
  }
  if (location.hostname === BACKEND_HOST) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}`;
  }
  return `wss://${BACKEND_HOST}`;
}

function webCodecsAvailable() {
  return (
    typeof VideoEncoder !== "undefined" &&
    typeof VideoDecoder !== "undefined" &&
    typeof VideoFrame !== "undefined" &&
    typeof EncodedVideoChunk !== "undefined"
  );
}

async function activityFetch(path, init) {
  const base = backendHttpBase();
  const attempts = inDiscordActivity()
    ? [`${base}${path}`, `/.proxy${base}${path}`]
    : [`${base}${path}`];
  let lastErr = null;
  for (const url of attempts) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      let detail = "";
      try {
        const body = await res.clone().json();
        detail = body?.error ? ` — ${body.error}` : "";
      } catch {}
      lastErr = new Error(`HTTP ${res.status} em ${url}${detail}`);
      // Erro do servidor com resposta válida: não adianta tentar outro caminho.
      if (res.status >= 400 && res.status < 500 && res.status !== 404) break;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Backend indisponível");
}

async function loadConfig() {
  let res;
  try {
    res = await activityFetch("/api/activity/config");
  } catch (e) {
    throw new Error(
      inDiscordActivity()
        ? "Backend não alcançado. No Developer Portal, adicione o mapeamento /backend → assembly.discloud.app"
        : `Backend indisponível: ${e.message || e}`
    );
  }
  return res.json();
}

// Página do transmissor externo: hospedada no GitHub Pages (evita bloqueios de
// antivírus no domínio compartilhado da Discloud). API/WS continuam na Discloud.
const PUBLISHER_ORIGIN = "https://mchael158.github.io/assembly-share/";

function publisherUrl() {
  const u = new URL(PUBLISHER_ORIGIN);
  u.searchParams.set("room", roomId);
  u.searchParams.set("key", publishKey || "");
  return u.toString();
}

function getOrCreatePublishKey() {
  const storageKey = `assembly-share:key:${roomId}`;
  let key = null;
  try {
    key = sessionStorage.getItem(storageKey);
  } catch {}
  if (!key) {
    key = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
    try {
      sessionStorage.setItem(storageKey, key);
    } catch {}
  }
  return key;
}

function refreshActivityButton() {
  if (mode !== "activity") return;
  if (roomLive) {
    els.mainBtn.disabled = true;
    els.mainBtn.textContent = "AO VIVO · pare pela aba do navegador";
  } else {
    els.mainBtn.disabled = false;
    els.mainBtn.textContent = "Transmitir tela (abre no navegador)";
  }
}

async function setupDiscord(clientId) {
  const params = new URLSearchParams(window.location.search);
  const inDiscord =
    inDiscordActivity() && params.has("frame_id") && params.has("instance_id");

  if (!inDiscord) {
    const roomParam = params.get("room");
    if (roomParam) {
      mode = "publisher";
      roomId = roomParam;
      publishKey = params.get("key");
      els.title.textContent = "Transmissor Assembly Share";
      setStatus("Clique abaixo e escolha o que transmitir (tela, janela ou aba).");
      els.mainBtn.disabled = false;
      els.mainBtn.textContent = "Escolher o que transmitir";
      connectWs();
      return;
    }

    mode = "demo";
    els.title.textContent = "Modo demo local";
    roomId = "demo-local";
    setStatus("Pronto para testar fora do Discord");
    els.mainBtn.disabled = false;
    els.mainBtn.textContent = "Transmitir tela";
    connectWs();
    return;
  }

  mode = "activity";
  setStatus("Conectando ao Discord…");
  discordSdk = new DiscordSDK(clientId);
  await discordSdk.ready();

  setStatus("Autorize o Assembly na janela do Discord, se aparecer…");
  const authz = await discordSdk.commands.authorize({
    client_id: clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify", "guilds", "applications.commands"],
  });
  const code = authz.code || authz?.data?.code;
  if (!code) throw new Error("Authorize não retornou code");

  setStatus("Validando sessão…");
  const tokenRes = await activityFetch("/api/activity/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

  const { access_token } = await tokenRes.json();
  auth = await discordSdk.commands.authenticate({ access_token });

  const channelId = discordSdk.channelId || "unknown";
  const guildId = discordSdk.guildId || "dm";
  roomId = `${guildId}:${channelId}`;
  publishKey = getOrCreatePublishKey();
  els.title.textContent = "Assembly Share";
  setStatus("Conectando à sala…");
  connectWs();
  refreshActivityButton();
}

async function openExternalPublisher() {
  if (!publishKey || roomId === "local-demo") {
    setStatus("A conexão com o Discord não foi concluída. Toque em Tentar novamente.");
    els.mainBtn.textContent = "Tentar novamente";
    els.mainBtn.onclick = () => location.reload();
    return;
  }
  const url = publisherUrl();
  setStatus("Abrindo o transmissor no navegador… escolha lá o que transmitir. O vídeo aparece aqui.");
  try {
    await discordSdk.commands.openExternalLink({ url });
  } catch (e) {
    console.warn(e);
    setStatus(`Não abriu automaticamente. Copie e abra no navegador: ${url}`);
  }
}

function wsUrl() {
  return `${backendWsBase()}/ws/share?room=${encodeURIComponent(roomId)}`;
}

function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  ws = new WebSocket(wsUrl());
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    setMeta(`Sala ${roomId}`);
    if (mode === "activity" && publishKey) {
      sendJson({ t: "claim", key: publishKey });
    }
  };
  ws.onclose = () => {
    setMeta("Reconectando…");
    setTimeout(connectWs, 1200);
  };
  ws.onmessage = async (ev) => {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data);
      if (msg.t === "roster") {
        roomLive = !!msg.live;
        setMeta(`${msg.live ? "AO VIVO" : "Aguardando"} · ${msg.viewers} na sala`);
        refreshActivityButton();
        if (!publishing && !msg.live) {
          setStatus(
            mode === "activity"
              ? "Ninguém transmitindo. Toque no botão para abrir o transmissor."
              : "Ninguém transmitindo. Toque para começar."
          );
          els.preview.hidden = true;
          els.remote.hidden = true;
          els.view.hidden = true;
          els.overlay.classList.remove("hidden");
        }
      } else if (msg.t === "config" && !publishing) {
        await ensureViewer(msg);
      } else if (msg.t === "ended" && !publishing) {
        teardownViewer();
        setStatus("Transmissão encerrada");
        els.remote.hidden = true;
        els.view.hidden = true;
        els.overlay.classList.remove("hidden");
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

function pickMediaRecorderMime() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  for (const mime of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return null;
}

async function pickWebCodecsCodec(preset) {
  if (!webCodecsAvailable()) return null;

  const candidates = [
    { codec: "vp8", width: Math.min(preset.width, 1280), height: Math.min(preset.height, 720), bitrate: Math.min(preset.bitrate, 4_000_000), framerate: Math.min(preset.fps, 30) },
    { codec: "vp09.00.10.08", width: Math.min(preset.width, 1280), height: Math.min(preset.height, 720), bitrate: Math.min(preset.bitrate, 4_000_000), framerate: Math.min(preset.fps, 30) },
    { codec: "avc1.42E01F", width: Math.min(preset.width, 1280), height: Math.min(preset.height, 720), bitrate: Math.min(preset.bitrate, 4_000_000), framerate: Math.min(preset.fps, 30), avc: { format: "annexb" } },
    { codec: "avc1.640028", width: preset.width, height: preset.height, bitrate: preset.bitrate, framerate: Math.min(preset.fps, 60), avc: { format: "annexb" } },
  ];

  for (const cfg of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        ...cfg,
        latencyMode: "realtime",
        hardwareAcceleration: "no-preference",
      });
      if (support.supported) {
        return { ...cfg, ...(support.config || {}) };
      }
    } catch {}
  }
  return null;
}

async function startPublish() {
  const preset = currentPreset();
  mediaStream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: Math.min(preset.fps, 30), max: preset.fps },
    },
    audio: false,
  });

  videoTrack = mediaStream.getVideoTracks()[0];
  videoTrack.addEventListener("ended", () => stopPublish());

  els.preview.srcObject = mediaStream;
  els.preview.hidden = false;
  els.view.hidden = true;
  els.overlay.classList.add("hidden");

  const wc = await pickWebCodecsCodec(preset);
  if (wc) {
    try {
      await startWebCodecsPublish(wc);
      return;
    } catch (e) {
      console.warn("WebCodecs falhou, tentando MediaRecorder:", e);
      await cleanupEncoderOnly();
    }
  }

  await startMediaRecorderPublish(preset);
}

async function cleanupEncoderOnly() {
  if (frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
  if (encoder) {
    try {
      encoder.close();
    } catch {}
    encoder = null;
  }
}

async function startWebCodecsPublish(cfg) {
  publishMode = "webcodecs";
  encoderConfigSent = false;

  canvas = document.createElement("canvas");
  canvas.width = cfg.width;
  canvas.height = cfg.height;
  ctx2d = canvas.getContext("2d", { alpha: false, desynchronized: true });

  encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (!encoderConfigSent) {
        sendJson({
          t: "config",
          mode: "webcodecs",
          codec: cfg.codec,
          codedWidth: cfg.width,
          codedHeight: cfg.height,
          description: meta?.decoderConfig?.description
            ? bufferToBase64(meta.decoderConfig.description)
            : null,
        });
        encoderConfigSent = true;
      }
      const buf = new ArrayBuffer(10 + chunk.byteLength);
      const view = new DataView(buf);
      view.setUint8(0, PACKET_WEBCODECS);
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
    codec: cfg.codec,
    width: cfg.width,
    height: cfg.height,
    bitrate: cfg.bitrate,
    framerate: cfg.framerate,
    latencyMode: "realtime",
    hardwareAcceleration: "no-preference",
  };
  if (cfg.avc) encConfig.avc = cfg.avc;

  await encoder.configure(encConfig);
  sendJson({ t: "publish", key: publishKey });

  const interval = Math.max(16, Math.floor(1000 / cfg.framerate));
  let frameNo = 0;
  let encoding = false;

  frameTimer = setInterval(async () => {
    if (!encoder || encoder.state !== "configured" || encoding) return;
    if (encoder.encodeQueueSize > 2) return;
    encoding = true;
    try {
      let bmp;
      try {
        bmp = await createImageBitmap(videoTrack);
      } catch {
        bmp = await createImageBitmap(els.preview);
      }
      try {
        ctx2d.fillStyle = "#000";
        ctx2d.fillRect(0, 0, canvas.width, canvas.height);
        const scale = Math.min(canvas.width / bmp.width, canvas.height / bmp.height);
        const w = bmp.width * scale;
        const h = bmp.height * scale;
        const x = (canvas.width - w) / 2;
        const y = (canvas.height - h) / 2;
        ctx2d.drawImage(bmp, x, y, w, h);
        const frame = new VideoFrame(canvas, {
          timestamp: frameNo * (1_000_000 / cfg.framerate),
        });
        const keyFrame = frameNo % Math.max(1, cfg.framerate) === 0;
        encoder.encode(frame, { keyFrame });
        frame.close();
        frameNo += 1;
      } finally {
        bmp.close();
      }
    } catch (e) {
      console.error(e);
      setStatus(`Encoder: ${e.message || e}`);
      clearInterval(frameTimer);
      frameTimer = null;
    } finally {
      encoding = false;
    }
  }, interval);

  publishing = true;
  els.mainBtn.textContent = "Parar transmissão";
  els.mainBtn.classList.add("live");
  els.quality.disabled = true;
  setStatus(`${cfg.codec} · ${cfg.width}x${cfg.height}@${cfg.framerate} · WebCodecs`, true);
}

async function startMediaRecorderPublish(preset) {
  const mime = pickMediaRecorderMime();
  if (!mime) {
    throw new Error(
      "Este navegador não suporta WebCodecs nem MediaRecorder. Use Chrome/Edge (ou Discord desktop)."
    );
  }

  publishMode = "mediarecorder";
  mrMime = mime;

  const bitrate = Math.min(preset.bitrate, 6_000_000);
  mediaRecorder = new MediaRecorder(mediaStream, {
    mimeType: mime,
    videoBitsPerSecond: bitrate,
  });

  sendJson({
    t: "config",
    mode: "mediarecorder",
    mime,
    codedWidth: preset.width,
    codedHeight: preset.height,
  });
  sendJson({ t: "publish", key: publishKey });

  mediaRecorder.ondataavailable = async (ev) => {
    if (!ev.data || ev.data.size === 0) return;
    const ab = await ev.data.arrayBuffer();
    const buf = new ArrayBuffer(1 + ab.byteLength);
    const out = new Uint8Array(buf);
    out[0] = PACKET_MEDIARECORDER;
    out.set(new Uint8Array(ab), 1);
    if (ws?.readyState === WebSocket.OPEN) ws.send(buf);
  };

  mediaRecorder.onerror = (e) => {
    console.error(e);
    setStatus(`MediaRecorder: ${e.error?.message || "erro"}`);
  };

  // timeslice curto = latência menor
  mediaRecorder.start(250);

  publishing = true;
  els.mainBtn.textContent = "Parar transmissão";
  els.mainBtn.classList.add("live");
  els.quality.disabled = true;
  setStatus(`MediaRecorder · ${mime} (compatível)`, true);
}

function teardownViewer() {
  if (decoder) {
    try {
      decoder.close();
    } catch {}
    decoder = null;
  }
  if (mediaSource) {
    try {
      if (mediaSource.readyState === "open") mediaSource.endOfStream();
    } catch {}
    mediaSource = null;
  }
  sourceBuffer = null;
  mrQueue = [];
  if (els.remote.src) {
    try {
      URL.revokeObjectURL(els.remote.src);
    } catch {}
    els.remote.removeAttribute("src");
    els.remote.load();
  }
}

async function ensureViewer(cfg) {
  teardownViewer();
  els.preview.hidden = true;

  if (cfg.mode === "mediarecorder") {
    els.view.hidden = true;
    els.remote.hidden = false;
    await ensureMediaRecorderViewer(cfg);
    return;
  }
  els.remote.hidden = true;
  els.view.hidden = false;
  await ensureWebCodecsViewer(cfg);
}

async function ensureMediaRecorderViewer(cfg) {
  mrMime = cfg.mime || "video/webm;codecs=vp8";
  if (!window.MediaSource) {
    setStatus("MediaSource indisponível para receber o stream");
    return;
  }

  mediaSource = new MediaSource();
  els.remote.src = URL.createObjectURL(mediaSource);
  els.remote.muted = true;
  els.remote.playsInline = true;

  await new Promise((resolve, reject) => {
    mediaSource.addEventListener("sourceopen", resolve, { once: true });
    mediaSource.addEventListener("error", reject, { once: true });
  });

  try {
    sourceBuffer = mediaSource.addSourceBuffer(mrMime);
  } catch (e) {
    try {
      sourceBuffer = mediaSource.addSourceBuffer("video/webm;codecs=vp8");
      mrMime = "video/webm;codecs=vp8";
    } catch (e2) {
      setStatus(`Viewer MSE: ${e2.message || e.message}`);
      return;
    }
  }

  sourceBuffer.mode = "sequence";
  sourceBuffer.addEventListener("updateend", flushMrQueue);
  setStatus("Recebendo stream (MediaRecorder)…", true);
  els.remote.play().catch(() => {});
}

function flushMrQueue() {
  if (!sourceBuffer || sourceBuffer.updating || !mrQueue.length) return;
  const next = mrQueue.shift();
  try {
    sourceBuffer.appendBuffer(next);
    els.overlay.classList.add("hidden");
  } catch (e) {
    console.warn(e);
  }
}

async function ensureWebCodecsViewer(cfg) {
  if (!webCodecsAvailable()) {
    setStatus("WebCodecs indisponível neste cliente para assistir");
    return;
  }

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
  const view = new DataView(buffer);
  const kind = view.getUint8(0);

  if (kind === PACKET_MEDIARECORDER) {
    const data = buffer.slice(1);
    mrQueue.push(data);
    flushMrQueue();
    return;
  }

  if (kind !== PACKET_WEBCODECS) return;
  if (!decoder || decoder.state === "closed") return;

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
  if (mediaRecorder) {
    try {
      if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
    } catch {}
    mediaRecorder = null;
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
  publishMode = null;
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
    if (mode === "activity") {
      await openExternalPublisher();
      return;
    }
    if (publishing) await stopPublish();
    else await startPublish();
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e));
    els.overlay.classList.remove("hidden");
    try {
      await stopPublish();
    } catch {}
  }
});

(async () => {
  try {
    const cfg = await loadConfig();
    await setupDiscord(cfg.client_id);
  } catch (e) {
    console.error(e);
    els.title.textContent = "Assembly Share";
    setStatus(`Erro: ${e.message || String(e)}`);
    if (mode === "activity") {
      // Dentro do Discord não há fallback: mostrar o erro e oferecer recarregar.
      els.mainBtn.disabled = false;
      els.mainBtn.textContent = "Tentar novamente";
      els.mainBtn.onclick = () => location.reload();
      return;
    }
    els.mainBtn.disabled = false;
    els.mainBtn.textContent = "Transmitir tela";
    connectWs();
  }
})();
