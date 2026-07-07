import { GameState, PlayerState, EnemyState, ProjectileState, DropboxState, PortalState, CoinPickupState, LootState, InputState } from './types';
import { prisma } from './db';

const CANVAS_WIDTH = 1550;
const CANVAS_HEIGHT = 700;
const TICK_RATE = 20;
const TIME_STEP = 1 / TICK_RATE; // 50ms

interface ServerPlayer extends PlayerState {
  inputs: InputState;
  weight: number;
  maxSpeed: number;
  height: number;
  width: number;
  jumpCount: number;
  maxJumps: number;
  dashTimer: number;
  dashCooldown: number;
  shieldTimer: number;
  hitCooldown: number;
  attackCooldown: number;
  slashProjectiles?: any[];
  windProjectiles?: any[];
}

interface ServerEnemy extends EnemyState {
  width: number;
  height: number;
  vx: number;
  vy: number;
  weight: number;
  groundY: number;
  attackTimer: number;
  attackInterval: number;
}

export class GameServer {
  private roomId: string;
  private mode: 'coop' | 'pvp';
  private level: number;
  private status: 'waiting' | 'active' | 'ended' = 'waiting';
  private winnerId?: string;

  private players: Map<string, ServerPlayer> = new Map();
  private enemies: ServerEnemy[] = [];
  private projectiles: ProjectileState[] = [];
  private dropbox: DropboxState | null = null;
  private portal: PortalState | null = null;
  private coins: CoinPickupState[] = [];
  private loot: LootState[] = [];

  private loopInterval: NodeJS.Timeout | null = null;
  private broadcastCallback: (state: GameState) => void;

  private cameraX = 0;
  private scrollSpeed = 0;

  // Wave manager states (Co-op only)
  private waveIndex = 0;
  private waveSpawnedCount = 0;
  private enemyTimer = 0;
  private waveComplete = false;
  private waveTransTimer = 0;
  private waveDelay = 2000; // ms

  // Dropbox and HP spawn timers
  private dropboxSpawned = false;
  private portalSpawned = false;
  private dropboxTimer = 0;
  private hpTimer = 0;

  // Level configuration matching client
  private levelConfig = {
    groundMargin: 55,
    enemyInterval: 2500,
    waves: [
      { type: 'skeleton_white', count: 3 },
      { type: 'flying', count: 2 },
      { type: 'mixed_level1', count: 4 },
      { type: 'boss', count: 1 }
    ]
  };

  public hostId: string;

  constructor(roomId: string, mode: 'coop' | 'pvp', level: number, hostId: string, broadcastCallback: (state: GameState) => void) {
    this.roomId = roomId;
    this.mode = mode;
    this.level = level;
    this.hostId = hostId;
    this.broadcastCallback = broadcastCallback;

    // Load level specific wave layouts
    this.initLevelConfig();
  }

  private initLevelConfig() {
    // Replicate level waves based on level index
    const lvl = this.level;
    const waves: { type: string; count: number }[] = [];

    if (lvl === 1) {
      waves.push({ type: 'skeleton_white', count: 3 }, { type: 'flying', count: 3 }, { type: 'boss', count: 1 });
    } else if (lvl === 2) {
      waves.push({ type: 'demon', count: 4 }, { type: 'skeleton_yellow', count: 4 }, { type: 'boss', count: 1 });
    } else {
      waves.push(
        { type: 'skeleton_white', count: 5 },
        { type: 'demon', count: 4 },
        { type: 'flying', count: 4 },
        { type: 'boss', count: 1 }
      );
    }

    this.levelConfig = {
      groundMargin: 55,
      enemyInterval: 2000 - Math.min(10, lvl) * 100,
      waves: waves
    };
  }

