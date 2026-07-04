// Player avatars: capsule body + visor + weapon block, name sprite,
// crouch pose and a simple topple-fade death animation. Low-poly by
// design - readability over fidelity.

import * as THREE from 'three';
import { CAPSULE_RADIUS, CROUCH_HEIGHT, STAND_HEIGHT } from '../../shared/constants';
import type { CapsuleTarget } from '../../shared/collision';
import type { WeaponId } from '../../shared/types';
import { lerpAngle } from '../../shared/math';

export interface PlayerPose {
  x: number;
  y: number; // feet
  z: number;
  yaw: number;
  pit: number;
  crouch: boolean;
  aim: boolean;
  alive: boolean;
  weapon: WeaponId | 0;
}

interface View {
  root: THREE.Group;
  body: THREE.Mesh;
  visor: THREE.Mesh;
  gunRoot: THREE.Group;
  guns: Record<WeaponId, THREE.Group>;
  name?: THREE.Sprite;
  deathT: number; // -1 = alive
  lastPose: PlayerPose | null;
  smoothYaw: number;
}

function nameSprite(name: string, color: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 56;
  const g = c.getContext('2d')!;
  g.font = '26px monospace';
  g.textAlign = 'center';
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(0,0,0,0.75)';
  g.strokeText(name, 128, 36);
  g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  g.fillText(name, 128, 36);
  const tex = new THREE.CanvasTexture(c);
  // depthTest stays ON so walls occlude names - no free wallhacks
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const s = new THREE.Sprite(mat);
  s.scale.set(2.2, 0.48, 1);
  return s;
}

// Each weapon gets its own body colour + silhouette so you can read what an
// enemy is holding (and what's in your own hands) at a glance.
export interface GunPalette {
  body: number; // receiver / dominant colour
  metal: number; // barrel / hardware
  accent: number; // bright detail (mag, rail, scope glass)
}
export const GUN_PALETTE: Record<WeaponId, GunPalette> = {
  ar: { body: 0x2f6f4f, metal: 0x24242a, accent: 0xffd27a }, // olive workhorse
  smg: { body: 0x2a3550, metal: 0x141822, accent: 0x9ab0e0 }, // dark navy, suppressed
  shotgun: { body: 0x7a4a26, metal: 0x2a2a30, accent: 0xd98a3a }, // wood + brass
  sniper: { body: 0x30302f, metal: 0x101010, accent: 0xaef2ff }, // long black rig
};

