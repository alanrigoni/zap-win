'use strict';
const {
  app, BrowserWindow, WebContentsView, Tray, Menu, nativeImage,
  ipcMain, shell, dialog, clipboard, screen, Notification,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const APP_ID = 'com.alanrigoni.zapwin';
const WA_URL = 'https://web.whatsapp.com/';
const WA_ORIGIN = 'https://web.whatsapp.com';
const SIDEBAR_WIDTH = 64;
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const PALETTE = ['#1FA855', '#2F80ED', '#9B51E0', '#EB5757', '#F2994A', '#00A3A3', '#E84393', '#6C7A89'];
const PERMISSIONS = new Set([
  'notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen',
  'persistent-storage', 'background-sync', 'screen-wake-lock',
]);

app.setAppUserModelId(APP_ID);
// O WhatsApp Web recusa navegadores que ele não reconhece, então nos apresentamos como um Chrome comum.
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|zapwin)\/\S+/gi, '');

let config;
let win;
let tray;
let isQuitting = false;
let modalOpen = false;
let pendingMaximize = false;
let lastTotal = 0;
const views = new Map(); // id da conta -> { view, unread }

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

// ---------- Configuração ----------

const newId = () => crypto.randomUUID().slice(0, 8);
const configPath = () => path.join(app.getPath('userData'), 'config.json');

function defaultConfig() {
  return {
    accounts: [{ id: newId(), name: 'Principal', color: PALETTE[0] }],
    activeId: null,
    settings: { closeToTray: true, startHidden: false, notifications: true },
    zoom: {},
    window: null,
  };
}

function loadConfig() {
  const d = defaultConfig();
  let c = d;
  try {
    const saved = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    c = { ...d, ...saved, settings: { ...d.settings, ...saved.settings }, zoom: { ...saved.zoom } };
    if (!Array.isArray(c.accounts) || c.accounts.length === 0) c.accounts = d.accounts;
  } catch { /* primeira execução ou arquivo inválido */ }
  if (!c.accounts.some((a) => a.id === c.activeId)) c.activeId = c.accounts[0].id;
  return c;
}

function writeConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('Falha ao salvar configuração:', err);
  }
}

let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeConfig, 400);
}

// ---------- Ciclo de vida ----------

function start() {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    isQuitting = true;
    saveWindowState();
    clearTimeout(saveTimer);
    writeConfig();
  });
  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(() => {
    config = loadConfig();
    registerIpc();
    createWindow();
    createTray();
    rebuildMenus();
    setupUpdater();
  });
}

function quit() {
  isQuitting = true;
  app.quit();
}

// ---------- Janela ----------

function savedBoundsAreVisible(b) {
  if (!b || b.x === undefined) return false;
  return screen.getAllDisplays().some(({ workArea: w }) =>
    b.x < w.x + w.width && b.x + b.width > w.x && b.y < w.y + w.height && b.y + b.height > w.y);
}

function createWindow() {
  const st = config.window || {};
  const useBounds = savedBoundsAreVisible(st);
  win = new BrowserWindow({
    width: st.width || 1200,
    height: st.height || 800,
    ...(useBounds ? { x: st.x, y: st.y } : {}),
    minWidth: 640,
    minHeight: 480,
    title: 'ZapWin',
    icon: ICON_PATH,
    backgroundColor: '#0f1a20',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-shell.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'shell', 'index.html'));
  for (const acc of config.accounts) createView(acc);
  layout();

  for (const ev of ['resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) {
    win.on(ev, layout);
  }

  win.once('ready-to-show', () => {
    const hidden = process.argv.includes('--hidden') || config.settings.startHidden;
    if (hidden) {
      pendingMaximize = !!st.maximized;
    } else if (st.maximized) {
      win.maximize();
    } else {
      win.show();
    }
  });

  win.on('close', (e) => {
    saveWindowState();
    if (!isQuitting && config.settings.closeToTray) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('focus', () => {
    win.flashFrame(false);
    if (!modalOpen) activeContents()?.focus();
  });
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  config.window = { ...win.getNormalBounds(), maximized: win.isMaximized() };
  saveConfig();
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (pendingMaximize) {
    pendingMaximize = false;
    win.maximize();
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else showWindow();
}

function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  for (const [id, entry] of views) {
    entry.view.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: Math.max(0, w - SIDEBAR_WIDTH), height: h });
    entry.view.setVisible(!modalOpen && id === config.activeId);
  }
}

// ---------- Contas (uma aba do WhatsApp Web por conta) ----------

const configuredSessions = new WeakSet();
function setupSession(ses) {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);
  ses.setUserAgent(app.userAgentFallback);

  // Só o próprio WhatsApp Web recebe permissões. Quadros internos (iframes) de outros sites
  // ou qualquer página que não seja o WhatsApp são sempre negados.
  const allow = (wc, permission, requestingUrl) => {
    if (!isWhatsAppOrigin(requestingUrl)) return false;
    if (wc && !isWhatsAppOrigin(wc.getURL())) return false;
    if (permission === 'notifications') return !!config.settings.notifications;
    return PERMISSIONS.has(permission);
  };
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(allow(wc, permission, details?.requestingUrl));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => allow(wc, permission, requestingOrigin));

  const langs = ['pt-BR', 'en-US'].filter((l) => ses.availableSpellCheckerLanguages.includes(l));
  if (langs.length) ses.setSpellCheckerLanguages(langs);
}

