const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog, powerMonitor, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

// Лог в %APPDATA%\YMusic\ymusic.log — чтобы было видно, почему что-то не работает.
function log(...args) {
  try {
    const line = `[${new Date().toISOString()}] ${args.map(a => (a && a.stack) || String(a)).join(' ')}\n`;
    const file = path.join(app.getPath('userData'), 'ymusic.log');
    try { if (fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.old'); } catch { /* */ }
    fs.appendFileSync(file, line);
  } catch { /* нет доступа к папке — молчим */ }
}
function fatal(err) {
  log('FATAL', err);
  try { dialog.showErrorBox('YMusic — ошибка', String((err && err.stack) || err)); } catch { /* */ }
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', (e) => log('unhandled', e));

const { ConfigStore, validate } = require('./config');
const { playerStore, authStore } = require('./store');
const { Library } = require('./library');
const { AUTH_URL, tokenFromUrl } = require('./yandex');
const { autoUpdater } = require('electron-updater');

app.setName('YMusic');
if (process.env.YMUSIC_DATA) app.setPath('userData', process.env.YMUSIC_DATA);
app.setAppUserModelId('in.alid.ymusic');
// Музыка должна играть без клика по окну (продолжение после запуска и обновления).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const AUTOSTART = process.argv.includes('--autostart');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showBar());
  app.whenReady().then(start).catch(fatal);
}
app.on('render-process-gone', (_e, _wc, d) => log('renderer gone', JSON.stringify(d)));
app.on('will-quit', () => log('quit'));

let bar = null;
let configWin = null;
let authWin = null;
let tray = null;
let quitting = false;
let config, player, auth, library;
let syncStatus = { state: 'idle' };
let playing = false;

const asset = (f) => path.join(__dirname, '..', 'assets', f);

function start() {
  const dir = app.getPath('userData');
  log('start', app.getVersion(), AUTOSTART ? 'autostart' : 'manual');
  config = new ConfigStore(dir);
  player = playerStore(dir);
  auth = authStore(dir);

  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: ['--autostart'] });
  }

  library = new Library({
    dir,
    getConfig: () => config.data,
    getToken: () => auth.data.token,
    onChange: (tracks) => send('tracks', tracks),
    onStatus: (s) => { syncStatus = s; send('status', s); createTrayMenu(); },
    onAuthError: () => { auth.set({ token: '' }); },
    log,
  });

  createTray();
  createBar();
  library.start();
  setupUpdates();

  powerMonitor.on('resume', () => { log('resume'); setTimeout(() => { ensureVisible(); library.sync(); }, 3000); });

  if (process.env.YMUSIC_SHOT) require(process.env.YMUSIC_TEST || '../test/shot')({ bar, send, openConfig, app, library, getConfigWin: () => configWin });
}

function send(channel, payload) {
  if (bar && !bar.isDestroyed()) bar.webContents.send(channel, payload);
}

// ---- Полоска плеера ----
let barHeight = 64;

// По умолчанию — по центру внизу основного экрана, прямо над панелью задач.
function placeDefault() {
  if (!bar || bar.isDestroyed()) return;
  const a = screen.getPrimaryDisplay().workArea;
  const w = config.data.width;
  bar.setBounds({ x: Math.round(a.x + (a.width - w) / 2), y: a.y + a.height - barHeight - 6, width: w, height: barHeight });
}

