/**
 * SDK mínimo Embedded App (postMessage RPC) — servido na mesma origem.
 * Inclui patchUrlMappings para o sandbox do Discord (discordsays.com).
 */

const Opcodes = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, HELLO: 3 };
const SUBSTITUTION_REGEX = /\{([a-z]+)\}/g;

function absoluteURL(url, protocol = location.protocol, host = location.host) {
  return new URL(url, `${protocol}//${host}`);
}

function regexFromTarget(target) {
  const regexString = target.replace(SUBSTITUTION_REGEX, (_, name) => `(?<${name}>[\\w-]+)`);
  return new RegExp(`${regexString}(/|$)`);
}

function matchAndRewriteURL({ originalURL, prefix, prefixHost, target }) {
  const targetURL = new URL(`https://${target}`);
  const targetRegEx = regexFromTarget(
    targetURL.host.replace(/%7B/g, "{").replace(/%7D/g, "}")
  );
  const match = originalURL.toString().match(targetRegEx);
  if (match == null) return originalURL;

  const newURL = new URL(originalURL.toString());
  newURL.host = prefixHost;
  newURL.pathname = prefix.replace(SUBSTITUTION_REGEX, (_, matchName) => {
    const replaceValue = match.groups?.[matchName];
    if (replaceValue == null) throw new Error("Misconfigured route.");
    return replaceValue;
  });

  const pathToAppend = originalURL.pathname.startsWith("/")
    ? originalURL.pathname.slice(1)
    : originalURL.pathname;
  newURL.pathname += newURL.pathname.endsWith("/") ? pathToAppend : `/${pathToAppend}`;
  newURL.pathname = newURL.pathname.replace(targetURL.pathname, "");
  if (originalURL.pathname.endsWith("/") && !newURL.pathname.endsWith("/")) {
    newURL.pathname += "/";
  }
  return newURL;
}

export function attemptRemap({ url, mappings }) {
  const newURL = new URL(url.toString());
  for (const mapping of mappings) {
    const mapped = matchAndRewriteURL({
      originalURL: newURL,
      prefix: mapping.prefix,
      target: mapping.target,
      prefixHost: location.host,
    });
    if (mapped != null && mapped.toString() !== url.toString()) {
      return mapped;
    }
  }
  return newURL;
}

function attemptRecreateScriptNode(node, { url, mappings }) {
  const newUrl = attemptRemap({ url, mappings });
  if (url.toString() === newUrl.toString()) return;
  const newNode = document.createElement(node.tagName);
  newNode.innerHTML = node.innerHTML;
  for (const attr of node.attributes) {
    newNode.setAttribute(attr.name, attr.value);
  }
  newNode.setAttribute("src", attemptRemap({ url, mappings }).toString());
  node.after(newNode);
  node.remove();
}

function attemptSetNodeSrc(node, mappings) {
  if (!(node instanceof HTMLElement) || !node.hasAttribute("src")) return;
  const rawSrc = node.getAttribute("src");
  const url = absoluteURL(rawSrc ?? "");
  if (url.host === location.host) return;
  if (node.tagName.toLowerCase() === "script") {
    attemptRecreateScriptNode(node, { url, mappings });
    return;
  }
  const newSrc = attemptRemap({ url, mappings }).toString();
  if (newSrc !== rawSrc) node.setAttribute("src", newSrc);
}

function recursivelyRemapChildNodes(node, mappings) {
  if (!node.hasChildNodes()) return;
  node.childNodes.forEach((child) => {
    attemptSetNodeSrc(child, mappings);
    recursivelyRemapChildNodes(child, mappings);
  });
}

/** Reescreve fetch/WebSocket/XHR para rotas mapeadas no Developer Portal. */
export function patchUrlMappings(
  mappings,
  { patchFetch = true, patchWebSocket = true, patchXhr = true, patchSrcAttributes = false } = {}
) {
  if (typeof window === "undefined") return;

  if (patchFetch) {
    const fetchImpl = window.fetch.bind(window);
    window.fetch = function (input, init) {
      if (input instanceof Request) {
        const newUrl = attemptRemap({ url: absoluteURL(input.url), mappings });
        const newInit = { ...(init ?? {}) };
        return input.blob().then((blob) => {
          if (
            input.method.toUpperCase() !== "HEAD" &&
            input.method.toUpperCase() !== "GET" &&
            blob.size > 0
          ) {
            newInit.body = blob;
          }
          return fetchImpl(new Request(newUrl, { ...newInit, method: input.method, headers: input.headers }));
        });
      }
      const remapped = attemptRemap({
        url: input instanceof URL ? input : absoluteURL(input),
        mappings,
      });
      return fetchImpl(remapped, init);
    };
  }

  if (patchWebSocket) {
    class WebSocketProxy extends WebSocket {
      constructor(url, protocols) {
        const remapped = attemptRemap({
          url: url instanceof URL ? url : absoluteURL(url),
          mappings,
        });
        super(remapped, protocols);
      }
    }
    window.WebSocket = WebSocketProxy;
  }

  if (patchXhr) {
    const openImpl = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, async, username, password) {
      const remapped = attemptRemap({ url: absoluteURL(url), mappings });
      openImpl.call(this, method, remapped.toString(), async, username, password);
    };
  }

  if (patchSrcAttributes) {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes" && mutation.attributeName === "src") {
          attemptSetNodeSrc(mutation.target, mappings);
        } else if (mutation.type === "childList") {
          mutation.addedNodes.forEach((node) => {
            attemptSetNodeSrc(node, mappings);
            recursivelyRemapChildNodes(node, mappings);
          });
        }
      }
    });
    observer.observe(document, { attributeFilter: ["src"], childList: true, subtree: true });
    document.querySelectorAll("[src]").forEach((node) => attemptSetNodeSrc(node, mappings));
  }
}

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
