// Authoritative simulation. Owns health, damage, inventory, pickups,
// drops, projectiles, barricades and respawns. Clients only ever send
// inputs; everything gameplay-visible flows back out through snapshots.

import type { WebSocket } from 'ws';
import {
  AMMO_CAP,
  AMMO_TYPES,
  BAR_MAX_COUNT,
  BAR_PLACE_COOLDOWN_MS,
  BOSS_PID,
  DEV_HURT_DMG,
  EYE_STAND,
  HP_MAX,
  MAX_INPUT_DT,
  MAX_PLAYERS,
  MED_HEAL,
  MED_USE_MS,
  PLAYER_COLORS,
  RESPAWN_MS,
  SPAWN_INVULN_MS,
  STAM_MAX,
  STAND_HEIGHT,
  SWAP_FIRE_LOCKOUT_MS,
  CAPSULE_RADIUS,
  TICK_DT,
  TICK_RATE,
  WEAPON_PICKUP_RADIUS,
  type AmmoType,
} from '../../shared/constants';
import { buildStaticColliders, SPAWN_POINTS } from '../../shared/map';
import { stepMove, type MoveState } from '../../shared/movement';
import { computeSpread, pelletDirs, WEAPONS } from '../../shared/weapons';
import { validatePlacement } from '../../shared/barricade';
import type { BoxCollider, CapsuleTarget, CastHit } from '../../shared/collision';
import { addScaled, clamp, dirFromYawPitch, dist2D, r2, r3, v3 } from '../../shared/math';
import type { ProjectileState } from '../../shared/projectile';
import type {
  ClientMsg,
  GameEvent,
  InputCmd,
  LootItem,
  PlayerPublic,
  ServerMsg,
  SlotState,
  YouState,
} from '../../shared/types';
import { Barricades } from './barricades';
import { Boss, type BossTarget } from './boss';
import { Loot, type LootTaker } from './loot';
import { Projectiles } from './projectiles';

const zeroReserve = (): Record<AmmoType, number> => ({ rifle: 0, smg: 0, shell: 0, long: 0 });

interface SPlayer {
  pid: number;
  ws: WebSocket;
  name: string;
  color: number;
  move: MoveState;
  yaw: number;
  pit: number;
  placing: boolean; // readying a barricade: weapon stowed, firing disabled
  aim: boolean;
  hp: number;
  alive: boolean;
  deadUntil: number;
  invulnUntil: number;
  slots: [SlotState | null, SlotState | null];
  act: 0 | 1;
  reserve: Record<AmmoType, number>;
  meds: number;
  kits: number;
  reloadEnd: number;
  useEnd: number;
  nextFire: number;
  lastPlaceAt: number;
  k: number;
  d: number;
  ping: number;
  lastAck: number;
  inputQ: InputCmd[];
}

export class Game {
  players = new Map<number, SPlayer>();
  private statics: BoxCollider[] = buildStaticColliders();
  private bars = new Barricades();
  private loot = new Loot(this.statics);
  private projs = new Projectiles();
  private boss = new Boss();
  private events: GameEvent[] = [];
  private nextPid = 1;
  private tick = 0;
  private lastStepAt = 0;
  tps = TICK_RATE;
  bytesOut = 0;
  msgsOut = 0;

  constructor() {
    this.loot.init(Date.now(), this.events);
    this.events.length = 0; // initial fill goes out via welcome, not events
  }

  get playerCount(): number {
    return this.players.size;
  }
  get projectileCount(): number {
    return this.projs.count;
  }
  get barricadeCount(): number {
    return this.bars.count;
  }
  get lootCount(): number {
    return this.loot.items.size;
  }

  private solids(): BoxCollider[] {
    return [...this.statics, ...this.bars.colliders()];
  }

