// GOLIATH's client view: a procedural low-poly titan (boxes, like
// everything else here), a thruster flame while it descends, and the
// missiles it fires. All state is server-authoritative; this file only
// renders the latest snapshot with a little smoothing.

import * as THREE from 'three';
import {
  BOSS_HEIGHT,
  BOSS_HP,
  BOSS_PID,
  BOSS_RADIUS,
  MISSILE_HIT_RADIUS,
  MISSILE_PID_BASE,
} from '../../shared/constants';
import type { CapsuleTarget } from '../../shared/collision';
import { lerp, lerpAngle } from '../../shared/math';
import type { BossPublic, MissilePublic } from '../../shared/types';
import type { Effects } from './effects';

interface MissileView {
  group: THREE.Group;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  smokeAcc: number;
}

function bossNameSprite(): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 56;
  const g = c.getContext('2d')!;
  g.font = 'bold 30px monospace';
  g.textAlign = 'center';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,0.8)';
  g.strokeText('GOLIATH', 128, 38);
  g.fillStyle = '#ff5b4a';
  g.fillText('GOLIATH', 128, 38);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true }));
  s.scale.set(6.4, 1.4, 1);
  return s;
}

function buildMissileMesh(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.2, 0.95),
    new THREE.MeshLambertMaterial({ color: 0x3a3f45 }),
  );
  g.add(body);
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.14, 0.4, 8),
    new THREE.MeshLambertMaterial({ color: 0xb03028 }),
  );
  nose.rotation.x = Math.PI / 2; // apex toward +Z (lookAt points +Z along velocity)
  nose.position.z = 0.65;
  g.add(nose);
  const finGeo = new THREE.BoxGeometry(0.55, 0.05, 0.22);
  const finMat = new THREE.MeshLambertMaterial({ color: 0x24282e });
  const finA = new THREE.Mesh(finGeo, finMat);
  finA.position.z = -0.38;
  const finB = finA.clone();
  finB.rotation.z = Math.PI / 2;
  g.add(finA, finB);
  const flame = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  flame.position.z = -0.62;
  g.add(flame);
  return g;
}

export class BossView {
  private group = new THREE.Group();
  private thruster: THREE.Mesh;
  private thrusterLight: THREE.PointLight;
  state: BossPublic | null = null;
  private missiles = new Map<number, MissileView>();
  private hasPose = false;

