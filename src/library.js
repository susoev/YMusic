// Синхронизация «Мне нравится» с диском: новые лайки докачиваются фоном, снятые — удаляются.
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');
const { YandexMusic, AuthError } = require('./yandex');
const { writeAtomic } = require('./config');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Имя файла: «Исполнитель - Название [id].mp3», без запрещённых в Windows символов.
function fileName(t) {
  const clean = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  const base = clean(`${t.artists} - ${t.title}`).slice(0, 150).replace(/[. ]+$/, '');
  return `${base} [${String(t.id).split(':')[0]}].mp3`;
}

class Library {
  constructor({ dir, getConfig, getToken, onChange, onStatus, onAuthError, log }) {
    this.dir = dir;
    this.file = path.join(dir, 'library.json');
    this.getConfig = getConfig;
    this.getToken = getToken;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.onAuthError = onAuthError;
    this.log = log || (() => {});
    const d = readJson(this.file, {});
    this.data = { uid: d.uid || null, revision: d.revision || 0, order: d.order || [], tracks: d.tracks || {}, trash: d.trash || [], dislikes: d.dislikes || [], blocked: d.blocked || {} };
    this.status = { state: 'idle', total: 0, ready: 0, queue: 0, at: null, error: null, login: null };
    this.running = false;
    this.again = false;
    this.timer = null;
    this.verifyFiles();
  }

