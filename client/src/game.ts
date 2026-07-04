// Client game orchestration: fixed-step input/prediction, server snapshot
// handling (reconciliation + interpolation), predicted fire with tracer
// visuals, barricade placement flow, loot prompts, HUD and debug overlay.

import * as THREE from 'three';
import {
  BAR_PLACE_DISTANCE,
  BOSS_PID,
  CLIENT_STEP,
  EYE_STAND,
  INPUT_BATCH,
  INTERP_DELAY_MS,
  MED_USE_MS,
  STAM_MAX,
  SWAP_FIRE_LOCKOUT_MS,
  WEAPON_PICKUP_RADIUS,
} from '../../shared/constants';
import { buildStaticColliders, type LootTable } from '../../shared/map';
import { barricadeCollider, validatePlacement } from '../../shared/barricade';
import type { BoxCollider, CapsuleTarget } from '../../shared/collision';
import { castSegment, groundSupportAt } from '../../shared/collision';
import { stepMove, type MoveState } from '../../shared/movement';
import { computeSpread, pelletDirs, WEAPONS } from '../../shared/weapons';
import {
  addScaled,
  clamp,
  dirFromYawPitch,
  dist2D,
  lerp,
  lerpAngle,
  norm,
  r3,
  sub,
  v3,
  type V3,
} from '../../shared/math';
import type {
  BarricadeState,
  GameEvent,
  InputCmd,
  LootItem,
  PlayerPublic,
  ServerMsg,
  WeaponId,
  YouState,
} from '../../shared/types';
import { Net } from './net';
import { Input } from './input';
import { TPCamera } from './camera';
import { SceneMgr } from './scene';
import { PlayerViews, type PlayerPose } from './players';
import { BossView } from './boss';
import { Effects } from './effects';
import { AudioMgr } from './audio';
import { Hud, Roster, type ScoreRow } from './hud';
import { DebugOverlay } from './debug';

interface RemoteSample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pit: number;
  aim: 0 | 1;
  alive: 0 | 1;
  w: WeaponId | 0;
  pl: 0 | 1;
}

export class ClientGame {
  net = new Net();
  private input: Input;
  private scene: SceneMgr;
  private camera: TPCamera;
  private views: PlayerViews;
  private bossView: BossView;
  private effects: Effects;
  private audio = new AudioMgr();
  private hud = new Hud();
  private roster = new Roster();
  private debug = new DebugOverlay();

  private statics: BoxCollider[] = buildStaticColliders();
  private barCols: BoxCollider[] = [];
  private bars = new Map<number, BarricadeState>();
  private loot = new Map<number, LootItem>();

