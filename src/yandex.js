// Клиент неофициального API Яндекс Музыки: только то, что нужно плееру.
// Протокол сверен с библиотекой MarshalX/yandex-music-api (Python).
const crypto = require('crypto');

const API = process.env.YMUSIC_API_BASE || 'https://api.music.yandex.net';
const DL_SCHEME = process.env.YMUSIC_DL_SCHEME || 'https';
const SIGN_SALT = 'XGRlBW9FXlekgbPrRHuSiA';
const DESKTOP_SIGN_KEY = 'kzqU4XhfCaY6B6JTHODeq5';
const DESKTOP_CLIENT = 'YandexMusicDesktopAppWindows/5.95.0';

// Вход: публичный client_id официального приложения Яндекс Музыки.
const CLIENT_ID = '23cabbbdc6cd418abb4b39c32c41195d';
const AUTH_URL = process.env.YMUSIC_AUTH_URL ||
  `https://oauth.yandex.ru/authorize?response_type=token&client_id=${CLIENT_ID}`;

class AuthError extends Error {}

// В Electron используем net.fetch (системный прокси, сертификаты Windows), в тестах — обычный fetch.
let doFetch = globalThis.fetch;
try { const { net } = require('electron'); if (net && net.fetch) doFetch = (u, o) => net.fetch(u, o); } catch { /* вне Electron */ }

class YandexMusic {
  constructor(token) {
    this.token = token;
    this.uid = null;
  }

  headers(extra = {}) {
    return {
      'Authorization': `OAuth ${this.token}`,
      'X-Yandex-Music-Client': 'YandexMusicAndroid/24023621',
      'Accept-Language': 'ru',
      'User-Agent': 'Yandex-Music-API',
      ...extra,
    };
  }

  async request(method, pathOrUrl, { params, form, headers, raw } = {}) {
    let url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
    if (params) url += (url.includes('?') ? '&' : '?') + new URLSearchParams(params).toString();
    const opts = { method, headers: this.headers(headers) };
    if (form) {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) {
        if (Array.isArray(v)) v.forEach(x => body.append(k, String(x)));
        else body.append(k, String(v));
      }
      opts.body = body.toString();
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    opts.signal = ctrl.signal;
    let res;
    try { res = await doFetch(url, opts); } finally { clearTimeout(timer); }
    if (res.status === 401 || res.status === 403) throw new AuthError(`Яндекс отклонил токен (${res.status})`);
    if (raw) {
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return res.text();
    }
    let json = null;
    try { json = await res.json(); } catch { /* не JSON */ }
    if (!res.ok || !json || json.error) {
      const msg = json && json.error ? (json.error.message || json.error.name || JSON.stringify(json.error)) : `HTTP ${res.status}`;
      throw new Error(`${msg} (${method} ${pathOrUrl})`);
    }
    return json.result;
  }

  async init() {
    const r = await this.request('GET', '/account/status');
    const acc = r && r.account;
    if (!acc || !acc.uid) throw new AuthError('Не удалось определить аккаунт — войдите заново');
    this.uid = acc.uid;
    this.login = acc.login || acc.displayName || String(acc.uid);
    this.plus = !!(r.plus && r.plus.hasPlus);
    return this;
  }

  // «Мне нравится»: [{ id: "trackId:albumId", ts }] от новых к старым + ревизия.
  async likedTracks() {
    const r = await this.request('GET', `/users/${this.uid}/likes/tracks`, { params: { 'if-modified-since-revision': 0 } });
    const lib = (r && r.library) || {};
    const list = (lib.tracks || []).map(t => ({
      id: t.albumId ? `${t.id}:${t.albumId}` : String(t.id),
      ts: t.timestamp ? Date.parse(t.timestamp) || 0 : 0,
    }));
    return { revision: lib.revision || 0, tracks: list };
  }

