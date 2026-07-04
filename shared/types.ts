// Wire protocol + entity state shapes. JSON over WebSocket, short-ish keys.

import type { AmmoType } from './constants';

export type WeaponId = 'ar' | 'smg' | 'shotgun' | 'sniper';

export type LootKind = 'w' | 'a' | 'm' | 'b'; // weapon / ammo / medkit / barricade kit

export interface LootItem {
  id: number;
  k: LootKind;
  x: number;
  y: number;
  z: number;
  w?: WeaponId; // k === 'w'
  mag?: number; // rounds loaded in dropped/spawned weapon
  res?: number; // reserve ammo bundled with weapon
  at?: AmmoType; // k === 'a'
  n?: number; // ammo amount
  sx?: number; // optional client pop animation start x
  sy?: number; // optional client pop animation start y
  sz?: number; // optional client pop animation start z
}

export interface BarricadeState {
  id: number;
  x: number;
  y: number; // base height (sits on ground or on top of a box)
  z: number;
  yaw: number;
  hp: number;
}

// The summoned boss, broadcast in every snapshot while active.
export interface BossPublic {
  x: number;
  y: number; // feet; > 0 while descending
  z: number;
  yaw: number;
  hp: number;
  mhp: number; // max hp after player-count difficulty scaling
  ph: 0 | 1 | 2; // 0 descending, 1 landed (pre-fire pause), 2 hunting
}

// A boss missile in flight. Position+velocity each snapshot; clients
// integrate between snapshots for smooth motion.
export interface MissilePublic {
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface PlayerPublic {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pit: number;
  hp: number;
  alive: 0 | 1;
  aim: 0 | 1;
  w: WeaponId | 0; // 0 = unarmed
  pl: 0 | 1; // readying a barricade
  k: number;
  d: number;
  ping: number;
}

export interface SlotState {
  w: WeaponId;
  mag: number;
}

// Private, authoritative state for one client (sent every snapshot).
export interface YouState {
  ack: number; // last processed input seq
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  og: 0 | 1; // on ground
  st: number; // stamina
  stcd: number; // stamina regen delay remaining (s)
  hp: number;
  slots: [SlotState | null, SlotState | null];
  act: 0 | 1; // active slot
  res: Record<AmmoType, number>;
  meds: number;
  kits: number;
  rld: number; // reload finishes at (server ms), 0 = not reloading
  use: number; // medkit channel finishes at (server ms)
  dead: number; // respawn at (server ms), 0 = alive
  inv: number; // spawn invulnerability until (server ms)
}

export interface FireCmd {
  sid: number; // client shot id, also the spread seed
  yaw: number;
  pit: number;
}

export interface InputCmd {
  seq: number;
  dt: number;
  mx: number; // world-space move intent, normalized
  mz: number;
  yaw: number;
  pit: number;
  sp: 0 | 1; // sprint held
  jp: 0 | 1; // jump pressed this step
  aim: 0 | 1;
  pl?: 0 | 1; // readying a barricade (weapon stowed, firing disabled)
  fire?: FireCmd[];
  rld?: 1;
  swap?: 0 | 1; // switch to slot index
  use?: 1; // start medkit
  pick?: number; // loot item id (press-E pickup)
  place?: { x: number; z: number; yaw: number };
  hurt?: 1; // dev helper: damage yourself to test healing
  summon?: 1; // secret combo entered: call in the boss
}

export type ImpactKind = 'w' | 'b' | 'p' | 'g' | 'e'; // wall/barricade/player/ground/end-of-range

export type GameEvent =
  | {
      t: 'shot';
      pid: number;
      w: WeaponId;
      sid: number;
      spr: number; // final spread (rad) used by server; clients reproduce pellet dirs
      ox: number;
      oy: number;
      oz: number;
      yaw: number;
      pit: number;
      ids: number[]; // server projectile ids, pellet order matches pelletDirs()
    }
  | { t: 'imp'; id: number; x: number; y: number; z: number; k: ImpactKind }
  | { t: 'hit'; v: number; a: number; dmg: number }
  | { t: 'kill'; v: number; a: number; w: WeaponId | 0 }
  | { t: 'spawn'; pid: number; x: number; y: number; z: number }
  | { t: 'join'; pid: number; name: string; color: number }
  | { t: 'leave'; pid: number }
  | { t: 'ladd'; item: LootItem }
  | { t: 'lgone'; id: number; taker?: number }
  | { t: 'badd'; bar: BarricadeState }
  | { t: 'bhp'; id: number; hp: number }
  | { t: 'bgone'; id: number }
  | { t: 'note'; pid: number; text: string } // private toast, clients filter by pid
  | { t: 'bossin'; x: number; z: number } // summoned; descent begins above (x,z)
  | { t: 'bossland'; x: number; z: number }
  | { t: 'bossdie'; x: number; z: number }
  | { t: 'mfire'; m: MissilePublic; tgt: number } // missile launched, locked on tgt
  | { t: 'mboom'; id: number; x: number; y: number; z: number };

export interface RosterEntry {
  pid: number;
  name: string;
  color: number;
}

export type ClientMsg =
  | { t: 'hello'; v: number; name: string }
  | { t: 'in'; cmds: InputCmd[] }
  | { t: 'ping'; t0: number; rtt: number };

export type ServerMsg =
  | {
      t: 'welcome';
      pid: number;
      time: number;
      tickRate: number;
      roster: RosterEntry[];
      loot: LootItem[];
      bars: BarricadeState[];
      scores: { pid: number; k: number; d: number }[];
    }
  | {
      t: 'snap';
      tick: number;
      time: number; // server ms clock
      tps: number; // measured tick rate
      players: PlayerPublic[];
      you: YouState;
      boss?: BossPublic;
      ms?: MissilePublic[];
      ev?: GameEvent[];
    }
  | { t: 'pong'; t0: number; st: number }
  | { t: 'reject'; reason: string };
