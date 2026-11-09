import { Player, SPEEDS, ASPECTS, ASPECT_SHORT } from './player.js';
import { Gestures, fmtTime } from './gestures.js';
import { OneDriveService, isOneDriveShareUrl } from './onedrive-service.js';
import { history, settings } from './storage.js';

const CFG = window.APP_CONFIG;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const PLAY_ICON = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const FOLDER_ICON = '<svg viewBox="0 0 24 24"><path d="M10 4H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z"/></svg>';

let prefs = settings.get();
let current = null;
let hideTimer = null;
let toastTimer = null;
let hudTimer = null;
let pendingLocalKey = null;

const ui = {
  library: $('#library'),
  player: $('#player'),
  stage: $('#stage'),
  controls: $('#controls'),
  seek: $('#seek'),
  seekBuffer: $('#seek-buffer'),
  timeCur: $('#time-cur'),
  timeDur: $('#time-dur'),
  spinner: $('#spinner'),
  errorBox: $('#error-box'),
  hud: $('#hud'),
  sheet: $('#sheet'),
  sheetList: $('#sheet-list')
};

const player = new Player({ stage: ui.stage, video: $('#video'), cuesEl: $('#cues'), hlsUrl: CFG.hlsUrl });
const od = new OneDriveService({
  clientId: prefs.clientId || CFG.oneDriveClientId,
  authority: CFG.authority,
  scopes: CFG.scopes,
  msalUrl: CFG.msalUrl
});

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function fmtSize(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}

/* ---------- Pestañas ---------- */
function showTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  sessionStorage.setItem('rp.tab', name);
  if (name === 'recent') renderRecent();
  if (name === 'onedrive') renderOneDrive();
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------- Tarjetas ---------- */
function card({ title, sub, thumb, badge, progress, folder, onClick, onRemove }) {
  const li = el('li', `file-item${folder ? ' folder' : ''}`);
  const btn = el('button', 'main');
  btn.type = 'button';
  const th = el('div', 'thumb');
  if (thumb) th.style.backgroundImage = `url("${thumb.replace(/"/g, '%22')}")`;
  else th.innerHTML = folder ? FOLDER_ICON : PLAY_ICON;
  if (badge) th.appendChild(el('span', 'badge', badge));
  if (progress > 0) {
    const p = el('i', 'progress');
    p.style.width = `${Math.min(100, progress * 100)}%`;
    th.appendChild(p);
  }
  const meta = el('div', 'meta');
  meta.appendChild(el('div', 'name', title));
  if (sub) meta.appendChild(el('div', 'sub', sub));
  btn.append(th, meta);
  btn.addEventListener('click', onClick);
  li.appendChild(btn);
  if (onRemove) {
    const rm = el('button', 'remove', 'Quitar');
    rm.type = 'button';
    rm.addEventListener('click', onRemove);
    li.appendChild(rm);
  }
  return li;
}

/* ---------- Recientes ---------- */
const SOURCE_LABEL = { onedrive: 'OneDrive', url: 'Enlace', local: 'Este iPad' };

function renderRecent() {
  const list = history.list();
  const ul = $('#recent-list');
  ul.textContent = '';
  $('#recent-empty').classList.toggle('hidden', list.length > 0);
  $('#btn-clear-history').classList.toggle('hidden', list.length === 0);
  $('#recent-count').textContent = list.length ? `${list.length} video${list.length > 1 ? 's' : ''}` : '';
  list.forEach((e) => {
    const done = e.duration && e.position >= e.duration - 10;
    const left = e.duration && !done ? `quedan ${fmtTime(e.duration - (e.position || 0))}` : done ? 'visto' : '';
    ul.appendChild(card({
      title: e.title,
      sub: [SOURCE_LABEL[e.source], left, new Date(e.updatedAt).toLocaleDateString('es')].filter(Boolean).join(' · '),
      thumb: e.thumb,
      badge: e.duration ? fmtTime(e.duration) : '',
      progress: e.duration ? (e.position || 0) / e.duration : 0,
      onClick: () => reopen(e),
      onRemove: () => { history.remove(e.key); renderRecent(); }
    }));
  });
}

