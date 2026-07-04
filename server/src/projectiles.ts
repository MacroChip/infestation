import { makeProjectile, stepProjectile, type ProjectileState } from '../../shared/projectile';
import type { BoxCollider, CapsuleTarget, CastHit } from '../../shared/collision';
import type { WeaponId } from '../../shared/types';
import type { V3 } from '../../shared/math';

export interface ProjectileHitHandlers {
  onPlayerHit(proj: ProjectileState, pid: number, hit: CastHit): void;
  onBarricadeHit(proj: ProjectileState, barId: number, hit: CastHit): void;
  onWorldHit(proj: ProjectileState, hit: CastHit): void;
  onExpire(proj: ProjectileState): void;
}

export class Projectiles {
  private list = new Map<number, ProjectileState>();
  private nextId = 1;

  get count(): number {
    return this.list.size;
  }

  spawn(owner: number, w: WeaponId, origin: V3, dir: V3): number {
    const id = this.nextId++;
    this.list.set(id, makeProjectile(id, owner, w, origin, dir));
    return id;
  }

  step(
    dt: number,
    solids: BoxCollider[],
    capsules: CapsuleTarget[],
    handlers: ProjectileHitHandlers,
  ): void {
    for (const p of this.list.values()) {
      const res = stepProjectile(p, dt, solids, capsules);
      if (res.hit) {
        const h = res.hit;
        if (h.kind === 'cap' && h.pid !== undefined) handlers.onPlayerHit(p, h.pid, h);
        else if (h.kind === 'box' && h.box && h.box.kind === 'bar')
          handlers.onBarricadeHit(p, h.box.id, h);
        else handlers.onWorldHit(p, h);
        this.list.delete(p.id);
      } else if (res.expired) {
        handlers.onExpire(p);
        this.list.delete(p.id);
      }
    }
  }
}
