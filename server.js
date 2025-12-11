// server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // You can tweak transports here if needed.
  cors: {
    origin: "*",
  },
});

// Serve static files (index.html, sketch.js, assets, etc.)
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// Optionally force root to index.html (default for static anyway)
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// In-memory lobby state (very lightweight)
const lobbyPlayers = new Map(); // key: socketId, value: { id, name, time }

// Helper for logging
function log(...args) {
  console.log("[RR]", ...args);
}

io.on("connection", (socket) => {
  log("Client connected:", socket.id);

  // Client announces itself & chosen name
  socket.on("join", (data) => {
    const name = (data && data.name) || "Player";
    const time = Date.now();

    const playerInfo = {
      id: socket.id, // trust server ID
      name,
      time,
    };

    lobbyPlayers.set(socket.id, playerInfo);

    // Broadcast to EVERYONE (including sender) so all lobbyPlayers stay in sync
    io.emit("join", playerInfo);

    log(`JOIN from ${socket.id} (${name})`);
  });

  // Position / status updates — only broadcast to others
  socket.on("update", (data) => {
    if (!data) return;

    const payload = {
      ...data,
      id: socket.id, // again, trust server ID
    };

    // Broadcast to everyone EXCEPT sender
    socket.broadcast.emit("update", payload);
  });

  // Elimination / spectator marking
  socket.on("delete", (id) => {
    const targetId = id || socket.id;

    // Let everyone know this player is effectively "deleted"/spectator
    io.emit("delete", targetId);
    log(`DELETE event for ${targetId}`);
  });

  // Host-only: round timer start, but we just relay to everyone
  socket.on("roundStart", (data) => {
    const payload = {
      ...(data || {}),
      hostId: socket.id,
    };
    io.emit("roundStart", payload);
    log("ROUND START from", socket.id, "at", payload.startTime);
  });

  // Host-only: zone role assignments
  socket.on("roundRoles", (data) => {
    const payload = {
      ...(data || {}),
      hostId: socket.id,
    };
    io.emit("roundRoles", payload);
    log("ROUND ROLES from", socket.id);
  });

  socket.on("disconnect", () => {
    log("Client disconnected:", socket.id);
    lobbyPlayers.delete(socket.id);

    // Tells everyone this player is gone / should become spectator
    io.emit("delete", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

server.listen(PORT, HOST, () => {
  log(`Server listening on http://${HOST}:${PORT}`);
});

