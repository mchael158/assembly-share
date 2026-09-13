/**
 * SDK mínimo Embedded App (postMessage RPC) — servido na mesma origem.
 * Suficiente para authorize/authenticate/ready sem CDN externo.
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
  const ok = new Set([
    window.location.origin,
    "https://discord.com",
    "https://discordapp.com",
    "https://ptb.discord.com",
    "https://ptb.discordapp.com",
    "https://canary.discord.com",
    "https://canary.discordapp.com",
    "null",
  ]);
  return ok.has(origin);
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

    this.source = window.parent.opener ?? window.parent;
    this.sourceOrigin = document.referrer || "*";

    window.addEventListener("message", this.#onMessage);
    this.commands = {
      authorize: (args) => this.#command("AUTHORIZE", args),
      authenticate: (args) => this.#command("AUTHENTICATE", args),
    };

    this.source.postMessage(
      [
        Opcodes.HANDSHAKE,
        {
          v: 1,
          encoding: "json",
          client_id: this.clientId,
          frame_id: this.frameId,
          sdk_version: "1.9.3-local",
        },
      ],
      this.sourceOrigin
    );
  }

  ready() {
    if (this.isReady) return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  #command(cmd, args = {}) {
    const nonce = uuid();
    return new Promise((resolve, reject) => {
      this.pending.set(nonce, { resolve, reject });
      this.source.postMessage(
        [Opcodes.FRAME, { cmd, args, nonce }],
        this.sourceOrigin
      );
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
      // AUTHORIZE responde com data.code; AUTHENTICATE com user etc.
      const data = payload.data ?? payload;
      pending.resolve(data);
      this.pending.delete(payload.nonce);
    }
  }
}
