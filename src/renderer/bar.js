const $ = (id) => document.getElementById(id);
const audio = $('audio');
const titleEl = $('title');
const timeEl = $('time');
const fill = $('fill');

let cfg = null;
let tracks = [];            // готовые к проигрыванию, порядок как в Яндексе
let byId = new Map();
let order = [];             // очередь воспроизведения (перемешанная или нет)
let pos = -1;               // индекс текущего трека в order
let current = null;         // id текущего трека
let shuffle = true;
let history = [];           // недавно сыгранные id, новые первыми
let status = {};
let wantPlay = false;       // при старте: играть ли, когда появится первый трек
let flash = null;           // временная надпись (громкость)
let flashTimer = null;
let flashAction = null;     // { label, run } — ссылка в надписи (например «Отменить»)
let pendingDislike = null;  // { id, timer } — 5 секунд на отмену
let lastSavedTime = 0;

// ---------- Цвета из одного hex (как в Sticker) ----------
function hexToHsl(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let hue = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    hue = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hue *= 60;
  }
  return [hue, s * 100, l * 100];
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hsl = (h, s, l, a = 1) => `hsla(${(h + 360) % 360}, ${clamp(s, 0, 100)}%, ${clamp(l, 0, 100)}%, ${a})`;

function palette(hex, theme) {
  const [h, s, l] = hexToHsl(hex);
  if (theme === 'dark') {
    return {
      bg: hsl(h, s * 0.25, 10),
      panel: hsl(h, s * 0.22, 14),
      rule: hsl(h, s * 0.3, 24),
      ink: hsl(h, s * 0.35, 90),
      'ink-soft': hsl(h, s * 0.2, 60),
      edge: hsl(h, s, Math.max(l, 60)),
      hover: hsl(h, s * 0.5, 40, 0.3),
      error: '#FF7A6B',
    };
  }
  const lightPaper = l >= 50;
  return {
    bg: hsl(h, s + 8, l - 14),
    panel: hsl(h, s, l),
    rule: hsl(h, s, l - 22, 0.6),
    ink: lightPaper ? hsl(h, Math.min(s, 40), 12) : hsl(h, 30, 94),
    'ink-soft': lightPaper ? hsl(h, Math.min(s, 30), 34) : hsl(h, 20, 75),
    edge: lightPaper ? hsl(h, s + 5, Math.max(l - 58, 10)) : hsl(h, s, Math.min(l + 45, 90)),
    hover: hsl(h, s, l - 30, 0.25),
    error: '#A3271A',
  };
}

function applyConfig(c) {
  cfg = c;
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(palette(c.color, c.theme))) root.setProperty('--' + k, v);
  root.setProperty('--font', `"${c.font_main}", "Segoe UI", sans-serif`);
  root.setProperty('--fs', c.font_size + 'px');
  root.setProperty('--op-idle', c.opacity_idle);
  history = history.slice(0, c.history_size);
  renderHistory();
  fit();
}

