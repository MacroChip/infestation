// Minimal kinematic collision layer. Everything solid is a (possibly
// yaw-rotated) box; players are vertical capsules approximated as circles
// in XZ. Runs identically on client (prediction/visual projectiles) and
// server (authority), which is why this is hand-rolled instead of a
// physics engine.

import { STEP_UP } from './constants';
import type { V3 } from './math';

export interface BoxCollider {
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
  yaw: number; // 0 for all static map geometry; barricades rotate
  kind: 'wall' | 'bar';
  id: number; // barricade id when kind === 'bar', else 0
}

export interface CapsuleTarget {
  pid: number;
  x: number;
  y: number; // feet
  z: number;
  r: number;
  h: number;
}

export interface CastHit {
  t: number;
  x: number;
  y: number;
  z: number;
  kind: 'box' | 'cap' | 'ground';
  box?: BoxCollider;
  pid?: number;
}

// world -> box-local (rotate by -yaw around box center)
function toLocalXZ(box: BoxCollider, x: number, z: number): [number, number] {
  const dx = x - box.cx;
  const dz = z - box.cz;
  if (box.yaw === 0) return [dx, dz];
  const c = Math.cos(box.yaw);
  const s = Math.sin(box.yaw);
  return [dx * c - dz * s, dx * s + dz * c];
}

// Push a circle (x,z,r) out of a box footprint if the player's vertical
// span actually overlaps the box. Returns corrected [x, z] or null.
export function pushCircleOutOfBox(
  box: BoxCollider,
  x: number,
  z: number,
  r: number,
  feetY: number,
  height: number,
): [number, number] | null {
  const top = box.cy + box.hy;
  const bottom = box.cy - box.hy;
  if (top <= feetY + STEP_UP) return null; // low enough to step onto
  if (bottom >= feetY + height) return null; // entirely above us
  const [lx, lz] = toLocalXZ(box, x, z);
  const px = Math.max(-box.hx, Math.min(box.hx, lx));
  const pz = Math.max(-box.hz, Math.min(box.hz, lz));
  let dx = lx - px;
  let dz = lz - pz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return null;
  let outLx: number;
  let outLz: number;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    const push = (r - d) / d;
    outLx = lx + dx * push;
    outLz = lz + dz * push;
  } else {
    // center inside the box: exit along the axis of least penetration
    const exitX = box.hx + r - Math.abs(lx);
    const exitZ = box.hz + r - Math.abs(lz);
    if (exitX < exitZ) {
      outLx = (lx >= 0 ? 1 : -1) * (box.hx + r);
      outLz = lz;
    } else {
      outLx = lx;
      outLz = (lz >= 0 ? 1 : -1) * (box.hz + r);
    }
  }
  if (box.yaw === 0) return [box.cx + outLx, box.cz + outLz];
  const c = Math.cos(box.yaw);
  const s = Math.sin(box.yaw);
  return [box.cx + outLx * c + outLz * s, box.cz + -outLx * s + outLz * c];
}

// Highest surface at (x,z) that the feet could rest on, given current feet
// height (boxes with tops above feet+STEP_UP don't count as support).
export function groundSupportAt(
  boxes: BoxCollider[],
  x: number,
  z: number,
  feetY: number,
  r: number,
): number {
  let support = 0;
  const margin = r * 0.4;
  for (const b of boxes) {
    const top = b.cy + b.hy;
    if (top <= support || top > feetY + STEP_UP + 1e-4) continue;
    const [lx, lz] = toLocalXZ(b, x, z);
    if (Math.abs(lx) <= b.hx + margin && Math.abs(lz) <= b.hz + margin) support = top;
  }
  return support;
}