  public addPlayer(id: string, username: string, characterType: string) {
    let maxHP = 100;
    let maxSpeed = 5.2;
    let weight = 0.16;
    let width = 95;
    let height = 96.1;

    if (characterType === 'jotem') {
      width = 240;
      height = 240;
      maxSpeed = 3.5;
      maxHP = 130;
      weight = 0.25;
    } else if (characterType === 'shaia') {
      width = 210;
      height = 210;
      maxSpeed = 4.8;
      maxHP = 90;
      weight = 0.14;
    } else if (characterType === 'archdemon') {
      width = 240;
      height = 240;
      maxSpeed = 5.0;
      maxHP = 110;
      weight = 0.16;
    }

    const groundY = CANVAS_HEIGHT - this.levelConfig.groundMargin;
    const startX = this.mode === 'pvp'
      ? [100, 500, 900, 1300][this.players.size % 4]
      : 100 + this.players.size * 50;

    const player: ServerPlayer = {
      id,
      username,
      characterType,
      x: startX,
      y: groundY - height,
      vy: 0,
      hp: maxHP,
      maxHp: maxHP,
      coins: 0,
      isDashing: false,
      facingLeft: false,
      animState: 'IDLE',
      frameX: 0,
      shieldActive: false,
      isDead: false,
      score: 0,
      weight,
      maxSpeed,
      width,
      height,
      jumpCount: 0,
      maxJumps: characterType === 'archdemon' ? 3 : 2,
      dashTimer: 0,
      dashCooldown: 0,
      shieldTimer: 0,
      hitCooldown: 0,
      attackCooldown: 0,
      inputs: { left: false, right: false, jump: false, interact: false, attack1: false, attack2: false, attack3: false }
    };

    this.players.set(id, player);
  }

  public removePlayer(id: string) {
    this.players.delete(id);
    if (this.players.size === 0) {
      this.stop();
    }
  }

  public updateInputs(id: string, inputs: InputState) {
    const player = this.players.get(id);
    if (player && !player.isDead) {
      player.inputs = { ...inputs };
    }
  }

  public start() {
    if (this.status === 'active') return;
    this.status = 'active';

    if (this.mode === 'pvp') {
      this.spawnPvpLoot();
    }

    this.loopInterval = setInterval(() => {
      this.tick();
    }, 1000 / TICK_RATE);
  }