$('#btn-clear-history').addEventListener('click', () => {
  if (confirm('¿Borrar todo el historial de reproducción?')) {
    history.clear();
    renderRecent();
  }
});

async function reopen(e) {
  try {
    if (e.source === 'onedrive') {
      await requireOneDrive();
      const item = await od.getItem(e.ref.driveId, e.ref.id);
      await playOneDriveItem(item);
    } else if (e.source === 'url') {
      await openPlayer({ key: e.key, source: 'url', title: e.title, url: e.ref.url, subUrl: e.ref.subUrl });
    } else if (e.source === 'local') {
      pendingLocalKey = e.key;
      toast(`Vuelve a elegir "${e.title}" para continuar.`);
      $('#local-file').click();
    }
  } catch (err) {
    toast(err.message || String(err), 5000);
  }
}

/* ---------- OneDrive ---------- */
const odState = { stack: [{ name: 'OneDrive', driveId: null, id: null }], searching: '' };

async function requireOneDrive() {
  if (!od.configured) {
    showTab('onedrive');
    throw new Error('Configura primero el ID de aplicación de Azure en Ajustes.');
  }
  await od.init();
  if (!od.signedIn) {
    showTab('onedrive');
    throw new Error('Inicia sesión en OneDrive.');
  }
}

function renderCrumbs() {
  const nav = $('#od-crumbs');
  nav.textContent = '';
  if (odState.searching) {
    const b = el('button', null, 'OneDrive');
    b.addEventListener('click', () => { odState.searching = ''; $('#od-search').value = ''; loadFolder(); });
    nav.append(b, el('span', null, '›'), el('span', null, `"${odState.searching}"`));
    return;
  }
  odState.stack.forEach((f, i) => {
    if (i) nav.appendChild(el('span', null, '›'));
    const b = el('button', null, f.name);
    b.addEventListener('click', () => {
      odState.stack = odState.stack.slice(0, i + 1);
      loadFolder();
    });
    nav.appendChild(b);
  });
}

function odThumb(it) {
  return it.thumbnails?.[0]?.medium?.url || '';
}

function renderOdItems({ folders, videos }) {
  const ul = $('#od-list');
  ul.textContent = '';
  folders.forEach((f) => ul.appendChild(card({
    title: f.name,
    sub: `${f.folder.childCount ?? 0} elementos`,
    folder: true,
    onClick: () => {
      odState.searching = '';
      $('#od-search').value = '';
      odState.stack.push({ name: f.name, driveId: f.parentReference.driveId, id: f.id });
      loadFolder();
    }
  })));
  videos.forEach((v) => {
    const h = history.get(`od:${v.parentReference.driveId}:${v.id}`);
    const durMs = v.video?.duration;
    ul.appendChild(card({
      title: v.name,
      sub: [fmtSize(v.size), v.video?.height ? `${v.video.height}p` : ''].filter(Boolean).join(' · '),
      thumb: odThumb(v),
      badge: durMs ? fmtTime(durMs / 1000) : '',
      progress: h?.duration ? (h.position || 0) / h.duration : 0,
      onClick: () => playOneDriveItem(v).catch((err) => toast(err.message, 5000))
    }));
  });
  $('#od-status').textContent = folders.length + videos.length ? '' : odState.searching ? 'Sin resultados.' : 'No hay videos ni carpetas aquí.';
}

async function loadFolder() {
  renderCrumbs();
  const status = $('#od-status');
  $('#od-list').textContent = '';
  status.textContent = 'Cargando…';
  try {
    const top = odState.stack[odState.stack.length - 1];
    renderOdItems(odState.searching ? await od.search(odState.searching) : await od.listFolder(top.driveId, top.id));
  } catch (err) {
    status.textContent = err.message || 'No se pudo cargar OneDrive.';
  }
}

let odLoadedOnce = false;
async function renderOneDrive() {
  const configured = od.configured;
  $('#od-noclient').classList.toggle('hidden', configured);
  $('#btn-od-login').disabled = !configured;
  if (configured) {
    try {
      await od.init();
    } catch (err) {
      toast(err.message, 5000);
    }
  }
  $('#od-signed-out').classList.toggle('hidden', od.signedIn);
  $('#od-signed-in').classList.toggle('hidden', !od.signedIn);
  if (od.signedIn && !odLoadedOnce) {
    odLoadedOnce = true;
    loadFolder();
  }
}