// Segment vs box (slab method in box-local space). Returns param t in [0,1].
export function segVsBox(from: V3, to: V3, box: BoxCollider): number | null {
  let fx: number, fz: number, tx: number, tz: number;
  if (box.yaw === 0) {
    fx = from.x - box.cx;
    fz = from.z - box.cz;
    tx = to.x - box.cx;
    tz = to.z - box.cz;
  } else {
    [fx, fz] = toLocalXZ(box, from.x, from.z);
    [tx, tz] = toLocalXZ(box, to.x, to.z);
  }
  const fy = from.y - box.cy;
  const ty = to.y - box.cy;
  const d = [tx - fx, ty - fy, tz - fz];
  const o = [fx, fy, fz];
  const h = [box.hx, box.hy, box.hz];
  let tmin = 0;
  let tmax = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (Math.abs(o[i]) > h[i]) return null;
      continue;
    }
    let t1 = (-h[i] - o[i]) / d[i];
    let t2 = (h[i] - o[i]) / d[i];
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
}

// Closest-approach test between the bullet segment and the capsule's core
// segment. Slightly approximate (reports closest-approach param rather than
// entry param) which is fine at our step sizes.
export function segVsCapsule(from: V3, to: V3, cap: CapsuleTarget): number | null {
  const ax = from.x, ay = from.y, az = from.z;
  const dx = to.x - ax, dy = to.y - ay, dz = to.z - az;
  const cy0 = cap.y + cap.r;
  const cy1 = cap.y + Math.max(cap.h - cap.r, cap.r + 0.01);
  const ex = 0, ey = cy1 - cy0, ez = 0;
  const rx = ax - cap.x, ry = ay - cy0, rz = az - cap.z;

  const a = dx * dx + dy * dy + dz * dz;
  const e = ey * ey;
  const f = dy * ey;
  const c = dx * rx + dy * ry + dz * rz;
  const g = ey * ry;

  let s: number, t: number;
  if (a <= 1e-9 && e <= 1e-9) {
    s = 0;
    t = 0;
  } else if (a <= 1e-9) {
    s = 0;
    t = Math.max(0, Math.min(1, g / e));
  } else if (e <= 1e-9) {
    t = 0;
    s = Math.max(0, Math.min(1, -c / a));
  } else {
    const denom = a * e - f * f;
    s = denom > 1e-9 ? Math.max(0, Math.min(1, (f * g - c * e) / denom)) : 0;
    t = (f * s + g) / e;
    if (t < 0) {
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else if (t > 1) {
      t = 1;
      s = Math.max(0, Math.min(1, (f - c) / a));
    }
  }
  const px = ax + dx * s - cap.x;
  const py = ay + dy * s - (cy0 + ey * t);
  const pz = az + dz * s - cap.z;
  if (px * px + py * py + pz * pz <= cap.r * cap.r) return s;
  return null;
}

// First hit along a segment against boxes, capsules and the ground plane.
export function castSegment(
  from: V3,
  to: V3,
  boxes: BoxCollider[],
  capsules?: CapsuleTarget[],
  ignorePid?: number,
): CastHit | null {
  let best: CastHit | null = null;
  for (const b of boxes) {
    const t = segVsBox(from, to, b);
    if (t !== null && (best === null || t < best.t)) {
      best = { t, x: 0, y: 0, z: 0, kind: 'box', box: b };
    }
  }
  if (capsules) {
    for (const c of capsules) {
      if (c.pid === ignorePid) continue;
      const t = segVsCapsule(from, to, c);
      if (t !== null && (best === null || t < best.t)) {
        best = { t, x: 0, y: 0, z: 0, kind: 'cap', pid: c.pid };
      }
    }
  }
  if (from.y > 0 && to.y <= 0) {
    const t = from.y / (from.y - to.y);
    if (best === null || t < best.t) best = { t, x: 0, y: 0, z: 0, kind: 'ground' };
  }
  if (best) {
    best.x = from.x + (to.x - from.x) * best.t;
    best.y = from.y + (to.y - from.y) * best.t;
    best.z = from.z + (to.z - from.z) * best.t;
  }
  return best;
}
