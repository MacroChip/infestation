// Shared kinematic movement step. The server runs this per input command;
// the client runs the exact same function for prediction and replays it
// during reconciliation, so any change here must ship to both at once.

import {
  ACCEL_AIR,
  ACCEL_GROUND,
  AIM_SPEED_MULT,
  CAPSULE_RADIUS,
  GRAVITY,
  JUMP_STAM_COST,
  JUMP_VY,
  MAX_INPUT_DT,
  SPRINT_DRAIN,
  SPRINT_MIN_STAM,
  SPRINT_SPEED,
  STAM_MAX,
  STAM_REGEN,
  STAM_REGEN_DELAY,
  STAND_HEIGHT,
  WALK_SPEED,
} from './constants';
import { ARENA_CLAMP } from './map';
import { groundSupportAt, pushCircleOutOfBox, type BoxCollider } from './collision';
import type { InputCmd } from './types';

export interface MoveState {
  x: number;
  y: number; // feet height
  z: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
  stamina: number;
  stamCd: number; // regen delay remaining
}

export function isSprinting(st: MoveState, cmd: InputCmd): boolean {
  return (
    cmd.sp === 1 &&
    cmd.aim !== 1 &&
    st.stamina > SPRINT_MIN_STAM &&
    (cmd.mx !== 0 || cmd.mz !== 0)
  );
}

export function stepMove(st: MoveState, cmd: InputCmd, solids: BoxCollider[]): void {
  const dt = Math.min(Math.max(cmd.dt, 0.001), MAX_INPUT_DT);
  const h = STAND_HEIGHT;
  const r = CAPSULE_RADIUS;

  // clamp move intent to a unit circle
  let mx = cmd.mx;
  let mz = cmd.mz;
  const ml = Math.hypot(mx, mz);
  if (ml > 1) {
    mx /= ml;
    mz /= ml;
  }
  const moving = ml > 0.01;

  const sprinting = isSprinting(st, cmd);
  let speed = sprinting ? SPRINT_SPEED : WALK_SPEED;
  if (cmd.aim === 1) speed *= AIM_SPEED_MULT;

  const accel = st.onGround ? ACCEL_GROUND : ACCEL_AIR;
  const k = 1 - Math.exp(-accel * dt);
  st.vx += (mx * speed - st.vx) * k;
  st.vz += (mz * speed - st.vz) * k;

  // stamina
  if (sprinting && moving) {
    st.stamina = Math.max(0, st.stamina - SPRINT_DRAIN * dt);
    st.stamCd = STAM_REGEN_DELAY;
  } else {
    st.stamCd = Math.max(0, st.stamCd - dt);
    if (st.stamCd <= 0) st.stamina = Math.min(STAM_MAX, st.stamina + STAM_REGEN * dt);
  }

  if (cmd.jp === 1 && st.onGround && st.stamina >= JUMP_STAM_COST) {
    st.vy = JUMP_VY;
    st.onGround = false;
    st.stamina -= JUMP_STAM_COST;
    st.stamCd = STAM_REGEN_DELAY;
  }

  // horizontal move + push-out (two passes handles corners)
  st.x += st.vx * dt;
  st.z += st.vz * dt;
  for (let pass = 0; pass < 2; pass++) {
    for (const b of solids) {
      const res = pushCircleOutOfBox(b, st.x, st.z, r, st.y, h);
      if (res) {
        st.x = res[0];
        st.z = res[1];
      }
    }
  }
  st.x = Math.max(-ARENA_CLAMP, Math.min(ARENA_CLAMP, st.x));
  st.z = Math.max(-ARENA_CLAMP, Math.min(ARENA_CLAMP, st.z));

  // vertical: gravity, landing, auto-step onto low geometry
  st.vy -= GRAVITY * dt;
  const ny = st.y + st.vy * dt;
  const support = groundSupportAt(solids, st.x, st.z, st.y, r);
  if (ny <= support + 1e-6) {
    st.y = support;
    st.vy = 0;
    st.onGround = true;
  } else {
    st.y = ny;
    st.onGround = false;
  }
}
