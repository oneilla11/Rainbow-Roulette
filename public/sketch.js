// ================================================================
// RAINBOW ROULETTE (ALPHA) — CENTRAL SERVER AUTHORITY (HOST = SPACE)
// ================================================================
// Alex O'Neill, 2025
//
// KEY CHANGE (ALPHA):
//  • Server is authoritative for:
//      - host election
//      - lobby list + slots
//      - matchHasBegun + roundNumber
//      - roundStart + roundRoles
//      - stats + system messages
//      - disconnects
//  • Client is authoritative ONLY for:
//      - local input + rendering
//      - sending movement updates + requesting actions
//
// New/required server events used:
//  • join(name)
//  • lobbyState
//  • requestRoundStart
//  • requestDelete
//
// ================================================================


// ---------- CONFIG ----------
const WORLD_SIZE = 1000;
const PLAYER_DIAMETER = 80;

const REG_SPEED = 6;
const MAX_IMMUNITY_VALUE = 2;

const LOBBY_START_PLAYERS = 6;
const MAX_PLAYERS = 10;

const GAME_RESET_DELAY = 5000;

// Networking timing
const HEARTBEAT_MS = 600;
const ELIM_REMOVE_DELAY_MS = 5000;

// Walls
const WALL_THICKNESS = 18;

// Timer (server-synced)
let totalTime = 20000;

// Networking
let socket = null;
let socketAvailable = false;

// Player & others
let player;
let otherPlayers;
let lobbyPlayers = {}; // id -> {id,name,joinTime,lastSeen}

// Zones
let banner;
let spawnZone;
let redZone, orangeZone, yellowZone, greenZone, blueZone, violetZone;
let rouletteZones = [];

// Solid wall sprites
let wallSprites;

// State
let lobby = true;
let gameStart = false;
let currentRound = 0;

let matchHasBegun = false;
let lobbyReady = false;

// Game over / reset
let gameOver = false;
let winnerName = "";
let gameOverTime = 0;

// Timer state
let timerRunning = false;
let startTime = 0;
let roundEndTime = 0;

// Zone roles
let zoneRoles = {};
let zoneHighlightStart = 0;
let zoneHighlightDuration = 2500;

// Transform
let arenaScale = 1;
let arenaOffsetX = 0;
let arenaOffsetY = 0;

// Movement/network throttling
let lastNetworkSendTime = 0;

// Host state (server authoritative)
let isHost = false;
let hostId = null;

// Sound state
let roundStartSound;
let countdownTickSound;
let roundEndSound;
let backgroundMusic;

let musicEnabled = true;
let sfxEnabled = true;

// Volume (0..1)
let musicVolume = 1.0;
let sfxVolume = 1.0;

// Ping timing
let lastSecondsLeft = null;

// Slot control (server authoritative via lobbyState / assignSlot)
let myRole = "player"; // "player" | "passive"
let hasSprite = true;
let playerSlots = {};  // id -> "player" | "passive"

// UI state
let showRulesPopup = false;
let showSettingsPopup = false;

let settingsClickable = null;
let rulesClickable = null;

let settingsBtn = { x: 0, y: 0, w: 195, h: 40 };
let rulesBtn = { x: 0, y: 0, w: 195, h: 40 };

let activeSlider = null; // "music" | "sfx" | null

let syncedStats = {
  lobbyCount: 0,
  activePlayers: 0,
  eliminatedPlayers: 0,
  passiveSpectators: 0,
};

let lastStatsSend = 0; // unused now, but kept harmlessly

let recentSystemMsg = "";
let recentSystemMsgTime = 0;
let recentSystemMsgStamp = 0;

// Sudden death (server authoritative flag in roundStart/roundRoles)
let suddenDeath = false;


// ================================================================
// PRELOAD
// ================================================================
function preload() {
  roundStartSound = loadSound("round_start_chime.wav");
  countdownTickSound = loadSound("countdown_tick.wav");
  roundEndSound = loadSound("round_end.wav");
  backgroundMusic = loadSound("rr_bg_music_loop.wav");
}


