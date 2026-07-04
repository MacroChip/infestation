// GOLIATH: the summonable boss. Descends onto a clear patch of the yard
// like a rocket landing (fast entry, decelerating burn, gentle touchdown),
// pauses, then fires slow heat-seeking missiles at random players while
// walking toward whoever is closest. Touching it is instantly lethal.
// Bullets damage it; missiles can be shot down mid-flight. Both piggyback
// on the projectile system's capsule targets using reserved negative pids.

import {
  BOSS_DESCENT_MAX,
  BOSS_DESCENT_MIN,
  BOSS_DESCENT_RATE,
  BOSS_HEIGHT,
  BOSS_HP,
  BOSS_LAND_PAUSE_MS,
  BOSS_MISSILE_INTERVAL_MS,
  BOSS_PID,
  BOSS_RADIUS,
  BOSS_SPAWN_ALT,
  BOSS_TOUCH_DMG,
  BOSS_WALK_SPEED,
  CAPSULE_RADIUS,
  MISSILE_DMG,
  MISSILE_FUSE_DIST,
  MISSILE_HIT_RADIUS,
  MISSILE_LIFE_S,
  MISSILE_PID_BASE,
  MISSILE_SPEED,
  MISSILE_SPLASH,
  MISSILE_TURN_RATE,
  STAND_HEIGHT,
} from '../../shared/constants';
import { MAP_BOXES } from '../../shared/map';
import { castSegment, type BoxCollider, type CapsuleTarget } from '../../shared/collision';
import { addScaled, clamp, dist2D, norm, r2, r3, scale, sub, v3 } from '../../shared/math';
import type { BossPublic, GameEvent, MissilePublic } from '../../shared/types';

// What the boss needs to know about a player. Kept minimal so Game can
// hand over its own SPlayer entries without exposing sockets/inventory.
export interface BossTarget {
  pid: number;
  alive: boolean;
  x: number;
  y: number;
  z: number;
}

interface Missile {
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  target: number; // locked player pid
  age: number;
}

type Phase = 'idle' | 'descend' | 'landed' | 'hunt';

export class Boss {
  private phase: Phase = 'idle';
  private x = 0;
  private y = 0;
  private z = 0;
  private yaw = 0;
  private hp = BOSS_HP;
  private nextMissileAt = 0;
  private missiles = new Map<number, Missile>();
  private nextMissileId = 1;

  get active(): boolean {
    return this.phase !== 'idle';
  }

  // Summon if none is active. Returns false when one is already deployed.
  trySummon(events: GameEvent[]): boolean {
    if (this.active) return false;
    const spot = this.pickLandingSpot();
    this.x = spot.x;
    this.z = spot.z;
    this.y = BOSS_SPAWN_ALT;
    this.yaw = 0;
    this.hp = BOSS_HP;
    this.phase = 'descend';
    events.push({ t: 'bossin', x: r2(this.x), z: r2(this.z) });
    return true;
  }

  // Random open ground: reject spots whose footprint overlaps map geometry.
  private pickLandingSpot(): { x: number; z: number } {
    const clearance = BOSS_RADIUS + 1;
    for (let i = 0; i < 60; i++) {
      const x = (Math.random() * 2 - 1) * 55;
      const z = (Math.random() * 2 - 1) * 55;
      let ok = true;
      for (const b of MAP_BOXES) {
        const dx = Math.max(0, Math.abs(x - b.x) - b.sx / 2);
        const dz = Math.max(0, Math.abs(z - b.z) - b.sz / 2);
        if (Math.hypot(dx, dz) < clearance) {
          ok = false;
          break;
        }
      }
      if (ok) return { x, z };
    }
    return { x: 0, z: -32 }; // open lane north of the mill
  }

