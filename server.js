"use strict";

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 3000;

// World / zones (match client)
const WORLD_SIZE = 1400;
const BANNER_H = 110;

const ZONE_W = 420;
const ZONE_H = 420;

const REQUIRED_PLAYERS = 10;   // set to 2 for quick testing if you want
const ROUND_DURATION_MS = 20000;
const INTERMISSION_MS = 4000;

const MAX_IMMUNITY_VALUE = 2;

// Zones layout: 6 around spawn center.
// We'll keep coordinates same as client.
const ZONES = [
  { key: "red",     x: WORLD_SIZE * 0.25, y: WORLD_SIZE * 0.25, w: ZONE_W, h: ZONE_H },
  { key: "orange",  x: WORLD_SIZE * 0.75, y: WORLD_SIZE * 0.25, w: ZONE_W, h: ZONE_H },
  { key: "yellow",  x: WORLD_SIZE * 0.25, y: WORLD_SIZE * 0.50, w: ZONE_W, h: ZONE_H },
  { key: "green",   x: WORLD_SIZE * 0.75, y: WORLD_SIZE * 0.50, w: ZONE_W, h: ZONE_H },
  { key: "blue",    x: WORLD_SIZE * 0.25, y: WORLD_SIZE * 0.75, w: ZONE_W, h: ZONE_H },
  { key: "violet",  x: WORLD_SIZE * 0.75, y: WORLD_SIZE * 0.75, w: ZONE_W, h: ZONE_H },
];

// Roles for a round
const ROLE_ELIMINATION = "elimination";
const ROLE_SURVIVAL = "survival";
const ROLE_IMMUNITY = "immunity";

// ---------------- GAME STATE ----------------
let players = {}; // socketId -> player
let lobbyOpen = true;

let currentRound = 0;
let roundRunning = false;
let roundStartTime = 0;
let roundEndTime = 0;

let zoneRoles = {}; // zoneKey -> role
let intermissionUntil = 0;

// ---------------- HELPERS ----------------
function now() {
  return Date.now();
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function isInsideZone(px, py, z) {
  return (
    px >= z.x - z.w / 2 &&
    px <= z.x + z.w / 2 &&
    py >= z.y - z.h / 2 &&
    py <= z.y + z.h / 2
  );
}

function getZoneKeyForPlayer(p) {
  for (const z of ZONES) {
    if (isInsideZone(p.x, p.y, z)) return z.key;
  }
  return null;
}

function assignZoneRolesRandomly() {
  // Pick 3 elimination, 2 survival, 1 immunity
  const keys = ZONES.map(z => z.key);
  // Fisher-Yates shuffle
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }

  zoneRoles = {};
  const elim = keys.slice(0, 3);
  const surv = keys.slice(3, 5);
  const immu = keys.slice(5, 6);

  elim.forEach(k => zoneRoles[k] = ROLE_ELIMINATION);
  surv.forEach(k => zoneRoles[k] = ROLE_SURVIVAL);
  immu.forEach(k => zoneRoles[k] = ROLE_IMMUNITY);
}

function startRound() {
  currentRound += 1;
  roundRunning = true;
  roundStartTime = now();
  roundEndTime = roundStartTime + ROUND_DURATION_MS;
  intermissionUntil = 0;

  // Clear last round choices
  for (const id in players) {
    players[id].zoneChoice = null;
  }

  console.log(`--- ROUND ${currentRound} START ---`);
}

function endRound() {
  // Randomize zone roles
  assignZoneRolesRandomly();

  console.log(`--- ROUND ${currentRound} END ---`);
  console.log("Zone roles:", zoneRoles);

  // Determine each player's zone choice by position
  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;

    p.zoneChoice = getZoneKeyForPlayer(p);
  }

  // Apply elimination / survival / immunity
  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;

    const choice = p.zoneChoice;
    if (!choice) {
      // Didn't pick a zone => eliminated
      p.alive = false;
      p.eliminatedRound = currentRound;
      continue;
    }

    const role = zoneRoles[choice];
    if (role === ROLE_ELIMINATION) {
      if (p.immunity > 0) {
        p.immunity -= 1; // spend immunity to survive
      } else {
        p.alive = false;
        p.eliminatedRound = currentRound;
      }
    } else if (role === ROLE_IMMUNITY) {
      p.immunity = clamp(p.immunity + 1, 0, MAX_IMMUNITY_VALUE);
    } else {
      // survival => nothing special
    }
  }

  roundRunning = false;
  intermissionUntil = now() + INTERMISSION_MS;
}

