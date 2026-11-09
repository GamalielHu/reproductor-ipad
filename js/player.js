import { decodeSubtitleBytes, subtitleBlobUrl, guessLang } from './subtitles.js';

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5];
export const ASPECTS = [
  { id: 'fit', label: 'Ajustar (contener)' },
  { id: 'fill', label: 'Estirar (llenar)' },
  { id: 'crop', label: 'Recortar (zoom)' },
  { id: '16:9', label: '16:9' },
  { id: '4:3', label: '4:3' },
  { id: '21:9', label: '21:9' }
];
export const ASPECT_SHORT = { fit: 'Ajustar', fill: 'Estirar', crop: 'Recortar', '16:9': '16:9', '4:3': '4:3', '21:9': '21:9' };

const UNSUPPORTED = /\.(mkv|avi|wmv|flv)(\?|$)/i;
const HLS_RE = /\.m3u8(\?|$)/i;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const nativeVolumeWorks = (() => {
  const v = document.createElement('video');
  try {
    v.volume = 0.5;
    return v.volume === 0.5;
  } catch {
    return false;
  }
})();

let hlsModule = null;
async function loadHls(url) {
  if (!hlsModule) hlsModule = import(url).then((m) => m.default).catch(() => null);
  return hlsModule;
}

export class Player extends EventTarget {
  constructor({ stage, video, cuesEl, hlsUrl }) {
    super();
    this.stage = stage;
    this.video = video;
    this.cuesEl = cuesEl;
    this.hlsUrl = hlsUrl;
    this.hls = null;
    this.src = null;
    this.blobUrls = [];
    this.aspect = 'fit';
    this.brightness = 1;
    this.volumeLevel = 1;
    this.audio = null;
    this.activeTextTrack = null;
    this.lastProgressAt = 0;
    this.onCueChange = () => this.#renderCues();
    this.#bindVideo(video);
    new ResizeObserver(() => this.applyAspect()).observe(stage);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #bindVideo(v) {
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('x-webkit-airplay', 'allow');
    v.setAttribute('autopictureinpicture', '');
    v.disableRemotePlayback = false;
    const state = () => this.#emit('state', { playing: !v.paused && !v.ended, waiting: v.readyState < 3 && !v.paused, muted: v.muted });
    ['play', 'pause', 'playing', 'waiting', 'canplay', 'ended', 'volumechange', 'seeking', 'seeked'].forEach((e) => v.addEventListener(e, state));
    v.addEventListener('timeupdate', () => {
      this.#emit('time', this.timeInfo());
      const now = performance.now();
      if (now - this.lastProgressAt > 4000) {
        this.lastProgressAt = now;
        this.#emit('progress', { position: v.currentTime, duration: v.duration });
      }
    });
    v.addEventListener('progress', () => this.#emit('time', this.timeInfo()));
    v.addEventListener('durationchange', () => this.#emit('time', this.timeInfo()));
    v.addEventListener('loadedmetadata', () => {
      this.applyAspect();
      const start = this.src?.startAt || 0;
      if (start > 5 && (!isFinite(v.duration) || start < v.duration - 10)) v.currentTime = start;
      this.#emit('tracks');
      this.#emit('quality');
    });
    v.addEventListener('resize', () => {
      this.applyAspect();
      this.#emit('quality');
    });
    v.addEventListener('ratechange', () => this.#emit('rate', v.playbackRate));
    v.addEventListener('error', () => this.#onVideoError());
    v.textTracks.addEventListener?.('addtrack', () => this.#emit('tracks'));
    v.textTracks.addEventListener?.('removetrack', () => this.#emit('tracks'));
    v.audioTracks?.addEventListener?.('addtrack', () => this.#emit('tracks'));
    v.audioTracks?.addEventListener?.('change', () => this.#emit('tracks'));
    v.addEventListener('enterpictureinpicture', () => this.#emit('pip', true));
    v.addEventListener('leavepictureinpicture', () => this.#emit('pip', false));
    v.addEventListener('webkitpresentationmodechanged', () => this.#emit('pip', v.webkitPresentationMode === 'picture-in-picture'));
  }

  #replaceVideo() {
    const old = this.video;
    const fresh = document.createElement('video');
    fresh.id = old.id;
    fresh.preload = 'metadata';
    fresh.playbackRate = old.playbackRate;
    fresh.style.cssText = old.style.cssText;
    old.pause();
    old.removeAttribute('src');
    old.load();
    old.replaceWith(fresh);
    this.video = fresh;
    this.audio = null;
    this.#bindVideo(fresh);
    this.#emit('videochange', fresh);
  }

  timeInfo() {
    const v = this.video;
    let buffered = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.5) buffered = Math.max(buffered, v.buffered.end(i));
    }
    return { current: v.currentTime || 0, duration: isFinite(v.duration) ? v.duration : 0, buffered };
  }

  async load({ url, title = '', startAt = 0, isBlob = false, mime = '' }) {
    this.#teardown();
    const isHls = HLS_RE.test(url) || /mpegurl/i.test(mime);
    this.src = { url, title, startAt, isBlob, isHls, cors: !isBlob, retried: false };
    this.#emit('loading', true);
    if (isHls) {
      const Hls = await loadHls(this.hlsUrl);
      if (Hls && Hls.isSupported()) return this.#loadWithHls(Hls, url);
      if (this.video.canPlayType('application/vnd.apple.mpegurl')) return this.#loadNative(url, true);
      return this.#fail('Este navegador no puede reproducir HLS (.m3u8).');
    }
    if (UNSUPPORTED.test(url) || /x-matroska|x-msvideo|x-ms-wmv/i.test(mime)) {
      const probe = this.video.canPlayType(mime || 'video/x-matroska');
      if (!probe) this.#emit('warn', 'Safari del iPad suele no abrir MKV/AVI/WMV. Si no reproduce, conviértelo a MP4 (H.264/HEVC).');
    }
    return this.#loadNative(url, !isBlob);
  }

  #loadNative(url, cors) {
    const v = this.video;
    if (cors) v.crossOrigin = 'anonymous';
    else v.removeAttribute('crossorigin');
    this.src.cors = cors;
    v.src = url;
    v.load();
    this.#tryPlay();
  }

  #loadWithHls(Hls, url) {
    const hls = new Hls({ enableWorker: true, backBufferLength: 90, maxBufferLength: 45, startLevel: -1, capLevelOnFPSDrop: true });
    this.hls = hls;
    this.src.cors = true;
    let netRetries = 0;
    let mediaRetries = 0;
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      this.#emit('tracks');
      this.#emit('quality');
      this.#tryPlay();
    });
    [Hls.Events.LEVEL_SWITCHED, Hls.Events.LEVELS_UPDATED].forEach((e) => hls.on(e, () => this.#emit('quality')));
    [Hls.Events.AUDIO_TRACKS_UPDATED, Hls.Events.AUDIO_TRACK_SWITCHED, Hls.Events.SUBTITLE_TRACKS_UPDATED, Hls.Events.SUBTITLE_TRACK_SWITCH].forEach((e) => hls.on(e, () => this.#emit('tracks')));
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && netRetries++ < 3) return hls.startLoad();
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries++ < 2) return hls.recoverMediaError();
      const pos = this.video.currentTime;
      hls.destroy();
      this.hls = null;
      if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
        this.src.startAt = pos;
        return this.#loadNative(url, true);
      }
      this.#fail(data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'No se pudo descargar la transmisión (red o CORS).' : 'Error al decodificar la transmisión.');
    });
    hls.loadSource(url);
    hls.attachMedia(this.video);
  }

  #onVideoError() {
    if (!this.src || this.hls) return;
    const err = this.video.error;
    if (!err) return;
    if (this.src.cors && !this.src.retried && err.code !== 3) {
      this.src.retried = true;
      this.src.startAt = this.video.currentTime || this.src.startAt;
      if (this.audio) this.#replaceVideo();
      return this.#loadNative(this.src.url, false);
    }
    const msgs = {
      1: 'Se canceló la carga.',
      2: 'Error de red al cargar el video. Si es un enlace de OneDrive viejo, vuelve a abrirlo.',
      3: 'El video está dañado o usa un códec que el iPad no soporta.',
      4: 'Formato no compatible con Safari (prueba MP4/MOV H.264 o HEVC, WebM o HLS).'
    };
    this.#fail(msgs[err.code] || 'No se pudo reproducir el video.');
  }

  #fail(message) {
    this.#emit('loading', false);
    this.#emit('error', message);
  }

  async #tryPlay() {
    try {
      await this.video.play();
    } catch {
      this.#emit('state', { playing: false, waiting: false, muted: this.video.muted });
    }
  }