  step(
    dt: number,
    now: number,
    solids: BoxCollider[],
    players: BossTarget[],
    events: GameEvent[],
    damage: (pid: number, dmg: number) => void,
  ): void {
    if (this.phase === 'descend') {
      // rocket-landing profile: speed proportional to remaining altitude,
      // capped on entry, floored so it actually touches down
      const vy = clamp(this.y * BOSS_DESCENT_RATE, BOSS_DESCENT_MIN, BOSS_DESCENT_MAX);
      this.y -= vy * dt;
      if (this.y <= 0) {
        this.y = 0;
        this.phase = 'landed';
        this.nextMissileAt = now + BOSS_LAND_PAUSE_MS;
        events.push({ t: 'bossland', x: r2(this.x), z: r2(this.z) });
      }
    } else if (this.phase === 'landed') {
      if (now >= this.nextMissileAt) {
        this.phase = 'hunt';
        this.fireMissile(players, events);
        this.nextMissileAt = now + BOSS_MISSILE_INTERVAL_MS;
      }
    } else if (this.phase === 'hunt') {
      const closest = this.closestPlayer(players);
      if (closest) {
        const dx = closest.x - this.x;
        const dz = closest.z - this.z;
        const d = Math.hypot(dx, dz);
        this.yaw = Math.atan2(-dx, -dz);
        if (d > 0.1) {
          const step = Math.min(BOSS_WALK_SPEED * dt, d);
          this.x = clamp(this.x + (dx / d) * step, -70, 70);
          this.z = clamp(this.z + (dz / d) * step, -70, 70);
        }
      }
      if (now >= this.nextMissileAt) {
        this.fireMissile(players, events);
        this.nextMissileAt = now + BOSS_MISSILE_INTERVAL_MS;
      }
    }

    if (this.active) this.touchKill(players, damage);
    this.stepMissiles(dt, solids, players, events, damage);
  }