$('#btn-od-login').addEventListener('click', async () => {
  try {
    sessionStorage.setItem('rp.tab', 'onedrive');
    await od.login();
  } catch (err) {
    toast(err.message || String(err), 5000);
  }
});
$('#btn-od-logout').addEventListener('click', () => od.logout().catch((err) => toast(err.message)));
$('#od-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  odState.searching = e.target.value.trim();
  e.target.blur();
  loadFolder();
});
$('#od-search').addEventListener('search', (e) => {
  if (!e.target.value && odState.searching) {
    odState.searching = '';
    loadFolder();
  }
});

async function playOneDriveItem(item) {
  toast('Abriendo…', 1500);
  const { item: full, url } = await od.playable(item);
  const driveId = full.parentReference.driveId;
  await openPlayer({
    key: `od:${driveId}:${full.id}`,
    source: 'onedrive',
    ref: { driveId, id: full.id },
    title: full.name,
    url,
    mime: full.file?.mimeType || '',
    thumb: odThumb(full)
  });
  if (prefs.autoSubs) {
    od.findSubtitles(full).then(async (subs) => {
      for (let i = 0; i < subs.length; i++) await player.addSubtitle({ ...subs[i], select: i === 0 });
      if (subs.length) toast(`Subtítulos cargados: ${subs.map((s) => s.name).join(', ')}`);
    }).catch(() => {});
  }
}

/* ---------- Enlace ---------- */
$('#link-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#link-url').value.trim();
  const subUrl = $('#link-sub').value.trim();
  try {
    if (isOneDriveShareUrl(url)) {
      await requireOneDrive();
      const item = await od.resolveShare(url);
      await playOneDriveItem(item);
      return;
    }
    await openPlayer({ key: `url:${url}`, source: 'url', title: decodeURIComponent(url.split('/').pop().split('?')[0]) || url, url, subUrl });
  } catch (err) {
    toast(err.message || String(err), 5000);
  }
});

async function loadSubtitleUrl(subUrl) {
  try {
    const res = await fetch(subUrl);
    if (!res.ok) throw new Error();
    await player.addSubtitle({ name: decodeURIComponent(subUrl.split('/').pop().split('?')[0]) || 'subtitulos.vtt', buffer: await res.arrayBuffer() });
  } catch {
    toast('No se pudo descargar el subtítulo (el servidor no permite CORS). Cárgalo como archivo.', 5000);
  }
}

/* ---------- Local ---------- */
$('#local-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const key = `local:${file.name}:${file.size}`;
  if (pendingLocalKey && pendingLocalKey !== key) toast('Es otro archivo; empieza desde el inicio.');
  pendingLocalKey = null;
  await openPlayer({ key, source: 'local', title: file.name, url: URL.createObjectURL(file), isBlob: true, mime: file.type });
});

/* ---------- Reproductor ---------- */
async function openPlayer({ key, source, ref, title, url, subUrl, isBlob = false, mime = '', thumb = '' }) {
  const prev = history.get(key);
  history.upsert({ key, source, title, thumb: thumb || prev?.thumb || '', ref: ref || (source === 'url' ? { url, subUrl } : null) });
  current = { key, title };
  $('#title').textContent = title;
  ui.errorBox.classList.add('hidden');
  ui.player.classList.remove('hidden');
  ui.player.setAttribute('aria-hidden', 'false');
  ui.library.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = 'hidden';
  window.history.pushState({ player: true }, '');
  updateChips();
  showControls();
  await player.load({ url, title, isBlob, mime, startAt: prefs.resume ? prev?.position || 0 : 0 });
  player.speed = prefs.speed;
  player.setAspect(prefs.aspect);
  player.setBrightness(prefs.brightness);
  if (prefs.volume < 1) player.setVolume(prefs.volume);
  if (subUrl) loadSubtitleUrl(subUrl);
  setMediaSession(title, thumb);
}

