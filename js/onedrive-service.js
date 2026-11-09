const GRAPH = 'https://graph.microsoft.com/v1.0';
export const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|m3u8|ts|mts|m2ts|3gp|avi|wmv)$/i;
export const SUB_EXT = /\.(srt|vtt)$/i;
const PAGE = 200;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.msal) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se pudo cargar la librería de Microsoft (¿sin conexión?).'));
    document.head.appendChild(s);
  });
}

function base64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isVideoItem(item) {
  return !!item.file && (item.file.mimeType?.startsWith('video/') || VIDEO_EXT.test(item.name) || !!item.video);
}

export function isOneDriveShareUrl(url) {
  try {
    const h = new URL(url).hostname;
    return /(^|\.)1drv\.ms$|(^|\.)onedrive\.live\.com$|(^|\.)sharepoint\.com$/i.test(h);
  } catch {
    return false;
  }
}

export class OneDriveService {
  constructor({ clientId, authority, scopes, msalUrl }) {
    this.clientId = (clientId || '').trim();
    this.authority = authority;
    this.scopes = scopes;
    this.msalUrl = msalUrl;
    this.pca = null;
    this.account = null;
    this.ready = null;
  }

  get configured() {
    return /^[0-9a-f-]{36}$/i.test(this.clientId);
  }

  get signedIn() {
    return !!this.account;
  }

  get redirectUri() {
    return location.origin + location.pathname.replace(/index\.html$/, '');
  }

  init() {
    if (!this.configured) return Promise.resolve(false);
    if (!this.ready) this.ready = this.#init();
    return this.ready;
  }

  async #init() {
    await loadScript(this.msalUrl);
    this.pca = new window.msal.PublicClientApplication({
      auth: {
        clientId: this.clientId,
        authority: this.authority,
        redirectUri: this.redirectUri,
        postLogoutRedirectUri: this.redirectUri,
        navigateToLoginRequestUrl: false
      },
      cache: { cacheLocation: 'localStorage', storeAuthStateInCookie: true }
    });
    const result = await this.pca.handleRedirectPromise();
    this.account = result?.account || this.pca.getAllAccounts()[0] || null;
    if (this.account) this.pca.setActiveAccount(this.account);
    return true;
  }

  async login() {
    await this.init();
    await this.pca.loginRedirect({ scopes: this.scopes, prompt: 'select_account', redirectStartPage: this.redirectUri });
  }

  async logout() {
    await this.init();
    const account = this.account;
    this.account = null;
    await this.pca.logoutRedirect({ account, postLogoutRedirectUri: this.redirectUri });
  }

  async token() {
    await this.init();
    if (!this.account) throw new Error('Inicia sesión en OneDrive.');
    try {
      const r = await this.pca.acquireTokenSilent({ scopes: this.scopes, account: this.account });
      return r.accessToken;
    } catch (err) {
      if (err instanceof window.msal.InteractionRequiredAuthError || /interaction_required|login_required|consent_required/.test(err.errorCode || '')) {
        await this.pca.acquireTokenRedirect({ scopes: this.scopes, account: this.account });
      }
      throw err;
    }
  }

  async graph(pathOrUrl, attempt = 0) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : GRAPH + pathOrUrl;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await this.token()}` } });
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      await sleep((Number(res.headers.get('Retry-After')) || 2 ** attempt) * 1000);
      return this.graph(pathOrUrl, attempt + 1);
    }
    if (!res.ok) {
      let msg = `Error ${res.status} de OneDrive`;
      try {
        const j = await res.json();
        if (j.error?.message) msg += `: ${j.error.message}`;
      } catch {}
      throw new Error(msg);
    }
    return res.json();
  }

  async #collect(path, limit = 2000) {
    const items = [];
    let next = path;
    while (next && items.length < limit) {
      const page = await this.graph(next);
      items.push(...(page.value || []));
      next = page['@odata.nextLink'];
    }
    return items;
  }

  #shape(items) {
    const folders = [];
    const videos = [];
    for (const it of items) {
      if (it.folder) folders.push(it);
      else if (isVideoItem(it)) videos.push(it);
    }
    const byName = (a, b) => a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' });
    return { folders: folders.sort(byName), videos: videos.sort(byName) };
  }

  async listFolder(driveId, itemId) {
    const base = driveId && itemId ? `/drives/${driveId}/items/${itemId}` : '/me/drive/root';
    const items = await this.#collect(`${base}/children?$top=${PAGE}&$expand=thumbnails($select=medium)`);
    return this.#shape(items);
  }

  async search(query) {
    const q = query.replace(/'/g, "''");
    const items = await this.#collect(`/me/drive/root/search(q='${encodeURIComponent(q)}')?$top=${PAGE}&$expand=thumbnails($select=medium)`, 600);
    return this.#shape(items);
  }

  async getItem(driveId, itemId) {
    return this.graph(`/drives/${driveId}/items/${itemId}?$expand=thumbnails($select=medium)`);
  }

  async resolveShare(url) {
    const item = await this.graph(`/shares/u!${base64Url(url)}/driveItem?$expand=thumbnails($select=medium)`);
    if (item.folder) throw new Error('El enlace es de una carpeta; abre la carpeta desde la pestaña OneDrive.');
    return item;
  }

  async playable(item) {
    const fresh = item['@microsoft.graph.downloadUrl'] ? item : await this.getItem(item.parentReference.driveId, item.id);
    const url = fresh['@microsoft.graph.downloadUrl'];
    if (!url) throw new Error('OneDrive no entregó un enlace de reproducción para este archivo.');
    return { item: fresh, url };
  }

  async findSubtitles(item) {
    const parent = item.parentReference;
    if (!parent?.driveId || !parent?.id) return [];
    const base = item.name.replace(/\.[^.]+$/, '').toLowerCase();
    const siblings = await this.#collect(`/drives/${parent.driveId}/items/${parent.id}/children?$top=${PAGE}&$select=id,name,file,parentReference`);
    const subs = siblings.filter((s) => s.file && SUB_EXT.test(s.name) && s.name.toLowerCase().startsWith(base));
    const out = [];
    for (const s of subs.slice(0, 6)) {
      const full = await this.getItem(parent.driveId, s.id);
      const res = await fetch(full['@microsoft.graph.downloadUrl']);
      if (res.ok) out.push({ name: s.name, buffer: await res.arrayBuffer() });
    }
    return out;
  }
}
