import {
  AMMO_CAP,
  AMMO_PICKUP_AMOUNT,
  AMMO_TYPES,
  DROP_EXPIRE_MS,
  LOOT_RESPAWN_MAX_MS,
  LOOT_RESPAWN_MIN_MS,
  MAX_KITS,
  MAX_MEDS,
  PICKUP_RADIUS,
  type AmmoType,
} from '../../shared/constants';
import { LOOT_SPAWNS, type LootTable } from '../../shared/map';
import { groundSupportAt, type BoxCollider } from '../../shared/collision';
import { WEAPONS } from '../../shared/weapons';
import { dist2D, r2 } from '../../shared/math';
import type { GameEvent, LootItem, WeaponId } from '../../shared/types';

interface ServerLoot extends LootItem {
  expireAt: number; // 0 = map loot (never expires)
  spawnerIdx: number; // -1 = dropped loot
}

interface SpawnerState {
  itemId: number; // 0 = empty
  nextAt: number;
}

// Minimal view of a player the loot system needs.
export interface LootTaker {
  pid: number;
  alive: boolean;
  x: number;
  y: number;
  z: number;
  reserve: Record<AmmoType, number>;
  meds: number;
  kits: number;
}

const WEAPON_TABLE: [WeaponId, number][] = [
  ['ar', 0.3],
  ['smg', 0.3],
  ['shotgun', 0.25],
  ['sniper', 0.15],
];
const LONG_TABLE: [WeaponId, number][] = [
  ['sniper', 0.5],
  ['ar', 0.5],
];

function rollWeighted(table: [WeaponId, number][]): WeaponId {
  let roll = Math.random();
  for (const [w, p] of table) {
    roll -= p;
    if (roll <= 0) return w;
  }
  return table[table.length - 1][0];
}

export class Loot {
  items = new Map<number, ServerLoot>();
  private spawners: SpawnerState[] = [];
  private nextItemId = 1;

  constructor(private statics: BoxCollider[]) {}

  init(now: number, events: GameEvent[]): void {
    this.spawners = LOOT_SPAWNS.map(() => ({ itemId: 0, nextAt: now }));
    this.step(now, [], events);
  }

  list(): LootItem[] {
    return [...this.items.values()];
  }

  private surfaceY(x: number, z: number): number {
    return groundSupportAt(this.statics, x, z, 2, 0.2);
  }

  private rollItem(table: LootTable, x: number, z: number): ServerLoot {
    const id = this.nextItemId++;
    const y = r2(this.surfaceY(x, z));
    const base = { id, x: r2(x), y, z: r2(z), expireAt: 0, spawnerIdx: -1 };
    if (table === 'w' || table === 'wl') {
      const w = rollWeighted(table === 'w' ? WEAPON_TABLE : LONG_TABLE);
      return { ...base, k: 'w', w, mag: WEAPONS[w].mag, res: WEAPONS[w].pickupReserve };
    }
    if (table === 'a') {
      const at = AMMO_TYPES[Math.floor(Math.random() * AMMO_TYPES.length)];
      return { ...base, k: 'a', at, n: AMMO_PICKUP_AMOUNT[at] };
    }
    if (table === 'm') return { ...base, k: 'm', n: 1 };
    return { ...base, k: 'b', n: 1 };
  }

  addDrop(partial: Omit<LootItem, 'id'>, now: number): ServerLoot {
    const item: ServerLoot = {
      ...partial,
      id: this.nextItemId++,
      expireAt: now + DROP_EXPIRE_MS,
      spawnerIdx: -1,
    };
    this.items.set(item.id, item);
    return item;
  }

  remove(id: number): void {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    if (item.spawnerIdx >= 0) {
      this.spawners[item.spawnerIdx] = {
        itemId: 0,
        nextAt:
          Date.now() +
          LOOT_RESPAWN_MIN_MS +
          Math.random() * (LOOT_RESPAWN_MAX_MS - LOOT_RESPAWN_MIN_MS),
      };
    }
  }

  // Grant a consumable item to a player. Returns true if anything was taken.
  applyConsumable(p: LootTaker, item: LootItem): boolean {
    if (item.k === 'a' && item.at) {
      const cap = AMMO_CAP[item.at];
      const gained = Math.min(cap - p.reserve[item.at], item.n ?? 0);
      if (gained <= 0) return false;
      p.reserve[item.at] += gained;
      return true;
    }
    if (item.k === 'm') {
      if (p.meds >= MAX_MEDS) return false;
      p.meds += 1;
      return true;
    }
    if (item.k === 'b') {
      if (p.kits >= MAX_KITS) return false;
      p.kits += 1;
      return true;
    }
    return false;
  }

  step(now: number, takers: LootTaker[], events: GameEvent[]): void {
    // respawn map loot
    for (let i = 0; i < this.spawners.length; i++) {
      const s = this.spawners[i];
      if (s.itemId === 0 && now >= s.nextAt) {
        const def = LOOT_SPAWNS[i];
        const item = this.rollItem(def.table, def.x, def.z);
        item.spawnerIdx = i;
        s.itemId = item.id;
        this.items.set(item.id, item);
        events.push({ t: 'ladd', item });
      }
    }
    // expire dropped loot
    for (const item of this.items.values()) {
      if (item.expireAt !== 0 && now >= item.expireAt) {
        this.remove(item.id);
        events.push({ t: 'lgone', id: item.id });
      }
    }
    // proximity auto-pickup for consumables
    for (const p of takers) {
      if (!p.alive) continue;
      for (const item of this.items.values()) {
        if (item.k === 'w') continue;
        if (Math.abs(item.y - p.y) > 2.2) continue;
        if (dist2D(item.x, item.z, p.x, p.z) > PICKUP_RADIUS) continue;
        if (this.applyConsumable(p, item)) {
          this.remove(item.id);
          events.push({ t: 'lgone', id: item.id, taker: p.pid });
        }
      }
    }
  }
}
