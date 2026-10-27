'use strict';
const api = window.zapwin;
const $ = (s) => document.querySelector(s);

let state = { accounts: [], activeId: null, total: 0, palette: [] };
let lastBadgeTotal = -1;
let editing = null;
let chosenColor = null;

const icon = new Image();
icon.src = '../assets/icon.png';
const iconReady = icon.decode().catch(() => {});

function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const chars = words.length > 1
    ? [Array.from(words[0])[0], Array.from(words[1])[0]]
    : Array.from(words[0] || '?').slice(0, 2);
  return chars.join('').toUpperCase();
}

function render() {
  const items = state.accounts.map((a, i) => {
    const active = a.id === state.activeId;
    const b = document.createElement('button');
    b.className = 'account' + (active ? ' active' : '');
    b.style.setProperty('--c', a.color);
    b.title = i < 9 ? `${a.name} (Ctrl+${i + 1})` : a.name;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(active));

    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = initials(a.name);
    b.append(avatar);

    if (a.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = a.unread > 99 ? '99+' : String(a.unread);
      b.append(badge);
    }

    b.addEventListener('click', () => api.select(a.id));
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      api.accountMenu(a.id);
    });
    return b;
  });
  $('#accounts').replaceChildren(...items);
}

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

// Desenha o selo da barra de tarefas e o ícone da bandeja com o total de não lidas.
async function renderBadges() {
  if (state.total === lastBadgeTotal) return;
  lastBadgeTotal = state.total;
  await iconReady;
  const n = state.total;

  let overlay = null;
  if (n > 0) {
    const text = n > 99 ? '99+' : String(n);
    const c = canvas(32);
    const g = c.getContext('2d');
    g.fillStyle = '#e53935';
    g.beginPath();
    g.arc(16, 16, 16, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.font = `bold ${text.length > 2 ? 13 : text.length > 1 ? 17 : 20}px "Segoe UI", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 16, 17);
    overlay = c.toDataURL('image/png');
  }

  const t = canvas(32);
  const tg = t.getContext('2d');
  tg.drawImage(icon, 0, 0, 32, 32);
  if (n > 0) {
    tg.globalCompositeOperation = 'destination-out';
    tg.beginPath();
    tg.arc(24, 8, 10, 0, Math.PI * 2);
    tg.fill();
    tg.globalCompositeOperation = 'source-over';
    tg.fillStyle = '#e53935';
    tg.beginPath();
    tg.arc(24, 8, 8, 0, Math.PI * 2);
    tg.fill();
  }

  api.setBadges({ overlay, tray: t.toDataURL('image/png') });
}

function applyState(s) {
  if (!s) return;
  state = s;
  render();
  renderBadges();
}

// ---------- Janela de nova conta / edição ----------

function renderColors() {
  const swatches = state.palette.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.setProperty('--c', c);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(c === chosenColor));
    b.setAttribute('aria-label', c);
    b.addEventListener('click', () => {
      chosenColor = c;
      renderColors();
    });
    return b;
  });
  $('#colors').replaceChildren(...swatches);
}

function openModal({ mode, account } = {}) {
  editing = mode === 'edit' && account ? account : null;
  $('#modal-title').textContent = editing ? 'Editar conta' : 'Nova conta';
  $('#account-name').value = editing ? editing.name : '';
  chosenColor = editing
    ? editing.color
    : state.palette[state.accounts.length % state.palette.length];
  renderColors();
  $('#modal').hidden = false;
  api.setModal(true);
  $('#account-name').focus();
}

function closeModal() {
  if ($('#modal').hidden) return;
  $('#modal').hidden = true;
  editing = null;
  api.setModal(false);
}

$('#account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#account-name').value.trim();
  if (!name) return;
  await api.saveAccount({ id: editing?.id, name, color: chosenColor });
  closeModal();
});
$('#cancel').addEventListener('click', closeModal);
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

$('#add').addEventListener('click', () => openModal({ mode: 'add' }));
$('#settings').addEventListener('click', () => api.settingsMenu());

api.onState(applyState);
api.onPrompt(openModal);
api.getState().then(applyState);