function createView(acc) {
  const view = new WebContentsView({
    webPreferences: {
      partition: `persist:wa-${acc.id}`,
      preload: path.join(__dirname, 'preload-wa.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false,
    },
  });
  const wc = view.webContents;
  setupSession(wc.session);
  views.set(acc.id, { view, unread: 0 });

  // O WhatsApp coloca o total de não lidas no título: "(3) WhatsApp".
  wc.on('page-title-updated', (_e, title) => {
    const m = /^\((\d+)\)/.exec(title);
    setUnread(acc.id, m ? Number(m[1]) : 0);
  });
  wc.on('did-finish-load', () => wc.setZoomFactor(config.zoom[acc.id] || 1));
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!isWhatsAppUrl(url)) {
      e.preventDefault();
      openExternal(url);
    }
  });
  // Redirecionamentos do servidor não passam pelo 'will-navigate'.
  wc.on('will-redirect', (e) => {
    if (e.isMainFrame && !isWhatsAppUrl(e.url)) {
      e.preventDefault();
      openExternal(e.url);
    }
  });
  wc.on('context-menu', (_e, params) => showWebContextMenu(wc, params));
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 1000);
  });

  win.contentView.addChildView(view);
  wc.loadURL(WA_URL);
}

function isWhatsAppUrl(url) {
  try {
    return new URL(url).hostname === 'web.whatsapp.com';
  } catch {
    return false;
  }
}

function isWhatsAppOrigin(url) {
  try {
    return new URL(url).origin === WA_ORIGIN;
  } catch {
    return false;
  }
}

function openExternal(url) {
  try {
    const { protocol } = new URL(url);
    if (['http:', 'https:', 'mailto:', 'tel:'].includes(protocol)) shell.openExternal(url);
  } catch { /* URL inválida */ }
}

const activeContents = () => views.get(config.activeId)?.view.webContents;
const findAccount = (id) => config.accounts.find((a) => a.id === id);

function accountIdFor(wc) {
  for (const [id, entry] of views) if (entry.view.webContents === wc) return id;
  return null;
}

function totalUnread() {
  let n = 0;
  for (const e of views.values()) n += e.unread;
  return n;
}

function setUnread(id, n) {
  const entry = views.get(id);
  if (!entry || entry.unread === n) return;
  entry.unread = n;
  const total = totalUnread();
  if (total > lastTotal && win && !win.isFocused()) win.flashFrame(true);
  lastTotal = total;
  tray?.setToolTip(total ? `ZapWin — ${total} não lida${total > 1 ? 's' : ''}` : 'ZapWin');
  sendState();
  rebuildMenus();
}

function selectAccount(id) {
  if (!views.has(id)) return;
  config.activeId = id;
  saveConfig();
  layout();
  if (!modalOpen) activeContents()?.focus();
  sendState();
  rebuildMenus();
}