// ================================================================
// SETUP
// ================================================================
function setup() {
  createCanvas(1000, 1000);
  textAlign(CENTER, CENTER);
  computeArenaTransform();

  // Networking — CENTRAL SERVER (no echo server)
  try {
    if (typeof io !== "undefined") {
      socket = io.connect(); // connects to same origin server
    } else socket = null;
  } catch (e) {
    socket = null;
  }

  if (socket) {
    setupSocketHandlers();
    socketAvailable = true;
  } else {
    setupMockSocket();
    socketAvailable = false;
  }

  otherPlayers = new Group();

  // Zones
  banner = { x: 0, y: 0, w: WORLD_SIZE, h: 110, color: color(300) };
  spawnZone = makeZone(WORLD_SIZE - 650, banner.h + 70, 300, 300, color(0), "spawn");

  const zoneWidth = 220;
  const zoneHeight = 220;
  const topRowY = 500;
  const rowGap = 25;
  const bottomRowY = topRowY + zoneHeight + rowGap;

  const redX = 100;
  const greenX = 390;
  const blueX = 680;

  redZone = makeZone(redX, topRowY, zoneWidth, zoneHeight, color(225, 0, 0), "red");
  greenZone = makeZone(greenX, topRowY, zoneWidth, zoneHeight, color(0, 225, 0), "green");
  blueZone = makeZone(blueX, topRowY, zoneWidth, zoneHeight, color(0, 0, 225), "blue");

  orangeZone = makeZone(redX, bottomRowY, zoneWidth, zoneHeight, color(255, 140, 0), "orange");
  yellowZone = makeZone(greenX, bottomRowY, zoneWidth, zoneHeight, color(255, 255, 0), "yellow");
  violetZone = makeZone(blueX, bottomRowY, zoneWidth, zoneHeight, color(148, 0, 211), "violet");

  rouletteZones = [redZone, orangeZone, yellowZone, greenZone, blueZone, violetZone];

  // Solid frame walls (p5.play colliders)
  wallSprites = new Group();
  const t = WALL_THICKNESS;

  let wTop = createSprite(WORLD_SIZE / 2, -t / 2, WORLD_SIZE + t * 2, t);
  let wBottom = createSprite(WORLD_SIZE / 2, WORLD_SIZE + t / 2, WORLD_SIZE + t * 2, t);
  let wLeft = createSprite(-t / 2, WORLD_SIZE / 2, t, WORLD_SIZE + t * 2);
  let wRight = createSprite(WORLD_SIZE + t / 2, WORLD_SIZE / 2, t, WORLD_SIZE + t * 2);

  [wTop, wBottom, wLeft, wRight].forEach((w) => {
    w.immovable = true;
    w.visible = false;
    wallSprites.add(w);
  });

  // Local player sprite (may be hidden later if passive)
  player = createSprite(
    spawnZone.x + spawnZone.w / 2,
    spawnZone.y + spawnZone.h / 2,
    PLAYER_DIAMETER,
    PLAYER_DIAMETER
  );

  // Name prompt (keep your flow)
  player.name = prompt("Name?") || ("Player" + floor(random(1000)));

  player.id = socket ? socket.id : ("local-" + floor(random(100000)));
  player.immunity = 0;
  player.isSpectator = false;

  hasSprite = true;
  myRole = "player";

  styleAliveSprite(player);

  player.prevX = player.position.x;
  player.prevY = player.position.y;

  startBackgroundMusic();
}


// ================================================================
// SOUND HELPERS
// ================================================================
function clamp01(v) { return max(0, min(1, v)); }

function applyVolumes() {
  try {
    if (backgroundMusic) backgroundMusic.setVolume(clamp01(musicVolume));
    if (roundStartSound) roundStartSound.setVolume(clamp01(sfxVolume));
    if (countdownTickSound) countdownTickSound.setVolume(clamp01(sfxVolume));
    if (roundEndSound) roundEndSound.setVolume(clamp01(sfxVolume));
  } catch (e) {}
}

function playGameStartChime() {
  if (!sfxEnabled || !roundStartSound) return;
  try { roundStartSound.play(); } catch (e) {}
}
function playPing() {
  if (!sfxEnabled || !countdownTickSound) return;
  try { countdownTickSound.play(); } catch (e) {}
}
function playBuzzer() {
  if (!sfxEnabled || !roundEndSound) return;
  try { roundEndSound.play(); } catch (e) {}
}

function startBackgroundMusic() {
  if (!backgroundMusic || !musicEnabled) return;
  try {
    applyVolumes();
    backgroundMusic.setLoop(true);
    if (typeof backgroundMusic.isPlaying === "function") {
      if (!backgroundMusic.isPlaying()) backgroundMusic.play();
    } else if (!backgroundMusic.isPlaying) {
      backgroundMusic.play();
    }
  } catch (e) {}
}
function stopBackgroundMusic() {
  if (!backgroundMusic) return;
  try {
    if (typeof backgroundMusic.isPlaying === "function") {
      if (backgroundMusic.isPlaying()) backgroundMusic.stop();
    } else if (backgroundMusic.isPlaying) {
      backgroundMusic.stop();
    }
  } catch (e) {}
}

function toggleMusicEnabled() {
  musicEnabled = !musicEnabled;
  if (musicEnabled) startBackgroundMusic();
  else stopBackgroundMusic();
}
function toggleSfxEnabled() {
  sfxEnabled = !sfxEnabled;
}

function getPingStartSeconds() {
  return totalTime === 10000 ? 5 : 10;
}


// ================================================================
// HOST STYLE (server-owned hostId)
// ================================================================
function restyleAllSpritesForHost() {
  if (player && hasSprite) {
    if (player.isSpectator) styleSpectatorSprite(player);
    else if (isHost) styleHostSprite(player);
    else styleAliveSprite(player);
  }

  otherPlayers.forEach((sp) => {
    if (sp.isSpectator) styleSpectatorSprite(sp);
    else if (sp.id === hostId) styleHostSprite(sp);
    else styleAliveSprite(sp);
  });
}


// ================================================================
// SLOT MODE (server assigns passive/player)
// ================================================================
function setPassiveMode(isPassive) {
  if (isPassive) {
    myRole = "passive";
    hasSprite = false;

    // PASSIVE spectators have NO sprite drawn (clutter control)
    player.isSpectator = true;
    player.immunity = 0;
    player.visible = false;
    player.draw = function () {};
  } else {
    myRole = "player";
    hasSprite = true;

    player.visible = true;
    player.isSpectator = false;
    player.immunity = 0;

    if (isHost) styleHostSprite(player);
    else styleAliveSprite(player);
  }
}