  myPid = 0;
  private pred: MoveState = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true, stamina: STAM_MAX, stamCd: 0,
  };
  private errX = 0;
  private errY = 0;
  private errZ = 0;
  private pending: InputCmd[] = [];
  private outBuf: InputCmd[] = [];
  private seq = 0;
  private you: YouState | null = null;
  private lastPlayers: PlayerPublic[] = [];
  private remotes = new Map<number, RemoteSample[]>();

  private sid = 1;
  private nextShotAt = 0;
  private autoReloadAt = 0; // debounces auto-reload sound on empty mag
  private shotMap = new Map<number, string>(); // server projectile id -> local visual key

  private placing = false;
  private ghost: { group: THREE.Group; mat: THREE.MeshBasicMaterial };
  private ghostValid = false;
  private ghostPos = { x: 0, y: 0, z: 0, yaw: 0 };

  private nearestWeaponLoot: LootItem | null = null;
  private scoreboardOpen = false;

  // stats
  corrections = 0;
  private corrWindow: number[] = [];
  lastCorrMag = 0;
  private fps = 0;
  private acc = 0;
  private lastFrame = 0;
  private running = false;

  onDisconnect: (reason: string) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    this.scene = new SceneMgr(canvas);
    this.camera = new TPCamera(window.innerWidth / window.innerHeight);
    this.views = new PlayerViews(this.scene.scene);
    this.bossView = new BossView(this.scene.scene);
    this.effects = new Effects(this.scene.scene);
    this.input = new Input(canvas);
    this.ghost = this.scene.buildGhost();

    this.input.onToggleDebug = () => this.debug.toggle();
    this.input.onToggleMute = () => {
      const m = this.audio.toggleMute();
      this.hud.toast(m ? 'sound muted (M)' : 'sound on');
    };
    this.input.onScoreboard = (show) => (this.scoreboardOpen = show);
    this.input.onToggleShoulder = () => this.camera.toggleShoulder();

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private resize(): void {
    this.scene.resize(window.innerWidth, window.innerHeight);
    this.camera.setAspect(window.innerWidth / window.innerHeight);
  }

  join(url: string, name: string, onReady: () => void, onFail: (reason: string) => void): void {
    this.audio.init();
    this.net.connect(url, name, {
      onWelcome: (msg) => {
        this.myPid = msg.pid;
        for (const r of msg.roster) {
          this.roster.set(r.pid, r.name, r.color);
          this.views.ensure(r.pid, r.name, r.color, r.pid === this.myPid);
        }
        for (const item of msg.loot) this.addLoot(item);
        for (const bar of msg.bars) this.addBar(bar, false);
        this.input.enabled = true;
        this.running = true;
        this.hud.show();
        this.debug.show();
        this.lastFrame = performance.now();
        requestAnimationFrame((t) => this.frame(t));
        onReady();
      },
      onSnap: (msg) => this.onSnap(msg),
      onReject: (reason) => onFail(reason),
      onClose: () => {
        this.running = false;
        this.onDisconnect('connection lost');
      },
    });
  }

  requestPointerLock(): void {
    this.input.requestLock();
  }

  get pointerLocked(): boolean {
    return this.input.locked;
  }

  // ---------- world helpers ----------

  private allSolids(): BoxCollider[] {
    return this.barCols.length > 0 ? [...this.statics, ...this.barCols] : this.statics;
  }

  private rebuildBarCols(): void {
    this.barCols = [...this.bars.values()].map(barricadeCollider);
  }

  private addLoot(item: LootItem): void {
    this.loot.set(item.id, item);
    this.scene.addLoot(item);
  }

  private removeLoot(id: number): void {
    this.loot.delete(id);
    this.scene.removeLoot(id);
  }

  private addBar(bar: BarricadeState, sound: boolean): void {
    this.bars.set(bar.id, bar);
    this.scene.addBarricade(bar);
    this.rebuildBarCols();
    if (sound) {
      const { d, p } = this.panDist(bar);
      this.audio.place(d, p);
    }
  }

  private panDist(pos: { x: number; z: number; y?: number }): { d: number; p: number } {
    const cp = this.camera.cam.position;
    const dx = pos.x - cp.x;
    const dy = (pos.y ?? 1) - cp.y;
    const dz = pos.z - cp.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.01) return { d: 0, p: 0 };
    const yaw = this.input.yaw;
    const p = (dx * Math.cos(yaw) + dz * -Math.sin(yaw)) / d;
    return { d, p };
  }

  private get isDead(): boolean {
    return (this.you?.dead ?? 0) > 0;
  }

  private activeWeapon(): WeaponId | 0 {
    const slot = this.you?.slots[this.you.act];
    return slot?.w ?? 0;
  }

  private pendingShotCount(): number {
    let n = 0;
    for (const c of this.pending) n += c.fire?.length ?? 0;
    return n;
  }

  // ---------- fixed-step prediction ----------

  private step(): void {
    this.seq += 1;
    const now = performance.now();
    const edges = this.input.consumeEdges();
    const wheel = this.input.consumeWheelFlip();
    const yaw = this.input.yaw;
    const pit = this.input.pit;

    const axes = this.input.moveAxes();
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    let mx = fx * axes.z + rx * axes.x;
    let mz = fz * axes.z + rz * axes.x;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) {
      mx /= ml;
      mz /= ml;
    }

    const aiming = this.input.aimHeld && !this.placing;
    const cmd: InputCmd = {
      seq: this.seq,
      dt: CLIENT_STEP,
      mx: r3(mx),
      mz: r3(mz),
      yaw: r3(yaw),
      pit: r3(pit),
      sp: this.input.sprintHeld() ? 1 : 0,
      jp: edges.jump ? 1 : 0,
      aim: aiming ? 1 : 0,
    };

    if (edges.reload) {
      cmd.rld = 1;
      const w = this.activeWeapon();
      if (w !== 0 && this.you) {
        const slot = this.you.slots[this.you.act]!;
        if (slot.mag < WEAPONS[w].mag && this.you.res[WEAPONS[w].ammo] > 0) this.audio.reload();
      }
    }
    if (edges.use) cmd.use = 1;
    if (edges.hurt && !this.isDead) cmd.hurt = 1;
    if (edges.summon && !this.isDead) cmd.summon = 1;
    if (edges.swap !== null) cmd.swap = edges.swap;
    else if (wheel && this.you) {
      const other = this.you.act === 0 ? 1 : 0;
      if (this.you.slots[other]) cmd.swap = other;
    }
    // Match the server's post-swap fire lockout (see processCmd/tryFire). Without
    // this the client keeps predicting shots the server rejects, so rapidly
    // switching weapons back and forth would fire visually forever while the
    // authoritative magazine never actually drained.
    const validWeaponSwap =
      cmd.swap !== undefined &&
      this.you &&
      cmd.swap !== this.you.act &&
      this.you.slots[cmd.swap];
    if (validWeaponSwap) {
      this.nextShotAt = Math.max(this.nextShotAt, now + SWAP_FIRE_LOCKOUT_MS);
      const nextSlot = this.you!.slots[cmd.swap as 0 | 1]!;
      const nextDef = WEAPONS[nextSlot.w];
      if (nextSlot.mag <= 0 && (this.you!.res[nextDef.ammo] ?? 0) > 0) {
        cmd.rld = 1;
        if (now - this.autoReloadAt > 250) {
          this.audio.reload();
          this.autoReloadAt = now;
        }
      }
    }
    if (this.placing && (edges.swap !== null || cmd.swap !== undefined)) {
      this.placing = false;
      this.ghost.group.visible = false;
    }
    if (edges.pick && this.nearestWeaponLoot) cmd.pick = this.nearestWeaponLoot.id;

    // barricade placement mode
    if (edges.placeToggle) {
      if (this.placing) {
        this.placing = false;
      } else if ((this.you?.kits ?? 0) > 0 && !this.isDead) {
        this.placing = true;
      } else if (!this.isDead) {
        this.hud.toast('No barricade kits - find one on the yard');
      }
    }
    if (this.placing) {
      // weapon is stowed while readying: the place click must never fire,
      // and the weapon is re-drawn (with a swap-style lockout) afterwards
      cmd.pl = 1;
      if (edges.aimPressed) {
        this.placing = false;
      } else if (edges.firePressed && this.ghostValid) {
        cmd.place = { x: r3(this.ghostPos.x), z: r3(this.ghostPos.z), yaw: r3(this.ghostPos.yaw) };
        this.placing = false;
        this.input.fireHeld = false; // don't let the held place-click keep firing an auto
        this.nextShotAt = Math.max(this.nextShotAt, now + SWAP_FIRE_LOCKOUT_MS);
      }
    } else if (!this.isDead) {
      this.handleFire(cmd, edges.firePressed, aiming, now);
    }

    if (!this.isDead) {
      stepMove(this.pred, cmd, this.allSolids());
    }

    this.pending.push(cmd);
    if (this.pending.length > 180) this.pending.splice(0, this.pending.length - 180);
    this.outBuf.push(cmd);
    if (this.outBuf.length >= INPUT_BATCH) {
      this.net.send({ t: 'in', cmds: this.outBuf });
      this.outBuf = [];
    }
  }

  private handleFire(cmd: InputCmd, pressedEdge: boolean, aiming: boolean, now: number): void {
    if (!this.you) return;
    const slot = this.you.slots[this.you.act];
    if (!slot) {
      if (pressedEdge) this.audio.dry();
      return;
    }
    const def = WEAPONS[slot.w];
    const snow = this.net.serverNow();
    if (this.you.rld > snow) return;
    const wantFire = def.auto ? this.input.fireHeld : pressedEdge;
    if (!wantFire || now < this.nextShotAt) return;

    const displayMag = Math.max(0, slot.mag - this.pendingShotCount());
    if (displayMag <= 0) {
      // Empty mag: auto-reload if there's reserve ammo so holding fire keeps
      // shooting until you're truly out, instead of forcing a manual R press.
      if ((this.you.res[def.ammo] ?? 0) > 0) {
        cmd.rld = 1;
        if (now - this.autoReloadAt > 250) {
          this.audio.reload();
          this.autoReloadAt = now;
        }
      } else if (pressedEdge) {
        this.audio.dry();
      }
      this.nextShotAt = now + 220;
      return;
    }

    this.nextShotAt = now + def.interval * 1000;
    const sid = this.sid++;
    const angles = this.fireAngles();
    if (!cmd.fire) cmd.fire = [];
    cmd.fire.push({ sid, yaw: r3(angles.yaw), pit: r3(angles.pit) });

    // predicted visuals: identical math to the server's authoritative spawn
    const speed = Math.hypot(this.pred.vx, this.pred.vz);
    const spread = computeSpread(def, aiming, speed, this.pred.onGround);
    const dirs = pelletDirs(def, angles.yaw, angles.pit, sid, spread);
    const center = dirFromYawPitch(angles.yaw, angles.pit);
    const eye = v3(this.pred.x, this.pred.y + EYE_STAND, this.pred.z);
    const origin = addScaled(eye, center, 0.3);
    dirs.forEach((d, i) =>
      this.effects.spawnProjectile(`c${sid}:${i}`, this.myPid, slot.w, origin, d),
    );
    this.effects.muzzleFlash(addScaled(origin, center, 0.3), slot.w);
    this.audio.shot(slot.w, 0, 0);
    this.input.kickView((Math.random() - 0.5) * def.kick * 0.5, def.kick * (0.8 + Math.random() * 0.4));

    if (displayMag === 1 && (this.you.res[def.ammo] ?? 0) > 0) {
      this.nextShotAt = Math.max(this.nextShotAt, now + def.reload * 1000);
      if (now - this.autoReloadAt > 250) {
        this.audio.reload();
        this.autoReloadAt = now;
      }
    }
  }

  // players + boss + missiles: everything a shot can visibly connect with
  private targetCapsules(): CapsuleTarget[] {
    return [...this.views.capsules(), ...this.bossView.capsules()];
  }

  private fireAngles(): { yaw: number; pit: number } {
    const ray = this.camera.ray(this.input.yaw, this.input.pit);
    const far = addScaled(ray.origin, ray.dir, 260);
    const hit = castSegment(ray.origin, far, this.allSolids(), this.targetCapsules(), this.myPid);
    const target = hit ? v3(hit.x, hit.y, hit.z) : far;
    const eye = v3(this.pred.x, this.pred.y + EYE_STAND, this.pred.z);
    const d = sub(target, eye);
    if (Math.hypot(d.x, d.y, d.z) < 0.6) return { yaw: this.input.yaw, pit: this.input.pit };
    const dir = norm(d);
    return { yaw: Math.atan2(-dir.x, -dir.z), pit: Math.asin(clamp(dir.y, -1, 1)) };
  }

  // ---------- snapshots ----------

  private onSnap(msg: Extract<ServerMsg, { t: 'snap' }>): void {
    this.lastPlayers = msg.players;
    const wasDead = this.isDead;
    this.you = msg.you;
    this.bossView.setFromSnap(msg.boss, msg.ms);

    for (const p of msg.players) {
      if (p.id === this.myPid) continue;
      let buf = this.remotes.get(p.id);
      if (!buf) {
        buf = [];
        this.remotes.set(p.id, buf);
      }
      buf.push({
        t: msg.time,
        x: p.x, y: p.y, z: p.z,
        yaw: p.yaw, pit: p.pit,
        aim: p.aim, alive: p.alive, w: p.w, pl: p.pl,
      });
      if (buf.length > 40) buf.splice(0, buf.length - 40);
    }

    // reconcile local prediction
    while (this.pending.length > 0 && this.pending[0].seq <= msg.you.ack) this.pending.shift();
    if (msg.you.dead > 0) {
      this.setPredFromYou(msg.you);
      this.pending = [];
      this.errX = this.errY = this.errZ = 0;
      this.placing = false;
    } else {
      const preX = this.pred.x;
      const preY = this.pred.y;
      const preZ = this.pred.z;
      this.setPredFromYou(msg.you);
      const solids = this.allSolids();
      for (const cmd of this.pending) stepMove(this.pred, cmd, solids);
      const dx = preX - this.pred.x;
      const dy = preY - this.pred.y;
      const dz = preZ - this.pred.z;
      const mag = Math.hypot(dx, dy, dz);
      if (mag > 3 || wasDead) {
        this.errX = this.errY = this.errZ = 0;
      } else if (mag > 0.0005) {
        this.errX += dx;
        this.errY += dy;
        this.errZ += dz;
        if (mag > 0.05) {
          this.corrections += 1;
          this.lastCorrMag = mag;
          this.corrWindow.push(performance.now());
        }
      }
    }

    if (msg.ev) for (const ev of msg.ev) this.onEvent(ev);
  }

  private setPredFromYou(you: YouState): void {
    this.pred.x = you.x;
    this.pred.y = you.y;
    this.pred.z = you.z;
    this.pred.vx = you.vx;
    this.pred.vy = you.vy;
    this.pred.vz = you.vz;
    this.pred.onGround = you.og === 1;
    this.pred.stamina = you.st;
    this.pred.stamCd = you.stcd;
  }

  // ---------- events ----------

  private onEvent(ev: GameEvent): void {
    switch (ev.t) {
      case 'shot': {
        if (ev.pid === this.myPid) {
          ev.ids.forEach((id, i) => this.shotMap.set(id, `c${ev.sid}:${i}`));
          return;
        }
        const def = WEAPONS[ev.w];
        const origin = v3(ev.ox, ev.oy, ev.oz);
        const dirs = pelletDirs(def, ev.yaw, ev.pit, ev.sid, ev.spr);
        dirs.forEach((d, i) => this.effects.spawnProjectile(`s${ev.ids[i]}`, ev.pid, ev.w, origin, d));
        this.effects.muzzleFlash(addScaled(origin, dirs[0], 0.3), ev.w);
        const { d, p } = this.panDist({ x: ev.ox, y: ev.oy, z: ev.oz });
        this.audio.shot(ev.w, d, p);
        break;
      }
      case 'imp': {
        const key = this.shotMap.get(ev.id) ?? `s${ev.id}`;
        this.shotMap.delete(ev.id);
        const pos = v3(ev.x, ev.y, ev.z);
        if (this.effects.has(key)) {
          this.effects.endProjectile(key, pos, ev.k);
        } else if (ev.k === 'p') {
          this.effects.impact(pos, 'p');
        }
        if (ev.k !== 'e') {
          const { d, p } = this.panDist(pos);
          if (d < 45) this.audio.impact(ev.k, d, p);
        }
        break;
      }
      case 'hit': {
        if (ev.a === this.myPid && ev.v !== this.myPid) {
          this.hud.hitmarker();
          this.audio.hitmarker();
        }
        if (ev.v === this.myPid) {
          this.hud.damageFlash();
          this.audio.hurt();
        }
        break;
      }
      case 'kill': {
        const wName = ev.a === BOSS_PID ? 'GOLIATH' : ev.w === 0 ? '?' : WEAPONS[ev.w].name;
        this.hud.addKillfeed(
          `${this.roster.colored(ev.a)} <span style="opacity:.6">[${wName}]</span> ${this.roster.colored(ev.v)}`,
          ev.a === this.myPid || ev.v === this.myPid,
        );
        if (ev.v === this.myPid) {
          this.hud.showDeath(`taken out by ${this.roster.colored(ev.a)} · ${wName}`);
          this.placing = false;
        } else if (ev.a === this.myPid) {
          this.audio.kill();
        }
        break;
      }
      case 'spawn': {
        if (ev.pid === this.myPid) {
          this.hud.hideDeath();
          // face the arena center, matching the server's spawn yaw
          this.input.setView(Math.atan2(ev.x, ev.z), 0);
          this.pred.x = ev.x;
          this.pred.y = ev.y;
          this.pred.z = ev.z;
          this.pred.vx = this.pred.vy = this.pred.vz = 0;
          this.errX = this.errY = this.errZ = 0;
          this.pending = [];
          this.nextShotAt = 0;
        } else {
          this.remotes.delete(ev.pid); // fresh interp buffer after teleport
        }
        break;
      }
      case 'join': {
        this.roster.set(ev.pid, ev.name, ev.color);
        this.views.ensure(ev.pid, ev.name, ev.color, ev.pid === this.myPid);
        if (ev.pid !== this.myPid) this.hud.addKillfeed(`${this.roster.colored(ev.pid)} deployed`, false);
        break;
      }
      case 'leave': {
        this.hud.addKillfeed(`${this.roster.colored(ev.pid)} left`, false);
        this.roster.remove(ev.pid);
        this.views.remove(ev.pid);
        this.remotes.delete(ev.pid);
        break;
      }
      case 'ladd':
        this.addLoot(ev.item);
        break;
      case 'lgone': {
        this.removeLoot(ev.id);
        if (ev.taker === this.myPid) this.audio.pickup();
        break;
      }
      case 'badd':
        this.addBar(ev.bar, true);
        break;
      case 'bhp': {
        const bar = this.bars.get(ev.id);
        if (bar) bar.hp = ev.hp;
        this.scene.setBarricadeHp(ev.id, ev.hp);
        break;
      }
      case 'bgone': {
        const bar = this.bars.get(ev.id);
        if (bar) {
          this.effects.barricadeBreak(v3(bar.x, bar.y + 0.7, bar.z));
          const { d, p } = this.panDist(bar);
          this.audio.barBreak(d, p);
        }
        this.bars.delete(ev.id);
        this.scene.removeBarricade(ev.id);
        this.rebuildBarCols();
        break;
      }
      case 'note':
        if (ev.pid === this.myPid) this.hud.toast(ev.text);
        break;
      case 'bossin': {
        this.hud.addKillfeed(`⚠ ${this.roster.colored(BOSS_PID)} inbound`, true);
        this.hud.toast('⚠ GOLIATH INBOUND — team up! PvP damage is disabled until he dies');
        this.audio.rumbleStart();
        break;
      }
      case 'bossland': {
        this.audio.rumbleStop();
        this.effects.dustRing(ev.x, ev.z, 2.6);
        this.effects.dustRing(ev.x, ev.z, 4.2);
        const { d, p } = this.panDist({ x: ev.x, y: 0, z: ev.z });
        this.audio.bossLand(d, p);
        break;
      }
      case 'bossdie': {
        this.audio.rumbleStop(); // in case it was sniped out of the sky
        this.effects.explosion(v3(ev.x, 4.5, ev.z), true);
        const { d, p } = this.panDist({ x: ev.x, y: 4.5, z: ev.z });
        this.audio.explosion(d, p);
        this.hud.addKillfeed(`${this.roster.colored(BOSS_PID)} destroyed`, true);
        break;
      }
      case 'mfire': {
        this.bossView.addMissile(ev.m);
        const { d, p } = this.panDist({ x: ev.m.x, y: ev.m.y, z: ev.m.z });
        this.audio.missileLaunch(d, p);
        if (ev.tgt === this.myPid) {
          this.hud.toast('⚠ MISSILE LOCK — shoot it down or run');
          this.audio.lockWarn();
        }
        break;
      }
      case 'mboom': {
        this.bossView.removeMissile(ev.id);
        const pos = v3(ev.x, ev.y, ev.z);
        this.effects.explosion(pos);
        const { d, p } = this.panDist(pos);
        this.audio.explosion(d, p);
        break;
      }
    }
  }

  // ---------- per-frame ----------

  private frame(t: number): void {
    if (!this.running) return;
    requestAnimationFrame((tt) => this.frame(tt));
    let dt = (t - this.lastFrame) / 1000;
    this.lastFrame = t;
    if (dt > 0.25) dt = 0.25;
    this.fps = this.fps * 0.95 + (dt > 0 ? 1 / dt : 60) * 0.05;

    // fixed-step prediction
    this.acc += dt;
    while (this.acc >= CLIENT_STEP) {
      this.acc -= CLIENT_STEP;
      this.step();
    }

    // decay reconciliation error offset
    const decay = Math.exp(-10 * dt);
    this.errX *= decay;
    this.errY *= decay;
    this.errZ *= decay;

    const aiming = this.input.aimHeld && !this.placing && !this.isDead;
    const activeW = this.activeWeapon();
    const zoomed = aiming && activeW === 'sniper';
    this.input.sensScale = zoomed ? 0.32 : aiming ? 0.6 : 1;

    // own avatar (weapon stowed while readying a barricade)
    const myPose: PlayerPose = {
      x: this.pred.x + this.errX,
      y: this.pred.y + this.errY,
      z: this.pred.z + this.errZ,
      yaw: this.input.yaw,
      pit: this.input.pit,
      aim: aiming,
      alive: !this.isDead,
      weapon: this.placing ? 'bar' : activeW,
    };
    this.views.update(this.myPid, myPose, dt, false);
    this.views.setLocalVisible(this.myPid, !zoomed);

    // remote interpolation
    const rt = this.net.serverNow() - INTERP_DELAY_MS;
    for (const [pid, buf] of this.remotes) {
      while (buf.length > 2 && buf[1].t <= rt) buf.shift();
      if (buf.length === 0) continue;
      const a = buf[0];
      const b = buf.length > 1 ? buf[1] : a;
      const u = b.t > a.t ? clamp((rt - a.t) / (b.t - a.t), 0, 1) : 1;
      const pose: PlayerPose = {
        x: lerp(a.x, b.x, u),
        y: lerp(a.y, b.y, u),
        z: lerp(a.z, b.z, u),
        yaw: lerpAngle(a.yaw, b.yaw, u),
        pit: lerp(a.pit, b.pit, u),
        aim: b.aim === 1,
        alive: b.alive === 1,
        weapon: b.pl === 1 ? 'bar' : b.w,
      };
      this.views.update(pid, pose, dt, true);
    }

    // camera
    const eyeY = myPose.y + EYE_STAND;
    this.camera.update(
      dt,
      v3(myPose.x, eyeY, myPose.z),
      this.input.yaw,
      this.input.pit,
      aiming,
      zoomed,
      this.allSolids(),
    );

    this.bossView.update(dt, this.effects);
    this.hud.setCompass(this.input.yaw);
    this.hud.setBoss(this.bossView.hpFrac, this.bossView.state?.ph === 0);

    this.updateGhost();
    this.updatePromptAndHud(aiming, zoomed, activeW);
    this.effects.update(dt, this.allSolids(), this.targetCapsules());
    this.scene.animateLoot(t / 1000);
    this.updateDebug();

    this.scene.render(this.camera.cam);
  }

  private updateGhost(): void {
    if (!this.placing || this.isDead) {
      this.ghost.group.visible = false;
      this.hud.setPlacementMode(false);
      return;
    }
    const yaw = this.input.yaw;
    const fwd = dirFromYawPitch(yaw, 0);
    const gx = clamp(this.pred.x + fwd.x * BAR_PLACE_DISTANCE, -72, 72);
    const gz = clamp(this.pred.z + fwd.z * BAR_PLACE_DISTANCE, -72, 72);
    const res = validatePlacement(
      gx,
      gz,
      yaw,
      { x: this.pred.x, y: this.pred.y, z: this.pred.z, eye: EYE_STAND },
      this.statics,
      this.barCols,
      this.views.capsules(),
      -1,
    );
    this.ghostValid = res.ok;
    const y = res.ok ? res.y : groundSupportAt(this.statics, gx, gz, this.pred.y + 0.6, 0.2);
    this.ghostPos = { x: gx, y, z: gz, yaw };
    this.ghost.group.position.set(gx, y, gz);
    this.ghost.group.rotation.y = yaw;
    this.ghost.group.visible = true;
    this.ghost.mat.color.setHex(res.ok ? 0x7bc95f : 0xd95040);
    this.hud.setPlacementMode(true);
  }

  private updatePromptAndHud(aiming: boolean, zoomed: boolean, activeW: WeaponId | 0): void {
    // nearest weapon on the ground
    this.nearestWeaponLoot = null;
    let bestD = WEAPON_PICKUP_RADIUS;
    for (const item of this.loot.values()) {
      if (item.k !== 'w') continue;
      if (Math.abs(item.y - this.pred.y) > 2.5) continue;
      const d = dist2D(item.x, item.z, this.pred.x, this.pred.z);
      if (d < bestD) {
        bestD = d;
        this.nearestWeaponLoot = item;
      }
    }
    if (this.nearestWeaponLoot?.w && !this.isDead) {
      const def = WEAPONS[this.nearestWeaponLoot.w];
      this.hud.setPrompt(
        `<b>[E]</b> ${def.name} · ${this.nearestWeaponLoot.mag ?? def.mag}rd${
          (this.nearestWeaponLoot.res ?? 0) > 0 ? ` +${this.nearestWeaponLoot.res}` : ''
        }`,
      );
    } else {
      this.hud.setPrompt(null);
    }

    if (!this.you) return;
    const snow = this.net.serverNow();
    this.hud.setVitals(this.you.hp, (this.pred.stamina / STAM_MAX) * 100);
    this.hud.setConsumables(this.you.meds, this.you.kits);
    const reloading = this.you.rld > snow;
    const magOverride =
      this.you.slots[this.you.act] !== null
        ? Math.max(0, this.you.slots[this.you.act]!.mag - this.pendingShotCount())
        : null;
    const reserveAmmo =
      activeW === 0 ? 0 : this.you.res[WEAPONS[activeW].ammo];
    this.hud.setWeapon(this.you.slots, this.you.act, reserveAmmo, magOverride, reloading, this.placing);

    this.hud.setUseProgress(
      this.you.use > snow ? 1 - (this.you.use - snow) / MED_USE_MS : null,
    );
    const spawnProtected = this.you.inv > snow && !this.isDead;
    this.hud.setInvuln(spawnProtected);
    this.views.setSpawnProtected(this.myPid, spawnProtected);
    this.hud.setScope(zoomed);

    if (activeW !== 0 && !zoomed && !this.placing) {
      const speed = Math.hypot(this.pred.vx, this.pred.vz);
      const spread = computeSpread(WEAPONS[activeW], aiming, speed, this.pred.onGround);
      this.hud.setCrosshairSpread(spread, true);
    } else {
      this.hud.setCrosshairSpread(0, !zoomed && !this.placing);
    }

    if (this.isDead) {
      this.hud.setDeathCountdown(Math.max(0, (this.you.dead - snow) / 1000));
    }

    if (this.scoreboardOpen) {
      const rows: ScoreRow[] = this.lastPlayers
        .map((p) => ({ pid: p.id, name: this.roster.name(p.id), k: p.k, d: p.d, ping: p.ping }))
        .sort((a, b) => b.k - a.k || a.d - b.d);
      this.hud.setScoreboard(rows, this.myPid);
    } else {
      this.hud.setScoreboard(null, this.myPid);
    }
  }

  // introspection for tooling / automated smoke tests
  probe(): Record<string, unknown> {
    let nw: LootItem | null = null;
    let bd = Infinity;
    for (const item of this.loot.values()) {
      if (item.k !== 'w') continue;
      const d = dist2D(item.x, item.z, this.pred.x, this.pred.z);
      if (d < bd) {
        bd = d;
        nw = item;
      }
    }
    return {
      x: this.pred.x,
      y: this.pred.y,
      z: this.pred.z,
      yaw: this.input.yaw,
      loot: this.loot.size,
      nearestWeapon: nw
        ? { id: nw.id, x: nw.x, z: nw.z, d: dist2D(nw.x, nw.z, this.pred.x, this.pred.z) }
        : null,
      weapon: this.activeWeapon(),
      pendingShots: this.pendingShotCount(),
    };
  }

  private updateDebug(): void {
    if (!this.debug.visible) return;
    const now = performance.now();
    while (this.corrWindow.length > 0 && this.corrWindow[0] < now - 10_000) this.corrWindow.shift();
    this.debug.set({
      ping: `${this.net.rtt.toFixed(0)} ms (offset ${this.net.offsetMs.toFixed(0)} ms)`,
      'server tick': `${this.net.tpsReported.toFixed(1)} /s`,
      'client fps': `${this.fps.toFixed(0)}`,
      'pkts in/out': `${this.net.inPps} / ${this.net.outPps} per s`,
      'kb in/out': `${this.net.inKbps.toFixed(1)} / ${this.net.outKbps.toFixed(1)} per s`,
      pos: `${this.pred.x.toFixed(1)}, ${this.pred.y.toFixed(1)}, ${this.pred.z.toFixed(1)}`,
      vel: `${Math.hypot(this.pred.vx, this.pred.vz).toFixed(1)} u/s ${this.pred.onGround ? 'ground' : 'air'}`,
      'pending in': `${this.pending.length} cmds`,
      corrections: `${this.corrections} total · ${this.corrWindow.length}/10s · last ${(this.lastCorrMag * 100).toFixed(0)}cm`,
      entities: `${this.remotes.size} remote · ${this.effects.projectileCount} proj · ${this.loot.size} loot · ${this.bars.size} bars`,
    });
  }
}