function closePlayer(fromPop = false) {
  if (!current) return;
  savePosition();
  player.destroy();
  current = null;
  closeSheet();
  if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  ui.player.classList.add('hidden');
  ui.player.setAttribute('aria-hidden', 'true');
  ui.library.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = '';
  if (!fromPop && window.history.state?.player) window.history.back();
  renderRecent();
}

window.addEventListener('popstate', () => { if (current) closePlayer(true); });

function savePosition() {
  if (!current) return;
  const v = player.video;
  if (isFinite(v.duration) && v.duration > 0) history.savePosition(current.key, v.currentTime, v.duration);
}

player.addEventListener('progress', savePosition);
document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(); });
window.addEventListener('pagehide', savePosition);

player.addEventListener('state', (e) => {
  const { playing, waiting, muted } = e.detail;
  ui.player.classList.toggle('playing', playing);
  ui.player.classList.toggle('muted', muted);
  ui.spinner.classList.toggle('hidden', !waiting);
  $('#btn-play').setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  if (playing) {
    ui.errorBox.classList.add('hidden');
    scheduleHide();
  } else {
    showControls(false);
  }
});

player.addEventListener('loading', (e) => ui.spinner.classList.toggle('hidden', !e.detail));
player.addEventListener('error', (e) => {
  ui.errorBox.textContent = e.detail;
  ui.errorBox.classList.remove('hidden');
  ui.spinner.classList.add('hidden');
  showControls(false);
});
player.addEventListener('warn', (e) => toast(e.detail, 6000));
player.addEventListener('quality', updateChips);
player.addEventListener('tracks', updateChips);
player.addEventListener('rate', updateChips);

let seeking = false;
player.addEventListener('time', (e) => {
  const { current: cur, duration, buffered } = e.detail;
  ui.timeDur.textContent = fmtTime(duration);
  ui.seekBuffer.style.width = duration ? `${(buffered / duration) * 100}%` : '0';
  if (seeking) return;
  ui.timeCur.textContent = fmtTime(cur);
  const p = duration ? (cur / duration) * 1000 : 0;
  ui.seek.value = p;
  ui.seek.style.setProperty('--p', `${p / 10}%`);
  if ('mediaSession' in navigator && duration && navigator.mediaSession.setPositionState) {
    try {
      navigator.mediaSession.setPositionState({ duration, position: Math.min(cur, duration), playbackRate: player.video.playbackRate || 1 });
    } catch {}
  }
});

ui.seek.addEventListener('input', () => {
  seeking = true;
  const d = player.video.duration || 0;
  ui.timeCur.textContent = fmtTime((ui.seek.value / 1000) * d);
  ui.seek.style.setProperty('--p', `${ui.seek.value / 10}%`);
  showControls();
});
ui.seek.addEventListener('change', () => {
  player.seekTo((ui.seek.value / 1000) * (player.video.duration || 0));
  seeking = false;
  scheduleHide();
});

function showControls(autoHide = true) {
  ui.player.classList.add('show-ui');
  if (autoHide) scheduleHide();
  else clearTimeout(hideTimer);
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!player.video.paused && ui.sheet.classList.contains('hidden') && !seeking) ui.player.classList.remove('show-ui');
  }, 3200);
}

function toggleControls() {
  if (ui.player.classList.contains('show-ui')) {
    clearTimeout(hideTimer);
    ui.player.classList.remove('show-ui');
  } else {
    showControls(!player.video.paused);
  }
}

ui.controls.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button, input')) showControls(!player.video.paused);
});

$('#btn-play').addEventListener('click', () => player.toggle());
$('#btn-rew').addEventListener('click', () => { player.seekBy(-10); ripple('left', '−10 s'); });
$('#btn-fwd').addEventListener('click', () => { player.seekBy(10); ripple('right', '+10 s'); });
$('#btn-back').addEventListener('click', () => closePlayer());
$('#btn-mute').addEventListener('click', () => player.toggleMute());
$('#btn-pip').addEventListener('click', () => player.togglePip().catch(() => toast('Imagen en imagen no disponible.')));
$('#btn-fullscreen').addEventListener('click', toggleFullscreen);