  constructor(private scene: THREE.Scene) {
    const hull = new THREE.MeshLambertMaterial({ color: 0x3a3f45 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x24282e });
    const add = (sx: number, sy: number, sz: number, x: number, y: number, z: number, mat = hull): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      this.group.add(m);
      return m;
    };
    // legs / hips / torso / shoulders / head - a ~9m walking artillery piece
    add(0.9, 3.6, 1.2, -1.15, 1.8, 0, dark);
    add(0.9, 3.6, 1.2, 1.15, 1.8, 0, dark);
    add(3.5, 1.0, 1.9, 0, 3.9, 0);
    add(3.9, 2.9, 2.4, 0, 5.9, 0);
    add(1.3, 1.5, 2.1, -2.55, 6.7, 0, dark); // shoulder pods
    add(1.3, 1.5, 2.1, 2.55, 6.7, 0, dark);
    add(0.3, 0.3, 1.4, 2.55, 7.55, -0.4); // launch tubes on the right pod
    add(0.3, 0.3, 1.4, 2.15, 7.55, -0.4);
    add(1.3, 1.0, 1.3, 0, 7.9, 0);
    const eye = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.18, 0.1),
      new THREE.MeshBasicMaterial({ color: 0xff3b30 }),
    );
    eye.position.set(0, 7.95, -0.71);
    this.group.add(eye);

    const name = bossNameSprite();
    name.position.y = BOSS_HEIGHT + 1.3;
    this.group.add(name);

    this.thruster = new THREE.Mesh(
      new THREE.ConeGeometry(1.15, 3.4, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffa040,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.thruster.rotation.x = Math.PI; // apex down: landing burn
    this.thruster.position.y = 1.4;
    this.group.add(this.thruster);
    this.thrusterLight = new THREE.PointLight(0xff9040, 2.4, 36);
    this.thrusterLight.position.y = 1.2;
    this.group.add(this.thrusterLight);

    this.group.visible = false;
    scene.add(this.group);
  }

  get hpFrac(): number | null {
    return this.state ? this.state.hp / BOSS_HP : null;
  }

  setFromSnap(boss: BossPublic | undefined, ms: MissilePublic[] | undefined): void {
    if (!boss) this.hasPose = false;
    this.state = boss ?? null;

    const seen = new Set<number>();
    for (const m of ms ?? []) {
      seen.add(m.id);
      const v = this.missiles.get(m.id);
      if (!v) {
        this.addMissile(m);
      } else {
        // soft-correct toward the authoritative position, adopt velocity
        v.x = lerp(v.x, m.x, 0.35);
        v.y = lerp(v.y, m.y, 0.35);
        v.z = lerp(v.z, m.z, 0.35);
        v.vx = m.vx;
        v.vy = m.vy;
        v.vz = m.vz;
      }
    }
    for (const id of this.missiles.keys()) {
      if (!seen.has(id)) this.removeMissile(id); // mboom fx handled by its event
    }
  }

  addMissile(m: MissilePublic): void {
    if (this.missiles.has(m.id)) return;
    const group = buildMissileMesh();
    group.position.set(m.x, m.y, m.z);
    this.scene.add(group);
    this.missiles.set(m.id, {
      group,
      x: m.x, y: m.y, z: m.z,
      vx: m.vx, vy: m.vy, vz: m.vz,
      smokeAcc: 0,
    });
  }

  removeMissile(id: number): void {
    const v = this.missiles.get(id);
    if (v) {
      this.scene.remove(v.group);
      this.missiles.delete(id);
    }
  }

  update(dt: number, effects: Effects): void {
    const s = this.state;
    if (!s) {
      this.group.visible = false;
    } else {
      if (!this.hasPose) {
        this.group.position.set(s.x, s.y, s.z);
        this.group.rotation.y = s.yaw;
        this.hasPose = true;
      } else {
        // approach the latest snapshot; fast enough to track the descent
        const k = 1 - Math.exp(-14 * dt);
        this.group.position.x += (s.x - this.group.position.x) * k;
        this.group.position.y += (s.y - this.group.position.y) * k;
        this.group.position.z += (s.z - this.group.position.z) * k;
        this.group.rotation.y = lerpAngle(this.group.rotation.y, s.yaw, 1 - Math.exp(-8 * dt));
      }
      this.group.visible = true;

      const burning = s.ph === 0;
      this.thruster.visible = burning;
      this.thrusterLight.visible = burning;
      if (burning) {
        const f = 0.8 + Math.random() * 0.4;
        this.thruster.scale.set(f, 0.85 + Math.random() * 0.3, f);
        this.thrusterLight.intensity = 2 + Math.random() * 1.4;
      }
    }

    for (const v of this.missiles.values()) {
      v.x += v.vx * dt;
      v.y += v.vy * dt;
      v.z += v.vz * dt;
      v.group.position.set(v.x, v.y, v.z);
      const sp = Math.hypot(v.vx, v.vy, v.vz);
      if (sp > 0.01) v.group.lookAt(v.x + v.vx / sp, v.y + v.vy / sp, v.z + v.vz / sp);
      v.smokeAcc += dt;
      while (v.smokeAcc > 0.045) {
        v.smokeAcc -= 0.045;
        effects.trail({ x: v.x, y: v.y, z: v.z });
      }
    }
  }

  // Boss body + missiles for client-side aim raycasts and tracer stops.
  capsules(): CapsuleTarget[] {
    const out: CapsuleTarget[] = [];
    if (this.state) {
      const p = this.group.position;
      out.push({ pid: BOSS_PID, x: p.x, y: p.y, z: p.z, r: BOSS_RADIUS, h: BOSS_HEIGHT });
    }
    for (const [id, v] of this.missiles) {
      out.push({
        pid: MISSILE_PID_BASE - id,
        x: v.x,
        y: v.y - MISSILE_HIT_RADIUS,
        z: v.z,
        r: MISSILE_HIT_RADIUS,
        h: MISSILE_HIT_RADIUS * 2,
      });
    }
    return out;
  }
}