  // Дизлайк: трек уходит в «Не рекомендовать» и снимается с «Мне нравится».
  // Лайк снимаем по номеру трека (без альбома) — так он записан в списке лайков.
  async dislike(trackId) {
    const num = String(trackId).split(':')[0];
    const a = await this.request('POST', `/users/${this.uid}/dislikes/tracks/add-multiple`, { form: { 'track-ids': [trackId] } });
    const b = await this.request('POST', `/users/${this.uid}/likes/tracks/remove`, { form: { 'track-ids': [num] } });
    return { dislike: a, unlike: b };
  }

  // Треки с отметкой «Не рекомендовать»: [{ num, ts }].
  async dislikedTracks() {
    const r = await this.request('GET', `/users/${this.uid}/dislikes/tracks`, { params: { 'if-modified-since-revision': 0 } });
    const lib = (r && r.library) || {};
    return (lib.tracks || []).map(t => ({ num: String(t.id), ts: t.timestamp ? Date.parse(t.timestamp) || 0 : 0 }));
  }

  // Полные данные треков пачками по 100.
  async tracks(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const r = await this.request('POST', '/tracks', { form: { 'track-ids': chunk, 'with-positions': 'True' } });
      if (Array.isArray(r)) out.push(...r);
    }
    return out;
  }

  // Прямая ссылка на MP3 (лучший битрейт). Ссылка живёт около минуты — качать сразу.
  async mp3Link(trackId) {
    const num = String(trackId).split(':')[0];
    try {
      const infos = await this.request('GET', `/tracks/${trackId}/download-info`);
      const mp3 = (infos || []).filter(i => i.codec === 'mp3' && !i.preview).sort((a, b) => b.bitrateInKbps - a.bitrateInKbps)[0];
      if (!mp3) throw new Error('нет mp3 в download-info');
      const xml = await this.request('GET', mp3.downloadInfoUrl, { raw: true });
      const tag = (n) => { const m = xml.match(new RegExp(`<${n}>([^<]*)</${n}>`)); return m ? m[1] : ''; };
      const host = tag('host'), p = tag('path'), ts = tag('ts'), s = tag('s');
      if (!host || !p || !s) throw new Error('неожиданный ответ download-info');
      const sign = crypto.createHash('md5').update(SIGN_SALT + p.slice(1) + s).digest('hex');
      return { url: `${DL_SCHEME}://${host}/get-mp3/${sign}/${ts}${p}`, bitrate: mp3.bitrateInKbps };
    } catch (e) {
      if (e instanceof AuthError) throw e;
      // Запасной путь — новый метод get-file-info (так сейчас качает десктопное приложение).
      const link = await this.fileInfoLink(num).catch(() => null);
      if (link) return link;
      throw e;
    }
  }

  async fileInfoLink(trackId) {
    const quality = 'nq', codecs = ['mp3'], transport = 'raw';
    const ts = Math.floor(Date.now() / 1000);
    const msg = `${ts}${trackId}${quality}${codecs.join('')}${transport}`;
    const sign = crypto.createHmac('sha256', DESKTOP_SIGN_KEY).update(msg).digest('base64').slice(0, -1);
    const r = await this.request('GET', '/get-file-info', {
      params: { ts, trackId, quality, codecs: codecs.join(','), transports: transport, sign },
      headers: { 'X-Yandex-Music-Client': DESKTOP_CLIENT },
    });
    const info = r && r.downloadInfo;
    if (!info || !info.url || info.codec !== 'mp3') return null;
    return { url: info.url, bitrate: info.bitrate || 0 };
  }

  // Скачивание по прямой ссылке в виде потока байтов.
  async fetchFile(url) {
    const res = await doFetch(url, { headers: { 'User-Agent': 'Yandex-Music-API' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} при скачивании`);
    return res;
  }
}

// Токен из адреса после входа: ...#access_token=XXX&token_type=bearer...
function tokenFromUrl(url) {
  const m = String(url).match(/[#&?]access_token=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

module.exports = { YandexMusic, AuthError, AUTH_URL, tokenFromUrl };
