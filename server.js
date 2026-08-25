const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Simple in-memory key-value store. Mirrors the get/set/delete shape the
// client used to talk to the Artifacts `window.storage` API, so the game
// logic on the client barely had to change.
const store = new Map();
const lastTouched = new Map();

function touch(key) {
  lastTouched.set(key, Date.now());
}

app.get("/api/kv/:key", (req, res) => {
  const key = req.params.key;
  if (!store.has(key)) return res.status(404).json({ error: "not found" });
  res.json({ value: store.get(key) });
});

app.put("/api/kv/:key", (req, res) => {
  const key = req.params.key;
  const { value } = req.body || {};
  if (typeof value !== "string") {
    return res.status(400).json({ error: "value must be a string" });
  }
  store.set(key, value);
  touch(key);
  res.json({ ok: true });
});

app.delete("/api/kv/:key", (req, res) => {
  store.delete(req.params.key);
  lastTouched.delete(req.params.key);
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, keys: store.size }));

// Rooms/lots are small and short-lived; sweep anything untouched for a
// day so a long-running server doesn't accumulate abandoned games forever.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of lastTouched) {
    if (now - ts > MAX_AGE_MS) {
      store.delete(key);
      lastTouched.delete(key);
    }
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Prem Auction League server running on http://localhost:${PORT}`);
});