function createBar() {
  bar = new BrowserWindow({
    width: config.data.width, height: barHeight,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'YMusic',
    icon: asset('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  bar.setAlwaysOnTop(true, 'floating');
  placeDefault();
  bar.loadFile(path.join(__dirname, 'renderer', 'bar.html'));
  const reveal = () => { if (!bar.isDestroyed() && !bar.isVisible()) { placeDefault(); bar.showInactive(); } };
  bar.once('ready-to-show', reveal);
  setTimeout(reveal, 4000);

  // Alt+F4 не закрывает, а прячет в трей.
  bar.on('close', (e) => {
    if (!quitting) { e.preventDefault(); hideBar(); }
  });
  // Win+D / «Свернуть всё» — возвращаем, не забирая фокус.
  bar.on('minimize', () => { if (wantVisible) setTimeout(ensureVisible, 100); });
  bar.on('always-on-top-changed', (_e, on) => { if (!on) bar.setAlwaysOnTop(true, 'floating'); });
  setInterval(ensureVisible, 2000);
  screen.on('display-removed', ensureOnScreen);
  screen.on('display-metrics-changed', ensureOnScreen);
}

let wantVisible = true;
function ensureVisible() {
  if (!wantVisible || !bar || bar.isDestroyed()) return;
  if (bar.isMinimized()) { bar.showInactive(); if (bar.isMinimized()) bar.restore(); }
  if (!bar.isVisible()) bar.showInactive();
  if (!bar.isAlwaysOnTop()) bar.setAlwaysOnTop(true, 'floating');
}

function ensureOnScreen() {
  if (!bar || bar.isDestroyed()) return;
  const b = bar.getBounds();
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    b.x + 40 > a.x && b.x < a.x + a.width - 40 && b.y + b.height > a.y + 20 && b.y < a.y + a.height - 20);
  if (!visible) placeDefault();
}

function showBar() {
  if (!bar) return;
  wantVisible = true;
  send('history', false);
  placeDefault();
  if (bar.isMinimized()) bar.restore();
  bar.showInactive();
  bar.setAlwaysOnTop(true, 'floating');
  createTrayMenu();
}

function hideBar() {
  if (!bar) return;
  wantVisible = false;
  bar.hide();
  createTrayMenu();
}

// ---- Вход в Яндекс ----
function openLogin() {
  if (authWin && !authWin.isDestroyed()) { authWin.show(); authWin.focus(); return; }
  authWin = new BrowserWindow({
    width: 480, height: 700,
    title: 'YMusic — вход в Яндекс',
    icon: asset('icon.png'),
    autoHideMenuBar: true,
    webPreferences: { partition: 'persist:yandex-auth', contextIsolation: true, nodeIntegration: false },
  });
  authWin.setMenu(null);
  let done = false;
  const check = (_e, url) => {
    const token = tokenFromUrl(url);
    if (!token || done) return;
    done = true;
    log('login ok');
    auth.set({ token });
    if (authWin && !authWin.isDestroyed()) authWin.close();
    library.sync();
    createTrayMenu();
  };
  const wc = authWin.webContents;
  for (const ev of ['will-redirect', 'will-navigate', 'did-navigate', 'did-navigate-in-page', 'did-redirect-navigation']) {
    wc.on(ev, (e, url) => check(e, typeof url === 'string' ? url : (e && e.url)));
  }
  wc.setWindowOpenHandler(({ url }) => { wc.loadURL(url); return { action: 'deny' }; });
  authWin.on('closed', () => { authWin = null; });
  authWin.loadURL(AUTH_URL);
}

async function logout() {
  auth.set({ token: '' });
  try { await session.fromPartition('persist:yandex-auth').clearStorageData(); } catch (e) { log('logout', e); }
  library.sync();
  createTrayMenu();
}

// ---- Автообновление из GitHub Releases (susoev/YMusic) ----
let updateState = '';
let updateReady = false;
function setupUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.logger = { info: (m) => log('upd', m), warn: (m) => log('upd warn', m), error: (m) => log('upd error', m), debug() {} };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (i) => { updateState = `Скачивается ${i.version}…`; createTrayMenu(); });
  autoUpdater.on('update-not-available', () => { updateState = ''; createTrayMenu(); });
  autoUpdater.on('error', (e) => { updateState = ''; log('upd error', e); createTrayMenu(); });
  autoUpdater.on('update-downloaded', (i) => {
    log('update downloaded', i.version);
    updateState = `Обновление ${i.version} готово`;
    updateReady = true;
    createTrayMenu();
    if (!playing) setTimeout(installIfPaused, 5000);
  });
  const check = () => autoUpdater.checkForUpdates().catch((e) => log('upd check', e));
  setTimeout(check, 10 * 1000);
  setInterval(check, 60 * 60 * 1000);
}

// Обновляемся в паузе или на стыке треков, чтобы не оборвать песню. После перезапуска плеер продолжит как был.
function installUpdate(wasPlaying) {
  if (!updateReady) return;
  updateReady = false;
  log('install update, playing=', wasPlaying);
  player.set({ afterUpdate: wasPlaying ? 'playing' : 'paused' });
  quitting = true;
  autoUpdater.quitAndInstall(true, true);
}
function installIfPaused() { if (updateReady && !playing) installUpdate(false); }

// ---- Трей ----
function statusLine() {
  const s = syncStatus;
  if (s.state === 'auth') return 'Нужно войти в Яндекс';
  if (s.state === 'error') return `Ошибка синхронизации: ${String(s.error).slice(0, 60)}`;
  if (s.total == null) return 'Синхронизация…';
  const base = `Треков: ${s.ready} из ${s.total}`;
  return s.queue ? `${base}, качается ${s.queue}` : base;
}

