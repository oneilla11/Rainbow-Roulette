// ================================================================
// RAINBOW ROULETTE (BETA)
// ------------------------------------------------
// RULES:
//  • 1 local sprite per player (remote & local)
//  • Hold mouse to move toward cursor
//  • SPACE starts round (20s timer) — HOST ONLY, SYNCED
//  • After time expires, 6 color zones get roles:
//      - 1 immunity zone
//      - 2 elimination zones
//      - 3 survival zones
//  • Eliminated players become transparent spectators
//  • Spectators still exist & update, but cannot move
// ================================================================

// ---------- CONFIG ----------
const WORLD_SIZE = 1000;
const ZONE_WIDTH = 420;
const PLAYER_DIAMETER = 80;
const REG_SPEED = 4;
const MAX_IMMUNITY_VALUE = 2;

// Ping only during last N seconds of the round
const PING_START_SECONDS = 10;

// Networking
let socket = null;
let socketAvailable = false;

// Player & others
let player;
let otherPlayers;
let lobbyPlayers = {};

// Zones
let banner;
let spawnZone;
let redZone, orangeZone, yellowZone, greenZone, blueZone, violetZone;
let rouletteZones = [];

// State
let lobby = true;
let requiredPlayers = 2;
let gameRulesScreen = true;
let gameStart = false;
let currentRound = 0;

// Game over / reset
let gameOver = false;
let winnerName = "";
let gameOverTime = 0;
const GAME_RESET_DELAY = 5000; // ms before auto-restart


// Timer (host-synced)
let timerRunning = false;
let startTime = 0;        // ms since epoch (Date.now)
let totalTime = 20000;    // 20s
let roundEndTime = 0;     // startTime + totalTime

// Zone roles
let zoneRoles = {};
let zoneHighlightStart = 0;
let zoneHighlightDuration = 2500;

// Transform
let arenaScale = 1;
let arenaOffsetX = 0;
let arenaOffsetY = 0;

// Movement tracking for networking
let lastNetworkSendTime = 0;

// ================================================================
// HOST STATE
// ================================================================
let isHost = false;
let hostId = null;

// ================================================================
// SOUND STATE
// ================================================================
// These names match what we load in preload()
let roundStartSound;
let countdownTickSound;
let roundEndSound;
let backgroundMusic;

let sfxEnabled = true;
let musicEnabled = true;

// Track last whole second left on timer (for timed pings)
let lastSecondsLeft = null;

