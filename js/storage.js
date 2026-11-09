const HISTORY_KEY = 'rp.history.v1';
const SETTINGS_KEY = 'rp.settings.v1';
const MAX_HISTORY = 60;

const DEFAULT_SETTINGS = {
  clientId: '',
  resume: true,
  autoSubs: true,
  subScale: 100,
  speed: 1,
  aspect: 'fit',
  volume: 1,
  brightness: 1
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    if (key === HISTORY_KEY && Array.isArray(value) && value.length > 10) write(key, value.slice(0, Math.floor(value.length / 2)));
  }
}

export const settings = {
  get() {
    return { ...DEFAULT_SETTINGS, ...read(SETTINGS_KEY, {}) };
  },
  set(patch) {
    const next = { ...this.get(), ...patch };
    write(SETTINGS_KEY, next);
    return next;
  }
};

export const history = {
  list() {
    return read(HISTORY_KEY, []);
  },
  get(key) {
    return this.list().find((e) => e.key === key) || null;
  },
  upsert(entry) {
    const list = this.list();
    const i = list.findIndex((e) => e.key === entry.key);
    const merged = { ...(i >= 0 ? list[i] : {}), ...entry, updatedAt: Date.now() };
    if (i >= 0) list.splice(i, 1);
    list.unshift(merged);
    write(HISTORY_KEY, list.slice(0, MAX_HISTORY));
    return merged;
  },
  savePosition(key, position, duration) {
    const list = this.list();
    const e = list.find((x) => x.key === key);
    if (!e) return;
    e.position = position;
    e.duration = duration;
    e.updatedAt = Date.now();
    write(HISTORY_KEY, list);
  },
  remove(key) {
    write(HISTORY_KEY, this.list().filter((e) => e.key !== key));
  },
  clear() {
    write(HISTORY_KEY, []);
  }
};