function aliveCount() {
  return Object.values(players).filter(p => p.alive).length;
}

function resetGameToLobby() {
  lobbyOpen = true;
  currentRound = 0;
  roundRunning = false;
  zoneRoles = {};
  intermissionUntil = 0;

  for (const id in players) {
    players[id].alive = true;
    players[id].immunity = 0;
    players[id].zoneChoice = null;
    players[id].eliminatedRound = null;
    // respawn near center
    players[id].x = WORLD_SIZE / 2 + (Math.random() * 80 - 40);
    players[id].y = WORLD_SIZE / 2 + (Math.random() * 80 - 40);
  }

  console.log("=== RESET TO LOBBY ===");
}

function gameLoopTick() {
  const t = now();

  // Auto-start when enough players and lobby open
  if (lobbyOpen && Object.keys(players).length >= REQUIRED_PLAYERS) {
    lobbyOpen = false;
    startRound();
  }

  // If round running and time up => end it
  if (roundRunning && t >= roundEndTime) {
    endRound();
  }

  // If intermission finished and more than 1 alive => start next
  if (!lobbyOpen && !roundRunning && intermissionUntil > 0 && t >= intermissionUntil) {
    if (aliveCount() <= 1) {
      // Game over -> back to lobby
      resetGameToLobby();
    } else {
      startRound();
    }
  }

  // Broadcast snapshot
  const snapshot = {
    t,
    lobbyOpen,
    requiredPlayers: REQUIRED_PLAYERS,
    currentRound,
    roundRunning,
    roundStartTime,
    roundEndTime,
    intermissionUntil,
    zoneRoles,
    players: Object.values(players).map(p => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      color: p.color,
      alive: p.alive,
      immunity: p.immunity,
      eliminatedRound: p.eliminatedRound,
      zoneChoice: p.zoneChoice,
    })),
  };

  io.sockets.emit("state", snapshot);
}

// 20Hz server tick
setInterval(gameLoopTick, 50);

// ---------------- SOCKETS ----------------
io.on("connection", (socket) => {
  console.log("connect:", socket.id);

  // Create player
  const newPlayer = {
    id: socket.id,
    name: "Player",
    x: WORLD_SIZE / 2 + (Math.random() * 80 - 40),
    y: WORLD_SIZE / 2 + (Math.random() * 80 - 40),
    color: Math.floor(Math.random() * 360),
    alive: true,
    immunity: 0,
    zoneChoice: null,
    eliminatedRound: null,
  };
  players[socket.id] = newPlayer;

  socket.emit("welcome", {
    id: socket.id,
    worldSize: WORLD_SIZE,
    bannerH: BANNER_H,
    zones: ZONES,
    maxImmunity: MAX_IMMUNITY_VALUE,
  });

  socket.on("setName", (name) => {
    if (typeof name === "string") {
      players[socket.id].name = name.slice(0, 20);
    }
  });

  socket.on("move", (data) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    if (!data) return;

    // Client sends x,y. Server clamps to world.
    const nx = clamp(Number(data.x) || p.x, 0, WORLD_SIZE);
    const ny = clamp(Number(data.y) || p.y, BANNER_H, WORLD_SIZE);
    p.x = nx;
    p.y = ny;
  });

  socket.on("disconnect", () => {
    console.log("disconnect:", socket.id);
    delete players[socket.id];

    // If lobby open, nothing special.
    // If game running and only one alive remains, next tick resets.
  });
});

// ---------------- STATIC ----------------
app.use(express.static(path.join(__dirname, "public")));

// ---------------- START ----------------
server.listen(PORT, () => {
  console.log(`Rainbow Roulette server running on http://localhost:${PORT}`);
});
