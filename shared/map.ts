// "MILLYARD" - a 150x150 abandoned industrial yard. Entirely original
// layout: central mill shell, container lanes NW, silo cluster NE, shed
// row SW, rail spur SE, scatter cover on the connecting lanes.
// All geometry is boxes resting on flat ground (y=0).

import type { BoxCollider } from './collision';

export interface MapBox {
  x: number;
  y: number; // center height
  z: number;
  sx: number;
  sy: number;
  sz: number;
  color: number;
}

export interface SpawnPoint {
  x: number;
  z: number;
  yaw: number;
}

export type LootTable = 'w' | 'wl' | 'a' | 'm' | 'b';
// w: any weapon | wl: long guns (mill premium) | a: ammo | m: medkit | b: barricade kit

export interface LootSpawnDef {
  id: number;
  x: number;
  z: number;
  table: LootTable;
}

const C = {
  perimeter: 0x8f8a80,
  mill: 0xb0a493,
  concrete: 0xa09a8e,
  lowCover: 0x857f72,
  wood: 0x8a6f4d,
  rustRed: 0x7d4a3a,
  teal: 0x4a6b6a,
  mustard: 0x8a7a3a,
  silo: 0x9aa0a4,
  boxcarA: 0x5a4a52,
  boxcarB: 0x624a44,
};

function B(x: number, z: number, sx: number, sy: number, sz: number, color: number, y?: number): MapBox {
  return { x, y: y ?? sy / 2, z, sx, sy, sz, color };
}

export const ARENA_HALF = 75;
export const ARENA_CLAMP = 72.5;

export const MAP_BOXES: MapBox[] = [
  // perimeter
  B(0, -74, 150, 5, 2, C.perimeter),
  B(0, 74, 150, 5, 2, C.perimeter),
  B(-74, 0, 2, 5, 150, C.perimeter),
  B(74, 0, 2, 5, 150, C.perimeter),

  // --- the mill (center) ---
  B(-8, -10, 10, 4.2, 0.9, C.mill), // N wall, gap x[-3..3]
  B(8, -10, 10, 4.2, 0.9, C.mill),
  B(-10, 10, 6, 4.2, 0.9, C.mill), // S wall, gap x[-7..-1]
  B(6, 10, 14, 4.2, 0.9, C.mill),
  B(-13, -6.25, 0.9, 4.2, 6.6, C.mill), // W wall, gap z[-3..3]
  B(-13, 6.25, 0.9, 4.2, 6.6, C.mill),
  B(13, -8, 0.9, 4.2, 4, C.mill), // E wall ends
  B(13, 8, 0.9, 4.2, 4, C.mill),
  B(13, 0, 0.9, 1.15, 12, C.mill), // E firing-slit sill
  B(13, 0, 0.9, 2.15, 12, C.mill, 3.125), // E slit header (gap 1.15..2.05)
  B(-5, 0, 1.2, 4.2, 1.2, C.concrete), // pillars
  B(5, 0, 1.2, 4.2, 1.2, C.concrete),
  B(0, 0, 2.4, 0.25, 2.4, C.lowCover), // loot dais (walkable step)

  // --- NW container lanes ---
  B(-44, -34, 12, 2.6, 2.4, C.rustRed),
  B(-44, -40, 12, 2.6, 2.4, C.teal),
  B(-44, -46, 12, 2.6, 2.4, C.mustard),
  B(-36.5, -43, 2, 1.0, 2, C.wood), // climb: crate -> stack -> container roof
  B(-39, -43, 2, 1.8, 2, C.wood),
  B(-51, -37, 1.6, 1.0, 1.6, C.wood),

  // --- NE silo cluster ---
  B(38, -48, 5.5, 9, 5.5, C.silo),
  B(50, -48, 5.5, 9, 5.5, C.silo),
  B(44, -37, 5.5, 9, 5.5, C.silo),
  B(44, -48, 6.5, 1.1, 1.2, C.lowCover), // pipe runs (shoot-over cover)
  B(41, -42.5, 1.2, 1.1, 5.5, C.lowCover),
  B(47, -42.5, 1.2, 1.1, 5.5, C.lowCover),

  // --- SW shed row ---
  B(-51.7, 34, 0.6, 3, 7, C.concrete), // shed A (opens east)
  B(-48, 30.8, 8, 3, 0.6, C.concrete),
  B(-48, 37.2, 8, 3, 0.6, C.concrete),
  B(-38, 47.7, 7, 3, 0.6, C.concrete), // shed B (opens north)
  B(-41.2, 44, 0.6, 3, 8, C.concrete),
  B(-34.8, 44, 0.6, 3, 8, C.concrete),
  B(-55.4, 50, 0.6, 3, 6, C.concrete), // shed C (opens east)
  B(-52, 47.2, 7, 3, 0.6, C.concrete),
  B(-52, 52.8, 7, 3, 0.6, C.concrete),
  B(-42, 36, 1.6, 1.2, 1.6, C.wood),
  B(-45, 42, 4, 1.1, 0.5, C.lowCover),

  // --- SE rail spur ---
  B(44, 38, 24, 1.1, 1.2, C.lowCover), // platform edges
  B(44, 50, 24, 1.1, 1.2, C.lowCover),
  B(37, 44, 9, 3.1, 2.7, C.boxcarA), // boxcars with a gap chokepoint between
  B(53, 44, 9, 3.1, 2.7, C.boxcarB),
  B(45, 44, 1.6, 1.0, 1.6, C.wood),

  // --- lane scatter cover ---
  B(0, -32, 4.5, 1.1, 0.6, C.lowCover),
  B(-24, 0, 0.6, 1.1, 4.5, C.lowCover),
  B(24, 6, 0.6, 1.1, 4.5, C.lowCover),
  B(6, 30, 4.5, 1.1, 0.6, C.lowCover),
  B(-16, -18, 1.8, 1.3, 1.8, C.wood),
  B(18, -14, 1.8, 1.0, 1.8, C.wood),
  B(-14, 20, 1.8, 1.4, 1.8, C.wood),
  B(16, 22, 1.8, 1.1, 1.8, C.wood),
  B(30, -26, 1.8, 1.2, 1.8, C.wood),
  B(-30, 24, 1.8, 1.0, 1.8, C.wood),
  B(-58, -12, 0.7, 2.2, 8, C.concrete),
  B(58, 14, 0.7, 2.2, 8, C.concrete),
  B(-12, 58, 8, 2.2, 0.7, C.concrete),
  B(14, -58, 8, 2.2, 0.7, C.concrete),
];