  public stop() {
    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }
    this.status = 'ended';
  }

  public updatePlayerState(playerId: string, state: any) {
    const p = this.players.get(playerId);
    if (p) {
      p.x = state.x;
      p.y = state.y;
      p.vy = state.vy;
      p.animState = state.animState;
      p.facingLeft = state.facingLeft;
      p.hp = state.hp;
      p.maxHp = state.maxHp;
      p.score = state.score;
      p.coins = state.coins;
      p.shieldActive = state.shieldActive;
      p.isDead = state.isDead;
      // Relay player projectiles so other clients can render them
      if (state.slashProjectiles !== undefined) p.slashProjectiles = state.slashProjectiles;
      if (state.windProjectiles !== undefined) p.windProjectiles = state.windProjectiles;
    }
    if (playerId === this.hostId) {
      if (state.cameraX !== undefined) this.cameraX = state.cameraX;
      if (state.scrollSpeed !== undefined) this.scrollSpeed = state.scrollSpeed;
    }
  }

  public damagePlayer(playerId: string, damage: number) {
    const p = this.players.get(playerId);
    if (p && !p.isDead) {
      p.hp = Math.max(0, p.hp - damage);
      p.animState = 'DAMAGE';
      p.hitCooldown = 800;
      if (p.hp <= 0) {
        p.isDead = true;
        p.animState = 'DEATH';
      }
    }
  }

  public handleEnemyHit(enemyId: string, damage: number, playerId: string) {
    const enemy = this.enemies.find(e => String(e.id) === String(enemyId));
    if (enemy && enemy.hp > 0) {
      enemy.hp = Math.max(0, enemy.hp - damage);
      enemy.state = enemy.hp <= 0 ? 'dead' : 'hurt';

      if (enemy.hp <= 0) {
        this.spawnCoins(enemy.x + enemy.width / 2, enemy.y + enemy.height / 2, enemy.isBoss ? 20 : 3);
        const attacker = this.players.get(playerId);
        if (attacker) {
          attacker.score += enemy.isBoss ? 100 : 10;
        }
      }
      
      // Snappy state broadcast
      this.broadcastCallback(this.getState());
    }
  }

  private tick() {
    if (this.status !== 'active') return;

    this.updateWaves();
    this.updateEnemies();
    this.updateProjectiles();
    this.updateDropbox();
    this.updateCoins();
    this.checkCollisions();
    this.checkEndConditions();

    this.broadcastCallback(this.getState());
  }

  private spawnPvpLoot() {
    // Spawn pre-placed weapons and heals for PvP
    this.loot = [
      { id: 'loot1', x: 200, y: 500, type: 'weapon', value: 'kamehameha', pickedUp: false },
      { id: 'loot2', x: 600, y: 350, type: 'health', value: 40, pickedUp: false },
      { id: 'loot3', x: 800, y: 500, type: 'weapon', value: 'rasengan', pickedUp: false },
      { id: 'loot4', x: 1200, y: 350, type: 'health', value: 40, pickedUp: false },
      { id: 'loot5', x: 1400, y: 500, type: 'weapon', value: 'kamehameha', pickedUp: false }
    ];
  }

  private updatePlayers() {
    const groundY = CANVAS_HEIGHT - this.levelConfig.groundMargin;

    this.players.forEach(p => {
      if (p.isDead) return;

      // Handle cooldowns
      if (p.dashCooldown > 0) p.dashCooldown -= TIME_STEP * 1000;
      if (p.shieldTimer > 0) {
        p.shieldTimer -= TIME_STEP * 1000;
        if (p.shieldTimer <= 0) p.shieldActive = false;
      }
      if (p.hitCooldown > 0) p.hitCooldown -= TIME_STEP * 1000;
      if (p.attackCooldown > 0) p.attackCooldown -= TIME_STEP * 1000;

      // Horizontal movement
      let speed = 0;
      if (p.inputs.left) {
        speed = -p.maxSpeed;
        p.facingLeft = true;
      } else if (p.inputs.right) {
        speed = p.maxSpeed;
        p.facingLeft = false;
      }

      // Check Dashing (shift / attack3)
      if (p.inputs.attack3 && p.dashCooldown <= 0 && !p.isDashing) {
        p.isDashing = true;
        p.dashTimer = 200; // 200ms dash
        p.dashCooldown = 1000;
      }

      if (p.isDashing) {
        p.dashTimer -= TIME_STEP * 1000;
        speed = p.facingLeft ? -p.maxSpeed * 2.5 : p.maxSpeed * 2.5;
        p.animState = 'RUNNING';
        if (p.dashTimer <= 0) {
          p.isDashing = false;
        }
      }

      p.x += speed * (TIME_STEP * 60); // normalize speed to 60fps equivalent for logic
      if (p.x < 0) p.x = 0;
      if (p.x > CANVAS_WIDTH - p.width) p.x = CANVAS_WIDTH - p.width;

      // Vertical movement & jump
      if (p.inputs.jump && p.jumpCount < p.maxJumps) {
        p.vy = -10;
        p.jumpCount++;
        // Clear jump input immediately so they don't hold jump to infinity
        p.inputs.jump = false;
        p.animState = 'JUMPING';
      }

      p.y += p.vy * (TIME_STEP * 60);
      p.vy += p.weight * (TIME_STEP * 60);

      // Ground bounds
      const limitY = groundY - p.height + (p.characterType === 'archdemon' ? -40 : 0);
      if (p.y >= limitY) {
        p.y = limitY;
        p.vy = 0;
        p.jumpCount = 0;
        if (!p.isDashing && speed !== 0) {
          p.animState = 'RUNNING';
        } else if (!p.isDashing) {
          p.animState = 'IDLE';
        }
      } else if (p.vy > 0) {
        p.animState = 'FALLING';
      }

      // Shield active (E / attack2)
      if (p.inputs.attack2 && p.shieldTimer <= 0) {
        p.shieldActive = true;
        p.shieldTimer = 2500; // 2.5 sec shield duration
        p.inputs.attack2 = false;
      }

      // Melee attack (Left Click / F / attack1)
      if (p.inputs.attack1 && p.attackCooldown <= 0) {
        p.animState = 'ATTACK';
        p.attackCooldown = 400; // 400ms speed
        p.inputs.attack1 = false;

        // Attack hit confirmation
        this.resolveMeleeAttack(p);
      }

      // Interactive Dropbox proximity check
      if (p.inputs.interact && this.dropbox && this.dropbox.state === 'closed') {
        const dist = Math.abs((p.x + p.width / 2) - this.dropbox.x);
        if (dist < 100) {
          this.dropbox.state = 'opening';
          // Wait 500ms then open and spawn rewards
          setTimeout(() => {
            if (this.dropbox) {
              this.dropbox.state = 'opened';
              this.spawnDropboxReward(p);
            }
          }, 500);
        }
        p.inputs.interact = false;
      }
    });
  }

  private resolveMeleeAttack(attacker: ServerPlayer) {
    let attackRange = 80;
    const axCenter = attacker.x + attacker.width / 2;
    const ayCenter = attacker.y + attacker.height / 2;

    if (this.mode === 'coop') {
      // Hit enemies
      this.enemies.forEach(e => {
        if (e.hp <= 0) return;
        const exCenter = e.x + e.width / 2;
        const eyCenter = e.y + e.height / 2;

        const dist = Math.hypot(axCenter - exCenter, ayCenter - eyCenter);
        if (dist <= attackRange) {
          // Verify direction
          const isToRight = exCenter > axCenter;
          if ((attacker.facingLeft && !isToRight) || (!attacker.facingLeft && isToRight)) {
            e.hp -= attacker.characterType === 'archdemon' || attacker.characterType === 'jotem' ? 18 : 12;
            e.state = 'hurt';
            if (e.hp <= 0) {
              e.state = 'dead';
              // spawn coins
              this.spawnCoins(e.x + e.width / 2, e.y + e.height / 2, e.isBoss ? 20 : 3);
              attacker.score += e.isBoss ? 100 : 10;
            }
          }
        }
      });
    } else {
      // PvP: Hit other players
      this.players.forEach(p => {
        if (p.id === attacker.id || p.isDead || p.shieldActive) return;
        const pxCenter = p.x + p.width / 2;
        const pyCenter = p.y + p.height / 2;

        const dist = Math.hypot(axCenter - pxCenter, ayCenter - pyCenter);
        if (dist <= attackRange) {
          const isToRight = pxCenter > axCenter;
          if ((attacker.facingLeft && !isToRight) || (!attacker.facingLeft && isToRight)) {
            p.hp -= 15;
            p.animState = 'DAMAGE';
            p.hitCooldown = 500;
            if (p.hp <= 0) {
              p.isDead = true;
              p.animState = 'DEATH';
            }
          }
        }
      });
    }
  }

  private spawnDropboxReward(player: ServerPlayer) {
    if (this.mode === 'coop') {
      // In co-op, unlock special move randomly (kamehameha or rasengan) or give 30 coins
      const r = Math.random();
      if (r < 0.4) {
        // Spawn kamehameha projectile immediately or give player active projectile power
        this.spawnSpecialAttack(player, 'kamehameha');
      } else if (r < 0.8) {
        this.spawnSpecialAttack(player, 'rasengan');
      } else {
        player.coins += 30;
      }
    }
  }

  private spawnSpecialAttack(player: ServerPlayer, type: 'kamehameha' | 'rasengan') {
    const startX = player.facingLeft ? player.x - 80 : player.x + player.width;
    const startY = player.y + player.height * 0.25;
    const vx = player.facingLeft ? -12 : 12;

    this.projectiles.push({
      id: Math.random().toString(),
      x: startX,
      y: startY,
      vx,
      vy: 0,
      type,
      ownerId: player.id
    });
  }

  private spawnCoins(x: number, y: number, count: number) {
    for (let i = 0; i < count; i++) {
      this.coins.push({
        id: Math.random().toString(),
        x,
        y,
        vy: -5 - Math.random() * 5,
        value: 1,
        phase: 1
      });
    }
  }

  private updateWaves() {
    if (this.waveIndex >= this.levelConfig.waves.length) {
      if (this.enemies.length === 0 && !this.portal && !this.portalSpawned) {
        this.portalSpawned = true;
        this.portal = { x: 1200, y: CANVAS_HEIGHT - this.levelConfig.groundMargin, active: true };
      }
      return;
    }

    const currentWave = this.levelConfig.waves[this.waveIndex];
    if (this.waveSpawnedCount < currentWave.count) {
      this.enemyTimer += TIME_STEP * 1000;
      if (this.enemyTimer >= this.levelConfig.enemyInterval) {
        this.spawnEnemy(currentWave.type);
        this.waveSpawnedCount++;
        this.enemyTimer = 0;
      }
    } else {
      // Check if all current wave enemies are dead
      if (this.enemies.every(e => e.hp <= 0)) {
        this.waveComplete = true;
        this.waveTransTimer += TIME_STEP * 1000;
        if (this.waveTransTimer >= this.waveDelay) {
          this.waveIndex++;
          this.waveSpawnedCount = 0;
          this.waveComplete = false;
          this.waveTransTimer = 0;
        }
      }
    }

    // Trigger dropbox spawn after 8 seconds
    if (!this.dropboxSpawned) {
      this.dropboxTimer += TIME_STEP * 1000;
      if (this.dropboxTimer >= 8000) {
        this.dropboxSpawned = true;
        this.dropbox = { x: 800, y: 100, state: 'closed' };
      }
    }
  }

  private spawnEnemy(type: string) {
    const id = Math.random().toString();
    const groundY = CANVAS_HEIGHT - this.levelConfig.groundMargin;

    let actualType = type;
    if (type === 'mixed_level1') {
      actualType = Math.random() < 0.6 ? 'skeleton_white' : 'flying';
    } else if (type === 'mixed_level2') {
      const r = Math.random();
      actualType = r < 0.4 ? 'demon' : (r < 0.75 ? 'skeleton_yellow' : 'flying');
    } else if (type === 'mixed_level3') {
      const r = Math.random();
      actualType = r < 0.3 ? 'demon' : (r < 0.55 ? 'skeleton_yellow' : (r < 0.8 ? 'arcane_archer' : 'flying'));
    }

    const lvl = this.level;
    let hp = 40;
    let width = 60;
    let height = 80;
    let isBoss = false;

    if (actualType === 'skeleton_white') {
      hp = 40 + (lvl - 1) * 15;
      width = 100;
      height = 120;
    } else if (actualType === 'skeleton_yellow') {
      hp = 70 + (lvl - 1) * 20;
      width = 100;
      height = 120;
    } else if (actualType === 'arcane_archer') {
      hp = 50 + (lvl - 1) * 18;
      width = 90;
      height = 120;
    } else if (actualType === 'demon') {
      hp = 60 + (lvl - 1) * 25;
      width = 200;
      height = 180;
    } else if (actualType === 'flying') {
      hp = 40;
      width = 82;
      height = 82;
    } else if (actualType === 'boss') {
      const lvlMod = this.level % 10 || 10;
      isBoss = true;
      if (lvlMod === 10) {
        actualType = 'amarjeet';
        hp = 3000;
        width = 320;
        height = 320;
      } else if (lvlMod === 9) {
        actualType = 'abyss_knight';
        hp = 1200;
        width = 320;
        height = 320;
      } else if (lvlMod === 8) {
        actualType = 'frost_wyrm';
        hp = 900;
        width = 320;
        height = 320;
      } else if (lvlMod === 7) {
        actualType = 'storm_seraph';
        hp = 750;
        width = 320;
        height = 320;
      } else if (lvlMod === 6) {
        actualType = 'crystal_titan';
        hp = 600;
        width = 320;
        height = 320;
      } else if (lvlMod === 5) {
        actualType = 'impaler';
        hp = 500;
        width = 320;
        height = 320;
      } else if (lvlMod === 4) {
        actualType = 'minoboss';
        hp = 400;
        width = 320;
        height = 320;
      } else if (lvlMod === 3) {
        actualType = 'demon_lord';
        hp = 400;
        width = 320;
        height = 320;
      } else if (lvlMod === 2) {
        actualType = 'mecha_stone';
        hp = 450;
        width = 320;
        height = 320;
      } else {
        actualType = 'boss_level_1';
        hp = 400;
        width = 320;
        height = 320;
      }
    }

    let enemyY = groundY - height;
    if (actualType === 'flying') {
      enemyY = 200 + Math.random() * 170;
    } else if (actualType === 'arcane_archer') {
      enemyY = groundY - height + 32;
    } else if (actualType === 'minoboss') {
      enemyY = groundY - height + 37;
    } else if (isBoss) {
      enemyY = groundY - height + 10;
    }

    const enemy: ServerEnemy = {
      id,
      type: actualType,
      x: CANVAS_WIDTH + 50,
      y: enemyY,
      hp,
      maxHp: hp,
      facingLeft: true,
      state: 'walk',
      isBoss,
      width,
      height,
      vx: -2.5,
      vy: 0,
      weight: 0.2,
      groundY,
      attackTimer: 0,
      attackInterval: isBoss ? 1500 : 2500,
      projectiles: []
    };

    this.enemies.push(enemy);

    // Broadcast spawn event to clients
    this.broadcastCallback({
      ...this.getState(),
      spawnedEnemy: {
        id,
        type: actualType,
        x: enemy.x,
        y: enemy.y,
        hp,
        maxHp: hp,
        isBoss
      }
    } as any);
  }

  private updateEnemies() {
    this.enemies.forEach(e => {
      if (e.hp <= 0) {
        e.state = 'dead';
        if (e.projectiles) {
          e.projectiles = []; // clear projectiles if dead
        }
        return;
      }

      // Initialize projectiles array on server enemy if not present
      if (!e.projectiles) e.projectiles = [];

      // Move toward closest player
      let targetPlayer: ServerPlayer | null = null;
      let minDist = 9999;
      this.players.forEach(p => {
        if (p.isDead) return;
        const dist = Math.abs(p.x - e.x);
        if (dist < minDist) {
          minDist = dist;
          targetPlayer = p;
        }
      });

      if (targetPlayer) {
        const tp: ServerPlayer = targetPlayer;
        const toRight = tp.x > e.x;
        e.facingLeft = !toRight;

        // Custom range: arcane archer has longer range
        const attackRange = e.type === 'arcane_archer' ? 350 : (e.isBoss ? 120 : 60);
        if (minDist <= attackRange) {
          e.vx = 0;
          e.state = 'atk';

          e.attackTimer += TIME_STEP * 1000;
          if (e.attackTimer >= e.attackInterval) {
            e.attackTimer = 0;

            // Handle projectile spawning or melee attack
            if (e.type === 'arcane_archer') {
              const fireX = e.facingLeft ? e.x : e.x + e.width;
              const fireY = e.y + e.height * 0.4;
              e.projectiles.push({
                id: Math.random().toString(),
                x: fireX,
                y: fireY,
                vx: e.facingLeft ? -8 : 8,
                vy: 0,
                type: 'ArcherProjectile',
                damage: 8,
                radius: 12
              });
            } else if (e.isBoss) {
              const r = Math.random();
              if (r < 0.4) {
                // Fireball
                const cx = e.x + e.width / 2;
                const cy = e.y + e.height / 2;
                const pvx = e.facingLeft ? -12 : 12;
                e.projectiles.push({
                  id: Math.random().toString(),
                  x: cx,
                  y: cy,
                  vx: pvx,
                  vy: 0,
                  type: 'BossFireballProjectile',
                  damage: 15,
                  radius: 12
                });
              } else if (r < 0.8) {
                // Giant fireball
                const cx = e.x + e.width / 2;
                const cy = e.y + e.height / 2;
                const pvx = e.facingLeft ? -8 : 8;
                e.projectiles.push({
                  id: Math.random().toString(),
                  x: cx,
                  y: cy,
                  vx: pvx,
                  vy: 0,
                  type: 'BossGiantFireball',
                  damage: 25,
                  radius: 24
                });
              } else {
                // Melee slash or direct strike
                if (!tp.shieldActive && tp.hitCooldown <= 0) {
                  tp.hp = Math.max(0, tp.hp - 20);
                  tp.animState = 'DAMAGE';
                  tp.hitCooldown = 800;
                  if (tp.hp <= 0) {
                    tp.isDead = true;
                    tp.animState = 'DEATH';
                  }
                }
              }
            } else {
              // Melee damage to target
              if (!tp.shieldActive && tp.hitCooldown <= 0) {
                tp.hp = Math.max(0, tp.hp - 8);
                tp.animState = 'DAMAGE';
                tp.hitCooldown = 800;
                if (tp.hp <= 0) {
                  tp.isDead = true;
                  tp.animState = 'DEATH';
                }
              }
            }
          }
        } else {
          e.vx = e.facingLeft ? -2 : 2;
          e.state = 'walk';
          e.attackTimer = 0;
        }
      } else {
        e.vx = 0;
        e.state = 'idle';
      }

      e.x += e.vx;
      if (e.x < 0) e.x = 0;

      // Update enemy's active projectiles and check player collisions
      if (e.projectiles && e.projectiles.length > 0) {
        e.projectiles.forEach((p: any) => {
          p.x += p.vx;
          p.y += p.vy;

          // Check collisions with all players
          this.players.forEach(tp => {
            if (tp.isDead || tp.shieldActive || tp.hitCooldown > 0) return;
            const dist = Math.hypot(tp.x + tp.width / 2 - p.x, tp.y + tp.height / 2 - p.y);
            if (dist < p.radius + tp.width / 4) {
              tp.hp = Math.max(0, tp.hp - p.damage);
              tp.animState = 'DAMAGE';
              tp.hitCooldown = 800;
              p.x = -9999; // mark for deletion
              if (tp.hp <= 0) {
                tp.isDead = true;
                tp.animState = 'DEATH';
              }
            }
          });
        });

        // Filter out collided or offscreen projectiles
        e.projectiles = e.projectiles.filter((p: any) => p.x > -200 && p.x < CANVAS_WIDTH + 200 && p.x !== -9999);
      }
    });

    // Clean up dead enemies after 2 seconds
    this.enemies = this.enemies.filter(e => {
      if (e.hp <= 0) {
        if (!(e as any).deathTime) {
          (e as any).deathTime = Date.now();
        }
        return Date.now() - (e as any).deathTime < 2000;
      }
      return true;
    });
  }

  private updateProjectiles() {
    this.projectiles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
    });

    // Remove offscreen projectiles
    this.projectiles = this.projectiles.filter(p => p.x > -100 && p.x < CANVAS_WIDTH + 100);
  }

  private updateDropbox() {
    if (this.dropbox && this.dropbox.state === 'opening') {
      // dropbox state matches wait
    }
  }

  private updateCoins() {
    const groundY = CANVAS_HEIGHT - this.levelConfig.groundMargin;

    this.coins.forEach(c => {
      if (c.phase === 1) {
        c.y += c.vy;
        c.vy += 0.2; // gravity
        if (c.y >= groundY - 15) {
          c.y = groundY - 15;
          c.phase = 2;
        }
      }

      // Check proximity pickup
      if (c.phase === 1 || c.phase === 2) {
        this.players.forEach(p => {
          if (p.isDead) return;
          const dist = Math.hypot(p.x + p.width / 2 - c.x, p.y + p.height / 2 - c.y);
          if (dist < 80) {
            c.phase = 3;
            p.coins += c.value;
          }
        });
      }
    });

    this.coins = this.coins.filter(c => c.phase !== 3);
  }

  private checkCollisions() {
    // Check projectles colliding with opponents
    this.projectiles.forEach(p => {
      if (this.mode === 'coop') {
        // Collide with enemies
        this.enemies.forEach(e => {
          if (e.hp <= 0) return;
          const px = p.x;
          const py = p.y;
          if (px >= e.x && px <= e.x + e.width && py >= e.y && py <= e.y + e.height) {
            // hit!
            e.hp -= 20;
            e.state = 'hurt';
            p.x = -9999; // mark for delete
            if (e.hp <= 0) {
              e.state = 'dead';
              this.spawnCoins(e.x + e.width / 2, e.y + e.height / 2, e.isBoss ? 20 : 3);
              const owner = this.players.get(p.ownerId);
              if (owner) owner.score += e.isBoss ? 100 : 10;
            }
          }
        });
      } else {
        // PvP: Collide with players
        this.players.forEach(tp => {
          if (tp.id === p.ownerId || tp.isDead || tp.shieldActive) return;
          const px = p.x;
          const py = p.y;
          if (px >= tp.x && px <= tp.x + tp.width && py >= tp.y && py <= tp.y + tp.height) {
            // hit!
            tp.hp -= 20;
            tp.animState = 'DAMAGE';
            tp.hitCooldown = 600;
            p.x = -9999; // delete
            if (tp.hp <= 0) {
              tp.isDead = true;
              tp.animState = 'DEATH';
            }
          }
        });
      }
    });

    // Check PvP Loot pick up
    if (this.mode === 'pvp') {
      this.loot.forEach(l => {
        if (l.pickedUp) return;
        this.players.forEach(p => {
          if (p.isDead) return;
          const dist = Math.hypot(p.x + p.width / 2 - l.x, p.y + p.height / 2 - l.y);
          if (dist < 60) {
            l.pickedUp = true;
            if (l.type === 'weapon') {
              this.spawnSpecialAttack(p, l.value as 'kamehameha' | 'rasengan');
            } else if (l.type === 'health') {
              p.hp = Math.min(p.maxHp, p.hp + (l.value as number));
            }
          }
        });
      });
    }
  }

  private checkEndConditions() {
    if (this.mode === 'coop') {
      // Co-op level finishes when all players are dead, or any active player interacts with the portal
      const allPlayersDead = Array.from(this.players.values()).every(p => p.isDead);
      if (allPlayersDead) {
        this.stop();
        return;
      }

      if (this.portal) {
        this.players.forEach(p => {
          if (p.isDead) return;
          const dist = Math.abs((p.x + p.width / 2) - this.portal!.x);
          if (dist < 80) {
            // Level cleared!
            this.saveProgress();
            this.stop();
          }
        });
      }
    } else {
      // PvP: finishes when only 1 player remains alive (if room size > 1)
      const alivePlayers = Array.from(this.players.values()).filter(p => !p.isDead);
      if (this.players.size > 1 && alivePlayers.length <= 1) {
        if (alivePlayers.length === 1) {
          this.winnerId = alivePlayers[0].id;
          this.saveWinnerCoins(this.winnerId);
        }
        this.stop();
      }
    }
  }

  private async saveProgress() {
    // Write completed levels & coins to DB for all logged in players
    for (const [id, player] of this.players.entries()) {
      if (id.startsWith('guest-')) continue; // skip guest
      try {
        const user = await prisma.user.findUnique({ where: { id } });
        if (user) {
          await prisma.user.update({
            where: { id },
            data: {
              coins: user.coins + player.coins,
              levelsCompleted: Math.max(user.levelsCompleted, this.level)
            }
          });
        }
      } catch (err) {
        console.error('Error saving coop stats to DB:', err);
      }
    }
  }

  private async saveWinnerCoins(winnerId: string) {
    if (winnerId.startsWith('guest-')) return;
    try {
      const user = await prisma.user.findUnique({ where: { id: winnerId } });
      if (user) {
        await prisma.user.update({
          where: { id: winnerId },
          data: {
            coins: user.coins + 50 // bonus for winning PVP match
          }
        });
      }
    } catch (err) {
      console.error('Error saving pvp winner stats to DB:', err);
    }
  }

  private getState(): GameState {
    const playersState: { [id: string]: PlayerState } = {};
    this.players.forEach((p, id) => {
      const pState: any = {
        id: p.id,
        username: p.username,
        characterType: p.characterType,
        x: p.x,
        y: p.y,
        vy: p.vy,
        hp: p.hp,
        maxHp: p.maxHp,
        coins: p.coins,
        isDashing: p.isDashing,
        facingLeft: p.facingLeft,
        animState: p.animState,
        frameX: p.frameX,
        shieldActive: p.shieldActive,
        isDead: p.isDead,
        score: p.score
      };
      // Pass through player projectiles for remote rendering
      if (p.slashProjectiles) pState.slashProjectiles = p.slashProjectiles;
      if (p.windProjectiles) pState.windProjectiles = p.windProjectiles;
      playersState[id] = pState;
    });

    return {
      players: playersState,
      enemies: this.enemies.map(e => ({
        id: e.id,
        type: e.type,
        x: e.x,
        y: e.y,
        hp: e.hp,
        maxHp: e.maxHp,
        facingLeft: e.facingLeft,
        state: e.state,
        isBoss: e.isBoss,
        projectiles: (e as any).projectiles,
        attackType: (e as any).attackType
      })),
      projectiles: this.projectiles,
      dropbox: this.dropbox,
      portal: this.portal,
      coins: this.coins,
      loot: this.loot,
      currentLevel: this.level,
      mode: this.mode,
      status: this.status,
      winnerId: this.winnerId,
      waveIndex: this.waveIndex,
      totalWaves: this.levelConfig.waves.length
    };
  }
}
