// WebSocket client: connection, clock sync (server-time offset via
// ping/pong), and traffic counters for the debug overlay.

import { PING_INTERVAL_MS, PROTOCOL_VERSION } from '../../shared/constants';
import type { ClientMsg, ServerMsg } from '../../shared/types';

export interface NetHandlers {
  onWelcome(msg: Extract<ServerMsg, { t: 'welcome' }>): void;
  onSnap(msg: Extract<ServerMsg, { t: 'snap' }>): void;
  onReject(reason: string): void;
  onClose(): void;
}

export class Net {
  private ws: WebSocket | null = null;
  private offset = 0; // serverTime - performance.now()
  private offsetInit = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  rtt = 0;
  tpsReported = 0;
  connected = false;

  // per-second traffic counters
  inPps = 0;
  outPps = 0;
  inKbps = 0;
  outKbps = 0;
  private cIn = 0;
  private cOut = 0;
  private cInBytes = 0;
  private cOutBytes = 0;
  private statTimer: ReturnType<typeof setInterval> | null = null;

  connect(url: string, name: string, handlers: NetHandlers): void {
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.sendRaw({ t: 'hello', v: PROTOCOL_VERSION, name });
    };

    ws.onmessage = (e) => {
      this.cIn += 1;
      this.cInBytes += typeof e.data === 'string' ? e.data.length : 0;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        this.connected = true;
        // rough first offset; refined by pong RTT halving
        this.offset = msg.time - performance.now();
        this.offsetInit = true;
        this.startTimers();
        handlers.onWelcome(msg);
      } else if (msg.t === 'snap') {
        this.tpsReported = msg.tps;
        handlers.onSnap(msg);
      } else if (msg.t === 'pong') {
        const now = performance.now();
        this.rtt = this.rtt === 0 ? now - msg.t0 : this.rtt * 0.7 + (now - msg.t0) * 0.3;
        const sample = msg.st + (now - msg.t0) / 2 - now;
        this.offset = this.offsetInit ? this.offset * 0.8 + sample * 0.2 : sample;
        this.offsetInit = true;
      } else if (msg.t === 'reject') {
        handlers.onReject(msg.reason);
        ws.close();
      }
    };

    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      this.stopTimers();
      if (was) handlers.onClose();
    };
    ws.onerror = () => {
      if (!this.connected) handlers.onReject('could not reach server');
    };
  }

  private startTimers(): void {
    this.pingTimer = setInterval(() => {
      this.sendRaw({ t: 'ping', t0: performance.now(), rtt: Math.round(this.rtt) });
    }, PING_INTERVAL_MS);
    this.statTimer = setInterval(() => {
      this.inPps = this.cIn;
      this.outPps = this.cOut;
      this.inKbps = this.cInBytes / 1024;
      this.outKbps = this.cOutBytes / 1024;
      this.cIn = this.cOut = this.cInBytes = this.cOutBytes = 0;
    }, 1000);
    this.sendRaw({ t: 'ping', t0: performance.now(), rtt: 0 });
  }

  private stopTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.statTimer) clearInterval(this.statTimer);
  }

  serverNow(): number {
    return performance.now() + this.offset;
  }

  get offsetMs(): number {
    return this.offset;
  }

  send(msg: ClientMsg): void {
    this.sendRaw(msg);
  }

  private sendRaw(msg: ClientMsg): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify(msg);
    this.cOut += 1;
    this.cOutBytes += data.length;
    this.ws.send(data);
  }
}
