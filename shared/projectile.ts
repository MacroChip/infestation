// Shared projectile integration. Server steps these authoritatively for
// damage; the client steps visual copies for tracers so predicted and
// remote fire looks identical to the authoritative sim.

import { castSegment, type BoxCollider, type CapsuleTarget, type CastHit } from './collision';
import { WEAPONS } from './weapons';
import type { WeaponId } from './types';
import { v3, type V3 } from './math';

export interface ProjectileState {
  id: number;
  owner: number;
  w: WeaponId;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number; // seconds
}

export function makeProjectile(
  id: number,
  owner: number,
  w: WeaponId,
  origin: V3,
  dir: V3,
): ProjectileState {
  const def = WEAPONS[w];
  return {
    id,
    owner,
    w,
    x: origin.x,
    y: origin.y,
    z: origin.z,
    vx: dir.x * def.velocity,
    vy: dir.y * def.velocity,
    vz: dir.z * def.velocity,
    age: 0,
  };
}

export interface ProjectileStepResult {
  expired: boolean; // exceeded weapon range/lifetime
  hit: CastHit | null;
}

export function stepProjectile(
  p: ProjectileState,
  dt: number,
  solids: BoxCollider[],
  capsules?: CapsuleTarget[],
): ProjectileStepResult {
  const def = WEAPONS[p.w];
  p.vy -= def.gravity * dt;
  const from = v3(p.x, p.y, p.z);
  const to = v3(p.x + p.vx * dt, p.y + p.vy * dt, p.z + p.vz * dt);
  const hit = castSegment(from, to, solids, capsules, p.owner);
  if (hit) {
    p.x = hit.x;
    p.y = hit.y;
    p.z = hit.z;
    return { expired: false, hit };
  }
  p.x = to.x;
  p.y = to.y;
  p.z = to.z;
  p.age += dt;
  return { expired: p.age >= def.life, hit: null };
}
