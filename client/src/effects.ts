// Visual-only combat effects: tracer projectiles (stepped with the shared
// sim so they fly exactly like the authoritative ones), muzzle flashes and
// a pooled particle system for impacts.

import * as THREE from 'three';
import { makeProjectile, stepProjectile, type ProjectileState } from '../../shared/projectile';
import type { BoxCollider, CapsuleTarget } from '../../shared/collision';
import { WEAPONS } from '../../shared/weapons';
import type { ImpactKind, WeaponId } from '../../shared/types';
import type { V3 } from '../../shared/math';

const MAX_PARTICLES = 240;

interface VisualProj {
  state: ProjectileState;
  mesh: THREE.Mesh;
}

interface Flash {
  sprite: THREE.Sprite;
  life: number;
}

const IMPACT_COLORS: Record<ImpactKind, number> = {
  w: 0xcdc4b0, // wall dust
  b: 0xd9b060, // wood chips
  p: 0xd14f40, // blood-ish puff (kept abstract)
  g: 0xb0a488, // ground dust
  e: 0x888888,
};

export class Effects {
  private projs = new Map<string, VisualProj>();
  private flashes: Flash[] = [];
  private tracerGeo = new THREE.BoxGeometry(0.045, 0.045, 1);
  private tracerMats = new Map<number, THREE.MeshBasicMaterial>();
  private flashTex: THREE.Texture;

  private points: THREE.Points;
  private pPos: Float32Array;
  private pCol: Float32Array;
  private pVel: Float32Array;
  private pLife: Float32Array;
  private pSlot = 0;

  constructor(private scene: THREE.Scene) {
    this.pPos = new Float32Array(MAX_PARTICLES * 3).fill(-500);
    this.pCol = new Float32Array(MAX_PARTICLES * 3);
    this.pVel = new Float32Array(MAX_PARTICLES * 3);
    this.pLife = new Float32Array(MAX_PARTICLES);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size: 0.14, vertexColors: true, transparent: true, opacity: 0.95 }),
    );
    this.points.frustumCulled = false;
    scene.add(this.points);

    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(255,240,190,1)');
    grad.addColorStop(0.4, 'rgba(255,180,80,0.85)');
    grad.addColorStop(1, 'rgba(255,120,30,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.flashTex = new THREE.CanvasTexture(c);
  }

  private tracerMat(color: number): THREE.MeshBasicMaterial {
    let m = this.tracerMats.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 });
      this.tracerMats.set(color, m);
    }
    return m;
  }

  get projectileCount(): number {
    return this.projs.size;
  }

  spawnProjectile(key: string, owner: number, w: WeaponId, origin: V3, dir: V3): void {
    if (this.projs.has(key)) return;
    const def = WEAPONS[w];
    const state = makeProjectile(0, owner, w, origin, dir);
    const len = def.suppressed ? 0.9 : w === 'sniper' ? 3.2 : 1.8;
    const mesh = new THREE.Mesh(this.tracerGeo, this.tracerMat(def.tracer));
    mesh.scale.z = len;
    mesh.position.set(origin.x, origin.y, origin.z);
    this.scene.add(mesh);
    this.projs.set(key, { state, mesh });
  }

  has(key: string): boolean {
    return this.projs.has(key);
  }

  // server says this projectile ended here: snap the visual + spark
  endProjectile(key: string, pos: V3, kind: ImpactKind): void {
    const vp = this.projs.get(key);
    if (vp) {
      this.scene.remove(vp.mesh);
      this.projs.delete(key);
    }
    if (kind !== 'e') this.impact(pos, kind);
  }

  muzzleFlash(pos: V3, w: WeaponId): void {
    const def = WEAPONS[w];
    if (def.suppressed) return;
    const mat = new THREE.SpriteMaterial({
      map: this.flashTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const s = new THREE.Sprite(mat);
    const scale = w === 'shotgun' || w === 'sniper' ? 1.0 : 0.62;
    s.scale.set(scale, scale, 1);
    s.position.set(pos.x, pos.y, pos.z);
    this.scene.add(s);
    this.flashes.push({ sprite: s, life: 0.05 });
  }

  impact(pos: V3, kind: ImpactKind): void {
    const color = new THREE.Color(IMPACT_COLORS[kind]);
    const n = kind === 'p' ? 8 : 6;
    for (let i = 0; i < n; i++) {
      const s = this.pSlot;
      this.pSlot = (this.pSlot + 1) % MAX_PARTICLES;
      this.pPos[s * 3] = pos.x;
      this.pPos[s * 3 + 1] = pos.y;
      this.pPos[s * 3 + 2] = pos.z;
      this.pVel[s * 3] = (Math.random() - 0.5) * 4;
      this.pVel[s * 3 + 1] = Math.random() * 3.5 + 0.6;
      this.pVel[s * 3 + 2] = (Math.random() - 0.5) * 4;
      this.pLife[s] = 0.22 + Math.random() * 0.16;
      this.pCol[s * 3] = color.r;
      this.pCol[s * 3 + 1] = color.g;
      this.pCol[s * 3 + 2] = color.b;
    }
  }

  barricadeBreak(pos: V3): void {
    for (let k = 0; k < 4; k++) {
      this.impact({ x: pos.x + (Math.random() - 0.5), y: pos.y + Math.random() * 1.2, z: pos.z + (Math.random() - 0.5) }, 'b');
    }
  }

  // Step visual projectiles against the client's view of the world so
  // tracers stop plausibly even before the authoritative impact arrives.
  update(dt: number, solids: BoxCollider[], capsules: CapsuleTarget[]): void {
    for (const [key, vp] of this.projs) {
      const res = stepProjectile(vp.state, dt, solids, capsules);
      const st = vp.state;
      vp.mesh.position.set(st.x, st.y, st.z);
      const sp = Math.hypot(st.vx, st.vy, st.vz);
      if (sp > 0.01) {
        vp.mesh.lookAt(st.x + st.vx / sp, st.y + st.vy / sp, st.z + st.vz / sp);
      }
      if (res.hit || res.expired) {
        if (res.hit) this.impact({ x: st.x, y: st.y, z: st.z }, res.hit.kind === 'ground' ? 'g' : 'w');
        this.scene.remove(vp.mesh);
        this.projs.delete(key);
      }
    }

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      if (f.life <= 0) {
        this.scene.remove(f.sprite);
        f.sprite.material.dispose();
        this.flashes.splice(i, 1);
      }
    }

    for (let s = 0; s < MAX_PARTICLES; s++) {
      if (this.pLife[s] <= 0) continue;
      this.pLife[s] -= dt;
      if (this.pLife[s] <= 0) {
        this.pPos[s * 3 + 1] = -500;
        continue;
      }
      this.pVel[s * 3 + 1] -= 9 * dt;
      this.pPos[s * 3] += this.pVel[s * 3] * dt;
      this.pPos[s * 3 + 1] += this.pVel[s * 3 + 1] * dt;
      this.pPos[s * 3 + 2] += this.pVel[s * 3 + 2] * dt;
    }
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }
}