// ================================================================
// NETWORKING (CENTRAL SERVER)
// ================================================================
function setupSocketHandlers() {
  socket.on("connect", () => {
    // set id now that socket exists
    player.id = socket.id;

    // Join the match (server authoritative lobby)
    socket.emit("join", { name: player.name });
  });

  // Authoritative lobby snapshot
  socket.on("lobbyState", (data) => {
    if (!data) return;

    // rebuild lobbyPlayers (UI uses this)
    lobbyPlayers = {};
    (data.players || []).forEach((p) => {
      lobbyPlayers[p.id] = {
        id: p.id,
        name: p.name,
        joinTime: p.joinTime,
        lastSeen: Date.now(),
      };
    });

    // slots
    if (data.playerSlots) playerSlots = { ...data.playerSlots };

    hostId = data.hostId || null;
    isHost = !!hostId && hostId === player.id;

    matchHasBegun = !!data.matchHasBegun;

    if (typeof data.roundNumber === "number") currentRound = data.roundNumber;

    // enforce my role if server assigned
    myRole = playerSlots[player.id] || myRole;
    setPassiveMode(myRole === "passive");

    restyleAllSpritesForHost();
  });

  // Compatibility: join event (server still emits it) — we just upsert locally
  socket.on("join", (info) => {
    if (!info || !info.id) return;
    upsertLobbyPlayer(info.id, info.name, info.time, Date.now());
  });

  // Updates (movement/heartbeat)
  socket.on("update", (data) => {
    if (!data || !data.id) return;

    // Track last-seen for UI if name present
    upsertLobbyPlayer(data.id, data.name, lobbyPlayers[data.id]?.joinTime ?? data.joinTime, Date.now());
    if (data.role) playerSlots[data.id] = data.role;

    if (data.id === player.id) return;

    updateSubjectRemote(data);
  });

  // Someone became spectator (eliminated) — ghost ring for slot players
  socket.on("delete", (id) => {
    if (!id) return;
    markRemoteSpectator(id);
  });

  // Server started a round
  socket.on("roundStart", (data) => {
    if (!data) return;

    // Chime at the start of each round (and/or match start)
    playGameStartChime();

    timerRunning = true;
    startTime = data.startTime;
    if (data.totalTime) totalTime = data.totalTime;
    roundEndTime = startTime + totalTime;
    lastSecondsLeft = totalTime / 1000;

    if (typeof data.roundNumber === "number") currentRound = data.roundNumber;

    if (typeof data.matchHasBegun === "boolean") matchHasBegun = data.matchHasBegun;

    suddenDeath = !!data.suddenDeath;

    gameStart = matchHasBegun;
    lobby = !matchHasBegun;
  });

  // Server sent roles
  socket.on("roundRoles", (data) => {
    if (!data) return;
    zoneRoles = data.zoneRoles || {};
    zoneHighlightStart = data.highlightStart || Date.now();
    suddenDeath = !!data.suddenDeath;

    if (typeof data.roundNumber === "number") currentRound = data.roundNumber;
  });

  // Slot assignment broadcast (optional; some servers may emit this)
  socket.on("assignSlot", (data) => {
    if (!data || !data.id) return;
    playerSlots[data.id] = data.role || "passive";

    if (data.id === player.id) {
      myRole = playerSlots[player.id];
      setPassiveMode(myRole === "passive");
      restyleAllSpritesForHost();
    }
  });

  // Stats (server broadcast)
  socket.on("stats", (data) => {
    if (!data) return;
    syncedStats = { ...syncedStats, ...data };
  });

  // System message (newest wins)
  socket.on("systemMsg", (data) => {
    if (!data || !data.msg) return;
    const stamp = data.stamp || Date.now();
    if (stamp >= recentSystemMsgStamp) {
      recentSystemMsgStamp = stamp;
      recentSystemMsg = data.msg;
      recentSystemMsgTime = millis();
    }
  });
}

function setupMockSocket() {
  console.log("⚠ No socket — Running in mock mode.");
  socket = {
    id: "mock-" + floor(random(100000)),
    emit: () => {},
    on: () => {},
  };
}

function upsertLobbyPlayer(id, name, joinTime, lastSeen) {
  if (!id) return;

  const existing = lobbyPlayers[id] || {};
  lobbyPlayers[id] = {
    id,
    name: name ?? existing.name ?? id,
    joinTime: joinTime ?? existing.joinTime ?? Date.now(),
    lastSeen: lastSeen ?? existing.lastSeen ?? Date.now(),
  };

  if (id === player.id) {
    lobbyPlayers[id].name = player.name;
  }
}

function sendUpdate(dataX, dataY) {
  if (!socket) return;

  const payload = {
    name: player.name,
    role: myRole,
    immunity: hasSprite ? player.immunity : 0,
    spectator: hasSprite ? player.isSpectator : true,
    time: Date.now(),
    x: hasSprite ? dataX : -9999,
    y: hasSprite ? dataY : -9999,
    heartbeat: true,
  };

  socket.emit("update", payload);
}

function sendDelete(id) {
  if (!socket) return;
  socket.emit("requestDelete", { id });
}


