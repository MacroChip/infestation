// Tuning constants shared by client prediction and server authority.
// Keep client + server in lockstep: changing these requires restarting both.

export const PROTOCOL_VERSION = 3;
export const MAX_PLAYERS = 16;

// --- timing ---
export const TICK_RATE = 30; // server simulation + snapshot rate (hz)
export const TICK_DT = 1 / TICK_RATE;
export const CLIENT_STEP = 1 / 60; // client fixed prediction step
export const INPUT_BATCH = 2; // inputs per network packet (60hz steps -> 30 pps)
export const INTERP_DELAY_MS = 120; // remote entity render delay
export const PING_INTERVAL_MS = 2000;

// --- movement ---
export const WALK_SPEED = 5.2;
export const SPRINT_SPEED = 7.8;
export const AIM_SPEED_MULT = 0.55;
export const ACCEL_GROUND = 12; // exponential approach rate
export const ACCEL_AIR = 3.5;
export const GRAVITY = 22;
export const JUMP_VY = 7.4;
export const STEP_UP = 0.35; // auto-step height onto low geometry
export const CAPSULE_RADIUS = 0.42;
export const STAND_HEIGHT = 1.8;
export const EYE_STAND = 1.62;
export const MAX_INPUT_DT = 0.05;

// --- stamina ---
export const STAM_MAX = 500;
export const SPRINT_DRAIN = 22; // per second while sprint-moving
export const JUMP_STAM_COST = 12;
export const STAM_REGEN = 18; // per second
export const STAM_REGEN_DELAY = 0.9; // seconds after last drain
export const SPRINT_MIN_STAM = 2;

// --- health / combat flow ---
export const HP_MAX = 100;
export const RESPAWN_MS = 3000;
export const SPAWN_INVULN_MS = 1500; // broken early by firing
export const MED_HEAL = 60;
export const MED_USE_MS = 1600; // instant heal cooldown duration
export const SWAP_FIRE_LOCKOUT_MS = 350; // fire delay after a weapon swap / pickup
export const MAX_MEDS = 3;
export const MAX_KITS = 3; // barricade kits
export const DEV_HURT_DMG = 30; // self-damage per press of the dev hurt key (H)

// --- loot ---
export const PICKUP_RADIUS = 1.2; // auto pickup (ammo/med/kit)
export const WEAPON_PICKUP_RADIUS = 2.2; // press-E pickup
export const DROP_EXPIRE_MS = 60_000;
export const LOOT_RESPAWN_MIN_MS = 22_000;
export const LOOT_RESPAWN_MAX_MS = 30_000;

// --- barricades ---
export const BAR_HX = 0.525; // half extents: 1.25x player width (CAPSULE_RADIUS * 2)
export const BAR_HY = 0.99; // half height: 1.1x standing character height
export const BAR_HZ = 0.15;
export const BAR_HP = 260;
export const BAR_PLACE_RANGE = 4.2;
export const BAR_PLACE_DISTANCE = 2.0; // default placement offset in front of the player (meters)
export const BAR_PLACE_COOLDOWN_MS = 900;
export const BAR_SPAWN_CLEARANCE = 7; // min distance to spawn points
export const BAR_MAX_COUNT = 48;

// --- boss ("GOLIATH", summoned by a secret input) ---
export const BOSS_PID = -1; // attacker id in hit/kill events; never a real player
export const MISSILE_PID_BASE = -1000; // missile capsule pids: MISSILE_PID_BASE - missileId
export const BOSS_HP = 2500;
export const BOSS_RADIUS = 2.2; // body capsule radius (touch = death)
export const BOSS_HEIGHT = 9;
export const BOSS_SPAWN_ALT = 130; // descent starts this high
export const BOSS_DESCENT_RATE = 0.35; // vertical speed = y * rate (suicide-burn profile)
export const BOSS_DESCENT_MAX = 24; // entry speed cap
export const BOSS_DESCENT_MIN = 3; // touchdown speed floor
export const BOSS_WALK_SPEED = 3.2; // slower than a walking player
export const BOSS_LAND_PAUSE_MS = 2000; // stands still after touchdown, then opens fire
export const BOSS_MISSILE_INTERVAL_MS = 8000; // follow-up launches after the first
export const BOSS_TOUCH_DMG = 9999;

// --- boss missile (slow, heat-seeking, can be shot down) ---
export const MISSILE_SPEED = 10;
export const MISSILE_TURN_RATE = 2.0; // rad/s steering limit
export const MISSILE_DMG = 70;
export const MISSILE_SPLASH = 3.2; // damage radius around the detonation
export const MISSILE_FUSE_DIST = 1.1; // proximity fuse vs the locked target
export const MISSILE_LIFE_S = 25;
export const MISSILE_HIT_RADIUS = 0.5; // capsule radius for shooting it down

// --- ammo ---
export type AmmoType = 'rifle' | 'smg' | 'shell' | 'long';
export const AMMO_TYPES: AmmoType[] = ['rifle', 'smg', 'shell', 'long'];
export const AMMO_CAP: Record<AmmoType, number> = {
  rifle: 120,
  smg: 160,
  shell: 32,
  long: 25,
};
export const AMMO_PICKUP_AMOUNT: Record<AmmoType, number> = {
  rifle: 30,
  smg: 40,
  shell: 8,
  long: 5,
};

export const PLAYER_COLORS: number[] = [
  0xe8722a, 0x4fa3d1, 0x7bc95f, 0xd14f8e, 0xe8c84a, 0x9a6fd9, 0x4fd1b8, 0xd15b4f,
  0x8fa3b8, 0xb8d14f, 0x4f6fd1, 0xd1a04f, 0x6fd94f, 0xd14fd1, 0x4fd16f, 0xb84fd1,
];