  #teardown() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    const v = this.video;
    v.pause();
    [...v.querySelectorAll('track')].forEach((t) => t.remove());
    this.blobUrls.forEach((u) => URL.revokeObjectURL(u));
    this.blobUrls = [];
    this.#detachCueListener();
    this.cuesEl.textContent = '';
    if (this.src?.isBlob) URL.revokeObjectURL(this.src.url);
    v.removeAttribute('src');
    v.load();
    this.src = null;
  }

  destroy() {
    this.#teardown();
  }

  play() { return this.#tryPlay(); }
  pause() { this.video.pause(); }
  toggle() { return this.video.paused || this.video.ended ? this.play() : this.pause(); }

  seekTo(t) {
    const d = this.video.duration;
    this.video.currentTime = clamp(t, 0, isFinite(d) ? Math.max(0, d - 0.25) : t);
  }

  seekBy(delta) { this.seekTo(this.video.currentTime + delta); }

  get speed() { return this.video.playbackRate; }
  set speed(r) {
    this.video.playbackRate = r;
    this.video.defaultPlaybackRate = r;
  }

  setAspect(mode) {
    this.aspect = mode;
    this.applyAspect();
  }

  applyAspect() {
    const v = this.video;
    const W = this.stage.clientWidth;
    const H = this.stage.clientHeight;
    const ratio = { '16:9': 16 / 9, '4:3': 4 / 3, '21:9': 21 / 9 }[this.aspect];
    if (ratio && W && H) {
      const w = W / H > ratio ? H * ratio : W;
      v.style.width = `${Math.round(w)}px`;
      v.style.height = `${Math.round(w / ratio)}px`;
      v.style.objectFit = 'fill';
      return;
    }
    v.style.width = '100%';
    v.style.height = '100%';
    v.style.objectFit = { fit: 'contain', fill: 'fill', crop: 'cover' }[this.aspect] || 'contain';
  }

  setBrightness(b) {
    this.brightness = clamp(b, 0.2, 1.8);
    this.video.style.filter = Math.abs(this.brightness - 1) < 0.01 ? '' : `brightness(${this.brightness.toFixed(2)})`;
    return this.brightness;
  }

  get volumeControllable() {
    return nativeVolumeWorks || (!!(window.AudioContext || window.webkitAudioContext) && !!this.src && (this.src.isBlob || this.src.cors));
  }

  unlockAudio() {
    if (this.audio?.ctx.state === 'suspended') this.audio.ctx.resume();
  }

  #ensureAudioGraph() {
    if (this.audio) return true;
    if (!this.volumeControllable) return false;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const source = ctx.createMediaElementSource(this.video);
      const gain = ctx.createGain();
      source.connect(gain).connect(ctx.destination);
      this.audio = { ctx, gain };
      ctx.resume();
      return true;
    } catch {
      return false;
    }
  }

  setVolume(level) {
    this.volumeLevel = clamp(level, 0, 1);
    if (nativeVolumeWorks) {
      this.video.volume = this.volumeLevel;
      if (this.volumeLevel > 0 && this.video.muted) this.video.muted = false;
      return true;
    }
    if (!this.#ensureAudioGraph()) return false;
    this.audio.gain.gain.setTargetAtTime(this.volumeLevel, this.audio.ctx.currentTime, 0.02);
    if (this.volumeLevel > 0 && this.video.muted) this.video.muted = false;
    return true;
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    return this.video.muted;
  }

  qualityOptions() {
    if (this.hls && this.hls.levels?.length) {
      const levels = this.hls.levels;
      const manual = this.hls.manualLevel ?? (this.hls.autoLevelEnabled ? -1 : this.hls.currentLevel);
      const cur = levels[this.hls.currentLevel];
      const byHeight = new Map();
      levels.forEach((l, i) => {
        const h = l.height || 0;
        const prev = byHeight.get(h);
        if (!prev || l.bitrate > levels[prev].bitrate) byHeight.set(h, i);
      });
      const opts = [{ id: -1, label: `Auto${manual === -1 && cur?.height ? ` (${cur.height}p)` : ''}`, active: manual === -1 }];
      [...byHeight.entries()]
        .sort((a, b) => b[0] - a[0])
        .forEach(([h, i]) => {
          const kb = Math.round(levels[i].bitrate / 1000);
          opts.push({ id: i, label: h ? `${h}p` : `${kb} kbps`, hint: h ? `${(kb / 1000).toFixed(1)} Mbps` : '', active: manual === i });
        });
      return { options: opts, note: '' };
    }
    const v = this.video;
    const h = v.videoHeight;
    return {
      options: [{ id: 'orig', label: h ? `Original (${h}p)` : 'Original', hint: v.videoWidth ? `${v.videoWidth}×${h}` : '', active: true }],
      note: 'Este archivo tiene una sola calidad. Las calidades 1080p/720p/480p aparecen con transmisiones HLS (.m3u8) adaptativas.'
    };
  }

  qualityLabel() {
    if (this.hls && this.hls.levels?.length) {
      const manual = this.hls.manualLevel ?? -1;
      if (manual === -1) return 'Auto';
      return `${this.hls.levels[manual]?.height || ''}p`;
    }
    return this.video.videoHeight ? `${this.video.videoHeight}p` : 'Auto';
  }

  setQuality(id) {
    if (!this.hls) return;
    if (id === -1) {
      this.hls.currentLevel = -1;
      this.hls.loadLevel = -1;
    } else {
      this.hls.currentLevel = id;
    }
    this.#emit('quality');
  }

  audioOptions() {
    if (this.hls && this.hls.audioTracks?.length) {
      return this.hls.audioTracks.map((t, i) => ({ id: i, label: t.name || t.lang || `Pista ${i + 1}`, hint: t.lang || '', active: this.hls.audioTrack === i }));
    }
    const at = this.video.audioTracks;
    if (at && at.length) {
      return [...at].map((t, i) => ({ id: i, label: t.label || t.language || `Pista ${i + 1}`, hint: t.language || '', active: t.enabled }));
    }
    return [];
  }

  setAudio(id) {
    if (this.hls && this.hls.audioTracks?.length) {
      this.hls.audioTrack = id;
    } else if (this.video.audioTracks?.length) {
      [...this.video.audioTracks].forEach((t, i) => { t.enabled = i === id; });
    }
    this.#emit('tracks');
  }

  #textTracks() {
    return [...this.video.textTracks].filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
  }

  subtitleOptions() {
    const tracks = this.#textTracks();
    const opts = [{ id: -1, label: 'Desactivados', active: !tracks.some((t) => t.mode !== 'disabled') }];
    tracks.forEach((t, i) => opts.push({ id: i, label: t.label || t.language || `Subtítulo ${i + 1}`, hint: t.language || '', active: t.mode !== 'disabled' }));
    return opts;
  }

  setSubtitle(id) {
    const tracks = this.#textTracks();
    this.#detachCueListener();
    tracks.forEach((t, i) => { if (i !== id) t.mode = 'disabled'; });
    const t = tracks[id];
    if (t) {
      t.mode = 'hidden';
      this.activeTextTrack = t;
      t.addEventListener('cuechange', this.onCueChange);
      if (this.hls) {
        const idx = this.hls.subtitleTracks?.findIndex((s) => s.name === t.label && (s.lang || '') === (t.language || ''));
        if (idx >= 0) this.hls.subtitleTrack = idx;
      }
    } else if (this.hls) {
      this.hls.subtitleTrack = -1;
    }
    this.#renderCues();
    this.#emit('tracks');
  }

  #detachCueListener() {
    if (this.activeTextTrack) this.activeTextTrack.removeEventListener('cuechange', this.onCueChange);
    this.activeTextTrack = null;
  }

  #renderCues() {
    const el = this.cuesEl;
    el.textContent = '';
    const t = this.activeTextTrack;
    if (!t || !t.activeCues) return;
    [...t.activeCues].forEach((cue) => {
      const span = document.createElement('span');
      if (typeof cue.getCueAsHTML === 'function') span.appendChild(cue.getCueAsHTML());
      else span.textContent = cue.text;
      el.appendChild(span);
      el.appendChild(document.createElement('br'));
    });
  }

  async addSubtitle({ name, text, buffer, select = true }) {
    const raw = text ?? (await decodeSubtitleBytes(buffer));
    const url = subtitleBlobUrl(raw);
    this.blobUrls.push(url);
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = name.replace(/\.(srt|vtt)$/i, '');
    track.srclang = guessLang(name) || 'es';
    track.src = url;
    this.video.appendChild(track);
    track.track.mode = 'hidden';
    await new Promise((resolve) => {
      track.addEventListener('load', resolve, { once: true });
      track.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 1500);
    });
    const idx = this.#textTracks().indexOf(track.track);
    if (select && idx >= 0) this.setSubtitle(idx);
    else track.track.mode = 'disabled';
    this.#emit('tracks');
    return idx;
  }

  get pipSupported() {
    const v = this.video;
    return (document.pictureInPictureEnabled && typeof v.requestPictureInPicture === 'function') || typeof v.webkitSupportsPresentationMode === 'function';
  }

  async togglePip() {
    const v = this.video;
    if (document.pictureInPictureElement) return document.exitPictureInPicture();
    if (document.pictureInPictureEnabled && v.requestPictureInPicture) return v.requestPictureInPicture();
    if (v.webkitSupportsPresentationMode?.('picture-in-picture')) {
      v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    }
  }
}
