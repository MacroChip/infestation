// Small vector/angle/random toolkit shared by client and server.

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export const TAU = Math.PI * 2;

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const clone = (a: V3): V3 => ({ x: a.x, y: a.y, z: a.z });
export const set = (out: V3, x: number, y: number, z: number): V3 => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};
export const add = (a: V3, b: V3): V3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: V3, s: number): V3 => v3(a.x * s, a.y * s, a.z * s);
export const addScaled = (a: V3, b: V3, s: number): V3 =>
  v3(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
export const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const len2 = (a: V3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const len = (a: V3): number => Math.sqrt(len2(a));
export const dist2 = (a: V3, b: V3): number => len2(sub(a, b));
export const dist = (a: V3, b: V3): number => Math.sqrt(dist2(a, b));
export const dist2D = (ax: number, az: number, bx: number, bz: number): number =>
  Math.hypot(ax - bx, az - bz);

export function norm(a: V3): V3 {
  const l = len(a);
  return l > 1e-9 ? scale(a, 1 / l) : v3(0, 0, -1);
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

// Convention: yaw 0 faces -Z, yaw rotates around +Y; positive pitch looks up.
export function dirFromYawPitch(yaw: number, pitch: number): V3 {
  const cp = Math.cos(pitch);
  return v3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

// Deterministic PRNG so client-predicted spread matches server exactly.
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export const r2 = (v: number): number => Math.round(v * 100) / 100;
export const r3 = (v: number): number => Math.round(v * 1000) / 1000;
