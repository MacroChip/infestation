// F3 network/perf overlay. Everything the spec asks for: ping, server
// tick rate, packet rates, position, and prediction-correction info.

export class DebugOverlay {
  private el = document.getElementById('debug') as HTMLPreElement;
  visible = true;

  toggle(): void {
    this.visible = !this.visible;
    this.el.classList.toggle('hidden', !this.visible);
  }

  show(): void {
    this.visible = true;
    this.el.classList.remove('hidden');
  }

  set(lines: Record<string, string>): void {
    if (!this.visible) return;
    let text = 'LEADFIELD NET DEBUG (F3)\n';
    for (const [k, v] of Object.entries(lines)) {
      text += `${k.padEnd(14)} ${v}\n`;
    }
    this.el.textContent = text;
  }
}