// ================================================================
// MAIN LOOP
// ================================================================
function draw() {
  background(200);
  computeArenaTransform();

  // Derived lobby readiness (UI only; server enforces start)
  const lobbyCount = Object.keys(lobbyPlayers).length;
  lobbyReady = lobbyCount >= LOBBY_START_PLAYERS;

  // Lobby state until match begins (server authoritative)
  lobby = !matchHasBegun;
  gameStart = matchHasBegun;

  // WORLD SPACE
  push();
  translate(arenaOffsetX, arenaOffsetY);
  scale(arenaScale);

  drawArena();
  drawZones();
  drawRoleHighlights();

  allSprites.draw();
  allSprites.forEach(drawSpriteName);

  pop();

  // UI + updates
  drawUI();
  updateMovementAndHeartbeat();

  // NO hostPruneDisconnected() in centralized server Alpha
  pruneEliminatedOnly();

  // TIMER + SFX
  if (timerRunning) {
    const now = Date.now();
    const msLeft = max(0, roundEndTime - now);
    const secondsLeft = ceil(msLeft / 1000);

    if (lastSecondsLeft !== null && secondsLeft < lastSecondsLeft && msLeft > 0) {
      if (secondsLeft <= getPingStartSeconds()) playPing();
    }
    lastSecondsLeft = secondsLeft;

    if (now >= roundEndTime) {
      timerRunning = false;
      playBuzzer();
      // Server will have already sent next roles on round start;
      // Clients resolve locally when highlight ends (see drawRoleHighlights).
    }
  }

  // Auto reset (local visual reset; server remains match authority)
  if (gameOver && millis() - gameOverTime >= GAME_RESET_DELAY) {
    resetGame();
  }
}


// ================================================================
// MOVEMENT + HEARTBEAT + SOLID WALLS
// ================================================================
function updateMovementAndHeartbeat() {
  const nowMs = millis();

  // movement only if you have a sprite and are alive
  if (hasSprite && !player.isSpectator && mouseIsPressed) {
    const worldMouse = screenToWorld(mouseX, mouseY);
    const dx = worldMouse.x - player.position.x;
    const dy = worldMouse.y - player.position.y;
    const d = sqrt(dx * dx + dy * dy);
    if (d > 0) {
      player.position.x += (dx / d) * REG_SPEED;
      player.position.y += (dy / d) * REG_SPEED;
    }
  }

  // Resolve wall collisions
  if (wallSprites && hasSprite && !player.isSpectator) {
    player.collide(wallSprites);

    // Hard clamp backup
    player.position.x = constrain(player.position.x, PLAYER_DIAMETER / 2, WORLD_SIZE - PLAYER_DIAMETER / 2);
    player.position.y = constrain(player.position.y, PLAYER_DIAMETER / 2, WORLD_SIZE - PLAYER_DIAMETER / 2);
  }

  const moved =
    hasSprite &&
    (abs(player.position.x - player.prevX) > 0.5 || abs(player.position.y - player.prevY) > 0.5);

  if (moved || nowMs - lastNetworkSendTime > HEARTBEAT_MS) {
    sendUpdate(player.position.x, player.position.y);
    lastNetworkSendTime = nowMs;
  }

  player.prevX = player.position.x;
  player.prevY = player.position.y;
}


// ================================================================
// ROUND / ROLE LOGIC (CLIENT: apply outcomes locally)
// ================================================================
function getActiveRouletteZones() {
  return suddenDeath ? [redZone, greenZone, blueZone] : rouletteZones;
}

function applyZoneOutcomes() {
  // Sudden death occupancy rule first (local evaluation)
  if (suddenDeath) {
    const zones = ["red", "green", "blue"];
    const occ = { red: [], green: [], blue: [] };

    if (hasSprite && !player.isSpectator) {
      const zn = whichZone(player.position.x, player.position.y);
      if (occ[zn]) occ[zn].push(player);
    }

    otherPlayers.forEach((sp) => {
      if (!sp.isSpectator) {
        const zn = whichZone(sp.position.x, sp.position.y);
        if (occ[zn]) occ[zn].push(sp);
      }
    });

    zones.forEach((z) => {
      if (occ[z].length > 1) {
        occ[z].forEach((p) => {
          becomeSpectator(p);
          sendDelete(p.id);
        });
      }
    });
  }

  if (hasSprite && !player.isSpectator) resolveOutcome(player);
  otherPlayers.forEach(resolveOutcome);

  checkForGameOver();
}

function resolveOutcome(p) {
  if (!p || p.isSpectator) return;

  const zn = whichZone(p.position.x, p.position.y);

  // If you didn't pick a roulette zone, you lose (spawn handled here too)
  if (!zn) {
    becomeSpectator(p);
    sendDelete(p.id);
    return;
  }

  // Spawn-zone elimination at timeout (same as BETA host logic, but local)
  if (isInsideRect(p.position.x, p.position.y, spawnZone)) {
    becomeSpectator(p);
    sendDelete(p.id);
    return;
  }

  const role = zoneRoles[zn];
  if (!role) return;

  if (suddenDeath) p.immunity = 0;

  if (role === "elimination") {
    if (!suddenDeath && p.immunity > 0) {
      p.immunity--;
    } else {
      becomeSpectator(p);
      sendDelete(p.id);
    }
  }

  if (!suddenDeath && role === "immunity") {
    p.immunity = min(MAX_IMMUNITY_VALUE, p.immunity + 1);
  }
}