const sp = (x: number, z: number): SpawnPoint => ({ x, z, yaw: Math.atan2(x, z) });

export const SPAWN_POINTS: SpawnPoint[] = [
  sp(-64, -64),
  sp(64, -64),
  sp(-64, 64),
  sp(64, 64),
  sp(0, -66),
  sp(0, 66),
  sp(-66, 0),
  sp(66, 0),
  sp(32, 66),
  sp(-32, -66),
];

let lootId = 0;
const L = (x: number, z: number, table: LootTable): LootSpawnDef => ({ id: lootId++, x, z, table });

export const LOOT_SPAWNS: LootSpawnDef[] = [
  // guaranteed weapon near every spawn: short time-to-gun
  L(-58, -58, 'w'), L(58, -58, 'w'), L(-58, 58, 'w'), L(58, 58, 'w'),
  L(0, -58, 'w'), L(0, 58, 'w'), L(-58, 0, 'w'), L(58, 0, 'w'),
  L(28, 58, 'w'), L(-28, -58, 'w'),
  // mill premium
  L(-0.7, 0, 'wl'), L(0.7, 0.6, 'wl'),
  L(-10, -7, 'a'), L(10, 7, 'a'), L(-10, 7, 'm'), L(10, -7, 'b'),
  // NW
  L(-44, -37, 'a'), L(-44, -43, 'a'), L(-36, -34, 'm'), L(-51, -46, 'b'),
  // NE
  L(44, -45, 'a'), L(44, -43, 'a'), L(50, -42, 'm'), L(38, -52, 'b'),
  // SW
  L(-48, 34, 'a'), L(-38, 44, 'a'), L(-52, 50, 'm'), L(-44, 39, 'b'),
  // SE
  L(40, 44, 'a'), L(48, 44, 'a'), L(44, 36, 'm'), L(52, 48, 'b'),
  // mid-lane
  L(-16, -16, 'w'), L(16, 20, 'w'), L(0, -30, 'm'), L(0, 32, 'a'),
  L(-26, 2, 'b'), L(26, 8, 'm'),
];

export function buildStaticColliders(): BoxCollider[] {
  return MAP_BOXES.map((b) => ({
    cx: b.x,
    cy: b.y,
    cz: b.z,
    hx: b.sx / 2,
    hy: b.sy / 2,
    hz: b.sz / 2,
    yaw: 0,
    kind: 'wall' as const,
    id: 0,
  }));
}
