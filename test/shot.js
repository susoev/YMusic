// Тестовый прогон на поддельном API (test/server.js): вход, синхронизация, плеер, снятие лайка, снимки окна.
// Запуск: YMUSIC_SHOT=<папка для снимков> YMUSIC_API_BASE=http://127.0.0.1:8765 YMUSIC_DL_SCHEME=http
//         YMUSIC_AUTH_URL=http://127.0.0.1:8765/oauth YMUSIC_DATA=<временная папка> npx electron .
const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = async ({ bar, openConfig, library, getConfigWin, app }) => {
  const out = process.env.YMUSIC_SHOT;
  const api = process.env.YMUSIC_API_BASE;
  const shot = async (name, win = bar) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, name + '.png'), img.toPNG());
  };
  const js = (code) => bar.webContents.executeJavaScript(code);
  const state = () => js(`({ title: document.getElementById('title').textContent, time: document.getElementById('time').textContent,
    playing: !document.getElementById('audio').paused, t: document.getElementById('audio').currentTime.toFixed(1),
    vol: document.getElementById('audio').volume, dot: document.getElementById('dot').className })`);
  const check = (name, ok, extra = '') => console.log(ok ? 'PASS' : 'FAIL', name, extra);

  await wait(2500);
  await js(`document.body.classList.add('pinned')`);
  await shot('1-login');
  const s1 = await state();
  check('без токена просит войти', s1.title.includes('Войти'), JSON.stringify(s1));

  await js(`document.getElementById('title').click()`);
  await wait(6000);
  const s2 = await state();
  check('после входа скачались и играют', s2.playing && s2.title.includes('Тестовая'), JSON.stringify(s2));
  const files = fs.readdirSync(library.musicDir());
  check('файлы на диске', files.filter(f => f.endsWith('.mp3')).length === 5, files.join(' | '));
  check('auth окно закрыто', BrowserWindow.getAllWindows().length === 1, String(BrowserWindow.getAllWindows().length));
  await shot('2-playing');

  const before = s2.title;
  await js(`document.getElementById('next').click()`);
  await wait(500);
  const s3 = await state();
  check('следующий трек', s3.title !== before, `${before} -> ${s3.title}`);

  await js(`document.getElementById('volume').dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }))`);
  await wait(200);
  const s4 = await state();
  check('громкость колесом', Math.abs(s4.vol - 0.65) < 0.001 && s4.title.includes('Громкость'), JSON.stringify(s4));
  await shot('3-volume');
  await wait(1300);

  await js(`document.getElementById('play').click()`);
  await wait(300);
  check('пауза', !(await state()).playing);
  await js(`document.getElementById('play').click()`);
  await wait(300);
  check('снова играет', (await state()).playing);

  await js(`document.getElementById('list').click()`);
  await wait(600);
  const rows = await js(`[...document.querySelectorAll('#historyList li')].map(l => l.textContent)`);
  check('история: два сыгранных', rows.length === 2, rows.join(' | '));
  const [w, h] = bar.getContentSize();
  check('окно выросло вверх под список', h > 100 && w === 400, `${w}x${h}`);
  await shot('4-history');
  await js(`document.querySelector('#historyList li:nth-child(2)').click()`);
  await wait(400);
  const s5 = await state();
  check('клик по истории играет трек', s5.title.includes(rows[1].split(' — ')[1].replace(/\d+:\d+$/, '').trim()), `${rows[1]} / ${s5.title}`);
  await js(`document.getElementById('list').click()`);
  await wait(500);
  check('список закрылся, окно снова низкое', bar.getContentSize()[1] < 80, String(bar.getContentSize()));

  // Снимаем лайк с двух треков в «Яндексе» и синхронизируем.
  await fetch(`${api}/__liked?ids=1000,1001,1002`);
  await library.sync();
  await wait(500);
  const left = fs.readdirSync(library.musicDir()).filter(f => f.endsWith('.mp3'));
  check('снятые лайки удалены с диска', left.length === 3, left.join(' | '));
  // Ставим обратно — докачиваются.
  await fetch(`${api}/__liked?ids=1000,1001,1002,1003,1004`);
  await library.sync();
  check('новые лайки докачались', fs.readdirSync(library.musicDir()).filter(f => f.endsWith('.mp3')).length === 5);

  await js(`document.getElementById('shuffle').click()`);
  await wait(200);
  check('shuffle выключается', (await js(`document.getElementById('shuffle').getAttribute('aria-pressed')`)) === 'false');
  await js(`document.body.classList.remove('pinned')`);
  await wait(400);
  await shot('5-idle');

  const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'player.json'), 'utf8'));
  check('состояние сохранено', saved.current && saved.volume === 0.65 && saved.shuffle === false && saved.history.length >= 2, JSON.stringify(saved));

  openConfig();
  await wait(1500);
  await shot('6-config', getConfigWin());
  const cw = getConfigWin();
  await cw.webContents.executeJavaScript(`document.getElementById('text').value = document.getElementById('text').value.replace('"dark"', '"light"').replace('"Segoe UI"', '"DejaVu Sans"'); document.getElementById('save').click()`);
  await wait(800);
  const errs = await cw.webContents.executeJavaScript(`document.getElementById('errors').textContent + '|' + document.getElementById('status').textContent`);
  check('конфиг сохраняется', errs.includes('Сохранено'), errs);
  cw.close();
  await js(`document.body.classList.add('pinned')`);
  await wait(500);
  await shot('7-light');
  console.log('BOUNDS', JSON.stringify(bar.getBounds()));
  console.log('DONE');
  app.exit(0);
};
