// Поддельный API Яндекс Музыки для локальной проверки: node test/server.js <папка с mp3> [порт]
// Отвечает так же, как настоящий: account/status, likes/tracks, POST /tracks, download-info → XML → get-mp3.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = process.argv[2];
const PORT = Number(process.argv[3] || 8765);
const TOKEN = 'testtoken';
const SALT = 'XGRlBW9FXlekgbPrRHuSiA';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.mp3')).sort();
const catalog = files.map((f, i) => ({
  id: String(1000 + i), albumId: String(500 + i),
  title: `Тестовая песня ${i + 1}`, artist: ['Исполнитель А', 'Группа Б', 'Артист В'][i % 3], file: path.join(dir, f),
}));
let liked = catalog.slice(0, Number(process.env.LIKED || catalog.length)).map(t => t.id);
let revision = 1;
const disliked = [];

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    console.log('API', req.method, u.pathname, body ? body.slice(0, 80) : '');
    // Страница входа: сразу «логинит» и уводит на адрес с токеном, как oauth.yandex.ru.
    if (u.pathname === '/oauth') { res.writeHead(302, { Location: `http://127.0.0.1:${PORT}/done#access_token=${TOKEN}&token_type=bearer` }); return res.end(); }
    if (u.pathname === '/done') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('ok'); }
    // Управление тестом: какие треки «лайкнуты».
    if (u.pathname === '/__liked') { liked = u.searchParams.get('ids').split(',').filter(Boolean); revision++; return json(res, 200, { liked }); }

    if (u.pathname === '/__state') return json(res, 200, { liked, disliked });
    const m3 = u.pathname.match(/^\/get-mp3\/([0-9a-f]{32})\/(\d+)(\/x\/(\d+)\.mp3)$/);
    if (m3) {
      const t = catalog.find(c => c.id === m3[4]);
      const expect = crypto.createHash('md5').update(SALT + m3[3].slice(1) + 'S' + m3[4]).digest('hex');
      if (!t || m3[1] !== expect) { res.writeHead(403); return res.end('bad sign'); }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      return fs.createReadStream(t.file).pipe(res);
    }
    const di = u.pathname.match(/^\/dlinfo\/(\d+)$/);
    if (di) {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(`<?xml version="1.0" encoding="utf-8"?><download-info><host>127.0.0.1:${PORT}</host><path>/x/${di[1]}.mp3</path><ts>0001</ts><region>-1</region><s>S${di[1]}</s></download-info>`);
    }

    if (req.headers.authorization !== `OAuth ${TOKEN}`) return json(res, 401, { error: { name: 'session-expired', message: 'Unauthorized' } });

    if (u.pathname === '/account/status') return json(res, 200, { result: { account: { uid: 42, login: 'tester' }, plus: { hasPlus: true } } });
    if (u.pathname === '/users/42/likes/tracks') {
      return json(res, 200, { result: { library: { uid: 42, revision, tracks: liked.map(id => {
        const t = catalog.find(c => c.id === id); return { id: t.id, albumId: t.albumId, timestamp: new Date().toISOString() };
      }) } } });
    }
    if (u.pathname === '/users/42/dislikes/tracks/add-multiple') { disliked.push(...new URLSearchParams(body).getAll('track-ids')); return json(res, 200, { result: { revision: ++revision } }); }
    if (u.pathname === '/users/42/likes/tracks/remove') {
      const rm = new URLSearchParams(body).getAll('track-ids').map(x => x.split(':')[0]);
      liked = liked.filter(id => !rm.includes(id)); return json(res, 200, { result: { revision: ++revision } });
    }
    if (u.pathname === '/tracks' && req.method === 'POST') {
      const ids = new URLSearchParams(body).getAll('track-ids');
      const out = ids.map(full => catalog.find(c => c.id === full.split(':')[0])).filter(Boolean).map(t => ({
        id: t.id, title: t.title, artists: [{ name: t.artist }], albums: [{ id: Number(t.albumId), title: 'Тестовый альбом' }], durationMs: 25000, available: true,
      }));
      return json(res, 200, { result: out });
    }
    const dm = u.pathname.match(/^\/tracks\/(\d+):\d+\/download-info$/);
    if (dm) return json(res, 200, { result: [
      { codec: 'mp3', bitrateInKbps: 192, preview: false, downloadInfoUrl: `http://127.0.0.1:${PORT}/dlinfo/${dm[1]}?low`, direct: false },
      { codec: 'mp3', bitrateInKbps: 320, preview: false, downloadInfoUrl: `http://127.0.0.1:${PORT}/dlinfo/${dm[1]}`, direct: false },
      { codec: 'aac', bitrateInKbps: 64, preview: false, downloadInfoUrl: 'http://bad/', direct: false },
    ] });
    json(res, 404, { error: { name: 'not-found', message: u.pathname } });
  });
}).listen(PORT, '127.0.0.1', () => console.log('fake yandex on', PORT, 'tracks', catalog.length));