// ================================================================
// REMOTES (sprites only for slot "player")
// ================================================================
function findRemoteSprite(id) {
  let found = null;
  otherPlayers.forEach((sp) => {
    if (sp.id === id) found = sp;
  });
  return found;
}

function updateSubjectRemote(data) {
  const role = playerSlots[data.id] || "passive";
  if (role !== "player") return; // PASSIVE spectators never create sprites

  let sp = findRemoteSprite(data.id);

  if (!sp) {
    sp = createSprite(data.x, data.y, PLAYER_DIAMETER, PLAYER_DIAMETER);
    sp.id = data.id;
    sp.name = data.name || data.id;
    sp.immunity = data.immunity || 0;
    sp.isSpectator = data.spectator || false;
    sp.lastSeen = Date.now();
    sp.elimTime = sp.isSpectator ? Date.now() : 0;

    if (sp.id === hostId) styleHostSprite(sp);
    else styleAliveSprite(sp);

    otherPlayers.add(sp);
  }

  if (typeof data.x === "number" && typeof data.y === "number") {
    sp.position.x = data.x;
    sp.position.y = data.y;
  }

  sp.name = data.name || sp.name;
  sp.immunity = (data.immunity ?? sp.immunity);
  sp.isSpectator = (data.spectator ?? sp.isSpectator);
  sp.lastSeen = Date.now();

  if (sp.isSpectator) {
    if (!sp.elimTime) sp.elimTime = Date.now();
    styleSpectatorSprite(sp);
  } else {
    sp.elimTime = 0;
    if (sp.id === hostId) styleHostSprite(sp);
    else styleAliveSprite(sp);
  }
}

function markRemoteSpectator(id) {
  if (player.id === id) {
    if (hasSprite) becomeSpectator(player);
    return;
  }

  const sp = findRemoteSprite(id);
  if (sp) {
    sp.isSpectator = true;
    sp.immunity = 0;
    sp.elimTime = Date.now();
    styleSpectatorSprite(sp);
  } else {
    // If they never had a sprite (passive), do nothing.
  }
}

// Only removes ELIMINATED remote sprites (not “no movement”)
function pruneEliminatedOnly() {
  const now = Date.now();

  otherPlayers.forEach((sp) => {
    if (sp.isSpectator && sp.elimTime && now - sp.elimTime > ELIM_REMOVE_DELAY_MS) {
      sp.remove();
    }
  });
}


// ================================================================
// DRAW: ARENA / ZONES / ROLE HIGHLIGHTS / NAMES
// ================================================================
function drawArena() {
  noStroke();
  fill(240);
  rect(0, 0, WORLD_SIZE, WORLD_SIZE);

  // Translucent grey frame (visual)
  const t = WALL_THICKNESS;
  fill(160, 160, 160, 80);

  rect(-t, -t, WORLD_SIZE + t * 2, t, 8);
  rect(-t, WORLD_SIZE, WORLD_SIZE + t * 2, t, 8);
  rect(-t, 0, t, WORLD_SIZE, 8);
  rect(WORLD_SIZE, 0, t, WORLD_SIZE, 8);

  // banner
  fill(banner.color);
  rect(banner.x, banner.y, banner.w, banner.h);
}

function drawZones() {
  drawZone(spawnZone, "SPAWN", color(255));

  // RGB always
  drawZone(redZone, "RED", color(255));
  drawZone(greenZone, "GREEN", color(0));
  drawZone(blueZone, "BLUE", color(255));

  if (!suddenDeath) {
    drawZone(orangeZone, "ORANGE", color(0));
    drawZone(yellowZone, "YELLOW", color(0));
    drawZone(violetZone, "VIOLET", color(255));
  }
}

function drawZone(z, label, labelColor) {
  noStroke();
  fill(z.color);
  rect(z.x, z.y, z.w, z.h, 25);

  fill(labelColor);
  textSize(16);
  textStyle(BOLD);
  text(label, z.x + z.w / 2, z.y + z.h / 2);
  textStyle(NORMAL);
}

function drawRoleHighlights() {
  if (!Object.keys(zoneRoles).length) return;

  const elapsed = Date.now() - zoneHighlightStart;

  if (elapsed < zoneHighlightDuration) {
    getActiveRouletteZones().forEach((z) => {
      const role = zoneRoles[z.name];
      if (!role) return;
      const c = roleColor(role);
      fill(red(c), green(c), blue(c), 120);
      rect(z.x, z.y, z.w, z.h);
    });
  } else {
    // Apply outcomes once per roles packet, then clear
    applyZoneOutcomes();
    zoneRoles = {};
  }
}

function drawSpriteName(s) {
  const sx = s.position.x;
  const sy = s.position.y;
  textAlign(CENTER, CENTER);
  textSize(12);
  fill(0);
  noStroke();
  if (s.name) text(s.name, sx, sy);
}


// ================================================================
// SPRITE STYLES
// ================================================================
function styleAliveSprite(s) {
  s.draw = function () {
    push();
    noStroke();
    fill(175, 225, 225);
    ellipse(0, 0, PLAYER_DIAMETER, PLAYER_DIAMETER);
    pop();
  };
}

function styleHostSprite(s) {
  s.draw = function () {
    push();
    noStroke();
    fill(255, 182, 193); // light pink
    ellipse(0, 0, PLAYER_DIAMETER, PLAYER_DIAMETER);
    pop();
  };
}

