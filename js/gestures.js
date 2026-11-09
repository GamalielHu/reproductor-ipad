const TAP_MS = 280;
const MOVE_PX = 14;

export function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export class Gestures {
  constructor(layer, player, ui) {
    this.layer = layer;
    this.player = player;
    this.ui = ui;
    this.pointers = new Map();
    this.g = null;
    this.tapTimer = null;
    this.lastTap = null;
    this.streak = { side: null, total: 0, until: 0 };
    layer.addEventListener('pointerdown', (e) => this.#down(e));
    layer.addEventListener('pointermove', (e) => this.#move(e));
    layer.addEventListener('pointerup', (e) => this.#up(e));
    layer.addEventListener('pointercancel', (e) => this.#cancel(e));
    layer.addEventListener('contextmenu', (e) => e.preventDefault());
    layer.addEventListener('dblclick', (e) => e.preventDefault());
  }

  #rect() {
    return this.layer.getBoundingClientRect();
  }

  #down(e) {
    this.layer.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.player.unlockAudio();
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.g = { mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), ratio: 1 };
      return;
    }
    if (this.pointers.size > 2) return;
    const r = this.#rect();
    this.g = {
      mode: null,
      x0: e.clientX,
      y0: e.clientY,
      t0: performance.now(),
      rx: (e.clientX - r.left) / r.width,
      w: r.width,
      h: r.height,
      startTime: this.player.video.currentTime,
      startBrightness: this.player.brightness,
      startVolume: this.player.volumeLevel
    };
  }

  #move(e) {
    if (!this.pointers.has(e.pointerId) || !this.g) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = this.g;
    if (g.mode === 'pinch') {
      const [a, b] = [...this.pointers.values()];
      if (a && b) g.ratio = Math.hypot(a.x - b.x, a.y - b.y) / (g.d0 || 1);
      return;
    }
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.mode) {
      if (Math.abs(dx) < MOVE_PX && Math.abs(dy) < MOVE_PX) return;
      if (Math.abs(dx) > Math.abs(dy)) {
        if (!isFinite(this.player.video.duration) || !this.player.video.duration) return;
        g.mode = 'seek';
      } else {
        g.mode = g.rx < 0.5 ? 'brightness' : 'volume';
        if (g.mode === 'volume' && !this.player.volumeControllable) {
          g.mode = 'none';
          this.ui.hud('Volumen', 'Usa los botones del iPad', null);
          this.ui.hideHud(1400);
          return;
        }
      }
    }
    if (g.mode === 'seek') {
      const dur = this.player.video.duration;
      const span = Math.min(Math.max(dur, 60), 240);
      const target = Math.min(dur, Math.max(0, g.startTime + (dx / g.w) * span));
      g.target = target;
      const diff = target - g.startTime;
      this.ui.hud(`${diff >= 0 ? '+' : '−'}${fmtTime(Math.abs(diff))}`, fmtTime(target), target / dur);
    } else if (g.mode === 'brightness') {
      const b = this.player.setBrightness(g.startBrightness - (dy / (g.h * 0.75)) * 1.6);
      this.ui.hud('Brillo', `${Math.round(((b - 0.2) / 1.6) * 100)}%`, (b - 0.2) / 1.6);
    } else if (g.mode === 'volume') {
      const v = Math.min(1, Math.max(0, g.startVolume - dy / (g.h * 0.75)));
      this.player.setVolume(v);
      this.ui.hud('Volumen', `${Math.round(v * 100)}%`, v);
    }
  }

  #up(e) {
    const g = this.g;
    this.pointers.delete(e.pointerId);
    if (!g) return;
    if (g.mode === 'pinch') {
      if (this.pointers.size === 0) {
        if (g.ratio > 1.18) this.ui.setAspect('crop');
        else if (g.ratio < 0.85) this.ui.setAspect('fit');
        this.g = null;
      }
      return;
    }
    if (g.mode === 'seek' && g.target != null) {
      this.player.seekTo(g.target);
      this.ui.hideHud(500);
    } else if (g.mode === 'brightness' || g.mode === 'volume') {
      this.ui.hideHud(600);
      this.ui.persist();
    } else if (!g.mode && performance.now() - g.t0 < 450) {
      this.#tap(g.rx);
    }
    this.g = null;
  }

  #cancel(e) {
    this.pointers.delete(e.pointerId);
    if (this.g?.mode && this.g.mode !== 'pinch') this.ui.hideHud(200);
    this.g = null;
  }

  #side(rx) {
    if (rx < 0.38) return 'left';
    if (rx > 0.62) return 'right';
    return 'center';
  }

  #tap(rx) {
    const now = performance.now();
    const side = this.#side(rx);
    if (side !== 'center' && this.streak.side === side && now < this.streak.until) {
      this.#skip(side, now);
      return;
    }
    if (this.lastTap && now - this.lastTap.t < TAP_MS) {
      clearTimeout(this.tapTimer);
      this.lastTap = null;
      if (side === 'center') this.player.toggle();
      else this.#skip(side, now);
      return;
    }
    this.lastTap = { t: now, side };
    this.tapTimer = setTimeout(() => {
      this.lastTap = null;
      this.ui.toggleControls();
    }, TAP_MS);
  }

  #skip(side, now) {
    const delta = side === 'left' ? -10 : 10;
    if (this.streak.side !== side || now > this.streak.until) this.streak.total = 0;
    this.streak.side = side;
    this.streak.total += delta;
    this.streak.until = now + 700;
    this.player.seekBy(delta);
    this.ui.ripple(side, `${this.streak.total > 0 ? '+' : '−'}${Math.abs(this.streak.total)} s`);
  }
}
