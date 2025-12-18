// server.js (ALPHA authoritative — host presses SPACE each round)
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Serve static files
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

// ---------------- CONFIG (mirror client) ----------------
const LOBBY_START_PLAYERS = 6;
const MAX_PLAYERS = 10;
const ROUND_TIME_MS_DEFAULT = 20000;
const ROUND_TIME_MS_FAST = 10000;
const HIGHLIGHT_MS = 2500;

// ---------------- SERVER STATE ----------------
const players = new Map(); // id -> { id, name, joinTime, role, spectator, immunity, lastSeen }
let hostId = null;

let matchHasBegun = false;
let roundNumber = 0;

let timerRunning = false;
let roundStartTime = 0;
let totalTimeMs = ROUND_TIME_MS_DEFAULT;

let suddenDeath = false;
let zoneRoles = {}; // { red: "survival", ... }
let highlightStart = 0;

// ---------------- HELPERS ----------------
function log(...args) {
  console.log("[RR]", ...args);
}

function now() {
  return Date.now();
}

function sanitizeName(name) {
  const s = String(name ?? "Player").trim();
  return (s.length ? s : "Player").slice(0, 24);
}

function getSortedPlayersArray() {
  return Array.from(players.values()).sort((a, b) => (a.joinTime || 0) - (b.joinTime || 0));
}

function electHostIfNeeded() {
  if (hostId && players.has(hostId)) return;

  const sorted = getSortedPlayersArray();
  hostId = sorted.length ? sorted[0].id : null;
}

function computeSlots() {
  // Before match: first 10 joiners are "player", rest passive.
  // After match begins: all new joiners become passive.
  const sorted = getSortedPlayersArray();
  const chosen = matchHasBegun ? [] : sorted.slice(0, MAX_PLAYERS).map((p) => p.id);

  for (const p of sorted) {
    if (matchHasBegun) p.role = "passive";
    else p.role = chosen.includes(p.id) ? "player" : "passive";

    // Server’s interpretation: passive = always spectator-ish
    if (p.role === "passive") {
      p.spectator = true;
      p.immunity = 0;
    }
  }
}

function buildLobbyStatePayload() {
  const list = getSortedPlayersArray().map((p) => ({
    id: p.id,
    name: p.name,
    joinTime: p.joinTime,
    role: p.role,
    spectator: !!p.spectator,
    immunity: p.immunity || 0,
  }));

  const playerSlots = {};
  list.forEach((p) => (playerSlots[p.id] = p.role || "passive"));

  return {
    hostId,
    matchHasBegun,
    roundNumber,
    timerRunning,
    serverTime: now(),
    players: list,
    playerSlots,
  };
}

function sendLobbyState(toSocket = null) {
  const payload = buildLobbyStatePayload();
  if (toSocket) toSocket.emit("lobbyState", payload);
  else io.emit("lobbyState", payload);
}

function systemMsg(msg) {
  io.emit("systemMsg", { msg, stamp: now() });
}

function countActivePlayersServerSide() {
  // active = role player AND not spectator
  let active = 0;
  for (const p of players.values()) {
    if (p.role === "player" && !p.spectator) active++;
  }
  return active;
}

function broadcastStats() {
  const lobbyCount = players.size;

  let activePlayers = 0;
  let eliminatedPlayers = 0;
  let slotPlayers = 0;

  for (const p of players.values()) {
    if (p.role === "player") slotPlayers++;
    if (p.role === "player" && !p.spectator) activePlayers++;
    if (p.role === "player" && p.spectator) eliminatedPlayers++;
  }

  const passiveSpectators = Math.max(0, lobbyCount - slotPlayers);

  io.emit("stats", {
    lobbyCount,
    activePlayers,
    eliminatedPlayers,
    passiveSpectators,
  });
}

// ---- RR role assignment (server-owned) ----
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function assignRolesServer() {
  const zones = suddenDeath
    ? ["red", "green", "blue"]
    : ["red", "orange", "yellow", "green", "blue", "violet"];

  const names = zones.slice();
  shuffle(names);

  const roles = {};
  if (suddenDeath) {
    roles[names[0]] = "elimination";
    roles[names[1]] = "survival";
    roles[names[2]] = "survival";
  } else {
    roles[names[0]] = "immunity";
    roles[names[1]] = "elimination";
    roles[names[2]] = "elimination";
    roles[names[3]] = "survival";
    roles[names[4]] = "survival";
    roles[names[5]] = "survival";
  }
  zoneRoles = roles;
}

// ---- Round timing control (B flow: host presses SPACE) ----
function computeTotalTimeForRound(nextRoundNumber) {
  // Your client rule: after round 5 => 10s rounds (i.e. roundNumber >= 6)
  return nextRoundNumber >= 6 ? ROUND_TIME_MS_FAST : ROUND_TIME_MS_DEFAULT;
}