function styleSpectatorSprite(s) {
  s.draw = function () {
    push();
    stroke(0);
    strokeWeight(2);
    noFill();
    ellipse(0, 0, PLAYER_DIAMETER, PLAYER_DIAMETER);
    pop();
  };
}

function becomeSpectator(s) {
  s.isSpectator = true; // ACTIVE spectator (ghost sprite)
  s.immunity = 0;
  s.elimTime = Date.now();
  styleSpectatorSprite(s);
}


// ================================================================
// GAME OVER (local visual only; server still runs match)
// ================================================================
function countActivePlayers() {
  let count = 0;
  if (hasSprite && !player.isSpectator) count++;
  otherPlayers.forEach((sp) => {
    if (!sp.isSpectator) count++;
  });
  return count;
}

function getLastActivePlayerName() {
  if (hasSprite && !player.isSpectator) return player.name;
  let winner = null;
  otherPlayers.forEach((sp) => {
    if (!sp.isSpectator) winner = sp.name || sp.id;
  });
  return winner;
}

function checkForGameOver() {
  if (gameOver) return;

  const activeCount = countActivePlayers();
  if (activeCount === 1 && matchHasBegun) {
    winnerName = getLastActivePlayerName() || "Unknown";
    gameOver = true;
    timerRunning = false;
    zoneRoles = {};
    gameOverTime = millis();
  }
}

function resetGame() {
  gameOver = false;
  winnerName = "";
  timerRunning = false;
  lastSecondsLeft = null;
  zoneRoles = {};
  currentRound = 0;

  // local visual reset only
  lobby = true;
  gameStart = false;

  matchHasBegun = false;
  suddenDeath = false;
  totalTime = 20000;

  if (hasSprite) {
    player.isSpectator = false;
    player.immunity = 0;
    player.elimTime = 0;
    player.position.x = spawnZone.x + spawnZone.w / 2;
    player.position.y = spawnZone.y + spawnZone.h / 2;
    if (isHost) styleHostSprite(player);
    else styleAliveSprite(player);
  }

  otherPlayers.forEach((sp) => {
    sp.isSpectator = false;
    sp.immunity = 0;
    sp.elimTime = 0;
    sp.position.x = spawnZone.x + spawnZone.w / 2;
    sp.position.y = spawnZone.y + spawnZone.h / 2;
    if (sp.id === hostId) styleHostSprite(sp);
    else styleAliveSprite(sp);
  });

  restyleAllSpritesForHost();
}


