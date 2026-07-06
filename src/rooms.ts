import { GameInstance } from './gameInstance';

export interface RoomMember {
  playerId: string;
  socketId: string;
  username: string;
  characterType: string;
  isReady: boolean;
}

export interface Room {
  code: string;
  mode: 'coop' | 'pvp';
  maxPlayers: number;
  level: number;
  hostId: string;
  members: Map<string, RoomMember>;
  gameInstance?: GameInstance;
  status: 'lobby' | 'playing' | 'ended';
}

export class RoomsManager {
  private rooms: Map<string, Room> = new Map();

  // Helper to generate a unique 6-character room code
  private generateRoomCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    do {
      code = '';
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
    } while (this.rooms.has(code));
    return code;
  }

  public createRoom(hostId: string, mode: 'coop' | 'pvp', maxPlayers: number, level: number): Room {
    const code = this.generateRoomCode();
    const room: Room = {
      code,
      mode,
      maxPlayers,
      level,
      hostId,
      members: new Map(),
      status: 'lobby'
    };
    this.rooms.set(code, room);
    return room;
  }

  public getRoom(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  public joinRoom(code: string, playerId: string, username: string, socketId: string): Room | string {
    const formattedCode = code.toUpperCase();
    const room = this.rooms.get(formattedCode);
    if (!room) {
      return 'Room not found.';
    }

    if (room.status !== 'lobby') {
      return 'Game has already started in this room.';
    }

    if (room.members.size >= room.maxPlayers) {
      return 'Room is full.';
    }

    // Default character selection is shinobi
    room.members.set(playerId, {
      playerId,
      socketId,
      username,
      characterType: 'shinobi',
      isReady: false
    });

    return room;
  }

  public changeCharacter(playerId: string, code: string, characterType: string): Room | null {
    const room = this.rooms.get(code.toUpperCase());
    if (room) {
      const member = room.members.get(playerId);
      if (member) {
        member.characterType = characterType;
        return room;
      }
    }
    return null;
  }

  public toggleReady(playerId: string, code: string): Room | null {
    const room = this.rooms.get(code.toUpperCase());
    if (room) {
      const member = room.members.get(playerId);
      if (member) {
        member.isReady = !member.isReady;
        return room;
      }
    }
    return null;
  }

  public leaveRoom(playerId: string): { roomCode: string; roomDeleted: boolean; hostChanged: boolean } | null {
    for (const [code, room] of this.rooms.entries()) {
      if (room.members.has(playerId)) {
        room.members.delete(playerId);
        
        // Remove from active game instance if playing
        if (room.gameInstance) {
          room.gameInstance.removePlayer(playerId);
        }

        // Clean up empty room
        if (room.members.size === 0) {
          if (room.gameInstance) {
            room.gameInstance.stop();
          }
          this.rooms.delete(code);
          return { roomCode: code, roomDeleted: true, hostChanged: false };
        }

        let hostChanged = false;
        // Re-assign host if host left
        if (room.hostId === playerId) {
          const nextMemberId = room.members.keys().next().value;
          if (nextMemberId) {
            room.hostId = nextMemberId;
            hostChanged = true;
          }
        }

        return { roomCode: code, roomDeleted: false, hostChanged };
      }
    }
    return null;
  }

  public startGame(code: string, broadcastCallback: (state: any) => void): Room | string {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) return 'Room not found.';
    if (room.status !== 'lobby') return 'Game already started.';

    room.status = 'playing';
    room.gameInstance = new GameInstance(code, room.mode, room.level, broadcastCallback);
    
    // Populate players on start
    room.members.forEach(m => {
      room.gameInstance!.addPlayer(m.playerId, m.username, m.characterType);
    });

    room.gameInstance.start();
    return room;
  }

  public getRoomByPlayerId(playerId: string): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.members.has(playerId)) {
        return room;
      }
    }
    return undefined;
  }
}
