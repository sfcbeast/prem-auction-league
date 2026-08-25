const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Simple in-memory key-value store. Mirrors the get/set/delete shape the
// client used to talk to the Artifacts `window.storage` API, so the game
// logic on the client barely had to change.
//
// Persisted to disk so active rooms survive a process restart — Render's
// free tier spins the service down after ~15 min idle and restarts it on
// the next request, which used to wipe every in-progress game with no
// warning to the players. This does NOT survive a fresh deploy (Render
// gives a new deploy a clean ephemeral disk), only same-instance restarts.
const DATA_FILE = path.join(__dirname, "data.json");
let store = new Map();
let lastTouched = new Map();
try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    store = new Map(raw.store);
    lastTouched = new Map(raw.lastTouched);
    console.log(`Loaded ${store.size} persisted key(s) from disk`);
  }
} catch (e) {
  console.error("Failed to load persisted data, starting fresh:", e.message);
}

let dirty = false;
function touch(key) {
  lastTouched.set(key, Date.now());
  dirty = true;
}
function persist() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ store: [...store], lastTouched: [...lastTouched] }));
  } catch (e) {
    console.error("Failed to persist data:", e.message);
  }
}
// Debounced rather than on every write — a bidding war can write several
// times a second, and this store is small enough that a couple of
// seconds of at-risk data on an ungraceful crash is an acceptable
// tradeoff against constantly blocking on disk I/O.
setInterval(persist, 2000);
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { persist(); process.exit(0); });
}

app.get("/api/kv/:key", (req, res) => {
  const key = req.params.key;
  if (!store.has(key)) return res.status(404).json({ error: "not found" });
  res.json({ value: store.get(key) });
});

// Optional `expectedRev` turns this into an atomic compare-and-swap: the
// read-and-compare happens synchronously (no `await` in between), so
// Node's single-threaded event loop guarantees no other request can
// interleave — two concurrent writers can no longer both "succeed" while
// one silently clobbers the other (e.g. two players joining a room in
// the same instant used to race a client-side GET-then-PUT check, and
// the second write would just overwrite the first's addition).
app.put("/api/kv/:key", (req, res) => {
  const key = req.params.key;
  const { value, expectedRev } = req.body || {};
  if (typeof value !== "string") {
    return res.status(400).json({ error: "value must be a string" });
  }
  if (expectedRev !== undefined) {
    const current = store.get(key);
    let currentRev = null;
    if (current !== undefined) {
      try { currentRev = JSON.parse(current).rev; } catch { /* leave null */ }
    }
    if (currentRev !== expectedRev) {
      return res.status(409).json({ error: "rev mismatch", currentRev });
    }
  }
  store.set(key, value);
  touch(key);
  res.json({ ok: true });
});

app.delete("/api/kv/:key", (req, res) => {
  store.delete(req.params.key);
  lastTouched.delete(req.params.key);
  dirty = true;
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
      dirty = true;
    }
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Prem Auction League server running on http://localhost:${PORT}`);
});
