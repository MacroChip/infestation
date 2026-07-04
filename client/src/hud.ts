// DOM-based HUD. Cheap, crisp, and easy to restyle.

import { WEAPONS } from '../../shared/weapons';
import type { SlotState, WeaponId } from '../../shared/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

export interface ScoreRow {
  pid: number;
  name: string;
  k: number;
  d: number;
  ping: number;
}

export class Hud {
  private hud = $('hud');
  private hpFill = $('hp-fill');
  private hpNum = $('hp-num');
  private stamFill = $('stam-fill');
  private meds = $('meds');
  private kits = $('kits');
  private weaponName = $('weapon-name');
  private mag = $('mag');
  private reserve = $('reserve');
  private slots = [$('slot0'), $('slot1')];
  private prompt = $('prompt');
  private placeHint = $('place-hint');
  private useBar = $('use-bar');
  private useFill = $('use-fill');
  private killfeed = $('killfeed');
  private toasts = $('toasts');
  private crosshair = $('crosshair');
  private scope = $('scope');
  private hitmark = $('hitmarker');
  private vignette = $('vignette');
  private invuln = $('invuln');
  private scoreboard = $('scoreboard');
  private scoreRows = $('score-rows');
  private deathScreen = $('death-screen');
  private deathBy = $('death-by');
  private deathTimer = $('death-timer');
  private vignetteT: ReturnType<typeof setTimeout> | null = null;

  show(): void {
    this.hud.classList.remove('hidden');
  }

  setVitals(hp: number, stam: number): void {
    this.hpFill.style.width = `${hp}%`;
    this.hpNum.textContent = String(Math.ceil(hp));
    this.hpFill.style.background = hp > 55 ? '#7bc95f' : hp > 25 ? '#d9b23f' : '#d95040';
    this.stamFill.style.width = `${stam}%`;
  }

  // key labels mirror the weapon slots' "1 <name>" style
  setConsumables(meds: number, kits: number): void {
    this.meds.textContent = `Q MED ${meds}`;
    this.kits.textContent = `B BAR ${kits}`;
  }

  setWeapon(slots: [SlotState | null, SlotState | null], act: 0 | 1, reserveAmmo: number, magOverride: number | null, reloading: boolean): void {
    const slot = slots[act];
    if (slot) {
      const def = WEAPONS[slot.w];
      this.weaponName.textContent = reloading ? 'RELOADING' : def.name.toUpperCase();
      this.weaponName.classList.toggle('reloading', reloading);
      this.mag.textContent = String(magOverride ?? slot.mag);
      this.reserve.textContent = `/ ${reserveAmmo}`;
    } else {
      this.weaponName.textContent = 'UNARMED - FIND A WEAPON';
      this.weaponName.classList.remove('reloading');
      this.mag.textContent = '--';
      this.reserve.textContent = '';
    }
    for (const i of [0, 1] as const) {
      const s = slots[i];
      this.slots[i].textContent = `${i + 1} ${s ? WEAPONS[s.w].name.split(' ')[0] : '·'}`;
      this.slots[i].classList.toggle('active', act === i && s !== null);
    }
  }

  setPrompt(html: string | null): void {
    if (html === null) {
      this.prompt.classList.add('hidden');
    } else {
      this.prompt.innerHTML = html;
      this.prompt.classList.remove('hidden');
    }
  }

  setPlacementMode(on: boolean): void {
    this.placeHint.classList.toggle('hidden', !on);
  }

  setUseProgress(frac: number | null): void {
    if (frac === null) {
      this.useBar.classList.add('hidden');
    } else {
      this.useBar.classList.remove('hidden');
      this.useFill.style.width = `${Math.round(frac * 100)}%`;
    }
  }

  setCrosshairSpread(spreadRad: number, visible: boolean): void {
    this.crosshair.style.display = visible ? '' : 'none';
    this.crosshair.style.setProperty('--gap', `${Math.round(8 + spreadRad * 900)}px`);
  }

  setScope(on: boolean): void {
    this.scope.classList.toggle('hidden', !on);
  }

  setInvuln(on: boolean): void {
    this.invuln.classList.toggle('hidden', !on);
  }

  hitmarker(): void {
    this.hitmark.classList.remove('pop');
    void this.hitmark.offsetWidth; // restart CSS animation
    this.hitmark.classList.add('pop');
  }

  damageFlash(): void {
    this.vignette.style.opacity = '1';
    if (this.vignetteT) clearTimeout(this.vignetteT);
    this.vignetteT = setTimeout(() => (this.vignette.style.opacity = '0'), 120);
  }

  addKillfeed(text: string, mine: boolean): void {
    const div = document.createElement('div');
    div.innerHTML = text;
    if (mine) div.classList.add('me');
    this.killfeed.prepend(div);
    while (this.killfeed.children.length > 6) this.killfeed.lastChild?.remove();
    setTimeout(() => div.remove(), 7000);
  }

  toast(text: string): void {
    const div = document.createElement('div');
    div.textContent = text;
    this.toasts.append(div);
    setTimeout(() => div.remove(), 2600);
  }

  setScoreboard(rows: ScoreRow[] | null, myPid: number): void {
    if (rows === null) {
      this.scoreboard.classList.add('hidden');
      return;
    }
    this.scoreboard.classList.remove('hidden');
    this.scoreRows.innerHTML = rows
      .map(
        (r) =>
          `<tr${r.pid === myPid ? ' class="me"' : ''}><td>${r.name}</td><td>${r.k}</td><td>${r.d}</td><td>${r.ping}</td></tr>`,
      )
      .join('');
  }

  showDeath(byHtml: string): void {
    this.deathBy.innerHTML = byHtml;
    this.deathScreen.classList.remove('hidden');
  }

  setDeathCountdown(sec: number): void {
    this.deathTimer.textContent = sec > 0 ? `redeploying in ${sec.toFixed(1)}s` : 'redeploying...';
  }

  hideDeath(): void {
    this.deathScreen.classList.add('hidden');
  }
}

// name/color registry shared by HUD text builders
export class Roster {
  private names = new Map<number, { name: string; color: number }>();

  set(pid: number, name: string, color: number): void {
    this.names.set(pid, { name, color });
  }

  remove(pid: number): void {
    this.names.delete(pid);
  }

  name(pid: number): string {
    return this.names.get(pid)?.name ?? `#${pid}`;
  }

  colored(pid: number): string {
    const e = this.names.get(pid);
    if (!e) return `#${pid}`;
    return `<b style="color:#${e.color.toString(16).padStart(6, '0')}">${e.name}</b>`;
  }

  weaponName(w: WeaponId | 0): string {
    return w === 0 ? '?' : WEAPONS[w].name;
  }
}
