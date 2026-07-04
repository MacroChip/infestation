import './style.css';
import { ClientGame } from './game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const startScreen = document.getElementById('start-screen')!;
const startStatus = document.getElementById('start-status')!;
const nameInput = document.getElementById('name-input') as HTMLInputElement;
const joinBtn = document.getElementById('join-btn') as HTMLButtonElement;
const clickCatch = document.getElementById('click-catch')!;

function serverUrl(): string {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q.includes('://') ? q : `ws://${q}`;
  // vite dev client on :5173 -> game server on :8081; built client is
  // served by the game server itself, so same host:port works there.
  if (location.port === '5173') return `ws://${location.hostname}:8081`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

nameInput.value =
  localStorage.getItem('lf-name') ?? `Drifter-${100 + Math.floor(Math.random() * 900)}`;

let game: ClientGame | null = null;
let inGame = false;

function updateClickCatch(): void {
  const show = inGame && game !== null && !game.pointerLocked;
  clickCatch.classList.toggle('hidden', !show);
}

document.addEventListener('pointerlockchange', () => setTimeout(updateClickCatch, 50));
clickCatch.addEventListener('click', () => game?.requestPointerLock());

function join(): void {
  if (game) return;
  const name = nameInput.value.trim() || 'Drifter';
  localStorage.setItem('lf-name', name);
  joinBtn.disabled = true;
  startStatus.textContent = 'connecting to the yard...';

  game = new ClientGame(canvas);
  game.onDisconnect = (reason) => {
    inGame = false;
    startScreen.classList.remove('hidden');
    startStatus.textContent = `${reason} - refresh to rejoin`;
    updateClickCatch();
  };
  game.join(
    serverUrl(),
    name,
    () => {
      inGame = true;
      startScreen.classList.add('hidden');
      game?.requestPointerLock();
      updateClickCatch();
      // small debug handle for automated smoke tests
      (window as unknown as Record<string, unknown>).__LF = {
        get pid() { return game?.myPid; },
        get connected() { return game?.net.connected; },
        get corrections() { return game?.corrections; },
        get locked() { return game?.pointerLocked; },
        probe: () => game?.probe(),
      };
    },
    (reason) => {
      startStatus.textContent = `rejected: ${reason}`;
      joinBtn.disabled = false;
      game = null;
    },
  );
}

joinBtn.addEventListener('click', join);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join();
});
