// Keyboard/mouse state with pointer lock. Continuous state is read every
// prediction step; one-shot presses are collected as "edges" and consumed
// exactly once per step so nothing is lost between frames.

import { clamp } from '../../shared/math';

const BASE_SENS = 0.0023;

export interface InputEdges {
  jump: boolean;
  reload: boolean;
  use: boolean;
  pick: boolean;
  swap: 0 | 1 | null;
  placeToggle: boolean;
  firePressed: boolean;
  aimPressed: boolean;
}

const freshEdges = (): InputEdges => ({
  jump: false,
  reload: false,
  use: false,
  pick: false,
  swap: null,
  placeToggle: false,
  firePressed: false,
  aimPressed: false,
});

export class Input {
  yaw = 0;
  pit = 0;
  sensScale = 1; // reduced while aiming/zoomed

  fireHeld = false;
  aimHeld = false;
  locked = false;
  enabled = false;

  onScoreboard: (show: boolean) => void = () => {};
  onToggleDebug: () => void = () => {};
  onToggleMute: () => void = () => {};

  private keys = new Set<string>();
  private crouchToggle = false;
  private edges = freshEdges();

  constructor(private canvas: HTMLCanvasElement) {
    document.addEventListener('keydown', (e) => this.onKeyDown(e));
    document.addEventListener('keyup', (e) => this.onKeyUp(e));
    document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    document.addEventListener('mousedown', (e) => this.onMouseDown(e));
    document.addEventListener('mouseup', (e) => this.onMouseUp(e));
    document.addEventListener('contextmenu', (e) => this.enabled && e.preventDefault());
    document.addEventListener('wheel', (e) => this.onWheel(e), { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        this.keys.clear();
        this.fireHeld = false;
        this.aimHeld = false;
      }
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.fireHeld = false;
      this.aimHeld = false;
    });
  }

  requestLock(): void {
    this.canvas.requestPointerLock();
  }

  setView(yaw: number, pit: number): void {
    this.yaw = yaw;
    this.pit = pit;
  }

  kickView(dYaw: number, dPit: number): void {
    this.yaw += dYaw;
    this.pit = clamp(this.pit + dPit, -1.45, 1.45);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.enabled) return;
    // While the mouse is captured, swallow browser shortcuts (Ctrl/Cmd+S save
    // page, Ctrl+D bookmark, etc.) so gameplay keys never leak to the browser.
    // Ctrl on its own is a gameplay bind (crouch), so keep that flowing.
    if (this.locked && (e.ctrlKey || e.metaKey) && e.code !== 'ControlLeft' && e.code !== 'ControlRight') {
      e.preventDefault();
    }
    if (e.code === 'Tab') {
      e.preventDefault();
      this.onScoreboard(true);
      return;
    }
    if (e.code === 'F3') {
      e.preventDefault();
      this.onToggleDebug();
      return;
    }
    if (e.repeat) return;
    this.keys.add(e.code);
    switch (e.code) {
      case 'Space': this.edges.jump = true; e.preventDefault(); break;
      case 'KeyR': this.edges.reload = true; break;
      case 'KeyQ': this.edges.use = true; break;
      case 'KeyE': this.edges.pick = true; break;
      case 'KeyB': this.edges.placeToggle = true; break;
      case 'Digit1': this.edges.swap = 0; break;
      case 'Digit2': this.edges.swap = 1; break;
      case 'KeyC': this.crouchToggle = !this.crouchToggle; break;
      case 'KeyM': this.onToggleMute(); break;
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code);
    if (e.code === 'Tab') {
      e.preventDefault();
      this.onScoreboard(false);
    }
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.locked || !this.enabled) return;
    const s = BASE_SENS * this.sensScale;
    this.yaw -= e.movementX * s;
    this.pit = clamp(this.pit - e.movementY * s, -1.45, 1.45);
  }

  private onMouseDown(e: MouseEvent): void {
    if (!this.enabled || !this.locked) return;
    if (e.button === 0) {
      this.fireHeld = true;
      this.edges.firePressed = true;
    } else if (e.button === 2) {
      this.aimHeld = true;
      this.edges.aimPressed = true;
    }
  }

  private onMouseUp(e: MouseEvent): void {
    if (e.button === 0) this.fireHeld = false;
    if (e.button === 2) this.aimHeld = false;
  }

  // wheel toggles to "the other slot"; game resolves against current slot
  private onWheel(e: WheelEvent): void {
    if (!this.enabled || !this.locked || e.deltaY === 0) return;
    this.wheelFlip = true;
  }

  wheelFlip = false;

  // local-space move intent: x = strafe right, z = forward
  moveAxes(): { x: number; z: number } {
    const f = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const s = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    return { x: s, z: f };
  }

  sprintHeld(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  crouchHeld(): boolean {
    return this.crouchToggle || this.keys.has('ControlLeft') || this.keys.has('ControlRight');
  }

  clearCrouchToggle(): void {
    this.crouchToggle = false;
  }

  consumeEdges(): InputEdges {
    const e = this.edges;
    this.edges = freshEdges();
    return e;
  }

  consumeWheelFlip(): boolean {
    const w = this.wheelFlip;
    this.wheelFlip = false;
    return w;
  }
}
