// Небольшие JSON-файлы в %APPDATA%\YMusic: состояние плеера и токен.
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./config');

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    let d = {};
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* нет файла */ }
    this.data = { ...defaults, ...d };
  }
  set(patch) {
    Object.assign(this.data, patch);
    try { writeAtomic(this.file, JSON.stringify(this.data, null, 2)); } catch { /* */ }
  }
}

// Плеер: текущий трек и позиция, громкость, shuffle, история сыгранного.
const playerStore = (dir) => new JsonStore(path.join(dir, 'player.json'), {
  current: null, time: 0, volume: 0.7, shuffle: true, history: [],
});

// Токен Яндекса хранится только здесь, в репозиторий не попадает.
const authStore = (dir) => new JsonStore(path.join(dir, 'auth.json'), { token: '' });

module.exports = { playerStore, authStore };
