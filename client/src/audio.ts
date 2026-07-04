// All sounds are synthesized with WebAudio at runtime - zero audio assets,
// zero copyright surface. Positional cues are approximated with stereo pan
// + distance attenuation computed against the camera.

import type { WeaponId } from '../../shared/types';
import { clamp } from '../../shared/math';

interface ShotVoice {
  noiseDur: number;
  noiseFreq: number;
  noiseGain: number;
  thump: boolean; // low sine sweep for big guns
}

const VOICES: Record<WeaponId, ShotVoice> = {
  ar: { noiseDur: 0.1, noiseFreq: 2600, noiseGain: 0.95, thump: true },
  smg: { noiseDur: 0.06, noiseFreq: 1050, noiseGain: 0.5, thump: false }, // suppressed, still punchy
  shotgun: { noiseDur: 0.24, noiseFreq: 850, noiseGain: 1.3, thump: true },
  sniper: { noiseDur: 0.32, noiseFreq: 3000, noiseGain: 1.4, thump: true },
};

export class AudioMgr {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private rumble: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  muted = false;

  // must be called from a user gesture
  init(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null;
    }
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  private spatial(dist: number, pan: number): { g: number; p: number } {
    return { g: 1 / (1 + dist / 16), p: clamp(pan, -0.9, 0.9) };
  }

  private out(gain: number, pan: number, t0: number, dur: number): GainNode | null {
    if (!this.ctx || !this.master) return null;
    const g = this.ctx.createGain();
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p);
    p.connect(this.master);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    return g;
  }

  private burst(freq: number, gain: number, dur: number, pan: number, type: BiquadFilterType = 'lowpass'): void {
    if (!this.ctx || !this.noise) return;
    const t0 = this.ctx.currentTime;
    const g = this.out(gain, pan, t0, dur);
    if (!g) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    src.connect(f);
    f.connect(g);
    src.start(t0, Math.random());
    src.stop(t0 + dur + 0.02);
  }

  private tone(f0: number, f1: number, gain: number, dur: number, pan: number, type: OscillatorType = 'sine'): void {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    const g = this.out(gain, pan, t0, dur);
    if (!g) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
    o.connect(g);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  shot(w: WeaponId, dist: number, pan: number): void {
    const v = VOICES[w];
    const { g, p } = this.spatial(dist, pan);
    this.burst(v.noiseFreq, v.noiseGain * g, v.noiseDur, p);
    // low-end crack: adds body/weight so shots read as loud, not just hissy
    if (v.thump) this.tone(150, 45, 0.75 * g, 0.2, p);
  }

  impact(kind: string, dist: number, pan: number): void {
    const { g, p } = this.spatial(dist, pan);
    if (kind === 'p') this.tone(300, 180, 0.25 * g, 0.06, p, 'square');
    else this.burst(kind === 'b' ? 700 : 1800, 0.12 * g, 0.05, p);
  }

  dry(): void {
    this.tone(1500, 900, 0.12, 0.04, 0, 'square');
  }

  reload(): void {
    this.tone(700, 500, 0.15, 0.05, 0, 'square');
    setTimeout(() => this.tone(900, 700, 0.15, 0.05, 0, 'square'), 130);
  }

  hitmarker(): void {
    this.tone(1300, 1100, 0.18, 0.05, 0, 'triangle');
  }

  hurt(): void {
    this.tone(280, 130, 0.3, 0.12, 0, 'sawtooth');
  }

  kill(): void {
    this.tone(660, 660, 0.2, 0.09, 0, 'triangle');
    setTimeout(() => this.tone(990, 990, 0.2, 0.12, 0, 'triangle'), 90);
  }

  pickup(): void {
    this.tone(520, 780, 0.18, 0.08, 0, 'triangle');
  }

  heal(): void {
    this.tone(440, 880, 0.2, 0.25, 0, 'sine');
  }

  place(dist = 0, pan = 0): void {
    const { g, p } = this.spatial(dist, pan);
    this.tone(120, 60, 0.5 * g, 0.12, p);
    this.burst(500, 0.2 * g, 0.08, p);
  }

  barBreak(dist: number, pan: number): void {
    const { g, p } = this.spatial(dist, pan);
    this.burst(450, 0.5 * g, 0.3, p);
    this.tone(180, 60, 0.4 * g, 0.2, p);
  }

  // ---- boss ----

  // continuous low engine roar while GOLIATH descends
  rumbleStart(): void {
    if (!this.ctx || !this.master || !this.noise || this.rumble) return;
    const t0 = this.ctx.currentTime;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.exponentialRampToValueAtTime(0.55, t0 + 1.5);
    gain.connect(this.master);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 110;
    f.connect(gain);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.connect(f);
    src.start(t0);
    this.rumble = { src, gain };
  }

  rumbleStop(): void {
    if (!this.ctx || !this.rumble) return;
    const t0 = this.ctx.currentTime;
    this.rumble.gain.gain.setTargetAtTime(0.0001, t0, 0.2);
    this.rumble.src.stop(t0 + 1);
    this.rumble = null;
  }

  bossLand(dist: number, pan: number): void {
    const { g, p } = this.spatial(dist, pan);
    this.tone(70, 22, 1.2 * g, 0.8, p);
    this.burst(220, 0.9 * g, 0.5, p);
  }

  missileLaunch(dist: number, pan: number): void {
    const { g, p } = this.spatial(dist, pan);
    this.burst(900, 0.55 * g, 0.45, p, 'bandpass');
    this.tone(320, 90, 0.35 * g, 0.4, p, 'sawtooth');
  }

  explosion(dist: number, pan: number): void {
    const { g, p } = this.spatial(dist, pan);
    this.burst(320, 1.1 * g, 0.5, p);
    this.tone(95, 28, 0.9 * g, 0.5, p);
  }

  // urgent double beep: a missile just locked onto YOU
  lockWarn(): void {
    this.tone(1250, 1250, 0.25, 0.09, 0, 'square');
    setTimeout(() => this.tone(1250, 1250, 0.25, 0.09, 0, 'square'), 160);
  }
}