function toggleFullscreen() {
  const d = document;
  const p = ui.player;
  if (d.fullscreenElement || d.webkitFullscreenElement) return (d.exitFullscreen || d.webkitExitFullscreen).call(d);
  const req = p.requestFullscreen || p.webkitRequestFullscreen;
  if (req) {
    const r = req.call(p);
    if (r?.catch) r.catch(() => player.video.webkitEnterFullscreen?.());
  } else if (player.video.webkitEnterFullscreen) {
    player.video.webkitEnterFullscreen();
  }
}

function ripple(side, text) {
  const r = $(`#ripple-${side}`);
  r.querySelector('span').textContent = text;
  r.classList.add('on');
  clearTimeout(r._t);
  r._t = setTimeout(() => r.classList.remove('on'), 450);
}

function hud(label, text, fraction) {
  clearTimeout(hudTimer);
  $('#hud-icon').textContent = label;
  $('#hud-text').textContent = text;
  const bar = ui.hud.querySelector('.hud-bar');
  bar.classList.toggle('hidden', fraction == null);
  if (fraction != null) $('#hud-fill').style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  ui.hud.classList.remove('hidden');
}

function hideHud(ms) {
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => ui.hud.classList.add('hidden'), ms);
}

function setAspect(mode) {
  player.setAspect(mode);
  prefs = settings.set({ aspect: mode });
  hud('Imagen', ASPECT_SHORT[mode], null);
  hideHud(800);
  updateChips();
}

new Gestures($('#gesture-layer'), player, {
  toggleControls,
  hud,
  hideHud,
  ripple,
  setAspect,
  persist: () => { prefs = settings.set({ brightness: player.brightness, volume: player.volumeLevel }); }
});

/* ---------- Menús ---------- */
function updateChips() {
  $('#chip-speed').textContent = `${player.speed}x`;
  $('#chip-aspect').textContent = ASPECT_SHORT[player.aspect];
  $('#chip-quality').textContent = player.qualityLabel();
  const audio = player.audioOptions();
  $('#chip-audio').classList.toggle('hidden', audio.length < 2);
  const subs = player.subtitleOptions();
  const activeSub = subs.find((s) => s.active && s.id !== -1);
  $('#chip-subs').textContent = activeSub ? `CC: ${activeSub.label}` : 'Subtítulos';
  $('#btn-pip').classList.toggle('hidden', !player.pipSupported);
}

function openSheet(title, options, onPick, extra = {}) {
  $('#sheet-title').textContent = title;
  ui.sheetList.textContent = '';
  if (extra.note) ui.sheetList.appendChild(el('li', 'note', extra.note));
  options.forEach((o) => {
    const li = el('li');
    const b = el('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(!!o.active));
    b.disabled = !!o.disabled;
    const label = el('span', null, o.label);
    b.appendChild(label);
    if (o.hint) b.appendChild(el('span', 'muted small', o.hint));
    b.addEventListener('click', () => {
      onPick(o.id);
      closeSheet();
    });
    li.appendChild(b);
    ui.sheetList.appendChild(li);
  });
  ui.sheet.classList.remove('hidden');
  showControls(false);
}

function closeSheet() {
  ui.sheet.classList.add('hidden');
  if (!player.video.paused) scheduleHide();
}

$('#sheet-close').addEventListener('click', closeSheet);
ui.sheet.addEventListener('click', (e) => { if (e.target === ui.sheet) closeSheet(); });

const menus = {
  speed: () => openSheet('Velocidad', SPEEDS.map((s) => ({ id: s, label: `${s}x`, hint: s === 1 ? 'Normal' : '', active: player.speed === s })), (s) => {
    player.speed = s;
    prefs = settings.set({ speed: s });
    updateChips();
  }),
  aspect: () => openSheet('Tamaño de imagen', ASPECTS.map((a) => ({ ...a, active: player.aspect === a.id })), setAspect, { note: 'También puedes pellizcar: abrir = recortar, cerrar = ajustar.' }),
  quality: () => {
    const q = player.qualityOptions();
    openSheet('Calidad', q.options, (id) => { if (id !== 'orig') player.setQuality(id); }, { note: q.note });
  },
  audio: () => {
    const opts = player.audioOptions();
    openSheet('Pista de audio', opts.length ? opts : [{ id: 0, label: 'Pista única', active: true, disabled: true }], (id) => player.setAudio(id));
  },
  subs: () => {
    const opts = player.subtitleOptions();
    opts.push({ id: 'file', label: 'Cargar archivo .srt / .vtt…' });
    openSheet('Subtítulos', opts, (id) => {
      if (id === 'file') $('#sub-file').click();
      else player.setSubtitle(id);
    });
  }
};
document.querySelectorAll('[data-menu]').forEach((b) => b.addEventListener('click', () => menus[b.dataset.menu]()));

$('#sub-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  await player.addSubtitle({ name: file.name, buffer: await file.arrayBuffer() });
  toast(`Subtítulo: ${file.name}`);
});