// ================================================================
// UI (buttons + popups + sliders + system msg box)
// ================================================================
function drawUI() {
  push();

  // Banner text
  textAlign(CENTER, CENTER);
  fill(0);
  textStyle(BOLD);

  const lobbyCount = Object.keys(lobbyPlayers).length;

  if (gameOver && winnerName) {
    textSize(24);
    text(`Game Over! Winner: ${winnerName}`, width / 2, 50);
  } else if (timerRunning) {
    textSize(20);
    text("Time Left: " + getSecondsLeft(), width / 2, 50);
  } else {
    textSize(16);

    if (matchHasBegun) {
      if (!hasSprite) {
        text("(–≡= MATCH IN PROGRESS — SPECTATING =≡–)", width / 2, 50);
      } else if (isHost) {
        text('(–≡= PRESS "SPACE" TO START NEXT ROUND =≡–)', width / 2, 50);
      } else {
        text("(–≡= MATCH IN PROGRESS =≡–)", width / 2, 50);
      }
    } else {
      if (lobbyCount < LOBBY_START_PLAYERS) {
        text(`(–≡= WAITING FOR PLAYERS: ${lobbyCount}/${LOBBY_START_PLAYERS} =≡–)`, width / 2, 50);
      } else {
        if (isHost) text('(–≡= PRESS "SPACE" TO START MATCH =≡–)', width / 2, 50);
        else text(`(–≡= READY: ${min(lobbyCount, MAX_PLAYERS)}/${MAX_PLAYERS} =≡–)`, width / 2, 50);
      }

      if (lobbyCount >= MAX_PLAYERS) {
        textSize(12);
        text("(–≡= MAX PLAYERS REACHED: NEW JOINERS SPECTATE =≡–)", width / 2, 78);
        textSize(16);
      }
    }
  }

  textStyle(NORMAL);

  // Left HUD (bold labels)
  textAlign(LEFT, TOP);
  fill(0);

  const hostLabel = (hostId && lobbyPlayers[hostId]) ? lobbyPlayers[hostId].name : (hostId || "Unknown");
  drawLabelValue(30, 30, "Name:", player.name);
  drawLabelValue(30, 50, "Host:", hostLabel + (isHost ? " (You)" : ""));
  drawLabelValue(30, 70, "Round:", String(currentRound));
  drawLabelValue(30, 90, "Immunity:", String(player.immunity));

  // Recent system message
  textSize(12);
  if (recentSystemMsg) drawSystemMsgBox(30, 130, recentSystemMsg);

  // Buttons on banner
  rulesBtn.w = 195; rulesBtn.h = 40;
  settingsBtn.w = 195; settingsBtn.h = 40;

  rulesBtn.x = width - rulesBtn.w - 20 - 15;
  rulesBtn.y = 22 + 10;

  settingsBtn.x = width - settingsBtn.w - 20 - 15;
  settingsBtn.y = (rulesBtn.y + rulesBtn.h * 1.15);

  drawButtonHover(rulesBtn, "RULES");
  drawButtonHover(settingsBtn, "SETTINGS ⚙️");

  const popup = { x: 250, y: 180, w: 500, h: 420 };

  // SETTINGS POPUP
  if (showSettingsPopup) {
    const ui = drawPopup(popup.x, popup.y, popup.w, popup.h, "Settings:");

    fill(255);
    textAlign(LEFT, TOP);
    textSize(14);

    const sx = popup.x + 60;
    let sy = popup.y + 80;

    // Music slider
    drawLabelValueWhite(sx, sy, "Music Volume:", `${floor(musicVolume * 100)}`);
    const musicSlider = { x: sx, y: sy + 28, w: popup.w - 120, h: 14 };
    drawSlider(musicSlider, musicVolume);
    sy += 70;

    // SFX slider
    drawLabelValueWhite(sx, sy, "SFX Volume:", `${floor(sfxVolume * 100)}`);
    const sfxSlider = { x: sx, y: sy + 28, w: popup.w - 120, h: 14 };
    drawSlider(sfxSlider, sfxVolume);
    sy += 85;

    // --- STATS (synced)
    sy += 10;

    textAlign(LEFT, TOP);
    textSize(12);
    textStyle(BOLD);

    stroke(255, 60);
    line(sx, sy, sx + (popup.w - 120), sy);
    noStroke();
    sy += 12;

    fill(90, 255, 120);
    text("Active Players: " + String(syncedStats.activePlayers), sx, sy);
    sy += 18;

    fill(255, 90, 90);
    text("Eliminated Players: " + String(syncedStats.eliminatedPlayers), sx, sy);
    sy += 18;

    fill(180);
    text("Passive Spectators: " + String(syncedStats.passiveSpectators), sx, sy);
    sy += 10;

    sy += 10;
    stroke(255, 60);
    line(sx, sy, sx + (popup.w - 120), sy);
    noStroke();

    settingsClickable = {
      xBtn: ui.xBtn,
      musicSlider,
      sfxSlider,
    };
  } else {
    settingsClickable = null;
  }

  // RULES POPUP
  if (showRulesPopup) {
    const ui = drawPopup(popup.x, popup.y, popup.w, popup.h, "Rainbow Roulette Rules:");

    fill(255);
    textAlign(LEFT, TOP);
    textSize(12);
    text(
      "— Choose a color zone before timer ends\n" +
      "— Staying in SPAWN at timeout = elimination\n" +
      "— Not in any roulette zone at timeout = elimination\n" +
      "— Normal mode (6 zones):\n" +
      "   • 2 elimination\n" +
      "   • 3 survival\n" +
      "   • 1 immunity (stacks up to 2)\n" +
      "— Sudden death (2 players left): RGB only\n" +
      "   • 1 elimination, 2 survival\n" +
      "   • no immunity\n" +
      "   • one player per zone (shared zone = both eliminated)\n" +
      "— Eliminated players become ACTIVE spectators (ghost sprites)\n" +
      "— Lobby overflow / late joiners become PASSIVE spectators (no sprite)",
      popup.x + 40,
      popup.y + 80,
      popup.w - 80,
      popup.h - 120
    );

    rulesClickable = { xBtn: ui.xBtn };
  } else {
    rulesClickable = null;
  }

  pop();
}

function keyPressed() {
  // ALPHA: host requests server to start next round
  if (key === " " && isHost && !timerRunning && socket) {
    socket.emit("requestRoundStart");
  }

  if (key === "M" || key === "m") toggleMusicEnabled();
  if (key === "S" || key === "s") toggleSfxEnabled();
}

function mousePressed() {
  if (isMouseInRect(settingsBtn.x, settingsBtn.y, settingsBtn.w, settingsBtn.h)) {
    showSettingsPopup = !showSettingsPopup;
    showRulesPopup = false;
    return;
  }

  if (isMouseInRect(rulesBtn.x, rulesBtn.y, rulesBtn.w, rulesBtn.h)) {
    showRulesPopup = !showRulesPopup;
    showSettingsPopup = false;
    return;
  }

  // Settings popup interactions
  if (settingsClickable) {
    if (isMouseInRect(settingsClickable.xBtn.x, settingsClickable.xBtn.y, settingsClickable.xBtn.w, settingsClickable.xBtn.h)) {
      showSettingsPopup = false;
      activeSlider = null;
      return;
    }
    if (isMouseInRect(settingsClickable.musicSlider.x, settingsClickable.musicSlider.y - 10, settingsClickable.musicSlider.w, settingsClickable.musicSlider.h + 20)) {
      activeSlider = "music";
      updateSliderFromMouse(settingsClickable.musicSlider, "music");
      return;
    }
    if (isMouseInRect(settingsClickable.sfxSlider.x, settingsClickable.sfxSlider.y - 10, settingsClickable.sfxSlider.w, settingsClickable.sfxSlider.h + 20)) {
      activeSlider = "sfx";
      updateSliderFromMouse(settingsClickable.sfxSlider, "sfx");
      return;
    }
  }

  // Rules popup close
  if (rulesClickable) {
    if (isMouseInRect(rulesClickable.xBtn.x, rulesClickable.xBtn.y, rulesClickable.xBtn.w, rulesClickable.xBtn.h)) {
      showRulesPopup = false;
      return;
    }
  }
}

