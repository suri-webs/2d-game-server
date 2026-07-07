import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import authRoutes from './auth/authRoutes';
import { getJwtSecret } from './auth/authMiddleware';
import { RoomsManager, Room } from './rooms';
import { GameState } from './types';

// Load environment variables
dotenv.config();

const app = express();
const httpServer = createServer(app);

// Enable CORS for client connections
app.use(cors({
  origin: '*', // Allow connections from any frontend origin (Vite dev server, Vercel, Netlify)
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// API Routes
app.use('/auth', authRoutes);

app.get('/status', (req, res) => {
  res.json({ status: 'active', time: new Date() });
});

// Configure Socket.IO Server
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const roomsManager = new RoomsManager();

// Auth Middleware for Socket.IO connections
io.use((socket: Socket, next) => {
  const token = socket.handshake.auth?.token;

  if (token) {
    try {
      const decoded = jwt.verify(token, getJwtSecret()) as { id: string; username: string; email: string };
      socket.data.userId = decoded.id;
      socket.data.username = decoded.username;
      socket.data.isGuest = false;
      return next();
    } catch (err) {
      // Allow connection but treat as failed token, fallback to guest flow below
    }
  }

  // Fallback: Connect as Guest
  const guestId = 'guest-' + Math.random().toString(36).substring(2, 11);
  const guestNum = Math.floor(1000 + Math.random() * 9000);
  socket.data.userId = guestId;
  socket.data.username = `Guest_${guestNum}`;
  socket.data.isGuest = true;
  next();
});

// Broadcast helper for rooms
function broadcastRoomUpdate(code: string) {
  const room = roomsManager.getRoom(code);
  if (!room) return;

  const membersArray = Array.from(room.members.values());
  io.to(code).emit('roomUpdate', {
    code: room.code,
    mode: room.mode,
    maxPlayers: room.maxPlayers,
    level: room.level,
    hostId: room.hostId,
    status: room.status,
    members: membersArray
  });
}

io.on('connection', (socket: Socket) => {
  const playerId = socket.data.userId;
  const username = socket.data.username;

  console.log(`User connected: ${username} (${playerId}) [Socket: ${socket.id}]`);

  // Send handshake success back with player credentials
  socket.emit('authSuccess', { playerId, username, isGuest: socket.data.isGuest });

  // 1. Create a Lobby Room
  socket.on('createRoom', ({ mode, maxPlayers, level }, callback) => {
    try {
      const room = roomsManager.createRoom(playerId, mode, Number(maxPlayers), Number(level));
      
      // Join host socket to the room code room channel
      socket.join(room.code);
      
      // Add the host as a member
      roomsManager.joinRoom(room.code, playerId, username, socket.id);
      
      console.log(`Room created: ${room.code} by ${username}`);
      
      // Fire callback with room details
      callback({ success: true, roomCode: room.code });
      
      // Broadcast initial room update
      broadcastRoomUpdate(room.code);
    } catch (err: any) {
      console.error(err);
      callback({ success: false, error: err.message || 'Failed to create room.' });
    }
  });

  // 2. Join a Lobby Room
  socket.on('joinRoom', ({ code }, callback) => {
    try {
      const result = roomsManager.joinRoom(code, playerId, username, socket.id);
      if (typeof result === 'string') {
        return callback({ success: false, error: result });
      }

      socket.join(result.code);
      console.log(`${username} joined room ${result.code}`);

      callback({ success: true, roomCode: result.code });
      broadcastRoomUpdate(result.code);
    } catch (err: any) {
      callback({ success: false, error: 'Internal server error.' });
    }
  });

  // 3. Selection of characterType
  socket.on('selectCharacter', ({ code, characterType }) => {
    const updated = roomsManager.changeCharacter(playerId, code, characterType);
    if (updated) {
      broadcastRoomUpdate(code);
    }
  });

  // 4. Toggle ready status
  socket.on('toggleReady', ({ code }) => {
    const updated = roomsManager.toggleReady(playerId, code);
    if (updated) {
      broadcastRoomUpdate(code);
    }
  });

  // 5. Host starts game
  socket.on('startGame', ({ code }, callback) => {
    const room = roomsManager.getRoom(code);
    if (!room) return callback({ success: false, error: 'Room not found.' });
    if (room.hostId !== playerId) return callback({ success: false, error: 'Only the host can start the game.' });

    const result = roomsManager.startGame(code, (state: GameState) => {
      // Logical ticks broadcast
      io.to(code).emit('gameState', state);
    });

    if (typeof result === 'string') {
      return callback({ success: false, error: result });
    }

    console.log(`Game started in room ${code}`);
    io.to(code).emit('gameStarted', { level: room.level, mode: room.mode });
    callback({ success: true });
  });

  // 6. Capture client inputs during matches
  socket.on('input', (inputState) => {
    const room = roomsManager.getRoomByPlayerId(playerId);
    if (room && room.gameInstance) {
      room.gameInstance.updateInputs(playerId, inputState);
    }
  });

  // 6b. Capture client player state updates (client-authoritative coordinates)
  socket.on('playerStateUpdate', (playerState) => {
    const room = roomsManager.getRoomByPlayerId(playerId);
    if (room && room.gameInstance) {
      room.gameInstance.updatePlayerState(playerId, playerState);
    }
  });

  // 6c. Capture client enemy damage updates and route to room host
  socket.on('enemyDamage', ({ enemyId, damage }) => {
    const room = roomsManager.getRoomByPlayerId(playerId);
    if (room && room.hostId) {
      const hostMember = room.members.get(room.hostId);
      if (hostMember && hostMember.socketId) {
        console.log(`Damage relayed from guest ${username} (${playerId}) to host for enemy ${enemyId}: ${damage}`);
        io.to(hostMember.socketId).emit('applyEnemyDamage', { enemyId, damage });
      } else {
        console.log(`Failed to relay damage: host member or socketId not found in room.`);
      }
    } else {
      console.log(`Failed to relay damage: room not found for player.`);
    }
  });

  // 6d. Capture host player damage updates on remote players and apply directly
  socket.on('playerTakeDamage', ({ playerId: targetPlayerId, damage }) => {
    const room = roomsManager.getRoomByPlayerId(playerId);
    if (room && room.gameInstance) {
      room.gameInstance.damagePlayer(targetPlayerId, damage);
    }
  });

  // 7. Chat messages in lobbies / matches
  socket.on('sendChatMessage', ({ code, message }) => {
    io.to(code).emit('chatMessage', {
      sender: username,
      message,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  // 8. Leave room manually
  socket.on('leaveRoom', () => {
    handlePlayerLeaving(socket, playerId);
  });

  // 9. Handle socket disconnects
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${username} (${playerId})`);
    handlePlayerLeaving(socket, playerId);
  });
});

function handlePlayerLeaving(socket: Socket, playerId: string) {
  const leaveInfo = roomsManager.leaveRoom(playerId);
  if (leaveInfo) {
    socket.leave(leaveInfo.roomCode);
    console.log(`Player ${playerId} left room ${leaveInfo.roomCode}`);

    if (!leaveInfo.roomDeleted) {
      broadcastRoomUpdate(leaveInfo.roomCode);
      io.to(leaveInfo.roomCode).emit('chatMessage', {
        sender: 'SYSTEM',
        message: `${socket.data.username} has left the room.`,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
    }
  }
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`Shadow Strike Server running on port ${PORT}`);
  console.log(`========================================`);
});

// Trigger compile restart