// ================================================================
// PRELOAD: LOAD SOUND ASSETS
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

  // Networking — try real echo server, else mock
  // Networking — connect to same-origin Socket.IO server, fallback to mock if missing
  try {
    if (typeof io !== "undefined") {
      // Connect to our centralized server (same origin)
      socket = io();
    } else {
      socket = null;
    }
  } catch (e) {
    console.error("Socket.IO connection error:", e);
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

  // Zones (in world coordinates)
  banner = { x: 0, y: 0, w: WORLD_SIZE, h: 110, color: color(300) };
  spawnZone = makeZone(WORLD_SIZE - 650, banner.h + 70, 300, 300, 10, color(0), "spawn");

  // ────────────────────────────────────────────────
  // 6 COLOR ZONES IN TWO PARALLEL ROWS
  // Top row Y:
  const zoneWidth = 220;
  const zoneHeight = 220;
  const topRowY = 500;
  // Gap of 100 between rows → bottom row Y:
  const rowGap = 25;
  const bottomRowY = topRowY + zoneHeight + rowGap; // 600 + 250 + 100 = 950

  const redX   = 100;
  const greenX = 390;
  const blueX  = 680;

  // Top row: R / G / B
  redZone   = makeZone(redX,   topRowY, zoneWidth, zoneHeight, color(225, 0, 0),     "red");
  greenZone = makeZone(greenX, topRowY, zoneWidth, zoneHeight, color(0, 225, 0),     "green");
  blueZone  = makeZone(blueX,  topRowY, zoneWidth, zoneHeight, color(0, 0, 225),     "blue");

  // Bottom row: O below R, Y below G, V below B
  orangeZone = makeZone(
    redX,
    bottomRowY,
    zoneWidth,
    zoneHeight,
    color(255, 140, 0),   // orange-ish
    "orange"
  );
  yellowZone = makeZone(
    greenX,
    bottomRowY,
    zoneWidth,
    zoneHeight,
    color(255, 255, 0),   // yellow
    "yellow"
  );
  violetZone = makeZone(
    blueX,
    bottomRowY,
    zoneWidth,
    zoneHeight,
    color(148, 0, 211),   // violet/purple
    "violet"
  );

  // All roulette zones (6 total)
  rouletteZones = [redZone, orangeZone, yellowZone, greenZone, blueZone, violetZone];

  // Local player
  player = createSprite(
    spawnZone.x + spawnZone.w / 2,
    spawnZone.y + spawnZone.h / 2,
    PLAYER_DIAMETER,
    PLAYER_DIAMETER
  );
  player.id = socket ? socket.id : "local-" + floor(random(100000));
  player.name = prompt("Name?") || ("Player" + floor(random(1000)));
  // don't use player.text; we draw names manually
  player.immunity = 0;
  player.isSpectator = false;
  styleAliveSprite(player);

  player.prevX = player.position.x;
  player.prevY = player.position.y;

  sendJoin();

  // Start looping background music (can be toggled with 'M')
  startBackgroundMusic();
}

// ================================================================
// SOUND HELPERS (ARCHITECTURE)
// ================================================================

function playGameStartChime() {
  if (!sfxEnabled || !roundStartSound) return;
  try {
    if (roundStartSound.isLoaded && roundStartSound.isLoaded()) {
      roundStartSound.play();
    } else {
      roundStartSound.play();
    }
  } catch (e) {
    // fail silently
  }
}

function playPing() {
  if (!sfxEnabled || !countdownTickSound) return;
  try {
    if (countdownTickSound.isLoaded && countdownTickSound.isLoaded()) {
      countdownTickSound.play();
    } else {
      countdownTickSound.play();
    }
  } catch (e) {}
}

function playBuzzer() {
  if (!sfxEnabled || !roundEndSound) return;
  try {
    if (roundEndSound.isLoaded && roundEndSound.isLoaded()) {
      roundEndSound.play();
    } else {
      roundEndSound.play();
    }
  } catch (e) {}
}

function startBackgroundMusic() {
  if (!backgroundMusic || !musicEnabled) return;
  try {
    backgroundMusic.setLoop(true);

    // Handle both method and property cases defensively
    if (typeof backgroundMusic.isPlaying === "function") {
      if (!backgroundMusic.isPlaying()) {
        backgroundMusic.play();
      }
    } else if (!backgroundMusic.isPlaying) {
      backgroundMusic.play();
    }
  } catch (e) {}
}

function stopBackgroundMusic() {
  if (!backgroundMusic) return;
  try {
    if (typeof backgroundMusic.isPlaying === "function") {
      if (backgroundMusic.isPlaying()) {
        backgroundMusic.stop();
      }
    } else if (backgroundMusic.isPlaying) {
      backgroundMusic.stop();
    }
  } catch (e) {}
}

function toggleMusic() {
  musicEnabled = !musicEnabled;
  if (musicEnabled) {
    startBackgroundMusic();
  } else {
    stopBackgroundMusic();
  }
}

function toggleSfx() {
  sfxEnabled = !sfxEnabled;
  // no need to stop currently playing sfx; just affects future plays
}


// ================================================================
// HOST LOGIC
// ================================================================
function recomputeHost() {
  let earliestTime = null;
  let earliestId = null;

  for (const id in lobbyPlayers) {
    const lp = lobbyPlayers[id];
    if (!lp || lp.time == null) continue;
    if (earliestTime === null || lp.time < earliestTime) {
      earliestTime = lp.time;
      earliestId = id;
    }
  }

  hostId = earliestId;
  isHost = !!hostId && hostId === player.id;
}

