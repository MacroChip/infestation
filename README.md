# LEADFIELD

A browser-based multiplayer PvP survival shooter **prototype**: 8-16 players,
one small high-action map ("Millyard"), third-person over-the-shoulder
gunplay with **server-simulated projectiles**, loose ground loot, dropped
gear on death, and deployable destructible barricades.

No rounds, no extraction, no safe zones, no PvE - spawn, grab a gun off the
ground, fight, die, redeploy in 3 seconds.

All code, assets, names, map layout, UI and sounds are original. Models are
procedural low-poly primitives; audio is synthesized at runtime with
WebAudio. There are zero binary assets in the repo.

---

## Quick start (local, multiple browser tabs)

Requires Node 20+.

```bash
npm install

# terminal A - authoritative game server (ws://localhost:8081)
npm run server

# terminal B - vite dev client (http://localhost:5173)
npm run dev
```

Open **http://localhost:5173** in two or more browser tabs (or windows -
separate windows are nicer since pointer lock captures the mouse), pick a
callsign, hit **DEPLOY**. Each tab is a player. Add bots for target
practice:

```bash
# terminal C - 8 dummy clients that wander, loot, shoot and place barricades
npm run loadtest
# options:
npm run loadtest -- --bots 12 --seconds 30 --url ws://localhost:8081
```

### Playing with friends (LAN / port-forward)

```bash
npm run build     # builds the client into client/dist
npm run server    # now serves the built client AND the game socket on :8081
```

Friends open `http://<your-ip>:8081` - one port for everything. The
prototype is tuned for trusted friends on low-latency connections; there is
intentionally no anti-cheat.

You can also point any client at any server with a query param:
`http://localhost:5173/?server=192.168.1.20:8081`.

## Controls

| Input | Action |
| --- | --- |
| WASD | move |
| Shift | sprint (drains stamina) |
| Space | jump |
| Mouse | look, LMB fire, RMB aim over shoulder (sniper zooms) |
| R | reload |
| 1 / 2 / wheel | weapon slots |
| E | pick up weapon (ammo/medkits/kits auto-pickup on walkover) |
| Q | use medkit (1.6s channel, interrupted by firing/sprinting/jumping) |
| B | barricade placement mode (stows your weapon) - LMB place, RMB cancel |
| H | hurt yourself 30hp (dev helper for testing medkits) |
| Tab | scoreboard |
| F3 | network debug overlay |
| M | mute |

## What's simulated where

**The server owns everything that matters**: movement integration (from
client inputs), health, damage, kills, inventory, loot spawns/pickups/drops,
projectile flight, barricade placement validation and barricade damage.
It runs at **30 ticks/sec** and broadcasts a full player snapshot plus a
per-client private state (`you`) every tick over WebSocket (JSON).

**The client predicts** its own movement at a fixed 60hz step using the
exact same shared movement code, and reconciles against the authoritative
`you` state each snapshot (rewind to server state, replay unacknowledged
inputs, smooth any residual error over ~100ms). Remote players render
~120ms in the past and interpolate between snapshots.

**Firing feels instant** because the client immediately renders predicted
tracers, muzzle flash and sound, using the same deterministic spread
function and projectile integrator the server uses (the shot id seeds the
spread PRNG, so predicted pellet directions match the server's exactly).
The server then simulates the authoritative projectiles and broadcasts
spawn/impact events; your own shot events are matched back to the predicted
visuals by shot id, and impacts/hits/kills only ever come from the server.

The **F3 overlay** shows ping, measured server tick rate, packet and
bandwidth rates in both directions, position/velocity, pending input count
and prediction-correction stats (total, per-10s, last magnitude).

## Layout

```
client/    browser game (three.js rendering, DOM HUD, WebAudio sounds)
server/    authoritative Node server (ws), static hosting of client/dist
shared/    deterministic sim code used by BOTH sides:
           movement, collision, projectiles, weapons/spread, barricade
           placement validation, map data, protocol types, constants
scripts/   loadtest.ts - dummy-client bot swarm
```

Key design choice: **no physics engine**. Everything solid is a (possibly
yaw-rotated) box and players are capsules, so collision is ~200 lines of
hand-rolled math in `shared/collision.ts` that runs byte-identically on
client and server. That's what makes cheap prediction/replay and visual
projectiles that match the authoritative ones possible, with zero WASM or
engine-determinism headaches.

## Weapons

| Weapon | Style | Damage | Notes |
| --- | --- | --- | --- |
| KV-7 Harrier | assault rifle, auto 600rpm | 21 | workhorse, mild drop |
| Vesper 9S | suppressed SMG, auto 800rpm | 13 | quiet, no muzzle flash, dim tracer |
| Drummel D8 | pump shotgun | 8 pellets x 9 | brutal inside ~15m |
| Meridian LR | bolt sniper | 85 | zoom aim, near-flat trajectory, shreds barricades |

All weapons fire **simulated projectiles** (velocity + gravity), not
hitscan. Damage is flat per projectile onto a single capsule hitbox - no
headshots, by design, for hitbox simplicity.

## Secret: GOLIATH

There is a hidden boss. Entering a certain arrow-key sequence in-game
(spoiler: `↑ ↑ ↓ ↓ ← → ← →`) calls in **GOLIATH**, a 9-meter walking
artillery piece:

- It descends from the sky on a landing burn - fast entry, decelerating
  to a gentle touchdown on a clear patch of the yard (~11 seconds; the
  whole server hears the rumble and sees the inbound warning).
- Two seconds after touchdown it fires its first **missile at a random
  player**, then another every 8 seconds. Missiles are slow but
  heat-seeking - sprint, break line of sight, or **shoot them down**
  (one bullet detonates them). A lock warning appears when it's you.
  The detonation deals 70 splash damage in ~3m, wherever it happens.
- It always walks toward the closest player. **Touching it is instant
  death** - so is being under it when it lands.
- It has 2500 hp and can be destroyed by gunfire (the hp bar sits top
  center while it's active). Only one can be active at a time; kills by
  GOLIATH credit no one.

Everything about it is server-authoritative and lives in
`server/src/boss.ts` (sim) + `client/src/boss.ts` (visuals); tuning is
in `shared/constants.ts` with the rest.

## Barricades

Find barricade kits on the map (you also spawn with one). Press **B** to
ready a kit - your weapon is stowed while lining up the green ghost, so
LMB places the barricade instead of firing, and your weapon comes back
out right after (with the usual swap delay). The server re-validates every
placement: in range, on flat ground, not intersecting players/walls/other
barricades, not through a wall (line-of-sight check), not within 7m of a
spawn point. Barricades have 260hp, block movement and bullets, darken as
they take damage, and can be destroyed (snipers do 1.6x to them). They're
chest-high cover to shoot over or duck behind.

## Tuning

Nearly every gameplay number lives in `shared/constants.ts` and
`shared/weapons.ts`. Both server and client must be restarted (or the page
refreshed) after edits since the sim runs on both sides.

## Scripts

| Command | What |
| --- | --- |
| `npm run dev` | vite dev client on :5173 |
| `npm run server` | game server on :8081 (tsx watch - restarts on edit) |
| `npm run build` | production client build into `client/dist` |
| `npm run start` | game server without file watching |
| `npm run loadtest` | 8 wandering/fighting dummy clients |
| `npm run typecheck` | strict tsc over client+server+shared+scripts |
