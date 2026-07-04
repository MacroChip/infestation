import { BAR_HP } from '../../shared/constants';
import { barricadeCollider } from '../../shared/barricade';
import type { BoxCollider } from '../../shared/collision';
import type { BarricadeState, GameEvent } from '../../shared/types';

export class Barricades {
  private map = new Map<number, BarricadeState>();
  private nextId = 1;
  private cache: BoxCollider[] | null = null;

  get count(): number {
    return this.map.size;
  }

  list(): BarricadeState[] {
    return [...this.map.values()];
  }

  colliders(): BoxCollider[] {
    if (!this.cache) this.cache = this.list().map(barricadeCollider);
    return this.cache;
  }

  add(x: number, y: number, z: number, yaw: number): BarricadeState {
    const bar: BarricadeState = { id: this.nextId++, x, y, z, yaw, hp: BAR_HP };
    this.map.set(bar.id, bar);
    this.cache = null;
    return bar;
  }

  // returns events describing what happened (hp update or destruction)
  damage(id: number, dmg: number): GameEvent[] {
    const bar = this.map.get(id);
    if (!bar) return [];
    bar.hp = Math.max(0, Math.round(bar.hp - dmg));
    if (bar.hp <= 0) {
      this.map.delete(id);
      this.cache = null;
      return [{ t: 'bgone', id }];
    }
    return [{ t: 'bhp', id, hp: bar.hp }];
  }
}
