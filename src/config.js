// Конфиг: значения по умолчанию, чтение/запись, валидация.
// music_dir: пустая строка = %APPDATA%\YMusic\tracks.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULTS = {
  width: 400,
  color: '#FFDB4D',
  theme: 'dark',
  opacity_idle: 0.55,
  font_main: 'Segoe UI',
  font_size: 12,
  sync_interval_min: 10,
  history_size: 10,
  music_dir: '',
};

// Правила для каждого ключа: тип и допустимые границы.
const RULES = {
  width: { type: 'number', min: 300, max: 1200 },
  color: { type: 'string', re: /^#([0-9a-f]{6}|[0-9a-f]{3})$/i, hint: 'hex вида #FFDB4D' },
  theme: { type: 'string', oneOf: ['light', 'dark'] },
  opacity_idle: { type: 'number', min: 0.1, max: 1 },
  font_main: { type: 'string' },
  font_size: { type: 'number', min: 9, max: 20 },
  sync_interval_min: { type: 'number', min: 1, max: 1440 },
  history_size: { type: 'number', min: 3, max: 30 },
  music_dir: { type: 'string' },
};

let fontCache = null;

// Список установленных шрифтов (имена в нижнем регистре).
function systemFonts() {
  if (fontCache) return fontCache;
  const names = new Set();
  try {
    if (process.platform === 'win32') {
      for (const hive of ['HKLM', 'HKCU']) {
        let out = '';
        try {
          out = execFileSync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts`], {
            encoding: 'utf8', windowsHide: true,
          });
        } catch { continue; }
        for (const line of out.split(/\r?\n/)) {
          const m = line.match(/^\s{4}(.+?)\s{4}REG_\w+\s{4}/);
          if (!m) continue;
          const raw = m[1].replace(/\s*\((TrueType|OpenType|Type 1|VGA res)\)\s*$/i, '');
          for (const part of raw.split('&')) names.add(part.trim().toLowerCase());
        }
      }
    } else {
      const out = execFileSync('fc-list', [':', 'family'], { encoding: 'utf8' });
      for (const line of out.split('\n')) for (const f of line.split(',')) if (f.trim()) names.add(f.trim().toLowerCase());
    }
  } catch { /* если не удалось прочитать — проверку шрифта пропустим */ }
  fontCache = names;
  return names;
}

// Шрифт есть в системе, если найдено точное имя или имя с начертанием ("Segoe UI Bold").
function fontInstalled(family) {
  const fonts = systemFonts();
  if (fonts.size === 0) return { ok: true, unknown: true };
  const f = family.trim().toLowerCase();
  for (const n of fonts) if (n === f || n.startsWith(f + ' ')) return { ok: true };
  const word = f.split(/\s+/)[0];
  const similar = [...new Set([...fonts]
    .filter(n => n.includes(word))
    .map(n => n.replace(/\s+(bold|italic|light|semibold|semilight|black|regular|condensed|oblique).*$/, '')))]
    .slice(0, 5);
  return { ok: false, similar };
}

function validate(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: ['Невалидный JSON: ' + e.message] };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['Конфиг должен быть объектом { ... }'] };
  }
  const errors = [];
  for (const key of Object.keys(obj)) {
    if (!RULES[key]) errors.push(`Неизвестный ключ "${key}"`);
  }
  for (const [key, r] of Object.entries(RULES)) {
    if (!(key in obj)) { errors.push(`Нет ключа "${key}"`); continue; }
    const v = obj[key];
    if (typeof v !== r.type) { errors.push(`"${key}" должен быть ${r.type === 'number' ? 'числом' : 'строкой'}`); continue; }
    if (r.type === 'number' && (v < r.min || v > r.max)) errors.push(`"${key}" должен быть от ${r.min} до ${r.max}`);
    if (r.re && !r.re.test(v)) errors.push(`"${key}": нужен ${r.hint}`);
    if (r.oneOf && !r.oneOf.includes(v)) errors.push(`"${key}": допустимо ${r.oneOf.join(' или ')}`);
  }
  if (typeof obj.font_main === 'string') {
    const res = fontInstalled(obj.font_main);
    if (!res.ok) {
      errors.push(`Шрифт "${obj.font_main}" не найден в системе` +
        (res.similar.length ? `. Похожие: ${res.similar.join(', ')}` : ''));
    }
  }
  if (typeof obj.music_dir === 'string' && obj.music_dir.trim() && !path.isAbsolute(obj.music_dir.trim())) {
    errors.push('"music_dir": нужен полный путь вида D:\\Music\\YMusic или пустая строка');
  }
  return errors.length ? { ok: false, errors } : { ok: true, config: obj };
}

class ConfigStore {
  constructor(dir) {
    this.file = path.join(dir, 'config.json');
    this.data = { ...DEFAULTS };
    if (fs.existsSync(this.file)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        // Новые ключи из будущих версий подставляются автоматически.
        this.data = { ...DEFAULTS, ...loaded };
        for (const k of Object.keys(this.data)) if (!RULES[k]) delete this.data[k];
      } catch { /* битый файл — работаем на дефолтах, файл не трогаем */ return; }
    }
    this.write();
  }
  text() { return JSON.stringify(this.data, null, 2); }
  write() { writeAtomic(this.file, this.text()); }
  set(obj) { this.data = obj; this.write(); }
}

function writeAtomic(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = { ConfigStore, validate, writeAtomic, DEFAULTS };