/* ---------- Teclado (iPad con teclado) ---------- */
document.addEventListener('keydown', (e) => {
  if (!current || e.target.closest('input, textarea')) return;
  const k = e.key;
  if (k === ' ' || k === 'k') player.toggle();
  else if (k === 'ArrowLeft' || k === 'j') player.seekBy(-10);
  else if (k === 'ArrowRight' || k === 'l') player.seekBy(10);
  else if (k === 'ArrowUp') player.setVolume(player.volumeLevel + 0.1);
  else if (k === 'ArrowDown') player.setVolume(player.volumeLevel - 0.1);
  else if (k === 'f') toggleFullscreen();
  else if (k === 'm') player.toggleMute();
  else if (k === 'p') player.togglePip().catch(() => {});
  else if (k === 'Escape') { if (!ui.sheet.classList.contains('hidden')) closeSheet(); else return; }
  else return;
  e.preventDefault();
  showControls(!player.video.paused);
});

/* ---------- Media Session ---------- */
function setMediaSession(title, thumb) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'Reproductor', artwork: thumb ? [{ src: thumb, sizes: '512x512' }] : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }] });
  const handlers = {
    play: () => player.play(),
    pause: () => player.pause(),
    seekbackward: (d) => player.seekBy(-(d.seekOffset || 10)),
    seekforward: (d) => player.seekBy(d.seekOffset || 10),
    seekto: (d) => player.seekTo(d.seekTime)
  };
  Object.entries(handlers).forEach(([a, h]) => {
    try { navigator.mediaSession.setActionHandler(a, h); } catch {}
  });
}

/* ---------- Ajustes ---------- */
function applySubScale() {
  document.documentElement.style.setProperty('--sub-scale', String(prefs.subScale / 100));
}

$('#btn-settings').addEventListener('click', () => {
  $('#set-client').value = prefs.clientId || CFG.oneDriveClientId || '';
  $('#set-redirect').textContent = od.redirectUri;
  $('#set-resume').checked = prefs.resume;
  $('#set-autosubs').checked = prefs.autoSubs;
  $('#set-subsize').value = prefs.subScale;
  $('#settings').showModal();
});

$('#settings').addEventListener('close', () => {
  if ($('#settings').returnValue !== 'save') return;
  const clientId = $('#set-client').value.trim();
  const changed = clientId !== (prefs.clientId || CFG.oneDriveClientId || '');
  prefs = settings.set({
    clientId,
    resume: $('#set-resume').checked,
    autoSubs: $('#set-autosubs').checked,
    subScale: Number($('#set-subsize').value)
  });
  applySubScale();
  if (changed) {
    toast('Guardado. Recargando para aplicar el ID de OneDrive…', 1500);
    setTimeout(() => location.reload(), 1200);
  } else {
    toast('Ajustes guardados.');
  }
});

/* ---------- Inicio ---------- */
applySubScale();
showTab(sessionStorage.getItem('rp.tab') || 'recent');
if (od.configured) {
  od.init().then(() => {
    if (document.querySelector('.tab.active')?.dataset.tab === 'onedrive') renderOneDrive();
  }).catch((err) => toast(err.message, 5000));
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