  private closestPlayer(players: BossTarget[]): BossTarget | null {
    let best: BossTarget | null = null;
    let bestD = Infinity;
    for (const p of players) {
      if (!p.alive) continue;
      const d = dist2D(p.x, p.z, this.x, this.z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // Anyone overlapping the body capsule dies - including being landed on.
  private touchKill(players: BossTarget[], damage: (pid: number, dmg: number) => void): void {
    for (const p of players) {
      if (!p.alive) continue;
      if (dist2D(p.x, p.z, this.x, this.z) > BOSS_RADIUS + CAPSULE_RADIUS) continue;
      if (p.y + STAND_HEIGHT < this.y || p.y > this.y + BOSS_HEIGHT) continue;
      damage(p.pid, BOSS_TOUCH_DMG);
    }
  }

  private fireMissile(players: BossTarget[], events: GameEvent[]): void {
    const alive = players.filter((p) => p.alive);
    if (alive.length === 0) return;
    const target = alive[Math.floor(Math.random() * alive.length)];
    const hor = norm(v3(target.x - this.x, 0, target.z - this.z));
    // launches upward with a lean toward the target, then pitches over
    const dir = norm(addScaled(v3(0, 1, 0), hor, 0.35));
    const ox = this.x + hor.x * (BOSS_RADIUS + 0.4);
    const oz = this.z + hor.z * (BOSS_RADIUS + 0.4);
    const m: Missile = {
      id: this.nextMissileId++,
      x: ox,
      y: this.y + BOSS_HEIGHT * 0.8,
      z: oz,
      vx: dir.x * MISSILE_SPEED,
      vy: dir.y * MISSILE_SPEED,
      vz: dir.z * MISSILE_SPEED,
      target: target.pid,
      age: 0,
    };
    this.missiles.set(m.id, m);
    events.push({ t: 'mfire', m: this.missilePublic(m), tgt: target.pid });
  }

  private stepMissiles(
    dt: number,
    solids: BoxCollider[],
    players: BossTarget[],
    events: GameEvent[],
    damage: (pid: number, dmg: number) => void,
  ): void {
    for (const m of this.missiles.values()) {
      m.age += dt;
      if (m.age >= MISSILE_LIFE_S) {
        this.explodeMissile(m, players, events, damage);
        continue;
      }

      // steer toward the locked target's chest, turn-rate limited
      const t = players.find((p) => p.pid === m.target && p.alive);
      if (t) {
        const chest = v3(t.x, t.y + STAND_HEIGHT * 0.6, t.z);
        const pos = v3(m.x, m.y, m.z);
        if (Math.hypot(chest.x - m.x, chest.y - m.y, chest.z - m.z) < MISSILE_FUSE_DIST) {
          this.explodeMissile(m, players, events, damage);
          continue;
        }
        const desired = norm(sub(chest, pos));
        const dir = norm(v3(m.vx, m.vy, m.vz));
        const ang = Math.acos(clamp(dir.x * desired.x + dir.y * desired.y + dir.z * desired.z, -1, 1));
        const maxTurn = MISSILE_TURN_RATE * dt;
        const nd =
          ang <= maxTurn
            ? desired
            : norm(addScaled(scale(dir, 1 - maxTurn / ang), desired, maxTurn / ang));
        m.vx = nd.x * MISSILE_SPEED;
        m.vy = nd.y * MISSILE_SPEED;
        m.vz = nd.z * MISSILE_SPEED;
      }

      const from = v3(m.x, m.y, m.z);
      const to = v3(m.x + m.vx * dt, m.y + m.vy * dt, m.z + m.vz * dt);
      const caps: CapsuleTarget[] = players
        .filter((p) => p.alive)
        .map((p) => ({ pid: p.pid, x: p.x, y: p.y, z: p.z, r: CAPSULE_RADIUS, h: STAND_HEIGHT }));
      const hit = castSegment(from, to, solids, caps);
      if (hit) {
        m.x = hit.x;
        m.y = hit.y;
        m.z = hit.z;
        this.explodeMissile(m, players, events, damage);
        continue;
      }
      m.x = to.x;
      m.y = to.y;
      m.z = to.z;
    }
  }

  private explodeMissile(
    m: Missile,
    players: BossTarget[],
    events: GameEvent[],
    damage: (pid: number, dmg: number) => void,
  ): void {
    this.missiles.delete(m.id);
    events.push({ t: 'mboom', id: m.id, x: r2(m.x), y: r2(m.y), z: r2(m.z) });
    for (const p of players) {
      if (!p.alive) continue;
      const chestY = p.y + STAND_HEIGHT * 0.6;
      if (Math.hypot(p.x - m.x, chestY - m.y, p.z - m.z) <= MISSILE_SPLASH) {
        damage(p.pid, MISSILE_DMG);
      }
    }
  }

  // Boss body + missiles as capsule targets so player bullets connect.
  bulletTargets(): CapsuleTarget[] {
    const out: CapsuleTarget[] = [];
    if (this.active) {
      out.push({ pid: BOSS_PID, x: this.x, y: this.y, z: this.z, r: BOSS_RADIUS, h: BOSS_HEIGHT });
    }
    for (const m of this.missiles.values()) {
      out.push({
        pid: MISSILE_PID_BASE - m.id,
        x: m.x,
        y: m.y - MISSILE_HIT_RADIUS,
        z: m.z,
        r: MISSILE_HIT_RADIUS,
        h: MISSILE_HIT_RADIUS * 2,
      });
    }
    return out;
  }

  // Route a bullet hit on a reserved pid. Returns true if it was ours.
  onBulletHit(
    pid: number,
    dmg: number,
    players: BossTarget[],
    events: GameEvent[],
    damage: (pid: number, dmg: number) => void,
  ): boolean {
    if (pid === BOSS_PID) {
      if (!this.active) return true;
      this.hp -= dmg;
      if (this.hp <= 0) {
        this.phase = 'idle';
        events.push({ t: 'bossdie', x: r2(this.x), z: r2(this.z) });
      }
      return true;
    }
    if (pid <= MISSILE_PID_BASE) {
      const m = this.missiles.get(MISSILE_PID_BASE - pid);
      if (m) this.explodeMissile(m, players, events, damage);
      return true;
    }
    return false;
  }

  publicState(): BossPublic | undefined {
    if (!this.active) return undefined;
    return {
      x: r2(this.x),
      y: r2(this.y),
      z: r2(this.z),
      yaw: r3(this.yaw),
      hp: Math.max(0, Math.round(this.hp)),
      ph: this.phase === 'descend' ? 0 : this.phase === 'landed' ? 1 : 2,
    };
  }

  missilesPublic(): MissilePublic[] {
    return [...this.missiles.values()].map((m) => this.missilePublic(m));
  }

  private missilePublic(m: Missile): MissilePublic {
    return {
      id: m.id,
      x: r2(m.x),
      y: r2(m.y),
      z: r2(m.z),
      vx: r2(m.vx),
      vy: r2(m.vy),
      vz: r2(m.vz),
    };
  }
}