function buildGun(w: WeaponId): THREE.Group {
  const g = new THREE.Group();
  const pal = GUN_PALETTE[w];
  const body = new THREE.MeshLambertMaterial({ color: pal.body });
  const metal = new THREE.MeshLambertMaterial({ color: pal.metal });
  const accent = new THREE.MeshLambertMaterial({ color: pal.accent });
  const add = (geo: THREE.BoxGeometry, mat: THREE.MeshLambertMaterial, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  if (w === 'ar') {
    add(new THREE.BoxGeometry(0.09, 0.14, 0.72), body, 0, 0, -0.28);
    add(new THREE.BoxGeometry(0.05, 0.05, 0.3), metal, 0, 0.02, -0.75); // barrel
    add(new THREE.BoxGeometry(0.07, 0.22, 0.14), accent, 0, -0.16, 0.02); // curved mag
    add(new THREE.BoxGeometry(0.03, 0.05, 0.36), metal, 0, 0.1, -0.3); // top rail
  } else if (w === 'smg') {
    add(new THREE.BoxGeometry(0.08, 0.12, 0.4), body, 0, 0, -0.13);
    add(new THREE.BoxGeometry(0.09, 0.09, 0.36), metal, 0, 0.01, -0.5); // fat suppressor
    add(new THREE.BoxGeometry(0.06, 0.2, 0.08), accent, 0, -0.15, 0.06); // stick mag
    add(new THREE.BoxGeometry(0.05, 0.04, 0.14), accent, 0, 0.09, -0.06); // compact optic
  } else if (w === 'shotgun') {
    add(new THREE.BoxGeometry(0.11, 0.14, 0.62), body, 0, 0, -0.2);
    add(new THREE.BoxGeometry(0.08, 0.08, 0.52), metal, 0, 0.05, -0.64); // barrel
    add(new THREE.BoxGeometry(0.075, 0.075, 0.34), accent, 0, -0.06, -0.52); // pump/tube
    add(new THREE.BoxGeometry(0.1, 0.16, 0.16), body, 0, -0.02, 0.16); // chunky stock heel
  } else {
    add(new THREE.BoxGeometry(0.08, 0.13, 0.78), body, 0, 0, -0.27);
    add(new THREE.BoxGeometry(0.045, 0.045, 0.7), metal, 0, 0.02, -0.95); // long thin barrel
    add(new THREE.BoxGeometry(0.06, 0.1, 0.3), metal, 0, 0.12, -0.12); // scope tube
    add(new THREE.BoxGeometry(0.055, 0.055, 0.05), accent, 0, 0.12, 0.04); // scope glass
    add(new THREE.BoxGeometry(0.09, 0.18, 0.12), body, 0, -0.02, 0.2); // skeleton stock
  }
  return g;
}

const WEAPON_LIST: WeaponId[] = ['ar', 'smg', 'shotgun', 'sniper'];

export class PlayerViews {
  private views = new Map<number, View>();

  constructor(private scene: THREE.Scene) {}

  ensure(pid: number, name: string, color: number, isLocal: boolean): void {
    if (this.views.has(pid)) return;
    const root = new THREE.Group();

    const bodyH = STAND_HEIGHT - CAPSULE_RADIUS * 2;
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(CAPSULE_RADIUS, bodyH, 4, 10),
      new THREE.MeshLambertMaterial({ color }),
    );
    body.position.y = STAND_HEIGHT / 2;
    body.castShadow = true;
    root.add(body);

    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.12, 0.16),
      new THREE.MeshLambertMaterial({ color: 0x1a1a20 }),
    );
    visor.position.set(0, STAND_HEIGHT - 0.28, -CAPSULE_RADIUS - 0.02);
    root.add(visor);

    const gunRoot = new THREE.Group();
    gunRoot.position.set(0.46, STAND_HEIGHT - 0.62, -0.15);
    root.add(gunRoot);
    const guns = {} as Record<WeaponId, THREE.Group>;
    for (const w of WEAPON_LIST) {
      const gun = buildGun(w);
      gun.visible = false;
      gunRoot.add(gun);
      guns[w] = gun;
    }

    const view: View = { root, body, visor, gunRoot, guns, deathT: -1, lastPose: null, smoothYaw: 0 };
    if (!isLocal) {
      const s = nameSprite(name, color);
      s.position.y = STAND_HEIGHT + 0.45;
      root.add(s);
      view.name = s;
    }
    this.scene.add(root);
    this.views.set(pid, view);
  }

  remove(pid: number): void {
    const v = this.views.get(pid);
    if (v) {
      this.scene.remove(v.root);
      this.views.delete(pid);
    }
  }

  setLocalVisible(pid: number, visible: boolean): void {
    const v = this.views.get(pid);
    if (v) v.root.visible = visible;
  }

  update(pid: number, pose: PlayerPose, dt: number, smoothTurn: boolean): void {
    const v = this.views.get(pid);
    if (!v) return;
    v.lastPose = pose;

    if (!pose.alive) {
      if (v.deathT < 0) v.deathT = 0;
      v.deathT += dt;
      const t = Math.min(v.deathT / 0.55, 1);
      v.root.rotation.z = t * 1.45;
      v.root.position.y = pose.y - t * 0.25;
      v.root.visible = v.deathT < 2.5;
      return;
    }
    if (v.deathT >= 0) {
      v.deathT = -1;
      v.root.rotation.z = 0;
      v.root.visible = true;
    }

    v.root.position.set(pose.x, pose.y, pose.z);
    if (smoothTurn) {
      v.smoothYaw = lerpAngle(v.smoothYaw, pose.yaw, 1 - Math.exp(-18 * dt));
    } else {
      v.smoothYaw = pose.yaw;
    }
    v.root.rotation.y = v.smoothYaw;

    const crouchScale = pose.crouch ? CROUCH_HEIGHT / STAND_HEIGHT : 1;
    v.body.scale.y += (crouchScale - v.body.scale.y) * (1 - Math.exp(-14 * dt));
    v.body.position.y = (STAND_HEIGHT * v.body.scale.y) / 2;
    const headY = STAND_HEIGHT * v.body.scale.y - 0.28;
    v.visor.position.y = headY;
    v.gunRoot.position.y = headY - 0.34;
    v.gunRoot.rotation.x = pose.pit;

    for (const w of WEAPON_LIST) v.guns[w].visible = pose.weapon === w;
  }

  muzzleWorld(pid: number, out: THREE.Vector3): boolean {
    const v = this.views.get(pid);
    if (!v) return false;
    v.gunRoot.getWorldPosition(out);
    return true;
  }

  capsules(): CapsuleTarget[] {
    const out: CapsuleTarget[] = [];
    for (const [pid, v] of this.views) {
      const p = v.lastPose;
      if (!p || !p.alive) continue;
      out.push({
        pid,
        x: p.x,
        y: p.y,
        z: p.z,
        r: CAPSULE_RADIUS,
        h: p.crouch ? CROUCH_HEIGHT : STAND_HEIGHT,
      });
    }
    return out;
  }
}
