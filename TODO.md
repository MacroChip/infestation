# TODO - next 10 engineering steps

Ordered by expected impact on PvP feel per hour of work.

1. **Lag-compensated hit registration (rewind).** Keep a ~250ms ring buffer
   of player capsule positions on the server and step projectiles against
   capsules rewound by the shooter's interpolation delay (`rtt/2 +
   INTERP_DELAY_MS`). Right now leading targets is required even at 40ms
   ping; with rewind, tracking a strafing target "where you see them" will
   land. The buffer belongs next to `Projectiles.step` and needs ~1 capsule
   snapshot per player per tick.

2. **WebRTC unreliable DataChannel transport.** TCP WebSockets head-of-line
   block: one dropped packet stalls every later snapshot. Add a
   `RTCDataChannel` (unordered, maxRetransmits: 0) negotiated over the
   existing WS for snapshots/inputs, keep WS for join/events that must
   arrive. Biggest win on real-internet (non-LAN) matches.

3. **Delta-compressed binary snapshots.** JSON full-state snapshots are
   ~2-4KB/tick. Move to a flat binary layout (Int16 quantized positions,
   bit-packed flags) and send deltas against the last acked snapshot with
   a periodic keyframe. Target: <300 bytes/tick at 16 players. Do this
   after (2) since delta streams want per-packet acks.

4. **Barricade placement UX pass.** Edge-snapping to align consecutive
   barricades into walls, yaw fine-rotation on Q/E while ghosting, a
   server-echoed "placement preview valid" bit so the ghost can't lie about
   contested spots, and a repair interaction (hold E, consumes time not
   kits) to reward holding a position.

5. **Weapon balance telemetry from bot matches.** The loadtest bots already
   fight; log per-weapon damage dealt, TTK samples, kill distances and
   barricade damage into a JSON report after `--seconds N` runs, and tune
   `shared/weapons.ts` from data instead of vibes. Add a headless CI job
   that fails if any weapon's win rate in bot duels drifts past 60%.

6. **Loot spawn director.** Static spawn points respawn on fixed timers, so
   lobbies over ~10 players starve. Track time-since-looted per zone and
   bias respawns toward under-visited zones (keeps rotations moving), and
   scale ammo spawn amounts with player count.

7. **Movement feel polish: acceleration curves + air control + landing
   recovery.** Split ground accel into accel/decel constants, add a small
   landing speed penalty (drop ~20% horizontal speed on landing from >2m)
   and a coyote-time window (~80ms) for jumps off ledges. All in
   `shared/movement.ts`, so prediction stays exact.

8. **Interest management / snapshot culling.** Stop sending full precision
   for players far outside the client's view: quantize far players harder,
   drop pitch/aim flags for them, and skip impact events beyond 60u. Not
   AOI streaming - the map is one arena - just bandwidth shaping before (3)
   lands.

9. **Spectate-killer camera + kill recap.** On death, orbit the killer for
   the 3s respawn timer and show the damage breakdown (weapon, distance,
   their remaining hp). Cheap closure for the victim and great for spotting
   netcode wrongness ("I was behind the barricade!") while iterating on (1).

10. **Server-side simulation hardening.** Cap per-player input backlog by
    wall-clock (drop >250ms of queued cmds, not >6), make the tick loop
    catch up on missed intervals (setInterval drift currently just slows
    the sim), and add a `--record` flag that dumps every input + snapshot
    to disk so desync reports from friends can be replayed deterministically
    against the shared sim.