function cleanName(name, fallback) {
  const s = String(name ?? '').trim().slice(0, 40);
  return s || fallback;
}
const cleanColor = (c, fallback) => (/^#[0-9a-f]{6}$/i.test(c) ? c : fallback);

function addAccount(name, color) {
  const n = config.accounts.length;
  const acc = {
    id: newId(),
    name: cleanName(name, `Conta ${n + 1}`),
    color: cleanColor(color, PALETTE[n % PALETTE.length]),
  };
  config.accounts.push(acc);
  createView(acc);
  selectAccount(acc.id);
}

function editAccount(id, name, color) {
  const acc = findAccount(id);
  if (!acc) return;
  acc.name = cleanName(name, acc.name);
  acc.color = cleanColor(color, acc.color);
  saveConfig();
  sendState();
  rebuildMenus();
}

async function removeAccount(id) {
  const acc = findAccount(id);
  if (!acc || config.accounts.length < 2) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Remover', 'Cancelar'],
    defaultId: 1,
    cancelId: 1,
    title: 'Remover conta',
    message: `Remover a conta "${acc.name}"?`,
    detail: 'Os dados desta conta serão apagados deste computador. Para usá-la de novo será preciso ler o QR code outra vez.',
  });
  if (response !== 0) return;

  const entry = views.get(id);
  const ses = entry.view.webContents.session;
  win.contentView.removeChildView(entry.view);
  entry.view.webContents.close();
  views.delete(id);
  config.accounts = config.accounts.filter((a) => a.id !== id);
  delete config.zoom[id];
  if (config.activeId === id) config.activeId = config.accounts[0].id;
  lastTotal = totalUnread();
  selectAccount(config.activeId);
  try {
    await ses.clearStorageData();
    await ses.clearCache();
  } catch (err) {
    console.error('Falha ao limpar dados da conta:', err);
  }
}

function promptAccount(mode, id) {
  showWindow();
  const account = mode === 'edit' ? findAccount(id) : null;
  win.webContents.send('prompt', { mode, account });
}

function reloadActive() {
  activeContents()?.reload();
}

function changeZoom(delta) {
  const wc = activeContents();
  if (!wc) return;
  const next = delta === 0 ? 1 : Math.min(2, Math.max(0.5, Math.round((wc.getZoomFactor() + delta) * 10) / 10));
  wc.setZoomFactor(next);
  config.zoom[config.activeId] = next;
  saveConfig();
}

// ---------- Estado para a barra lateral ----------

function stateSnapshot() {
  return {
    accounts: config.accounts.map((a) => ({ ...a, unread: views.get(a.id)?.unread || 0 })),
    activeId: config.activeId,
    total: totalUnread(),
    palette: PALETTE,
  };
}

function sendState() {
  if (win && !win.isDestroyed()) win.webContents.send('state', stateSnapshot());
}

// ---------- Menus ----------

function accountLabel(a) {
  const n = views.get(a.id)?.unread || 0;
  return n ? `${a.name} (${n})` : a.name;
}

function settingsItems() {
  const toggle = (key) => (item) => {
    config.settings[key] = item.checked;
    saveConfig();
    rebuildMenus();
  };
  const login = app.getLoginItemSettings({ args: ['--hidden'] });
  return [
    {
      label: 'Iniciar com o Windows (na bandeja)',
      type: 'checkbox',
      checked: login.openAtLogin,
      enabled: app.isPackaged,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] });
        rebuildMenus();
      },
    },
    { label: 'Abrir minimizado na bandeja', type: 'checkbox', checked: config.settings.startHidden, click: toggle('startHidden') },
    { label: 'Fechar para a bandeja', type: 'checkbox', checked: config.settings.closeToTray, click: toggle('closeToTray') },
    { label: 'Mostrar notificações', type: 'checkbox', checked: config.settings.notifications, click: toggle('notifications') },
  ];
}

function rebuildMenus() {
  if (!config) return;
  const accountItems = config.accounts.map((a, i) => ({
    label: accountLabel(a),
    type: 'radio',
    checked: a.id === config.activeId,
    accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
    click: () => selectAccount(a.id),
  }));

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '&Arquivo',
      submenu: [
        { label: 'Nova conta…', accelerator: 'CmdOrCtrl+Shift+N', click: () => promptAccount('add') },
        { label: 'Recarregar conta', accelerator: 'CmdOrCtrl+R', click: reloadActive },
        { type: 'separator' },
        { label: 'Ocultar na bandeja', accelerator: 'CmdOrCtrl+W', click: () => win.hide() },
        { label: 'Sair', accelerator: 'CmdOrCtrl+Q', click: quit },
      ],
    },
    {
      label: '&Exibir',
      submenu: [
        { label: 'Aumentar zoom', accelerator: 'CmdOrCtrl+=', click: () => changeZoom(0.1) },
        { label: 'Diminuir zoom', accelerator: 'CmdOrCtrl+-', click: () => changeZoom(-0.1) },
        { label: 'Zoom padrão', accelerator: 'CmdOrCtrl+0', click: () => changeZoom(0) },
        { type: 'separator' },
        { label: 'Tela cheia', role: 'togglefullscreen' },
        { label: 'Ferramentas do desenvolvedor', accelerator: 'CmdOrCtrl+Shift+I', click: () => activeContents()?.toggleDevTools() },
      ],
    },
    { label: '&Contas', submenu: accountItems },
    { label: 'C&onfigurações', submenu: settingsItems() },
    { label: 'Aj&uda', submenu: [updateMenuItem(), { type: 'separator' }, { label: 'Sobre o ZapWin', click: showAbout }] },
  ]));

  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mostrar ZapWin', click: showWindow },
    { type: 'separator' },
    ...config.accounts.map((a) => ({
      label: accountLabel(a),
      type: 'radio',
      checked: a.id === config.activeId,
      click: () => { showWindow(); selectAccount(a.id); },
    })),
    { type: 'separator' },
    { label: 'Configurações', submenu: settingsItems() },
    ...(updateReady ? [updateMenuItem()] : []),
    { type: 'separator' },
    { label: 'Sair', click: quit },
  ]));
}

