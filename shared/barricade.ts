// Barricade footprint math + placement validation. The client uses
// validatePlacement() to tint the ghost; the server re-runs the exact same
// checks before accepting a placement.

import {
  BAR_HX,
  BAR_HY,
  BAR_HZ,
  BAR_PLACE_RANGE,
  BAR_SPAWN_CLEARANCE,
  CAPSULE_RADIUS,
} from './constants';
import { ARENA_CLAMP, SPAWN_POINTS } from './map';
import {
  castSegment,
  groundSupportAt,
  type BoxCollider,
  type CapsuleTarget,
} from './collision';
import { dist2D, v3 } from './math';
import type { BarricadeState } from './types';

export function barricadeCollider(b: BarricadeState): BoxCollider {
  return {
    cx: b.x,
    cy: b.y + BAR_HY,
    cz: b.z,
    hx: BAR_HX,
    hy: BAR_HY,
    hz: BAR_HZ,
    yaw: b.yaw,
    kind: 'bar',
    id: b.id,
  };
}

interface Rect2 {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  yaw: number;
}

// 2D SAT for yaw-rotated rectangles (all our verticals are axis-aligned in Y).
function rectsOverlap(a: Rect2, b: Rect2): boolean {
  const corners = (r: Rect2): [number, number][] => {
    const c = Math.cos(r.yaw);
    const s = Math.sin(r.yaw);
    // local axes in world space (see collision.ts rotation convention)
    const ax = [r.hx * c, -r.hx * s];
    const az = [r.hz * s, r.hz * c];
    return [
      [r.cx + ax[0] + az[0], r.cz + ax[1] + az[1]],
      [r.cx - ax[0] + az[0], r.cz - ax[1] + az[1]],
      [r.cx - ax[0] - az[0], r.cz - ax[1] - az[1]],
      [r.cx + ax[0] - az[0], r.cz + ax[1] - az[1]],
    ];
  };
  const axesOf = (r: Rect2): [number, number][] => {
    const c = Math.cos(r.yaw);
    const s = Math.sin(r.yaw);
    return [
      [c, -s],
      [s, c],
    ];
  };
  const ca = corners(a);
  const cb = corners(b);
  for (const axis of [...axesOf(a), ...axesOf(b)]) {
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (const [x, z] of ca) {
      const p = x * axis[0] + z * axis[1];
      minA = Math.min(minA, p);
      maxA = Math.max(maxA, p);
    }
    for (const [x, z] of cb) {
      const p = x * axis[0] + z * axis[1];
      minB = Math.min(minB, p);
      maxB = Math.max(maxB, p);
    }
    if (maxA < minB || maxB < minA) return false;
  }
  return true;
}

export interface PlacementResult {
  ok: boolean;
  y: number; // resolved base height
  reason: string;
}

export function validatePlacement(
  x: number,
  z: number,
  yaw: number,
  placer: { x: number; y: number; z: number; eye: number },
  statics: BoxCollider[],
  bars: BoxCollider[],
  players: CapsuleTarget[],
  ignorePid: number,
): PlacementResult {
  const fail = (reason: string): PlacementResult => ({ ok: false, y: 0, reason });

  if (Math.abs(x) > ARENA_CLAMP - 1.5 || Math.abs(z) > ARENA_CLAMP - 1.5) {
    return fail('out of bounds');
  }
  if (dist2D(x, z, placer.x, placer.z) > BAR_PLACE_RANGE) return fail('too far');

  // resolved support height under both ends must match (no cliff-straddling)
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const ex = BAR_HX * 0.85;
  const e1x = x + ex * c, e1z = z - ex * s;
  const e2x = x - ex * c, e2z = z + ex * s;
  const probeFeet = placer.y + 0.6;
  const y0 = groundSupportAt(statics, x, z, probeFeet, 0.2);
  const y1 = groundSupportAt(statics, e1x, e1z, probeFeet, 0.2);
  const y2 = groundSupportAt(statics, e2x, e2z, probeFeet, 0.2);
  if (Math.abs(y1 - y0) > 0.2 || Math.abs(y2 - y0) > 0.2) return fail('uneven ground');
  if (Math.abs(y0 - placer.y) > 1.0) return fail('bad surface');

  const rect: Rect2 = { cx: x, cz: z, hx: BAR_HX, hz: BAR_HZ + 0.05, yaw };
  const top = y0 + BAR_HY * 2;
  const bottom = y0;

  for (const b of statics) {
    if (b.cy + b.hy <= bottom + 0.05 || b.cy - b.hy >= top) continue;
    if (rectsOverlap(rect, { cx: b.cx, cz: b.cz, hx: b.hx, hz: b.hz, yaw: b.yaw })) {
      return fail('blocked by structure');
    }
  }
  for (const b of bars) {
    if (rectsOverlap(rect, { cx: b.cx, cz: b.cz, hx: b.hx + 0.1, hz: b.hz + 0.1, yaw: b.yaw })) {
      return fail('blocked by barricade');
    }
  }
  for (const p of players) {
    if (p.pid === ignorePid) continue;
    if (p.y > top || p.y + p.h < bottom) continue;
    const pad = CAPSULE_RADIUS + 0.1;
    if (
      rectsOverlap(rect, { cx: p.x, cz: p.z, hx: pad, hz: pad, yaw: 0 })
    ) {
      return fail('blocked by player');
    }
  }
  for (const spn of SPAWN_POINTS) {
    if (dist2D(x, z, spn.x, spn.z) < BAR_SPAWN_CLEARANCE) return fail('too close to spawn');
  }

  // no placing through walls: eye -> barricade center must be clear
  const eye = v3(placer.x, placer.y + placer.eye, placer.z);
  const target = v3(x, y0 + BAR_HY, z);
  const hit = castSegment(eye, target, statics);
  if (hit && hit.t < 0.97) return fail('no line of sight');

  return { ok: true, y: y0, reason: '' };
}