function startGlobalRoundTimer() {
  const start = Date.now();

  if (socket) {
    socket.emit("roundStart", {
      hostId: player.id,
      startTime: start,
    });
  }

  timerRunning = true;
  startTime = start;
  roundEndTime = start + totalTime;

  // Reset per-second ping tracking at the start of each round
  lastSecondsLeft = totalTime / 1000;
}

// Host-only end-of-round logic that also broadcasts zone roles
function onRoundEndHost() {
  // SPAWN ZONE ELIMINATION AT TIMEOUT (host-authoritative)
  if (!player.isSpectator && isInsideRect(player.position.x, player.position.y, spawnZone)) {
    becomeSpectator(player);
    sendDelete(player.id);
  }

  otherPlayers.forEach((op) => {
    if (!op.isSpectator && isInsideRect(op.position.x, op.position.y, spawnZone)) {
      op.isSpectator = true;
      op.immunity = 0;
      styleSpectatorSprite(op);
      sendDelete(op.id);
    }
  });

  // Host decides the random roles across 6 zones:
  // 1 immunity, 2 elimination, 3 survival
  assignRGBRoles();
  const start = Date.now();
  zoneHighlightStart = start;

  // Broadcast the role assignments + highlight start time
  if (socket) {
    socket.emit("roundRoles", {
      hostId: player.id,
      zoneRoles: zoneRoles,
      highlightStart: start,
    });
  }
}