function mouseDragged() {
  if (!settingsClickable) return;
  if (activeSlider === "music") updateSliderFromMouse(settingsClickable.musicSlider, "music");
  if (activeSlider === "sfx") updateSliderFromMouse(settingsClickable.sfxSlider, "sfx");
}

function mouseReleased() {
  activeSlider = null;
}

function updateSliderFromMouse(sliderRect, which) {
  const t = clamp01((mouseX - sliderRect.x) / sliderRect.w);
  if (which === "music") {
    musicVolume = t;
    applyVolumes();
    if (musicEnabled) startBackgroundMusic();
  } else {
    sfxVolume = t;
    applyVolumes();
  }
}


// ================================================================
// HELPERS: UI DRAW
// ================================================================
function isMouseInRect(rx, ry, rw, rh) {
  return mouseX >= rx && mouseX <= rx + rw && mouseY >= ry && mouseY <= ry + rh;
}

function drawButtonHover(btn, label) {
  const hover = isMouseInRect(btn.x, btn.y, btn.w, btn.h);

  noStroke();
  fill(hover ? color(120) : color(100));
  rect(btn.x, btn.y, btn.w, btn.h, 10);

  if (hover) {
    fill(255, 40);
    rect(btn.x, btn.y, btn.w, btn.h, 10);
  }

  fill(245);
  textAlign(CENTER, CENTER);
  textSize(12);
  textStyle(BOLD);
  text(label, btn.x + btn.w / 2, btn.y + btn.h / 2);
  textStyle(NORMAL);
}

function drawPopup(x, y, w, h, title) {
  noStroke();
  fill(0, 230);
  rect(x, y, w, h, 20);

  fill(255);
  textAlign(CENTER, TOP);
  textStyle(BOLD);
  textSize(16);
  text(title, x + w / 2, y + 15);
  textStyle(NORMAL);

  const bx = x + w - 35;
  const by = y + 10;

  noStroke();
  fill(255);
  rect(bx, by, 25, 25, 6);
  fill(0);
  textAlign(CENTER, CENTER);
  textStyle(BOLD);
  textSize(12);
  text("X", bx + 12.5, by + 12.5);
  textStyle(NORMAL);

  return { xBtn: { x: bx, y: by, w: 25, h: 25 } };
}

function drawSlider(r, value01) {
  noStroke();
  fill(255, 255, 255, 60);
  rect(r.x, r.y, r.w, r.h, 10);

  const kx = r.x + value01 * r.w;
  fill(255);
  ellipse(kx, r.y + r.h / 2, r.h * 2.2, r.h * 2.2);

  noFill();
  stroke(255, 120);
  strokeWeight(1);
  rect(r.x, r.y, r.w, r.h, 10);
  noStroke();
}

function drawLabelValue(x, y, label, value) {
  textAlign(LEFT, TOP);
  textSize(14);
  fill(0);

  textStyle(BOLD);
  text(label, x, y);

  const labelW = textWidth(label);
  textStyle(NORMAL);
  text(value, x + labelW + 6, y);
}

function drawLabelValueWhite(x, y, label, value) {
  textAlign(LEFT, TOP);
  textSize(14);
  fill(255);

  textStyle(BOLD);
  text(label, x, y);

  const labelW = textWidth(label);
  textStyle(NORMAL);
  text(value, x + labelW + 6, y);
}

function drawSystemMsgBox(x, y, msg) {
  push();
  textAlign(LEFT, TOP);
  textSize(12);

  const padX = 10;
  const padY = 6;
  const maxW = 520;
  const w = min(maxW, textWidth(msg) + padX * 2);
  const h = 12 + padY * 2;

  noStroke();
  fill(0, 200);
  rect(x, y, w, h, 10);

  fill(255);
  text(msg, x + padX, y + padY);
  pop();
}


// ================================================================
// HELPERS: GEOMETRY / ZONES / TIMER
// ================================================================
function makeZone(x, y, w, h, col, name) {
  return { x, y, w, h, color: col, name };
}

function isInsideRect(x, y, z) {
  return x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h;
}

function whichZone(x, y) {
  const zones = getActiveRouletteZones();
  for (let z of zones) if (isInsideRect(x, y, z)) return z.name;
  return null;
}

function computeArenaTransform() {
  const margin = 20;
  arenaScale = min(
    (width - margin * 2) / WORLD_SIZE,
    (height - margin * 2) / WORLD_SIZE
  );
  arenaOffsetX = (width - WORLD_SIZE * arenaScale) / 2;
  arenaOffsetY = (height - WORLD_SIZE * arenaScale) / 2;
}

function screenToWorld(sx, sy) {
  return {
    x: (sx - arenaOffsetX) / arenaScale,
    y: (sy - arenaOffsetY) / arenaScale,
  };
}

function roleColor(role) {
  if (role === "elimination") return color(255, 70, 70);
  if (role === "immunity") return color(70, 200, 255);
  return color(255);
}

function getSecondsLeft() {
  if (!timerRunning) return 0;
  const now = Date.now();
  const msLeft = max(0, roundEndTime - now);
  return ceil(msLeft / 1000);
}
