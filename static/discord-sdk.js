/**
 * SDK mínimo Embedded App (postMessage RPC) — mesma origem, sem CDN.
 */

const Opcodes = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, HELLO: 3 };

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function allowedOrigin(origin) {
  if (!origin || origin === "null") return true;
  if (origin.endsWith(".discordsays.com")) return true;
  return /https:\/\/([a-z]+\.)?discord(app)?\.com$/i.test(origin);
}

export class DiscordSDK {
  constructor(clientId) {
    this.clientId = clientId;
    this.isReady = false;
    this.pending = new Map();
    this.readyWaiters = [];
    this.closeInfo = null;

    const params = new URLSearchParams(window.location.search);
    this.frameId = params.get("frame_id");
    this.instanceId = params.get("instance_id");
    this.platform = params.get("platform") || "desktop";
    this.guildId = params.get("guild_id");
    this.channelId = params.get("channel_id");

    if (!this.frameId || !this.instanceId) {
      throw new Error("Abra pelo foguete do Discord (faltam frame_id/instance_id).");
    }

    this.source = window.parent.opener ?? window.parent;
    this.targetOrigin = document.referrer ? new URL(document.referrer).origin : "*";

    window.addEventListener("message", this.#onMessage);
    this.commands = {
      authorize: (args) => this.#command("AUTHORIZE", args),
      authenticate: (args) => this.#command("AUTHENTICATE", args),
      openExternalLink: (args) => this.#command("OPEN_EXTERNAL_LINK", args),
    };

    this.#send([
      Opcodes.HANDSHAKE,
      {
        v: 1,
        encoding: "json",
        client_id: this.clientId,
        frame_id: this.frameId,
        sdk_version: "1.9.3-local",
      },
    ]);
  }

  ready(timeoutMs = 10_000) {
    if (this.isReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            this.closeInfo
              ? `Discord fechou a conexão: ${this.closeInfo}`
              : "Discord não respondeu ao handshake. Feche e reabra a Activity."
          )
        );
      }, timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #send(payload) {
    try {
      this.source.postMessage(payload, this.targetOrigin);
    } catch {
      this.source.postMessage(payload, "*");
    }
  }

  #command(cmd, args = {}) {
    const nonce = uuid();
    return new Promise((resolve, reject) => {
      this.pending.set(nonce, { resolve, reject });
      this.#send([Opcodes.FRAME, { cmd, args, nonce }]);
    });
  }

  #onMessage = (event) => {
    if (!allowedOrigin(event.origin)) return;
    const tuple = event.data;
    if (!Array.isArray(tuple)) return;
    const [opcode, data] = tuple;

    if (opcode === Opcodes.FRAME) {
      this.#onFrame(data);
    } else if (opcode === Opcodes.CLOSE) {
      this.closeInfo = data?.message || `code ${data?.code ?? "?"}`;
    }
  };

  #onFrame(payload) {
    if (!payload || typeof payload !== "object") return;

    if (payload.cmd === "DISPATCH" && payload.evt === "READY") {
      this.isReady = true;
      for (const resolve of this.readyWaiters) resolve();
      this.readyWaiters = [];
      return;
    }

    if (payload.evt === "ERROR" && payload.nonce) {
      const pending = this.pending.get(payload.nonce);
      if (pending) {
        const msg = payload.data?.message || payload.data?.code || "SDK error";
        pending.reject(new Error(String(msg)));
        this.pending.delete(payload.nonce);
      }
      return;
    }

    if (payload.nonce && this.pending.has(payload.nonce)) {
      const pending = this.pending.get(payload.nonce);
      const data = payload.data ?? payload;
      pending.resolve(data);
      this.pending.delete(payload.nonce);
    }
  }
}
