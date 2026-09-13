import { patchUrlMappings } from "./discord-sdk.js";

const cfg = window.__ASSEMBLY__ || {
  mappingPrefix: "/",
  mappingTarget: "assembly.discloud.app",
};

function inDiscordActivity() {
  return (
    location.hostname.endsWith(".discordsays.com") ||
    new URLSearchParams(location.search).has("frame_id")
  );
}

if (inDiscordActivity()) {
  patchUrlMappings([{ prefix: cfg.mappingPrefix, target: cfg.mappingTarget }], {
    patchFetch: true,
    patchWebSocket: true,
    patchXhr: true,
    patchSrcAttributes: true,
  });
}

import("./app.js").catch((err) => {
  console.error(err);
  const status = document.getElementById("status");
  const overlay = document.getElementById("overlay");
  if (status) status.textContent = err?.message || String(err);
  overlay?.classList.remove("hidden");
});
