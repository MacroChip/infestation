// Dummy-client load test: spawns N bot connections that wander the map,
// pick up weapons, shoot at the nearest player, occasionally place
// barricades and use medkits. Exercises nearly every server code path.
//
//   npm run loadtest                        8 bots against localhost
//   npm run loadtest -- --bots 12 --seconds 30 --url ws://host:8081

import WebSocket from 'ws';
import { BAR_PLACE_DISTANCE, PROTOCOL_VERSION } from '../shared/constants';
import type { ClientMsg, InputCmd, LootItem, PlayerPublic, ServerMsg, YouState } from '../shared/types';

interface Args {
  bots: number;
  url: string;
  seconds: number;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    bots: Number(get('--bots') ?? 8),
    url: get('--url') ?? 'ws://localhost:8081',
    seconds: Number(get('--seconds') ?? 0), // 0 = run until ctrl-c
  };
}

const stats = {
  msgsIn: 0,
  bytesIn: 0,
  msgsOut: 0,
  killsSeen: 0,
  deaths: 0,
  shotsFired: 0,
  barricadesPlaced: 0,
  pickupsTried: 0,
};

class Bot {
  private ws: WebSocket;
  private pid = 0;
  private seq = 0;
  private sid = 1;
  private you: YouState | null = null;
  private players: PlayerPublic[] = [];
  private loot = new Map<number, LootItem>();
  private wp = { x: 0, z: 0 };
  private wpUntil = 0;
  private burstLeft = 0;
  private nextFireAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private idx: number, url: string) {
    this.pickWaypoint();
    this.ws = new WebSocket(url);
    this.ws.on('open', () => {
      this.send({ t: 'hello', v: PROTOCOL_VERSION, name: `Bot-${String(idx + 1).padStart(2, '0')}` });
      this.timer = setInterval(() => this.tick(), 1000 / 30);
    });
    this.ws.on('message', (data) => {
      stats.msgsIn += 1;
      stats.bytesIn += (data as Buffer).length;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        this.pid = msg.pid;
        for (const item of msg.loot) this.loot.set(item.id, item);
      } else if (msg.t === 'snap') {
        this.you = msg.you;
        this.players = msg.players;
        if (msg.ev) {
          for (const ev of msg.ev) {
            if (ev.t === 'ladd') this.loot.set(ev.item.id, ev.item);
            else if (ev.t === 'lgone') this.loot.delete(ev.id);
            else if (ev.t === 'kill') {
              stats.killsSeen += 1;
              if (ev.v === this.pid) stats.deaths += 1;
            }
          }
        }
      }
    });
    this.ws.on('close', () => this.timer && clearInterval(this.timer));
    this.ws.on('error', (err) => console.error(`bot ${idx}: ${err.message}`));
  }

  private send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      stats.msgsOut += 1;
      this.ws.send(JSON.stringify(msg));
    }
  }

  private pickWaypoint(): void {
    this.wp = { x: (Math.random() - 0.5) * 120, z: (Math.random() - 0.5) * 120 };
    this.wpUntil = Date.now() + 4000 + Math.random() * 6000;
  }

  private tick(): void {
    if (!this.you) return;
    const now = Date.now();
    const me = this.you;
    const alive = me.dead === 0;

    if (now > this.wpUntil || Math.hypot(this.wp.x - me.x, this.wp.z - me.z) < 4) {
      this.pickWaypoint();
    }

    // steer toward waypoint
    const dx = this.wp.x - me.x;
    const dz = this.wp.z - me.z;
    const dl = Math.hypot(dx, dz) || 1;
    const mx = dx / dl;
    const mz = dz / dl;
    const yaw = Math.atan2(-mx, -mz);

    const cmd: InputCmd = {
      seq: ++this.seq,
      dt: 1 / 30,
      mx,
      mz,
      yaw,
      pit: 0,
      sp: Math.random() < 0.55 ? 1 : 0,
      jp: Math.random() < 0.012 ? 1 : 0,
      aim: 0,
    };

    if (alive) {
      const hasWeapon = me.slots[me.act] !== null;

      // grab nearby weapons
      if (!hasWeapon || Math.random() < 0.02) {
        for (const item of this.loot.values()) {
          if (item.k !== 'w') continue;
          if (Math.hypot(item.x - me.x, item.z - me.z) < 2.0) {
            cmd.pick = item.id;
            stats.pickupsTried += 1;
            break;
          }
        }
      }

      // shoot at nearest living player
      const slot = me.slots[me.act];
      if (slot && slot.mag > 0) {
        let target: PlayerPublic | null = null;
        let bestD = 65;
        for (const p of this.players) {
          if (p.id === this.pid || p.alive === 0) continue;
          const d = Math.hypot(p.x - me.x, p.z - me.z);
          if (d < bestD) {
            bestD = d;
            target = p;
          }
        }
        if (target && this.burstLeft <= 0 && Math.random() < 0.05) {
          this.burstLeft = 2 + Math.floor(Math.random() * 5);
        }
        if (target && this.burstLeft > 0 && now >= this.nextFireAt) {
          this.burstLeft -= 1;
          this.nextFireAt = now + 140;
          const tx = target.x - me.x;
          const tz = target.z - me.z;
          const ty = target.y + 1.2 - (me.y + 1.6);
          const tYaw = Math.atan2(-tx, -tz) + (Math.random() - 0.5) * 0.06;
          const tPit = Math.atan2(ty, Math.hypot(tx, tz)) + (Math.random() - 0.5) * 0.04;
          cmd.fire = [{ sid: this.sid++, yaw: tYaw, pit: tPit }];
          cmd.yaw = tYaw;
          stats.shotsFired += 1;
        }
        if (slot.mag === 0) cmd.rld = 1;
      } else if (slot && slot.mag === 0) {
        cmd.rld = 1;
      }

      if (me.kits > 0 && Math.random() < 0.004) {
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        cmd.place = { x: me.x + fx * BAR_PLACE_DISTANCE, z: me.z + fz * BAR_PLACE_DISTANCE, yaw };
        stats.barricadesPlaced += 1;
      }
      if (me.meds > 0 && me.hp < 45 && me.use === 0 && Math.random() < 0.3) {
        cmd.use = 1;
        cmd.sp = 0;
      }
    }

    this.send({ t: 'in', cmds: [cmd] });
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.ws.close();
  }
}

const args = parseArgs();
console.log(`spawning ${args.bots} bots against ${args.url}` + (args.seconds ? ` for ${args.seconds}s` : ''));
const bots: Bot[] = [];
for (let i = 0; i < args.bots; i++) {
  setTimeout(() => bots.push(new Bot(i, args.url)), i * 150);
}

const started = Date.now();
const report = setInterval(() => {
  const dt = (Date.now() - started) / 1000;
  console.log(
    `[${dt.toFixed(0)}s] in=${stats.msgsIn} msgs (${(stats.bytesIn / 1024).toFixed(0)}KB) ` +
      `out=${stats.msgsOut} shots=${stats.shotsFired} kills=${stats.killsSeen} ` +
      `deaths=${stats.deaths} pickups=${stats.pickupsTried} placed=${stats.barricadesPlaced}`,
  );
}, 5000);

if (args.seconds > 0) {
  setTimeout(() => {
    clearInterval(report);
    for (const b of bots) b.close();
    console.log('--- load test summary ---');
    console.log(JSON.stringify(stats, null, 2));
    process.exit(0);
  }, args.seconds * 1000);
}
