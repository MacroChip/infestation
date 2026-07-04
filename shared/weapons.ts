// The four firearms. All projectile-based; numbers are gameplay-tuned,
// not realistic. Names/branding are original.

import type { AmmoType } from './constants';
import type { WeaponId } from './types';
import { dirFromYawPitch, mulberry32, type V3 } from './math';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  ammo: AmmoType;
  dmg: number; // per projectile
  pellets: number;
  interval: number; // seconds between shots
  auto: boolean;
  velocity: number; // units/sec
  gravity: number; // projectile drop
  life: number; // max flight seconds (range limiter)
  mag: number;
  reload: number; // seconds
  spreadHip: number; // radians
  spreadAim: number;
  kick: number; // client-side camera recoil per shot
  barricadeMult: number;
  suppressed: boolean;
  zoom: boolean; // sniper-style aim zoom
  pickupReserve: number; // reserve ammo bundled with a fresh map spawn
  tracer: number; // color
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  ar: {
    id: 'ar',
    name: 'KV-7 Harrier',
    ammo: 'rifle',
    dmg: 21,
    pellets: 1,
    interval: 0.1,
    auto: true,
    velocity: 110,
    gravity: 5,
    life: 1.4,
    mag: 30,
    reload: 2.1,
    spreadHip: 0.017,
    spreadAim: 0.005,
    kick: 0.0045,
    barricadeMult: 1,
    suppressed: false,
    zoom: false,
    pickupReserve: 30,
    tracer: 0xffd27a,
  },
  smg: {
    id: 'smg',
    name: 'Vesper 9S',
    ammo: 'smg',
    dmg: 13,
    pellets: 1,
    interval: 0.075,
    auto: true,
    velocity: 90,
    gravity: 6,
    life: 1.1,
    mag: 32,
    reload: 1.8,
    spreadHip: 0.021,
    spreadAim: 0.009,
    kick: 0.003,
    barricadeMult: 0.8,
    suppressed: true,
    zoom: false,
    pickupReserve: 40,
    tracer: 0x9aa4c4,
  },
  shotgun: {
    id: 'shotgun',
    name: 'Drummel D8 Auto',
    ammo: 'shell',
    dmg: 9,
    pellets: 8,
    interval: 0.55,
    auto: true,
    velocity: 70,
    gravity: 9,
    life: 0.55,
    mag: 6,
    reload: 2.6,
    spreadHip: 0.055,
    spreadAim: 0.045,
    kick: 0.024,
    barricadeMult: 1.2,
    suppressed: false,
    zoom: false,
    pickupReserve: 8,
    tracer: 0xffb35a,
  },
  sniper: {
    id: 'sniper',
    name: 'Meridian LR',
    ammo: 'long',
    dmg: 85,
    pellets: 1,
    interval: 1.5,
    auto: false,
    velocity: 220,
    gravity: 2,
    life: 1.3,
    mag: 5,
    reload: 2.8,
    spreadHip: 0.035,
    spreadAim: 0.0008,
    kick: 0.016,
    barricadeMult: 1.6,
    suppressed: false,
    zoom: true,
    pickupReserve: 5,
    tracer: 0xaef2ff,
  },
  minigun: {
    id: 'minigun',
    name: 'Goliath Minigun',
    ammo: 'rifle',
    dmg: 17,
    pellets: 1,
    interval: 0.04,
    auto: true,
    velocity: 125,
    gravity: 4,
    life: 1.35,
    mag: 999,
    reload: 99,
    spreadHip: 0.025,
    spreadAim: 0.018,
    kick: 0.015,
    barricadeMult: 1.4,
    suppressed: false,
    zoom: false,
    pickupReserve: 0,
    tracer: 0xff7a2e,
  },
};

export const WEAPON_IDS: WeaponId[] = ['ar', 'smg', 'shotgun', 'sniper'];

const WEAPON_INDEX: Record<WeaponId, number> = { ar: 0, smg: 1, shotgun: 2, sniper: 3, minigun: 4 };

// Final spread in radians. Client predicts with the same inputs the server
// uses, and the server echoes the value in the 'shot' event so remote
// clients reproduce identical pellet directions.
export function computeSpread(
  w: WeaponDef,
  aiming: boolean,
  horizSpeed: number,
  onGround: boolean,
): number {
  const base = aiming ? w.spreadAim : w.spreadHip;
  let mult = 1 + Math.min(horizSpeed / 7.8, 1) * 1.4;
  if (!onGround) mult *= 2.2;
  return base * mult;
}

// Deterministic pellet directions from the shot id. Both sides call this
// with identical (weapon, yaw, pit, sid, spread) and get identical results.
export function pelletDirs(
  w: WeaponDef,
  yaw: number,
  pit: number,
  sid: number,
  spread: number,
): V3[] {
  const rng = mulberry32((Math.imul(sid, 1103515245) ^ (WEAPON_INDEX[w.id] * 7919)) >>> 0);
  const dirs: V3[] = [];
  for (let i = 0; i < w.pellets; i++) {
    // sum of two uniforms ~ triangular: denser center, softer edges
    const offYaw = (rng() + rng() - 1) * spread;
    const offPit = (rng() + rng() - 1) * spread;
    dirs.push(dirFromYawPitch(yaw + offYaw, pit + offPit));
  }
  return dirs;
}
