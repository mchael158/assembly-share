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

    const params = new URLSearchParams(window.location.search);
    this.frameId = params.get("frame_id");
    this.instanceId = params.get("instance_id");
    this.platform = params.get("platform") || "desktop";
    this.guildId = params.get("guild_id");
    this.channelId = params.get("channel_id");

    if (!this.frameId || !this.instanceId) {
      throw new Error("Abra pelo foguete do Discord (faltam frame_id/instance_id).");
    }

    this.source = window.parent;
    this.targetOrigin = "*";

    window.addEventListener("message", this.#onMessage);
    this.commands = {
      authorize: (args) => this.#command("AUTHORIZE", args),
      authenticate: (args) => this.#command("AUTHENTICATE", args),
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

  ready() {
    if (this.isReady) return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  #send(payload) {
    this.source.postMessage(payload, this.targetOrigin);
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
        pending.reject(payload.data || new Error("SDK error"));
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