  musicDir() {
    const custom = (this.getConfig().music_dir || '').trim();
    const d = custom || path.join(this.dir, 'tracks');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  save() { writeAtomic(this.file, JSON.stringify(this.data)); }

  // Файлы могли удалить руками или сменить папку — проверяем при старте.
  verifyFiles() {
    for (const t of Object.values(this.data.tracks)) {
      if (t.file && !fs.existsSync(t.file)) delete t.file;
    }
    this.countStatus();
  }

  // Готовые к проигрыванию треки, порядок как в Яндексе (новые сверху).
  playable() {
    return this.data.order
      .map(id => this.data.tracks[id])
      .filter(t => t && t.file)
      .map(t => ({ id: t.id, title: t.title, artists: t.artists, album: t.album, durationMs: t.durationMs, url: pathToFileURL(t.file).href }));
  }

  countStatus() {
    const all = this.data.order.map(id => this.data.tracks[id]).filter(Boolean);
    this.status.total = all.length;
    this.status.ready = all.filter(t => t.file).length;
    this.status.queue = all.filter(t => !t.file && t.available !== false).length;
  }

  setStatus(patch) {
    Object.assign(this.status, patch);
    this.countStatus();
    this.onStatus({ ...this.status });
  }

  start() {
    clearInterval(this.timer);
    const min = Math.max(1, this.getConfig().sync_interval_min || 10);
    this.timer = setInterval(() => this.sync(), min * 60 * 1000);
    this.sync();
  }

  stop() { clearInterval(this.timer); }

  async sync() {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.syncOnce();
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  async syncOnce() {
    const token = this.getToken();
    if (!token) { this.setStatus({ state: 'auth', error: null }); return; }
    const api = new YandexMusic(token);
    this.setStatus({ state: 'syncing', error: null });
    try {
      await api.init();
      this.status.login = api.login;
      if (this.data.uid && this.data.uid !== api.uid) {
        // Вошли другим аккаунтом — старую библиотеку убираем.
        this.log('account changed', this.data.uid, '->', api.uid);
        for (const id of [...this.data.order]) this.removeTrack(id);
        this.data.order = [];
      }
      this.data.uid = api.uid;

      this.emptyTrash();
      await this.sendDislikes(api);
      const liked = await api.likedTracks();
      const ids = this.filterBlocked(liked.tracks, await api.dislikedTracks().catch((e) => { this.log('dislikes list', e); return []; }));
      const keep = new Set(ids);
      let changed = false;

      for (const id of Object.keys(this.data.tracks)) {
        if (!keep.has(id)) { this.removeTrack(id); changed = true; }
      }

      const noMeta = ids.filter(id => !this.data.tracks[id]);
      if (noMeta.length) {
        const full = await api.tracks(noMeta);
        const byId = new Map();
        for (const t of full) {
          const albumId = t.albums && t.albums[0] && t.albums[0].id;
          byId.set(String(t.id), t);
          if (albumId) byId.set(`${t.id}:${albumId}`, t);
        }
        for (const id of noMeta) {
          const t = byId.get(id) || byId.get(id.split(':')[0]);
          if (!t) continue;
          this.data.tracks[id] = {
            id,
            title: t.title + (t.version ? ` (${t.version})` : ''),
            artists: (t.artists || []).map(a => a.name).join(', ') || 'Неизвестный исполнитель',
            album: (t.albums && t.albums[0] && t.albums[0].title) || '',
            durationMs: t.durationMs || 0,
            available: t.available !== false,
          };
        }
        changed = true;
      }

      if (changed || ids.join() !== this.data.order.join()) {
        this.data.order = ids.filter(id => this.data.tracks[id]);
        this.data.revision = liked.revision;
        this.save();
        this.onChange(this.playable());
      }

      await this.downloadMissing(api);
      this.setStatus({ state: 'ok', at: Date.now(), error: null });
    } catch (e) {
      this.log('sync error', e);
      if (e instanceof AuthError) {
        this.setStatus({ state: 'auth', error: e.message });
        this.onAuthError(e);
      } else {
        this.setStatus({ state: 'error', error: e.message || String(e), at: this.status.at });
      }
    }
  }

  // Дизлайк из плеера: трек сразу попадает в локальный стоп-лист (blocked) и больше не играет,
  // даже если Яндекс не снимет лайк. В Яндекс отправляем при синхронизации (без сети — позже).
  dislike(id) {
    this.data.blocked[String(id).split(':')[0]] = Date.now();
    this.data.dislikes = [...new Set([...(this.data.dislikes || []), id])];
    this.removeTrack(id);
    this.data.order = this.data.order.filter(x => x !== id);
    this.save();
    this.onChange(this.playable());
    this.sync();
  }

  // Стоп-лист = свои дизлайки + «Не рекомендовать» из Яндекса.
  // Трек снова играет, только если его лайкнули ПОСЛЕ дизлайка (например, в браузере).
  filterBlocked(likes, yandexDislikes) {
    const blocked = this.data.blocked;
    for (const d of yandexDislikes) blocked[d.num] = Math.max(blocked[d.num] || 0, d.ts || 1);
    const out = [];
    for (const t of likes) {
      const num = t.id.split(':')[0];
      const at = blocked[num];
      if (!at) { out.push(t.id); continue; }
      if (t.ts && t.ts > at + 60 * 1000) {
        this.log('unblocked (liked again)', t.id);
        delete blocked[num];
        out.push(t.id);
      }
    }
    // Записи, которых нет ни в лайках, ни в дизлайках Яндекса, больше не нужны.
    const alive = new Set([...likes.map(t => t.id.split(':')[0]), ...yandexDislikes.map(d => d.num), ...(this.data.dislikes || []).map(x => String(x).split(':')[0])]);
    for (const num of Object.keys(blocked)) if (!alive.has(num)) delete blocked[num];
    return out;
  }

  async sendDislikes(api) {
    for (const id of [...(this.data.dislikes || [])]) {
      const r = await api.dislike(id);
      this.log('disliked', id, JSON.stringify(r));
      this.data.dislikes = this.data.dislikes.filter(x => x !== id);
      this.save();
    }
  }

  // Файл может быть занят (сейчас играет) — тогда удалим при следующей синхронизации.
  removeTrack(id) {
    const t = this.data.tracks[id];
    if (t && t.file) this.unlink(t.file);
    delete this.data.tracks[id];
  }

  unlink(file) {
    try { fs.unlinkSync(file); } catch (e) {
      if (e.code === 'ENOENT') return;
      this.log('unlink later', file, e.code);
      this.data.trash = [...new Set([...(this.data.trash || []), file])];
    }
  }

  emptyTrash() {
    const left = [];
    for (const f of this.data.trash || []) {
      try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') left.push(f); }
    }
    this.data.trash = left;
  }

  // По одному треку, новые лайки первыми.
  async downloadMissing(api) {
    const dir = this.musicDir();
    for (const id of [...this.data.order]) {
      const t = this.data.tracks[id];
      if (!t || t.file || t.available === false) continue;
      if (t.failedAt && Date.now() - t.failedAt < 30 * 60 * 1000) continue;
      this.setStatus({ state: 'syncing', current: `${t.artists} — ${t.title}` });
      const target = path.join(dir, fileName(t));
      const part = target + '.part';
      try {
        const { url, bitrate } = await api.mp3Link(id);
        const res = await api.fetchFile(url);
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
        if (fs.statSync(part).size < 10 * 1024) throw new Error('слишком маленький файл');
        fs.renameSync(part, target);
        // Пока качали, лайк могли снять.
        if (!this.data.tracks[id]) { this.unlink(target); continue; }
        Object.assign(t, { file: target, bitrate });
        delete t.failedAt;
        this.save();
        this.onChange(this.playable());
      } catch (e) {
        try { fs.unlinkSync(part); } catch { /* */ }
        if (e instanceof AuthError) throw e;
        this.log('download failed', id, e);
        t.failedAt = Date.now();
        this.save();
      }
    }
    this.status.current = null;
  }

  // Плеер не смог открыть файл — удаляем и скачаем заново.
  broken(id) {
    const t = this.data.tracks[id];
    if (!t || !t.file) return;
    this.log('broken file', t.file);
    this.unlink(t.file);
    delete t.file;
    // Повторяется — значит дело не в файле; не качаем по кругу, ждём 30 минут.
    t.broken = (t.broken || 0) + 1;
    if (t.broken >= 2) { t.failedAt = Date.now(); t.broken = 0; }
    this.save();
    this.onChange(this.playable());
    this.sync();
  }

  // Смена music_dir: уже скачанные файлы остаются на месте, новые качаются в новую папку.
  dirChanged() {
    this.verifyFiles();
    this.onChange(this.playable());
    this.sync();
  }
}

module.exports = { Library, fileName };