  private capsules(excludeInvuln: boolean, now: number): CapsuleTarget[] {
    const out: CapsuleTarget[] = [];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (excludeInvuln && p.invulnUntil > now) continue;
      out.push({
        pid: p.pid,
        x: p.move.x,
        y: p.move.y,
        z: p.move.z,
        r: CAPSULE_RADIUS,
        h: STAND_HEIGHT,
      });
    }
    return out;
  }

  // ---- lifecycle ----

  addPlayer(ws: WebSocket, name: string): SPlayer | null {
    if (this.players.size >= MAX_PLAYERS) return null;
    const pid = this.nextPid++;
    const p: SPlayer = {
      pid,
      ws,
      name: name.slice(0, 16) || `Drifter-${pid}`,
      color: PLAYER_COLORS[(pid - 1) % PLAYER_COLORS.length],
      move: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true, stamina: STAM_MAX, stamCd: 0 },
      yaw: 0,
      pit: 0,
      placing: false,
      aim: false,
      hp: HP_MAX,
      alive: false,
      deadUntil: 0,
      invulnUntil: 0,
      slots: [null, null],
      act: 0,
      reserve: zeroReserve(),
      meds: 0,
      kits: 0,
      reloadEnd: 0,
      useEnd: 0,
      nextFire: 0,
      lastPlaceAt: 0,
      k: 0,
      d: 0,
      ping: 0,
      lastAck: 0,
      inputQ: [],
    };
    this.players.set(pid, p);
    this.respawn(p, Date.now());
    this.events.push({ t: 'join', pid, name: p.name, color: p.color });

    const welcome: ServerMsg = {
      t: 'welcome',
      pid,
      time: Date.now(),
      tickRate: TICK_RATE,
      roster: [...this.players.values()].map((q) => ({ pid: q.pid, name: q.name, color: q.color })),
      loot: this.loot.list(),
      bars: this.bars.list(),
      scores: [...this.players.values()].map((q) => ({ pid: q.pid, k: q.k, d: q.d })),
    };
    this.sendTo(p, welcome);
    return p;
  }

  removePlayer(pid: number): void {
    if (this.players.delete(pid)) this.events.push({ t: 'leave', pid });
  }

  handleMessage(p: SPlayer, msg: ClientMsg): void {
    if (msg.t === 'in') {
      if (!Array.isArray(msg.cmds)) return;
      for (const cmd of msg.cmds) {
        if (typeof cmd?.seq !== 'number') continue;
        p.inputQ.push(cmd);
      }
      if (p.inputQ.length > 30) p.inputQ.splice(0, p.inputQ.length - 30);
    } else if (msg.t === 'ping') {
      p.ping = clamp(Math.round(msg.rtt ?? 0), 0, 999);
      this.sendTo(p, { t: 'pong', t0: msg.t0, st: Date.now() });
    }
  }

  private respawn(p: SPlayer, now: number): void {
    let best = SPAWN_POINTS[0];
    let bestScore = -Infinity;
    for (const s of SPAWN_POINTS) {
      let minDist = Infinity;
      for (const q of this.players.values()) {
        if (q.pid === p.pid || !q.alive) continue;
        minDist = Math.min(minDist, dist2D(s.x, s.z, q.move.x, q.move.z));
      }
      const score = (minDist === Infinity ? 100 : minDist) + Math.random() * 8;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    p.move = {
      x: best.x, y: 0, z: best.z,
      vx: 0, vy: 0, vz: 0,
      onGround: true, stamina: STAM_MAX, stamCd: 0,
    };
    p.yaw = best.yaw;
    p.pit = 0;
    p.hp = HP_MAX;
    p.alive = true;
    p.deadUntil = 0;
    p.invulnUntil = now + SPAWN_INVULN_MS;
    p.slots = [null, null];
    p.act = 0;
    p.reserve = zeroReserve();
    p.meds = 1;
    p.kits = 1; // one barricade kit on spawn so cover play is always available
    p.reloadEnd = 0;
    p.useEnd = 0;
    p.nextFire = 0;
    p.placing = false;
    p.inputQ = [];
    this.events.push({ t: 'spawn', pid: p.pid, x: r2(best.x), y: 0, z: r2(best.z) });
  }

  // ---- input processing ----

  private sanitize(cmd: InputCmd): InputCmd | null {
    const n = (v: unknown, lo: number, hi: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : 0;
    return {
      seq: cmd.seq,
      dt: n(cmd.dt, 0.001, MAX_INPUT_DT),
      mx: n(cmd.mx, -1, 1),
      mz: n(cmd.mz, -1, 1),
      yaw: n(cmd.yaw, -100, 100),
      pit: n(cmd.pit, -1.5, 1.5),
      sp: cmd.sp === 1 ? 1 : 0,
      jp: cmd.jp === 1 ? 1 : 0,
      aim: cmd.aim === 1 ? 1 : 0,
      pl: cmd.pl === 1 ? 1 : 0,
      fire: Array.isArray(cmd.fire) ? cmd.fire.slice(0, 4) : undefined,
      rld: cmd.rld,
      swap: cmd.swap === 0 || cmd.swap === 1 ? cmd.swap : undefined,
      use: cmd.use,
      pick: typeof cmd.pick === 'number' ? cmd.pick : undefined,
      place: cmd.place,
      hurt: cmd.hurt === 1 ? 1 : undefined,
      summon: cmd.summon === 1 ? 1 : undefined,
    };
  }

  private processCmd(p: SPlayer, raw: InputCmd, now: number): void {
    const cmd = this.sanitize(raw);
    if (!cmd) return;
    p.lastAck = cmd.seq;
    if (!p.alive) return;

    p.yaw = cmd.yaw;
    p.pit = cmd.pit;
    p.placing = cmd.pl === 1;
    p.aim = cmd.aim === 1;

    if (cmd.swap !== undefined && cmd.swap !== p.act && p.slots[cmd.swap]) {
      p.act = cmd.swap;
      p.reloadEnd = 0;
      p.nextFire = Math.max(p.nextFire, now + SWAP_FIRE_LOCKOUT_MS);
      const slot = p.slots[p.act];
      if (slot) {
        const def = WEAPONS[slot.w];
        if (slot.mag <= 0 && p.reserve[def.ammo] > 0) this.tryReload(p, now);
      }
    }
    if (cmd.rld === 1) this.tryReload(p, now);
    if (cmd.use === 1) this.tryUseMedkit(p, now);
    if (cmd.pick !== undefined) this.tryPickup(p, cmd.pick, now);
    if (cmd.place) this.tryPlace(p, cmd.place, now);
    if (cmd.hurt === 1) {
      p.invulnUntil = 0; // dev helper must work right after spawning
      this.damagePlayer(p.pid, DEV_HURT_DMG, p.pid, 0, now);
      if (!p.alive) return;
    }
    if (cmd.summon === 1) {
      if (!this.boss.trySummon(this.events, this.players.size)) {
        this.events.push({ t: 'note', pid: p.pid, text: 'GOLIATH is already deployed' });
      }
    }

    stepMove(p.move, cmd, this.solids());

    if (cmd.fire && !p.placing) {
      for (const fc of cmd.fire) this.tryFire(p, fc, now);
    }
  }

  private tryReload(p: SPlayer, now: number): void {
    const slot = p.slots[p.act];
    if (!slot || p.reloadEnd > 0) return;
    const def = WEAPONS[slot.w];
    if (slot.mag >= def.mag || p.reserve[def.ammo] <= 0) return;
    p.reloadEnd = now + def.reload * 1000;
  }

  private tryUseMedkit(p: SPlayer, now: number): void {
    if (p.meds <= 0 || p.hp >= HP_MAX || p.useEnd > now) return;
    p.meds -= 1;
    p.hp = Math.min(HP_MAX, p.hp + MED_HEAL);
    p.useEnd = now + MED_USE_MS;
  }

  private tryFire(p: SPlayer, fc: { sid: number; yaw: number; pit: number }, now: number): void {
    const slot = p.slots[p.act];
    if (!slot || p.reloadEnd > 0) return;
    const def = WEAPONS[slot.w];
    if (now < p.nextFire - 8) return;
    if (slot.mag <= 0) return;
    if (typeof fc.yaw !== 'number' || typeof fc.pit !== 'number' || typeof fc.sid !== 'number')
      return;
    if (!Number.isFinite(fc.yaw) || !Number.isFinite(fc.pit)) return;

    slot.mag -= 1;
    p.nextFire = now + def.interval * 1000 * 0.88;
    if (slot.mag <= 0 && p.reserve[def.ammo] > 0) p.reloadEnd = now + def.reload * 1000;
    p.invulnUntil = 0; // firing drops spawn protection

    const pit = clamp(fc.pit, -1.5, 1.5);
    const speed = Math.hypot(p.move.vx, p.move.vz);
    const spread = computeSpread(def, p.aim, speed, p.move.onGround);
    const dirs = pelletDirs(def, fc.yaw, pit, fc.sid, spread);
    const center = dirFromYawPitch(fc.yaw, pit);
    const eye = v3(p.move.x, p.move.y + EYE_STAND, p.move.z);
    const origin = addScaled(eye, center, 0.3);

    const ids: number[] = [];
    for (const dir of dirs) ids.push(this.projs.spawn(p.pid, slot.w, origin, dir));

    this.events.push({
      t: 'shot',
      pid: p.pid,
      w: slot.w,
      sid: fc.sid,
      spr: r3(spread),
      ox: r2(origin.x),
      oy: r2(origin.y),
      oz: r2(origin.z),
      yaw: r3(fc.yaw),
      pit: r3(pit),
      ids,
    });
  }

  private tryPickup(p: SPlayer, itemId: number, now: number): void {
    const item = this.loot.items.get(itemId);
    if (!item) return;
    // generous tolerance over the client prompt radius: the player may have
    // sprinted ~2 ticks past the item between pressing E and us processing it
    if (dist2D(item.x, item.z, p.move.x, p.move.z) > WEAPON_PICKUP_RADIUS + 1.0) return;
    if (Math.abs(item.y - p.move.y) > 2.5) return;

    if (item.k === 'w' && item.w) {
      const idx: 0 | 1 = p.slots[0] === null ? 0 : p.slots[1] === null ? 1 : p.act;
      const existing = p.slots[idx];
      if (existing) {
        // swap: current weapon goes to the ground with its loaded mag
        const dropped = this.loot.addDrop(
          {
            k: 'w',
            w: existing.w,
            mag: existing.mag,
            res: 0,
            x: r2(p.move.x),
            y: r2(Math.max(0, p.move.y)),
            z: r2(p.move.z),
          },
          now,
        );
        this.events.push({ t: 'ladd', item: dropped });
      }
      p.slots[idx] = { w: item.w, mag: item.mag ?? WEAPONS[item.w].mag };
      const at = WEAPONS[item.w].ammo;
      p.reserve[at] = Math.min(p.reserve[at] + (item.res ?? 0), AMMO_CAP[at]);
      p.act = idx;
      p.reloadEnd = 0;
      p.nextFire = Math.max(p.nextFire, now + SWAP_FIRE_LOCKOUT_MS);
      this.loot.remove(item.id);
      this.events.push({ t: 'lgone', id: item.id, taker: p.pid });
    } else {
      if (this.loot.applyConsumable(this.asTaker(p), item)) {
        this.loot.remove(item.id);
        this.events.push({ t: 'lgone', id: item.id, taker: p.pid });
      }
    }
  }

  private tryPlace(p: SPlayer, place: { x: number; z: number; yaw: number }, now: number): void {
    const note = (text: string): void => {
      this.events.push({ t: 'note', pid: p.pid, text });
    };
    if (p.kits <= 0) return note('No barricade kits');
    if (now - p.lastPlaceAt < BAR_PLACE_COOLDOWN_MS) return;
    if (this.bars.count >= BAR_MAX_COUNT) return note('Barricade limit reached');
    if (
      !Number.isFinite(place.x) || !Number.isFinite(place.z) || !Number.isFinite(place.yaw)
    )
      return;

    const res = validatePlacement(
      place.x,
      place.z,
      place.yaw,
      { x: p.move.x, y: p.move.y, z: p.move.z, eye: EYE_STAND },
      this.statics,
      this.bars.colliders(),
      this.capsules(false, now),
      -1,
    );
    if (!res.ok) return note(`Can't place: ${res.reason}`);

    p.kits -= 1;
    p.lastPlaceAt = now;
    // re-drawing the stowed weapon takes as long as a weapon swap
    p.nextFire = Math.max(p.nextFire, now + SWAP_FIRE_LOCKOUT_MS);
    const bar = this.bars.add(r2(place.x), r2(res.y), r2(place.z), r3(place.yaw));
    this.events.push({ t: 'badd', bar });
  }

  // ---- combat resolution ----

  private damagePlayer(victimPid: number, dmg: number, attackerPid: number, w: LootItem['w'] | 0, now: number): void {
    const victim = this.players.get(victimPid);
    if (!victim || !victim.alive || victim.invulnUntil > now) return;
    victim.hp = Math.max(0, victim.hp - dmg);
    this.events.push({ t: 'hit', v: victimPid, a: attackerPid, dmg });
    if (victim.hp > 0) return;

    victim.alive = false;
    victim.deadUntil = now + RESPAWN_MS;
    victim.reloadEnd = 0;
    victim.useEnd = 0;
    victim.d += 1;
    const attacker = this.players.get(attackerPid);
    if (attacker && attacker.pid !== victimPid) attacker.k += 1;
    this.events.push({ t: 'kill', v: victimPid, a: attackerPid, w: w ?? 0 });
    this.dropAllLoot(victim, now);
  }

  private dropAllLoot(p: SPlayer, now: number): void {
    const drops: Omit<LootItem, 'id'>[] = [];
    const reserveLeft = { ...p.reserve };
    for (const slot of p.slots) {
      if (!slot) continue;
      const at = WEAPONS[slot.w].ammo;
      drops.push({ k: 'w', w: slot.w, mag: slot.mag, res: reserveLeft[at], x: 0, y: 0, z: 0 });
      reserveLeft[at] = 0;
    }
    for (const at of AMMO_TYPES) {
      if (reserveLeft[at] > 0) drops.push({ k: 'a', at, n: reserveLeft[at], x: 0, y: 0, z: 0 });
    }
    for (let i = 0; i < p.meds; i++) drops.push({ k: 'm', n: 1, x: 0, y: 0, z: 0 });
    for (let i = 0; i < p.kits; i++) drops.push({ k: 'b', n: 1, x: 0, y: 0, z: 0 });

    drops.forEach((d, i) => {
      const ang = i * 2.39996; // golden-angle scatter
      const rad = 0.5 + (i % 3) * 0.35;
      d.x = r2(clamp(p.move.x + Math.cos(ang) * rad, -72, 72));
      d.z = r2(clamp(p.move.z + Math.sin(ang) * rad, -72, 72));
      d.y = r2(Math.max(0, p.move.y));
      d.sx = r2(p.move.x);
      d.sy = r2(Math.max(0, p.move.y) + 0.9);
      d.sz = r2(p.move.z);
      const item = this.loot.addDrop(d, now);
      this.events.push({ t: 'ladd', item });
    });

    p.slots = [null, null];
    p.reserve = zeroReserve();
    p.meds = 0;
    p.kits = 0;
  }

  // The taker proxies meds/kits back onto the real player. reserve is already
  // an object shared by reference, but meds/kits are primitives - without the
  // accessors below, applyConsumable would mutate a throwaway copy and picked-up
  // medkits / barricade kits would silently vanish.
  private asTaker(p: SPlayer): LootTaker {
    return {
      pid: p.pid,
      alive: p.alive,
      x: p.move.x,
      y: p.move.y,
      z: p.move.z,
      reserve: p.reserve,
      get meds() {
        return p.meds;
      },
      set meds(v: number) {
        p.meds = v;
      },
      get kits() {
        return p.kits;
      },
      set kits(v: number) {
        p.kits = v;
      },
    };
  }

  // ---- tick ----

  step(): void {
    const now = Date.now();
    if (this.lastStepAt > 0) {
      const real = (now - this.lastStepAt) / 1000;
      if (real > 0) this.tps = this.tps * 0.9 + (1 / real) * 0.1;
    }
    this.lastStepAt = now;
    this.tick += 1;

    // player inputs
    for (const p of this.players.values()) {
      const batch = p.inputQ.splice(0, 6);
      for (const cmd of batch) this.processCmd(p, cmd, now);

      // timed completions
      if (p.alive && p.reloadEnd > 0 && now >= p.reloadEnd) {
        const slot = p.slots[p.act];
        p.reloadEnd = 0;
        if (slot) {
          const def = WEAPONS[slot.w];
          const want = def.mag - slot.mag;
          const take = Math.min(want, p.reserve[def.ammo]);
          slot.mag += take;
          p.reserve[def.ammo] -= take;
        }
      }
      if (p.alive && p.useEnd > 0 && now >= p.useEnd) p.useEnd = 0;
      if (!p.alive && p.deadUntil > 0 && now >= p.deadUntil) this.respawn(p, now);
    }

    // boss + its missiles (before projectiles so bullets see fresh capsules)
    const solids = this.solids();
    const bossTargets: BossTarget[] = [...this.players.values()].map((q) => ({
      pid: q.pid,
      alive: q.alive,
      x: q.move.x,
      y: q.move.y,
      z: q.move.z,
    }));
    const bossDamage = (pid: number, dmg: number): void =>
      this.damagePlayer(pid, dmg, BOSS_PID, 0, now);
    this.boss.step(TICK_DT, now, solids, bossTargets, this.events, bossDamage);

    // authoritative projectiles
    const capsules = [...this.capsules(true, now), ...this.boss.bulletTargets()];
    this.projs.step(TICK_DT, solids, capsules, {
      onPlayerHit: (proj: ProjectileState, pid: number, hit: CastHit) => {
        if (pid < 0) {
          // reserved pids: boss body or a missile - metal, not flesh
          this.pushImpact(proj, hit, 'w');
          this.boss.onBulletHit(pid, WEAPONS[proj.w].dmg, bossTargets, this.events, bossDamage);
          return;
        }
        this.pushImpact(proj, hit, 'p');
        this.damagePlayer(pid, WEAPONS[proj.w].dmg, proj.owner, proj.w, now);
      },
      onBarricadeHit: (proj: ProjectileState, barId: number, hit: CastHit) => {
        this.pushImpact(proj, hit, 'b');
        const def = WEAPONS[proj.w];
        this.events.push(...this.bars.damage(barId, def.dmg * def.barricadeMult));
      },
      onWorldHit: (proj: ProjectileState, hit: CastHit) => {
        this.pushImpact(proj, hit, hit.kind === 'ground' ? 'g' : 'w');
      },
      onExpire: (proj: ProjectileState) => {
        this.events.push({
          t: 'imp', id: proj.id, x: r2(proj.x), y: r2(proj.y), z: r2(proj.z), k: 'e',
        });
      },
    });

    // loot: respawns, expiry, auto-pickup
    this.loot.step(
      now,
      [...this.players.values()].map((p) => this.asTaker(p)),
      this.events,
    );

    this.broadcast(now);
    this.events.length = 0;
  }

  private pushImpact(proj: ProjectileState, hit: CastHit, k: 'p' | 'b' | 'g' | 'w'): void {
    this.events.push({ t: 'imp', id: proj.id, x: r2(hit.x), y: r2(hit.y), z: r2(hit.z), k });
  }

  // ---- snapshots ----

  private buildPublic(): PlayerPublic[] {
    const arr: PlayerPublic[] = [];
    for (const p of this.players.values()) {
      arr.push({
        id: p.pid,
        x: r2(p.move.x),
        y: r2(p.move.y),
        z: r2(p.move.z),
        yaw: r3(p.yaw),
        pit: r3(p.pit),
        hp: Math.round(p.hp),
        alive: p.alive ? 1 : 0,
        aim: p.aim ? 1 : 0,
        w: p.slots[p.act]?.w ?? 0,
        pl: p.placing ? 1 : 0,
        k: p.k,
        d: p.d,
        ping: p.ping,
      });
    }
    return arr;
  }

  private buildYou(p: SPlayer): YouState {
    return {
      ack: p.lastAck,
      x: p.move.x,
      y: p.move.y,
      z: p.move.z,
      vx: r3(p.move.vx),
      vy: r3(p.move.vy),
      vz: r3(p.move.vz),
      og: p.move.onGround ? 1 : 0,
      st: r2(p.move.stamina),
      stcd: r3(p.move.stamCd),
      hp: Math.round(p.hp),
      slots: [
        p.slots[0] ? { w: p.slots[0].w, mag: p.slots[0].mag } : null,
        p.slots[1] ? { w: p.slots[1].w, mag: p.slots[1].mag } : null,
      ],
      act: p.act,
      res: { ...p.reserve },
      meds: p.meds,
      kits: p.kits,
      rld: p.reloadEnd,
      use: p.useEnd,
      dead: p.alive ? 0 : p.deadUntil,
      inv: p.invulnUntil,
    };
  }

  private broadcast(now: number): void {
    const players = this.buildPublic();
    const boss = this.boss.publicState();
    const ms = this.boss.missilesPublic();
    const hasNotes = this.events.some((e) => e.t === 'note');
    const publicEvents = hasNotes ? this.events.filter((e) => e.t !== 'note') : this.events;
    for (const p of this.players.values()) {
      let ev = publicEvents;
      if (hasNotes) {
        ev = this.events.filter((e) => e.t !== 'note' || e.pid === p.pid);
      }
      const msg: ServerMsg = {
        t: 'snap',
        tick: this.tick,
        time: now,
        tps: Math.round(this.tps * 10) / 10,
        players,
        you: this.buildYou(p),
        boss,
        ms: ms.length > 0 ? ms : undefined,
        ev: ev.length > 0 ? ev : undefined,
      };
      this.sendTo(p, msg);
    }
  }

  private sendTo(p: SPlayer, msg: ServerMsg): void {
    if (p.ws.readyState !== 1) return;
    const data = JSON.stringify(msg);
    this.bytesOut += data.length;
    this.msgsOut += 1;
    p.ws.send(data);
  }
}
