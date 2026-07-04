// Three.js scene: procedural low-poly map, lighting, loot + barricade
// meshes. Everything is generated in code - no external assets at all.

import * as THREE from 'three';
import { MAP_BOXES } from '../../shared/map';
import { BAR_HP, BAR_HX, BAR_HY, BAR_HZ } from '../../shared/constants';
import { WEAPONS } from '../../shared/weapons';
import type { BarricadeState, LootItem } from '../../shared/types';

const AMMO_COLORS: Record<string, number> = {
  rifle: 0xd98f3a,
  smg: 0x6fa4d9,
  shell: 0xd9543a,
  long: 0x9a6fd9,
};

function groundTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6f6a60';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 260; i++) {
    const shade = 100 + Math.floor(Math.random() * 24);
    g.fillStyle = `rgba(${shade},${shade - 4},${shade - 10},0.25)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2 + Math.random() * 7, 2 + Math.random() * 7);
  }
  g.strokeStyle = 'rgba(90,86,78,0.8)';
  g.lineWidth = 2;
  g.strokeRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(30, 30);
  return tex;
}

export class SceneMgr {
  scene = new THREE.Scene();
  renderer: THREE.WebGLRenderer;
  private lootMeshes = new Map<number, THREE.Group>();
  private barMeshes = new Map<number, THREE.Group>();
  private barMats = new Map<number, THREE.MeshLambertMaterial>();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = new THREE.Color(0xd7b98c);
    this.scene.fog = new THREE.Fog(0xd7b98c, 70, 280);

    const hemi = new THREE.HemisphereLight(0xffe8c4, 0x5a4a3a, 0.85);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffdba8, 1.35);
    sun.position.set(70, 110, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -95;
    sun.shadow.camera.right = 95;
    sun.shadow.camera.top = 95;
    sun.shadow.camera.bottom = -95;
    sun.shadow.camera.far = 300;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(420, 420),
      new THREE.MeshLambertMaterial({ map: groundTexture() }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    for (const b of MAP_BOXES) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(b.sx, b.sy, b.sz),
        new THREE.MeshLambertMaterial({ color: b.color }),
      );
      mesh.position.set(b.x, b.y, b.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
  }

  render(cam: THREE.Camera): void {
    this.renderer.render(this.scene, cam);
  }

  // ---------- loot ----------

  private buildLootMesh(item: LootItem): THREE.Group {
    const g = new THREE.Group();
    const lam = (color: number) => new THREE.MeshLambertMaterial({ color });
    if (item.k === 'w' && item.w) {
      const def = WEAPONS[item.w];
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.16, 0.8), lam(0x3a3a40));
      g.add(body);
      const barrelLen = item.w === 'sniper' ? 0.7 : item.w === 'shotgun' ? 0.45 : 0.35;
      const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, barrelLen), lam(0x2a2a30));
      barrel.position.set(0, 0.05, -(0.4 + barrelLen / 2));
      g.add(barrel);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.1), lam(0x4a3a2a));
      grip.position.set(0, -0.15, 0.2);
      g.add(grip);
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 8, 6),
        new THREE.MeshBasicMaterial({ color: def.tracer }),
      );
      marker.position.y = 0.55;
      g.add(marker);
    } else if (item.k === 'a' && item.at) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.24), lam(AMMO_COLORS[item.at]));
      g.add(box);
      const lid = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.05, 0.26), lam(0x3a3a3a));
      lid.position.y = 0.13;
      g.add(lid);
    } else if (item.k === 'm') {
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.3), lam(0xe8e4da));
      g.add(box);
      const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.07), lam(0xd14f40));
      c1.position.y = 0.13;
      const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, 0.22), lam(0xd14f40));
      c2.position.y = 0.13;
      g.add(c1, c2);
    } else {
      // barricade kit: folded panel bundle
      const p1 = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, 0.4), lam(0xc2a05a));
      const p2 = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, 0.4), lam(0xb2905a));
      p2.position.y = 0.09;
      p2.rotation.y = 0.25;
      g.add(p1, p2);
    }
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    return g;
  }

  addLoot(item: LootItem): void {
    if (this.lootMeshes.has(item.id)) return;
    const g = this.buildLootMesh(item);
    g.position.set(item.x, item.y + 0.28, item.z);
    this.scene.add(g);
    this.lootMeshes.set(item.id, g);
  }

  removeLoot(id: number): void {
    const g = this.lootMeshes.get(id);
    if (g) {
      this.scene.remove(g);
      this.lootMeshes.delete(id);
    }
  }

  animateLoot(t: number): void {
    for (const [id, g] of this.lootMeshes) {
      g.rotation.y = t * 0.8 + id;
      g.position.y = g.userData.baseY ?? (g.userData.baseY = g.position.y);
      g.position.y += Math.sin(t * 2 + id) * 0.05;
    }
  }

  // ---------- barricades ----------

  addBarricade(bar: BarricadeState): void {
    if (this.barMeshes.has(bar.id)) return;
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0xc2a05a });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(BAR_HX * 2, BAR_HY * 2, BAR_HZ * 2), mat);
    panel.position.y = BAR_HY;
    panel.castShadow = true;
    panel.receiveShadow = true;
    g.add(panel);
    const legMat = new THREE.MeshLambertMaterial({ color: 0x5a5248 });
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 1.0), legMat);
      leg.position.set(side * (BAR_HX * 0.7), BAR_HY * 0.55, 0.38);
      leg.rotation.x = -0.85;
      leg.castShadow = true;
      g.add(leg);
    }
    const brace = new THREE.Mesh(new THREE.BoxGeometry(BAR_HX * 1.7, 0.1, 0.1), legMat);
    brace.position.set(0, BAR_HY * 1.55, 0.02);
    g.add(brace);
    g.position.set(bar.x, bar.y, bar.z);
    g.rotation.y = bar.yaw;
    this.scene.add(g);
    this.barMeshes.set(bar.id, g);
    this.barMats.set(bar.id, mat);
    this.setBarricadeHp(bar.id, bar.hp);
  }

  setBarricadeHp(id: number, hp: number): void {
    const mat = this.barMats.get(id);
    if (!mat) return;
    const f = 0.35 + 0.65 * (hp / BAR_HP); // darken as it breaks
    mat.color.setRGB((0xc2 / 255) * f, (0xa0 / 255) * f, (0x5a / 255) * f);
  }

  removeBarricade(id: number): void {
    const g = this.barMeshes.get(id);
    if (g) {
      this.scene.remove(g);
      this.barMeshes.delete(id);
      this.barMats.delete(id);
    }
  }

  // ---------- placement ghost ----------

  buildGhost(): { group: THREE.Group; mat: THREE.MeshBasicMaterial } {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x7bc95f,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });
    const group = new THREE.Group();
    const panel = new THREE.Mesh(new THREE.BoxGeometry(BAR_HX * 2, BAR_HY * 2, BAR_HZ * 2), mat);
    panel.position.y = BAR_HY;
    group.add(panel);
    group.visible = false;
    this.scene.add(group);
    return { group, mat };
  }
}