function createTrayMenu() {
  if (!tray) return;
  const loggedIn = !!auth.data.token;
  tray.setToolTip(`YMusic — ${statusLine()}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `YMusic ${app.getVersion()}`, enabled: false },
    { label: statusLine(), enabled: false },
    ...(updateState ? [{ label: updateState, enabled: false }] : []),
    { type: 'separator' },
    { label: playing ? 'Пауза' : 'Играть', click: () => send('cmd', 'toggle') },
    { label: 'Следующий трек', click: () => send('cmd', 'next') },
    { label: wantVisible ? 'Свернуть в трей' : 'Показать плеер', click: () => (wantVisible ? hideBar() : showBar()) },
    { type: 'separator' },
    { label: 'Синхронизировать сейчас', enabled: loggedIn, click: () => library.sync() },
    { label: 'Папка с музыкой', click: () => shell.openPath(library.musicDir()) },
    { label: 'Конфиг', click: openConfig },
    loggedIn
      ? { label: `Выйти из Яндекса${syncStatus.login ? ` (${syncStatus.login})` : ''}`, click: logout }
      : { label: 'Войти в Яндекс…', click: openLogin },
    ...(app.isPackaged ? [{ label: 'Проверить обновления', click: () => autoUpdater.checkForUpdates().catch((e) => log('upd check', e)) }] : []),
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(asset('tray.png')));
  createTrayMenu();
  tray.on('click', () => (wantVisible && bar.isVisible() ? hideBar() : showBar()));
}

// ---- Конфиг ----
function openConfig() {
  if (configWin && !configWin.isDestroyed()) { configWin.show(); configWin.focus(); return; }
  configWin = new BrowserWindow({
    width: 560, height: 520,
    title: 'YMusic — конфиг',
    icon: asset('icon.png'),
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  configWin.setMenu(null);
  configWin.loadFile(path.join(__dirname, 'renderer', 'config.html'));
}

function applyConfig(prev) {
  if (bar && !bar.isDestroyed()) {
    const b = bar.getBounds();
    const w = config.data.width;
    bar.setBounds({ x: Math.round(b.x + (b.width - w) / 2), y: b.y, width: w, height: b.height });
  }
  send('config', config.data);
  if (prev.music_dir !== config.data.music_dir) library.dirChanged();
  if (prev.sync_interval_min !== config.data.sync_interval_min) library.start();
}

// ---- IPC ----
ipcMain.handle('init', () => {
  let autoplay = !AUTOSTART;
  if (player.data.afterUpdate) {
    autoplay = player.data.afterUpdate === 'playing';
    player.set({ afterUpdate: null });
  }
  return { config: config.data, tracks: library.playable(), player: player.data, status: syncStatus, autoplay };
});

ipcMain.on('player:save', (_e, patch) => {
  player.set(patch);
  if (typeof patch.playing === 'boolean' && patch.playing !== playing) {
    playing = patch.playing;
    createTrayMenu();
    if (!playing && updateReady) setTimeout(installIfPaused, 5000);
  }
});

// Новый трек начался — удобный момент поставить обновление.
ipcMain.on('player:started', () => { if (updateReady) installUpdate(true); });
ipcMain.on('player:broken', (_e, id) => library.broken(id));
ipcMain.on('player:dislike', (_e, id) => library.dislike(id));

// Высота меняется, когда раскрывается список; нижний край остаётся на месте.
ipcMain.on('resize', (_e, height) => {
  if (!bar || bar.isDestroyed()) return;
  const h = Math.max(40, Math.min(Math.round(height), 600));
  if (h === barHeight) return;
  const b = bar.getBounds();
  bar.setBounds({ x: b.x, y: b.y + b.height - h, width: config.data.width, height: h });
  barHeight = h;
});

ipcMain.on('hide', hideBar);
ipcMain.on('login', openLogin);

ipcMain.handle('config:get', () => config.text());
ipcMain.handle('config:save', (_e, text) => {
  const res = validate(text);
  if (!res.ok) return res;
  const prev = { ...config.data };
  config.set(res.config);
  applyConfig(prev);
  return { ok: true, text: config.text() };
});
ipcMain.on('config:close', () => configWin && configWin.close());

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', (e) => e.preventDefault());
