// LEADFIELD dedicated server: HTTP static hosting (for the built client)
// plus the authoritative WebSocket game loop.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_PLAYERS, PROTOCOL_VERSION, TICK_RATE } from '../../shared/constants';
import type { ClientMsg } from '../../shared/types';
import { Game } from './game';

const PORT = Number(process.env.PORT ?? 8081);
const DIST = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'client', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url ?? '/').split('?')[0];
    const rel = url === '/' ? 'index.html' : normalize(url).replace(/^([/\\.])+/, '');
    const file = join(DIST, rel);
    if (!file.startsWith(DIST)) throw new Error('bad path');
    await stat(file);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(
      'LEADFIELD server is running.\n\n' +
        'No built client found at client/dist - during development open the\n' +
        'Vite dev client (npm run dev -> http://localhost:5173) instead, or\n' +
        'run "npm run build" to serve the client from this port.\n',
    );
  }
});

const game = new Game();
const wss = new WebSocketServer({ server });

interface Session {
  pid: number | null;
}

wss.on('connection', (ws: WebSocket) => {
  const session: Session = { pid: null };
  const helloTimeout = setTimeout(() => {
    if (session.pid === null) ws.close();
  }, 5000);

  ws.on('message', (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (session.pid === null) {
      if (msg.t !== 'hello') return;
      if (msg.v !== PROTOCOL_VERSION) {
        ws.send(JSON.stringify({ t: 'reject', reason: 'version mismatch - refresh the page' }));
        ws.close();
        return;
      }
      const name = typeof msg.name === 'string' ? msg.name.replace(/[^\w \-]/g, '').trim() : '';
      const p = game.addPlayer(ws, name);
      if (!p) {
        ws.send(JSON.stringify({ t: 'reject', reason: `server full (${MAX_PLAYERS} players)` }));
        ws.close();
        return;
      }
      session.pid = p.pid;
      clearTimeout(helloTimeout);
      console.log(`[join] #${p.pid} ${p.name} (${game.playerCount} online)`);
      return;
    }
    const p = game.players.get(session.pid);
    if (p) game.handleMessage(p, msg);
  });

  ws.on('close', () => {
    clearTimeout(helloTimeout);
    if (session.pid !== null) {
      const p = game.players.get(session.pid);
      console.log(`[leave] #${session.pid} ${p?.name ?? '?'} (${game.playerCount - 1} online)`);
      game.removePlayer(session.pid);
    }
  });

  ws.on('error', () => ws.close());
});

setInterval(() => game.step(), 1000 / TICK_RATE);

let lastBytes = 0;
let lastMsgs = 0;
setInterval(() => {
  const bytes = game.bytesOut - lastBytes;
  const msgs = game.msgsOut - lastMsgs;
  lastBytes = game.bytesOut;
  lastMsgs = game.msgsOut;
  console.log(
    `[stats] tps=${game.tps.toFixed(1)} players=${game.playerCount} ` +
      `projectiles=${game.projectileCount} barricades=${game.barricadeCount} ` +
      `loot=${game.lootCount} out=${(bytes / 10240).toFixed(1)}KB/s (${Math.round(msgs / 10)}msg/s)`,
  );
}, 10_000);

server.listen(PORT, () => {
  console.log(`LEADFIELD server listening on :${PORT} (ws + http), tick rate ${TICK_RATE}hz`);
});