// ---------- Очередь ----------
function shuffled(ids) {
  const a = [...ids];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Треки для очереди: всё скачанное, кроме ждущего отправки дизлайка.
const queueIds = () => tracks.map(t => t.id).filter(id => !pendingDislike || id !== pendingDislike.id);

// Перестроить очередь, сохранив текущий трек на своём месте.
function rebuildOrder() {
  const ids = queueIds();
  if (shuffle) {
    order = shuffled(ids.filter(id => id !== current));
    if (current && byId.has(current)) order.unshift(current);
  } else {
    order = ids;
  }
  pos = current ? order.indexOf(current) : -1;
}

// Пришёл новый список: новые треки вставляем в очередь, пропавшие убираем.
function mergeTracks(list) {
  const old = new Set(byId.keys());
  tracks = list;
  byId = new Map(list.map(t => [t.id, t]));
  if (!shuffle || order.length === 0) { rebuildOrder(); return; }
  order = order.filter(id => byId.has(id));
  for (const t of list) {
    if (old.has(t.id) || (pendingDislike && pendingDislike.id === t.id)) continue;
    const from = Math.max(pos + 1, 0);
    const at = from + Math.floor(Math.random() * (order.length - from + 1));
    order.splice(at, 0, t.id);
  }
  pos = current ? order.indexOf(current) : -1;
}

// ---------- Воспроизведение ----------
function load(id, { time = 0, play = true } = {}) {
  const t = byId.get(id);
  if (!t) return;
  current = id;
  pos = order.indexOf(id);
  audio.src = t.url;
  const seek = () => { if (time > 0 && time < (audio.duration || Infinity)) audio.currentTime = time; };
  audio.addEventListener('loadedmetadata', seek, { once: true });
  if (play) {
    audio.play().catch(() => {});
    remember(id);
    window.api.started(id);
  }
  window.api.save({ current: id, time });
  updateMedia(t);
  renderInfo();
  renderHistory();
}

function remember(id) {
  history = [id, ...history.filter(x => x !== id)].slice(0, cfg ? cfg.history_size : 10);
  window.api.save({ history });
}

function togglePlay() {
  if (!current) {
    if (order.length) load(order[0]); else wantPlay = !wantPlay;
    return;
  }
  if (audio.paused) {
    audio.play().catch(() => {});
    if (history[0] !== current) remember(current);
  } else audio.pause();
}

function step(dir) {
  if (!order.length) return;
  if (dir < 0 && audio.currentTime > 3) { audio.currentTime = 0; return; }
  let i = pos + dir;
  if (i >= order.length) {
    // Круг пройден: в режиме shuffle перемешиваем заново (без повтора только что сыгранного).
    if (shuffle) {
      order = shuffled(queueIds());
      if (order[0] === current && order.length > 1) order.push(order.shift());
    }
    i = 0;
  }
  if (i < 0) i = order.length - 1;
  load(order[i]);
}

function setShuffle(v) {
  shuffle = v;
  $('shuffle').setAttribute('aria-pressed', String(v));
  rebuildOrder();
  window.api.save({ shuffle: v });
}

// ---------- Отрисовка ----------
const fmt = (sec) => {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderInfo() {
  titleEl.classList.remove('link');
  titleEl.onclick = null;
  const t = current && byId.get(current);
  if (flash) {
    titleEl.textContent = flash;
    if (flashAction) {
      const a = document.createElement('span');
      a.className = 'undo';
      a.textContent = flashAction.label;
      a.onclick = (e) => { e.stopPropagation(); const run = flashAction.run; clearFlash(); run(); };
      titleEl.append(a);
    }
  } else if (t) {
    titleEl.innerHTML = `<b>${esc(t.artists)}</b> — ${esc(t.title)}${t.album ? ` <span class="soft">· ${esc(t.album)}</span>` : ''}`;
    titleEl.title = `${t.artists} — ${t.title}${t.album ? `\nАльбом: ${t.album}` : ''}`;
  } else if (status.state === 'auth') {
    titleEl.textContent = 'Войти в Яндекс Музыку';
    titleEl.title = 'Откроется окно входа Яндекса';
    titleEl.classList.add('link');
    titleEl.onclick = () => window.api.login();
  } else if (status.total && !tracks.length) {
    titleEl.textContent = `Скачиваю «Мне нравится»: ${status.ready} из ${status.total}…`;
  } else if (status.state === 'error') {
    titleEl.textContent = 'Нет связи с Яндексом';
  } else {
    titleEl.textContent = 'Загружаю «Мне нравится»…';
  }
  renderTime();
}

function renderTime() {
  const t = current && byId.get(current);
  const dur = audio.duration || (t ? t.durationMs / 1000 : 0);
  timeEl.textContent = t ? `${fmt(audio.currentTime)} / ${fmt(dur)}` : '';
  fill.style.width = dur ? `${(audio.currentTime / dur) * 100}%` : '0';
}

function renderHistory() {
  const list = $('historyList');
  list.textContent = '';
  const items = history.filter(id => byId.has(id));
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Здесь появятся последние сыгранные треки';
    list.append(li);
  }
  for (const id of items) {
    const t = byId.get(id);
    const li = document.createElement('li');
    if (id === current) li.className = 'current';
    li.innerHTML = `<span class="name">${esc(t.artists)} — ${esc(t.title)}</span><span class="dur">${fmt(t.durationMs / 1000)}</span>`;
    li.title = `${t.artists} — ${t.title}`;
    li.addEventListener('click', () => load(id));
    list.append(li);
  }
  fit();
}

function statusText(s) {
  if (s.state === 'auth') return 'Нужно войти в Яндекс — клик по надписи или меню в трее';
  if (s.state === 'error') return `Ошибка синхронизации: ${s.error}. Играет то, что уже скачано.`;
  if (s.total == null) return 'Синхронизация…';
  let t = `Скачано ${s.ready} из ${s.total}`;
  if (s.queue) t += `, в очереди ${s.queue}`;
  if (s.current) t += `\nКачается: ${s.current}`;
  if (s.at) t += `\nПроверено в ${new Date(s.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  return t;
}

function showStatus(s) {
  status = s || {};
  const dot = $('dot');
  dot.className = 'dot ' + (status.state || '');
  dot.title = statusText(status);
  renderInfo();
}

// Высота окна = содержимое; main растит окно вверх, нижний край на месте.
function fit() {
  requestAnimationFrame(() => {
    const h = document.querySelector('.bar').offsetHeight + ($('history').hidden ? 0 : $('history').offsetHeight + 4);
    window.api.resize(h);
  });
}

function setHistoryOpen(v) {
  $('history').hidden = !v;
  $('list').setAttribute('aria-pressed', String(v));
  document.body.classList.toggle('pinned', v);
  renderHistory();
}

// ---------- Громкость ----------
function setVolume(v, show = true) {
  v = Math.round(clamp(v, 0, 1) * 100) / 100;
  audio.volume = v;
  audio.muted = false;
  renderVolume();
  window.api.save({ volume: v });
  if (show) showFlash(`Громкость ${Math.round(v * 100)}%`);
}
function renderVolume() {
  document.body.classList.toggle('muted', audio.muted || audio.volume === 0);
  document.body.classList.toggle('vol-low', audio.volume < 0.5);
  $('volume').title = `Громкость ${audio.muted ? 'выкл.' : Math.round(audio.volume * 100) + '%'} — колесо мыши, клик — без звука`;
}
function showFlash(text, action = null, ms = 1200) {
  flash = text;
  flashAction = action;
  renderInfo();
  clearTimeout(flashTimer);
  flashTimer = setTimeout(clearFlash, ms);
}
function clearFlash() {
  clearTimeout(flashTimer);
  flash = null;
  flashAction = null;
  renderInfo();
}

// ---------- Дизлайк ----------
// Трек сразу пропускается; в Яндекс уходит через 5 секунд, если не нажали «Отменить».
function dislike() {
  if (!current) return;
  commitDislike();
  const id = current;
  const time = audio.currentTime;
  step(1);
  order = order.filter(x => x !== id);
  pos = current ? order.indexOf(current) : -1;
  pendingDislike = { id, time, timer: setTimeout(commitDislike, 5000) };
  showFlash(`Убрано из «Мне нравится»`, { label: "Отменить", run: undoDislike }, 5000);
}
function commitDislike() {
  if (!pendingDislike) return;
  clearTimeout(pendingDislike.timer);
  const { id } = pendingDislike;
  pendingDislike = null;
  history = history.filter(x => x !== id);
  window.api.save({ history });
  window.api.dislike(id);
}
function undoDislike() {
  if (!pendingDislike) return;
  clearTimeout(pendingDislike.timer);
  const { id, time } = pendingDislike;
  pendingDislike = null;
  if (!byId.has(id)) return;
  // Возвращаемся к треку с того же места, следующим пойдёт тот, что начался после дизлайка.
  if (!order.includes(id)) order.splice(Math.max(pos, 0), 0, id);
  load(id, { time });
  showFlash('Вернул');
}
window.addEventListener('beforeunload', commitDislike);

$('volume').addEventListener('wheel', (e) => {
  e.preventDefault();
  setVolume(audio.volume + (e.deltaY < 0 ? 0.05 : -0.05));
}, { passive: false });
$('volume').addEventListener('click', () => {
  audio.muted = !audio.muted;
  renderVolume();
  showFlash(audio.muted ? 'Звук выключен' : `Громкость ${Math.round(audio.volume * 100)}%`);
});

// ---------- Кнопки ----------
$('play').addEventListener('click', togglePlay);
$('next').addEventListener('click', () => step(1));
$('prev').addEventListener('click', () => step(-1));
$('dislike').addEventListener('click', dislike);
$('shuffle').addEventListener('click', () => { setShuffle(!shuffle); showFlash(shuffle ? 'Перемешивание включено' : 'Подряд, как в «Мне нравится»'); });
$('list').addEventListener('click', () => setHistoryOpen($('history').hidden));
$('hide').addEventListener('click', () => window.api.hide());
$('progress').addEventListener('click', (e) => {
  if (!current || !audio.duration) return;
  const r = e.currentTarget.getBoundingClientRect();
  audio.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * audio.duration;
});

// ---------- События плеера ----------
audio.addEventListener('play', () => { document.body.classList.add('playing'); $('play').title = 'Пауза'; window.api.save({ playing: true }); });
audio.addEventListener('pause', () => {
  document.body.classList.remove('playing');
  $('play').title = 'Играть';
  window.api.save({ playing: false, time: audio.currentTime });
});
audio.addEventListener('ended', () => step(1));
audio.addEventListener('timeupdate', () => {
  renderTime();
  if (Math.abs(audio.currentTime - lastSavedTime) >= 5) {
    lastSavedTime = audio.currentTime;
    window.api.save({ time: audio.currentTime });
  }
});
audio.addEventListener('loadedmetadata', renderTime);
audio.addEventListener('error', () => {
  if (!current) return;
  const bad = current;
  window.api.broken(bad);
  if (order.length > 1) step(1);
});

// Системная панель Windows (громкость/медиа) показывает трек и умеет переключать.
function updateMedia(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artists, album: t.album });
}
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', togglePlay);
  navigator.mediaSession.setActionHandler('pause', togglePlay);
  navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
  navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
}

// ---------- Из main ----------
window.api.on('config', applyConfig);
window.api.on('status', showStatus);
window.api.on('history', setHistoryOpen);
window.api.on('cmd', (c) => ({ toggle: togglePlay, next: () => step(1), prev: () => step(-1) }[c] || (() => {}))());
window.api.on('tracks', (list) => {
  mergeTracks(list);
  // Текущий трек сняли с лайков — дослушиваем его до конца, дальше он не попадётся.
  if (!current && order.length) load(order[0], { play: wantPlay });
  if (current && !byId.has(current) && audio.paused) { current = null; if (order.length) load(order[0], { play: false }); }
  renderInfo();
  renderHistory();
});

window.api.init().then(({ config, tracks: list, player, status: st, autoplay }) => {
  shuffle = player.shuffle !== false;
  $('shuffle').setAttribute('aria-pressed', String(shuffle));
  history = Array.isArray(player.history) ? player.history : [];
  audio.volume = typeof player.volume === 'number' ? clamp(player.volume, 0, 1) : 0.7;
  renderVolume();
  applyConfig(config);
  showStatus(st);
  tracks = list;
  byId = new Map(list.map(t => [t.id, t]));
  current = byId.has(player.current) ? player.current : null;
  rebuildOrder();
  wantPlay = autoplay;
  if (current) load(current, { time: player.time || 0, play: autoplay });
  else if (order.length) load(order[0], { play: autoplay });
  renderInfo();
});
