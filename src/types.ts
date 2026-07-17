export interface InputState {
  left: boolean;
  right: boolean;
  jump: boolean;
  interact: boolean;
  attack1: boolean;
  attack2: boolean;
  attack3: boolean;
}

export interface PlayerState {
  id: string;
  username: string;
  characterType: string;
  x: number;
  y: number;
  vy: number;
  hp: number;
  maxHp: number;
  coins: number;
  isDashing: boolean;
  facingLeft: boolean;
  animState: string;
  frameX: number;
  shieldActive: boolean;
  isDead: boolean;
  score: number;
}

export interface EnemyState {
  id: string;
  type: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  facingLeft: boolean;
  state: string; // e.g. 'idle', 'walk', 'atk', 'hurt', 'dead'
  isBoss: boolean;
  introLocked?: boolean;
}

export interface ProjectileState {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  type: string; // e.g. 'wind', 'slash', 'kamehameha', 'rasengan', 'boss_fireball'
  ownerId: string;
}

export interface DropboxState {
  x: number;
  y: number;
  state: 'closed' | 'opening' | 'opened';
}

export interface PortalState {
  x: number;
  y: number;
  active: boolean;
}

export interface CoinPickupState {
  id: string;
  x: number;
  y: number;
  vy: number;
  value: number;
  phase: number; // 1 = falling, 2 = static, 3 = collected
}

export interface LootState {
  id: string;
  x: number;
  y: number;
  type: 'weapon' | 'health';
  value: string | number; // 'kamehameha', 'rasengan', or hp amount
  pickedUp: boolean;
}

export interface GameState {
  players: { [id: string]: PlayerState };
  enemies: EnemyState[];
  projectiles: ProjectileState[];
  dropbox: DropboxState | null;
  portal: PortalState | null;
  coins: CoinPickupState[];
  loot: LootState[];
  currentLevel: number;
  mode: 'coop' | 'pvp';
  status: 'waiting' | 'active' | 'ended';
  winnerId?: string;
  timeRemaining?: number; // for timed final bosses/PVP rounds
  waveIndex?: number;
  totalWaves?: number;
  cameraX?: number;
  scrollSpeed?: number;
}

export interface RoomConfig {
  code: string;
  mode: 'coop' | 'pvp';
  maxPlayers: number;
  level: number;
  hostId: string;
}