function showAccountMenu(id) {
  const acc = findAccount(id);
  if (!acc) return;
  Menu.buildFromTemplate([
    { label: 'Recarregar', click: () => views.get(id)?.view.webContents.reload() },
    { label: 'Editar nome e cor…', click: () => promptAccount('edit', id) },
    { type: 'separator' },
    { label: 'Remover conta…', enabled: config.accounts.length > 1, click: () => removeAccount(id) },
  ]).popup({ window: win });
}

function showSettingsMenu() {
  Menu.buildFromTemplate([
    ...settingsItems(),
    { type: 'separator' },
    { label: 'Nova conta…', click: () => promptAccount('add') },
    { label: 'Recarregar conta atual', click: reloadActive },
    updateMenuItem(),
    { label: 'Sobre o ZapWin', click: showAbout },
    { type: 'separator' },
    { label: 'Sair', click: quit },
  ]).popup({ window: win });
}

function showWebContextMenu(wc, p) {
  const t = [];
  if (p.misspelledWord) {
    for (const s of p.dictionarySuggestions.slice(0, 5)) t.push({ label: s, click: () => wc.replaceMisspelling(s) });
    if (!p.dictionarySuggestions.length) t.push({ label: 'Sem sugestões', enabled: false });
    t.push({ label: 'Adicionar ao dicionário', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
    t.push({ type: 'separator' });
  }
  if (p.linkURL && /^https?:/i.test(p.linkURL)) {
    t.push(
      { label: 'Abrir link no navegador', click: () => openExternal(p.linkURL) },
      { label: 'Copiar link', click: () => clipboard.writeText(p.linkURL) },
      { type: 'separator' },
    );
  }
  if (p.mediaType === 'image' && p.srcURL) {
    t.push(
      { label: 'Copiar imagem', click: () => wc.copyImageAt(p.x, p.y) },
      { label: 'Salvar imagem como…', click: () => wc.downloadURL(p.srcURL) },
      { type: 'separator' },
    );
  }
  if (p.isEditable) {
    const f = p.editFlags;
    t.push(
      { label: 'Desfazer', role: 'undo', enabled: f.canUndo },
      { label: 'Refazer', role: 'redo', enabled: f.canRedo },
      { type: 'separator' },
      { label: 'Recortar', role: 'cut', enabled: f.canCut },
      { label: 'Copiar', role: 'copy', enabled: f.canCopy },
      { label: 'Colar', role: 'paste', enabled: f.canPaste },
      { label: 'Selecionar tudo', role: 'selectAll' },
    );
  } else if (p.selectionText.trim()) {
    t.push({ label: 'Copiar', role: 'copy' });
  }
  while (t.length && t[t.length - 1].type === 'separator') t.pop();
  if (t.length) Menu.buildFromTemplate(t).popup({ window: win });
}

function showAbout() {
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'Sobre o ZapWin',
    message: `ZapWin ${app.getVersion()}`,
    detail: 'Cliente não oficial do WhatsApp Web para Windows, inspirado no ZapZap.\nNão tem afiliação com o WhatsApp ou a Meta.',
    icon: nativeImage.createFromPath(ICON_PATH),
  });
}

// ---------- Atualização automática (GitHub Releases) ----------

const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;
let manualCheck = false;
let updateReady = null; // versão baixada e pronta para instalar

// Janelas de aviso só ficam presas à janela principal quando ela está visível.
const dialogParent = () => (win && !win.isDestroyed() && win.isVisible() ? win : undefined);
function message(opts) {
  const parent = dialogParent();
  return parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts);
}

function setupUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    if (manualCheck) {
      message({ type: 'info', title: 'Atualização', message: `Baixando a versão ${info.version}…`, detail: 'Você será avisado quando ela estiver pronta.' });
    }
    manualCheck = false;
  });
  autoUpdater.on('update-not-available', () => {
    if (manualCheck) {
      message({ type: 'info', title: 'Atualização', message: 'Você já está usando a versão mais recente.', detail: `ZapWin ${app.getVersion()}` });
    }
    manualCheck = false;
  });
  autoUpdater.on('error', (err) => {
    console.error('Falha na atualização:', err);
    if (manualCheck) {
      message({ type: 'error', title: 'Atualização', message: 'Não foi possível verificar atualizações.', detail: String(err?.message || err) });
    }
    manualCheck = false;
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = info.version;
    rebuildMenus();
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'Atualização do ZapWin pronta',
        body: `A versão ${info.version} será instalada quando você fechar o app. Clique para reiniciar agora.`,
        icon: ICON_PATH,
      });
      n.on('click', installUpdate);
      n.show();
    }
    if (dialogParent()) askToInstall();
  });

  checkForUpdates(false);
  setInterval(() => checkForUpdates(false), UPDATE_INTERVAL);
}

function checkForUpdates(manual) {
  if (!app.isPackaged) {
    if (manual) message({ type: 'info', title: 'Atualização', message: 'A atualização automática só funciona na versão instalada.' });
    return;
  }
  if (updateReady) {
    if (manual) askToInstall();
    return;
  }
  manualCheck = manual;
  autoUpdater.checkForUpdates().catch(() => { /* tratado no evento 'error' */ });
}

async function askToInstall() {
  const { response } = await message({
    type: 'info',
    buttons: ['Reiniciar agora', 'Depois'],
    defaultId: 0,
    cancelId: 1,
    title: 'Atualização pronta',
    message: `A versão ${updateReady} do ZapWin foi baixada.`,
    detail: 'Reinicie para instalar agora, ou ela será instalada automaticamente quando você sair do app.',
  });
  if (response === 0) installUpdate();
}

function installUpdate() {
  isQuitting = true;
  saveWindowState();
  clearTimeout(saveTimer);
  writeConfig();
  // Instalação silenciosa, abrindo o app de novo ao terminar.
  autoUpdater.quitAndInstall(true, true);
}

function updateMenuItem() {
  return updateReady
    ? { label: `Reiniciar e atualizar para ${updateReady}`, click: installUpdate }
    : { label: 'Verificar atualizações…', click: () => checkForUpdates(true) };
}

// ---------- Bandeja ----------

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON_PATH).resize({ width: 32, height: 32, quality: 'best' }));
  tray.setToolTip('ZapWin');
  tray.on('click', toggleWindow);
}

// ---------- IPC ----------

function registerIpc() {
  const fromShell = (e) => win && e.sender === win.webContents;

  ipcMain.handle('shell:get-state', (e) => (fromShell(e) ? stateSnapshot() : null));
  ipcMain.on('shell:select', (e, id) => { if (fromShell(e)) selectAccount(id); });
  ipcMain.on('shell:account-menu', (e, id) => { if (fromShell(e)) showAccountMenu(id); });
  ipcMain.on('shell:settings-menu', (e) => { if (fromShell(e)) showSettingsMenu(); });
  ipcMain.on('shell:modal', (e, open) => {
    if (!fromShell(e)) return;
    modalOpen = !!open;
    layout();
    if (modalOpen) win.webContents.focus();
    else activeContents()?.focus();
  });
  ipcMain.handle('shell:save-account', (e, data) => {
    if (!fromShell(e) || !data) return;
    if (data.id) editAccount(data.id, data.name, data.color);
    else addAccount(data.name, data.color);
  });
  ipcMain.on('shell:badges', (e, { overlay, tray: trayImage } = {}) => {
    if (!fromShell(e)) return;
    const total = totalUnread();
    win.setOverlayIcon(
      overlay ? nativeImage.createFromDataURL(overlay) : null,
      overlay ? `${total} mensagens não lidas` : '',
    );
    if (trayImage) tray?.setImage(nativeImage.createFromDataURL(trayImage));
  });

  // Chamados pelo preload das páginas do WhatsApp.
  ipcMain.on('wa:notification-title', (e, title) => {
    const acc = findAccount(accountIdFor(e.sender));
    const t = String(title ?? '');
    e.returnValue = acc && config.accounts.length > 1 ? `${t} (${acc.name})` : t;
  });
  ipcMain.on('wa:notifications-enabled', (e) => {
    e.returnValue = !!config.settings.notifications;
  });
  ipcMain.on('wa:notification-click', (e) => {
    const id = accountIdFor(e.sender);
    showWindow();
    if (id) selectAccount(id);
  });
}
