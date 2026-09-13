import("./app.js").catch((err) => {
  console.error(err);
  const status = document.getElementById("status");
  const overlay = document.getElementById("overlay");
  if (status) status.textContent = err?.message || String(err);
  overlay?.classList.remove("hidden");
});