// ================================================================
// NETWORKING
// ================================================================
function setupSocketHandlers() {
  socket.on("connect", () => {
    player.id = socket.id;
    sendJoin();
  });

  socket.on("update", (data) => {
    if (!data || data.id === player.id) return;
    updateSubjectRemote(data);
  });

  socket.on("delete", (id) => {
    markRemoteSpectator(id);
  });

  socket.on("join", (data) => {
    if (!data) return;
    lobbyPlayers[data.id] = data;
    recomputeHost();
  });

  // HOST LOGIC: synced round start
  socket.on("roundStart", (data) => {
    if (!data) return;

    // TRUST THE EVENT FOR EVERYONE — so all see the same timer
    timerRunning = true;
    startTime = data.startTime;
    roundEndTime = startTime + totalTime;

    // Reset per-second ping tracking when round starts for non-hosts too
    lastSecondsLeft = totalTime / 1000;
  });

  // synced zone role assignments + highlight start
  socket.on("roundRoles", (data) => {
    if (!data) return;

    zoneRoles = data.zoneRoles || {};
    zoneHighlightStart = data.highlightStart || Date.now();
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

function sendJoin() {
  const now = Date.now();
  if (socket) {
    socket.emit("join", { id: player.id, name: player.name, time: now });
  }
  lobbyPlayers[player.id] = { id: player.id, name: player.name, time: now };
  recomputeHost();
}

function sendUpdate() {
  if (!socket) return;
  socket.emit("update", {
    id: player.id,
    x: player.position.x,
    y: player.position.y,
    name: player.name,
    immunity: player.immunity,
    spectator: player.isSpectator,
    time: Date.now(),
  });
}

function sendDelete(id) {
  if (!socket) return;
  socket.emit("delete", id);
}

// ================================================================
// MAIN LOOP
// ================================================================
function draw() {
  background(200);
  computeArenaTransform();

  // ---- WORLD SPACE (arena + players + names) ----
  push();
  translate(arenaOffsetX, arenaOffsetY);
  scale(arenaScale);

  drawArena();
  drawZones();
  drawRoleHighlights();

  allSprites.draw();
  allSprites.forEach(drawSpriteName); // names locked to sprite center

  pop();
  // ---- END WORLD SPACE ----

  drawUI();
  updateMovement();
  pruneStaleRemotes();

  // HOST-SYNCED TIMER + SOUND EFFECTS
  if (timerRunning) {
    const now = Date.now();
    const msLeft = max(0, roundEndTime - now);
    const secondsLeft = ceil(msLeft / 1000);

    // Ping every time the displayed whole second decreases,
    // but only in the last PING_START_SECONDS seconds.
    if (
      lastSecondsLeft !== null &&
      secondsLeft < lastSecondsLeft &&
      msLeft > 0
    ) {
      if (secondsLeft <= PING_START_SECONDS) {
        playPing();
      }
    }
    lastSecondsLeft = secondsLeft;

    if (now >= roundEndTime) {
      timerRunning = false;

      // Buzzer at round termination (everyone hears it)
      playBuzzer();

      if (isHost) {
        onRoundEndHost();
      }
    }
  }

  // Lobby → Game start transition
  if (lobby && Object.keys(lobbyPlayers).length >= requiredPlayers) {
    lobby = false;
    gameStart = true;
    currentRound = 1;
    console.log("Game has started.");

    // Game start chime (only first time game leaves lobby)
    playGameStartChime();
  }

  // Auto-reset a few seconds after game over
  if (gameOver && millis() - gameOverTime >= GAME_RESET_DELAY) {
    resetGame();
  }
}

// ================================================================
// MOVEMENT + NETWORKING THROTTLING
// ================================================================
function updateMovement() {
  if (!player.isSpectator && mouseIsPressed) {
    const worldMouse = screenToWorld(mouseX, mouseY);
    const dx = worldMouse.x - player.position.x;
    const dy = worldMouse.y - player.position.y;
    const d = sqrt(dx * dx + dy * dy);
    if (d > 0) {
      player.position.x += (dx / d) * REG_SPEED;
      player.position.y += (dy / d) * REG_SPEED;
    }
  }

  const moved =
    abs(player.position.x - player.prevX) > 0.5 ||
    abs(player.position.y - player.prevY) > 0.5;

  if (moved || millis() - lastNetworkSendTime > 250) {
    sendUpdate();
    lastNetworkSendTime = millis();
  }

  player.prevX = player.position.x;
  player.prevY = player.position.y;
}

// ================================================================
// ROUND / ROLE LOGIC
// ================================================================
function assignRGBRoles() {
  // We now have 6 roulette zones: R, O, Y, G, B, V
  // We want:
  //  • 1 immunity zone
  //  • 2 elimination zones
  //  • 3 survival zones
  const names = rouletteZones.map((z) => z.name);
  shuffleArray(names);

  zoneRoles = {};

  // 1 immunity
  zoneRoles[names[0]] = "immunity";

  // 2 elimination
  zoneRoles[names[1]] = "elimination";
  zoneRoles[names[2]] = "elimination";

  // 3 survival
  zoneRoles[names[3]] = "survival";
  zoneRoles[names[4]] = "survival";
  zoneRoles[names[5]] = "survival";
}

function applyZoneOutcomes() {
  if (!player.isSpectator) {
    resolveOutcome(player);
  }

  otherPlayers.forEach(resolveOutcome);

  currentRound++;
}

function logPlayerZoneOutcome(zoneName, role, prevImmunity, newImmunity, wasEliminated) {
  const prettyZone = zoneName.toUpperCase();
  let outcomeText = "";

  if (role === "elimination") {
    if (wasEliminated) {
      outcomeText = "You have been eliminated.";
    } else {
      outcomeText = `Your immunity saved you. Immunity is now ${newImmunity}.`;
    }
  } else if (role === "immunity") {
    if (newImmunity > prevImmunity) {
      outcomeText = `You have gained immunity. Immunity is now ${newImmunity}.`;
    } else {
      outcomeText = "You were already at max immunity.";
    }
  } else if (role === "survival") {
    outcomeText = "You have survived this round.";
  }

  console.log(`${prettyZone} = ${role.toUpperCase()}. ${outcomeText}`);
}

function resolveOutcome(p) {
  const zn = whichZone(p.position.x, p.position.y);
  if (!zn) return;

  const role = zoneRoles[zn];
  if (!role) return;

  const prevImmunity = p.immunity;
  let wasEliminated = false;

  if (role === "elimination") {
    if (p.immunity > 0) {
      // Immunity gets consumed instead of dying
      p.immunity--;
    } else {
      // No immunity left → elimination
      becomeSpectator(p);
      sendDelete(p.id);
      wasEliminated = true;
    }
  }

  if (role === "immunity") {
    p.immunity = min(MAX_IMMUNITY_VALUE, p.immunity + 1);
  }

  // Only log for the local player on this client
  if (p === player) {
    logPlayerZoneOutcome(zn, role, prevImmunity, p.immunity, wasEliminated);
  }
}

// ================================================================
// REMOTES
// ================================================================
function findRemoteSprite(id) {
  let found = null;
  otherPlayers.forEach((sp) => {
    if (sp.id === id) found = sp;
  });
  return found;
}

function updateSubjectRemote(data) {
  let sp = findRemoteSprite(data.id);

  if (!sp) {
    sp = createSprite(data.x, data.y, PLAYER_DIAMETER, PLAYER_DIAMETER);
    sp.id = data.id;
    sp.name = data.name;
    sp.immunity = data.immunity || 0;
    sp.isSpectator = data.spectator || false;
    styleAliveSprite(sp);
    otherPlayers.add(sp);
  }

  sp.position.x = data.x;
  sp.position.y = data.y;
  sp.name = data.name; // keep name synced
  sp.immunity = data.immunity || sp.immunity;
  sp.isSpectator = data.spectator || false;
  sp.lastUpdate = Date.now();

  if (sp.isSpectator) styleSpectatorSprite(sp);
}

function pruneStaleRemotes() {
  const now = Date.now();
  otherPlayers.forEach((sp) => {
    if (now - (sp.lastUpdate || now) > 5000) sp.remove();
  });
}

function markRemoteSpectator(id) {
  if (player.id === id) {
    becomeSpectator(player);
    return;
  }

  const sp = findRemoteSprite(id);
  if (sp) {
    sp.isSpectator = true;
    sp.immunity = 0;
    styleSpectatorSprite(sp);
  }
}

// ================================================================
// DRAW HELPERS (ARENA / UI / ZONES)
// ================================================================
function drawArena() {
  noStroke();
  fill(240);
  rect(0, 0, WORLD_SIZE, WORLD_SIZE);

  fill(banner.color);
  rect(banner.x, banner.y, banner.w, banner.h);
}

function drawZones() {
  drawZone(spawnZone, "SPAWN", color(255));

  // Top row
  drawZone(redZone,   "RED",    color(255));
  drawZone(greenZone, "GREEN",  color(0));
  drawZone(blueZone,  "BLUE",   color(255));

  // Bottom row
  drawZone(orangeZone, "ORANGE", color(0));
  drawZone(yellowZone, "YELLOW", color(0));
  drawZone(violetZone, "VIOLET", color(255));
}

function drawZone(z, label, labelColor) {
  noStroke(); // no outlines on zones
  fill(z.color);
  rect(z.x, z.y, z.w, z.h, 25);  // rounded corners (same radius as rules box)

  fill(labelColor);
  textSize(16);
  noStroke();
  textStyle(BOLD);  // <- zone label bold
  text(label, z.x + z.w / 2, z.y + z.h / 2);
  textStyle(NORMAL); // <- reset after drawing label
}


function drawRoleHighlights() {
  if (!Object.keys(zoneRoles).length) return;

  const elapsed = Date.now() - zoneHighlightStart;

  if (elapsed < zoneHighlightDuration) {
    rouletteZones.forEach((z) => {
      const role = zoneRoles[z.name];
      if (!role) return;
      const c = roleColor(role);
      fill(red(c), green(c), blue(c), 120);
      rect(z.x, z.y, z.w, z.h);
    });
  } else {
    applyZoneOutcomes();
    zoneRoles = {};
  }
}

// ================================================================
// SPRITE LABELS (NAME ONLY, CENTERED ON SPRITE)
// ================================================================
function drawSpriteName(s) {
  const sx = s.position.x;
  const sy = s.position.y;

  textAlign(CENTER, CENTER);
  textSize(12);
  fill(0); // black text
  noStroke();

  if (s.name) {
    text(s.name, sx, sy);
  }
}

// ================================================================
// SPRITE STYLING
// ================================================================
function styleAliveSprite(s) {
  s.draw = function () {
    push();
    noStroke();                  // no outline for active player
    fill(175, 225, 225);         // light blue
    ellipse(0, 0, PLAYER_DIAMETER, PLAYER_DIAMETER);
    pop();
  };
}

function styleSpectatorSprite(s) {
  s.draw = function () {
    push();
    stroke(0);           // black outline
    strokeWeight(2);
    noFill();            // hollow circle to show "ghost"
    ellipse(0, 0, PLAYER_DIAMETER, PLAYER_DIAMETER);
    pop();
  };
}

function becomeSpectator(s) {
  s.isSpectator = true;
  s.immunity = 0;
  styleSpectatorSprite(s);

  // Check if only one player remains alive
  checkForGameOver();
}


function countActivePlayers() {
  let count = 0;
  if (!player.isSpectator) count++;
  otherPlayers.forEach((sp) => {
    if (!sp.isSpectator) count++;
  });
  return count;
}

function getLastActivePlayerName() {
  if (!player.isSpectator) return player.name;
  let winner = null;
  otherPlayers.forEach((sp) => {
    if (!sp.isSpectator) {
      winner = sp.name || sp.id;
    }
  });
  return winner;
}

function checkForGameOver() {
  if (gameOver) return;

  const activeCount = countActivePlayers();

  // Only consider game over once the game has actually started
  if (activeCount === 1 && (gameStart || !lobby)) {
    winnerName = getLastActivePlayerName() || "Unknown";
    gameOver = true;
    timerRunning = false;
    zoneRoles = {};
    console.log("Game Over! Winner: " + winnerName);
    gameOverTime = millis();
  }
}

function resetGame() {
  // Core flags
  gameOver = false;
  winnerName = "";
  timerRunning = false;
  lastSecondsLeft = null;
  zoneRoles = {};
  currentRound = 0;

  // Back to lobby flow
  lobby = true;
  gameStart = false;
  gameRulesScreen = true;

  // Reset local player
  player.isSpectator = false;
  player.immunity = 0;
  player.position.x = spawnZone.x + spawnZone.w / 2;
  player.position.y = spawnZone.y + spawnZone.h / 2;
  styleAliveSprite(player);

  // Reset all remotes locally
  otherPlayers.forEach((sp) => {
    sp.isSpectator = false;
    sp.immunity = 0;
    sp.position.x = spawnZone.x + spawnZone.w / 2;
    sp.position.y = spawnZone.y + spawnZone.h / 2;
    styleAliveSprite(sp);
  });

  // Host may change on reconnects etc.
  recomputeHost();
}


// ================================================================
// UI + CONTROLS
// ================================================================
function drawUI() {
  push();

  // ── BANNER TEXT (TOP CENTER, BOLD) ─────────────────────────────
  textAlign(CENTER, CENTER);
  fill(0);
  textStyle(BOLD);  // <- make banner text bold

  // GAME OVER banner takes precedence over everything
  if (gameOver && winnerName) {
    textSize(24);
    text(`Game Over! Winner: ${winnerName}`, width / 2, 50);
  } else if (timerRunning) {
    // UNIVERSAL TIMER: shows for EVERYONE when timerRunning is true
    textSize(20);
    const secondsLeft = getSecondsLeft();
    text("Time Left: " + secondsLeft, width / 2, 50);
  } else if (!gameStart && lobby) {
    textSize(20);
    text(
      `(–≡= Lobby — waiting (${Object.keys(lobbyPlayers).length}/${requiredPlayers}) =≡–)`,
      width / 2,
      50
    );
  } else if (!timerRunning && gameStart) {
    textSize(16);
    const hostMsg = isHost ? "Press SPACE to start next round (You are host)"
      : "(–≡= WAITING FOR PLAYERS =≡–)";
    text(hostMsg, width / 2, 50);
  }

  // ── SIDE HUD / OTHER TEXT (NORMAL WEIGHT) ──────────────────────
  textStyle(NORMAL);      // <- reset to normal for everything else
  textAlign(LEFT, TOP);
  fill(0);

  text(`Name: ${player.name}`, 30, 30);
  text(`Immunity: ${player.immunity}`, 30, 90);
  text(`Round: ${currentRound}`, 30, 70);
  fill(120, 120, 120);
  text("*Press ENTER to Toggle Rules*", 30, 130);


  // HOST DISPLAY
  let hostLabel = "Unknown";
  if (hostId && lobbyPlayers[hostId]) {
    hostLabel = lobbyPlayers[hostId].name;
  }
  fill(0);
  text(`Host: ${hostLabel}${isHost ? " (You)" : ""}`, 30, 50);

  // Audio status
  text(
    `Music: ${musicEnabled ? "ON" : "OFF"} (M)\n` +
    `SFX: ${sfxEnabled ? "ON" : "OFF"} (S)`,
    850,
    height - 970
  );

  if (gameRulesScreen) {
    noStroke();
    fill(0, 140);
    rect(30, 160, 300, 320, 10);
    fill(255);
    textAlign(LEFT, TOP);
    textSize(12);
    text(
      "–≡= RAINBOW ROULETTE =≡–\n" +
        " \n" +
        "— Choose a color zone before timer ends (20s)\n" +
        "— Staying in SPAWN or leaving ARENA at timeout = elimination\n" +
        "— After timer:\n" +
        "     • 2 zones = ELIMINATION\n" +
        "     • 3 zones = SURVIVAL\n" +
        "     • 1 zone = IMMUNITY\n" +
        "— Roles are assigned at random based on where each player stands.\n" +
        "— Immunity stacks up to 2; consumes on elimination.\n" +
        "— Upon death, players become ghosts and spectate in the arena.\n" +
        " \n" +
        "Press ENTER to close.",
      45,
      180,
      280,
      300
    );
  }

  pop();
}


function keyPressed() {
  if (keyCode === ENTER) {
	    gameRulesScreen = !gameRulesScreen;  // <- toggle on/off
  }
  // HOST LOGIC: only host can start the global timer
  if (key === " " && gameStart && !timerRunning && isHost) {
    startGlobalRoundTimer();
  }

  // Toggle music (M) and SFX (S)
  if (key === "M" || key === "m") {
    toggleMusic();
  }
  if (key === "S" || key === "s") {
    toggleSfx();
  }
}

// ================================================================
// HELPERS: GEOMETRY / COLOR / ZONES / TIMER
// ================================================================
function makeZone(x, y, w, h, col, name) {
  return { x, y, w, h, color: col, name };
}

function isInsideRect(x, y, z) {
  return x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h;
}

function whichZone(x, y) {
  for (let z of rouletteZones) if (isInsideRect(x, y, z)) return z.name;
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

function worldToScreen(wx, wy) {
  return {
    x: wx * arenaScale + arenaOffsetX,
    y: wy * arenaScale + arenaOffsetY,
  };
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

function shuffleArray(a) {
  for (let i = a.length - 1; i > 0; i--) {
    let j = floor(random(i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function getSecondsLeft() {
  if (!timerRunning) return 0;
  const now = Date.now();
  const msLeft = max(0, roundEndTime - now);
  return ceil(msLeft / 1000);
}