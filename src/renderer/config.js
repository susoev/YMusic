const area = document.getElementById('text');
const errors = document.getElementById('errors');
const status = document.getElementById('status');

window.api.getConfig().then(t => { area.value = t; area.focus(); });

async function save() {
  status.textContent = '';
  errors.textContent = '';
  const res = await window.api.saveConfig(area.value);
  if (res.ok) {
    area.value = res.text;
    status.textContent = 'Сохранено';
  } else {
    for (const e of res.errors) {
      const li = document.createElement('li');
      li.textContent = e;
      errors.append(li);
    }
  }
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('close').addEventListener('click', () => window.api.closeConfig());
area.addEventListener('input', () => { status.textContent = ''; });
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  if (e.key === 'Escape') window.api.closeConfig();
  // Tab вставляет отступ, а не уводит фокус
  if (e.key === 'Tab' && document.activeElement === area) {
    e.preventDefault();
    area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
  }
});