function startRoundFromHost(hostSocketId) {
  electHostIfNeeded();
  if (!hostId || hostSocketId !== hostId) return false;

  // Lobby rule: first ever start requires >= 6 players
  if (!matchHasBegun && players.size < LOBBY_START_PLAYERS) return false;

  // Start match on first round
  if (!matchHasBegun) {
    matchHasBegun = true;
    roundNumber = 1;
    systemMsg("Match started!");
  } else {
    roundNumber += 1;
  }

  computeSlots(); // once match begins, everyone becomes passive (including late joiners)
  sendLobbyState();

  // Sudden death trigger: ONLY after match begins, when 2 active remain
  // NOTE: this checks current server-side alive count before the new round starts.
  // If you want this to apply *after* outcomes, you can also update it later.
  suddenDeath = (matchHasBegun && countActivePlayersServerSide() === 2);

  totalTimeMs = computeTotalTimeForRound(roundNumber);
  roundStartTime = now();
  timerRunning = true;

  io.emit("roundStart", {
    hostId,
    startTime: roundStartTime,
    totalTime: totalTimeMs,
    roundNumber,
    matchHasBegun,
    suddenDeath,
    serverTime: now(),
  });

  // Immediately decide next roles (these are *for the upcoming resolution*)
  assignRolesServer();
  highlightStart = now();

  io.emit("roundRoles", {
    hostId,
    zoneRoles,
    highlightStart,
    suddenDeath,
    roundNumber,
  });

  broadcastStats();
  log("ROUND START", { hostId, roundNumber, totalTimeMs, suddenDeath });
  return true;
}

// ---------------- SOCKET.IO ----------------
io.on("connection", (socket) => {
  log("Client connected:", socket.id);

  // Send current state immediately
  electHostIfNeeded();
  sendLobbyState(socket);

  socket.on("join", (data) => {
    const name = sanitizeName(data && data.name);
    const joinTime = now();

    const p = {
      id: socket.id,
      name,
      joinTime,
      role: "player",
      spectator: false,
      immunity: 0,
      lastSeen: now(),
    };

    players.set(socket.id, p);

    electHostIfNeeded();
    computeSlots();

    // Keep compatibility: still emit "join"
    io.emit("join", { id: p.id, name: p.name, time: p.joinTime });

    // If they were forced passive (lobby full or mid-match), announce it
    if (p.role === "passive") {
      systemMsg(`'${p.name} (ID: ${p.id})' has joined as a spectator`);
    } else {
      systemMsg(`'${p.name} (ID: ${p.id})' has connected`);
    }

    // Tell everyone authoritative snapshot
    sendLobbyState();
    broadcastStats();

    log("JOIN", p.id, p.name, "host=", hostId, "role=", p.role, "matchHasBegun=", matchHasBegun);
  });

  // Movement/status updates (server trusts socket.id, may ignore/clip fields)
  socket.on("update", (data) => {
    if (!data) return;

    const p = players.get(socket.id);
    if (p) p.lastSeen = now();

    const payload = { ...data, id: socket.id };

    // Broadcast to everyone EXCEPT sender
    socket.broadcast.emit("update", payload);
  });

  // Client requests to mark elimination/spectator
  socket.on("requestDelete", (data) => {
    const targetId = (data && data.id) || socket.id;

    const p = players.get(targetId);
    if (p) {
      p.spectator = true;
      p.immunity = 0;
      // role stays "player" if they had a slot; passive spectators already spectator anyway
    }

    io.emit("delete", targetId);
    broadcastStats();
    log("DELETE", targetId);
  });

  // Host presses SPACE -> request round start (server enforces host + lobby>=6 for first start)
  socket.on("requestRoundStart", () => {
    const ok = startRoundFromHost(socket.id);
    if (!ok) {
      // optional targeted feedback
      const reason =
        (!hostId || socket.id !== hostId) ? "Only the host can start rounds."
          : (!matchHasBegun && players.size < LOBBY_START_PLAYERS) ? `Need ${LOBBY_START_PLAYERS} players to start.`
            : "Round could not start.";
      socket.emit("systemMsg", { msg: reason, stamp: now() });
      log("ROUND START denied for", socket.id, reason);
    }
  });

  socket.on("disconnect", () => {
    const leaving = players.get(socket.id);
    log("Client disconnected:", socket.id, leaving ? leaving.name : "");

    players.delete(socket.id);

    const wasHost = socket.id === hostId;
    electHostIfNeeded();
    computeSlots();

    // Compatibility: treat as delete so client removes/ghosts them
    io.emit("delete", socket.id);

    // Clearer leave message + host change
    if (leaving) systemMsg(`'${leaving.name} (ID: ${socket.id})' has disconnected`);
    if (wasHost && hostId) systemMsg(`New host: '${players.get(hostId)?.name || hostId}'`);

    sendLobbyState();
    broadcastStats();

    // If host leaves mid-round: we do NOT auto-advance. Next host can press SPACE.
  });
});

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
server.listen(PORT, HOST, () => log(`Server listening on http://${HOST}:${PORT}`));


