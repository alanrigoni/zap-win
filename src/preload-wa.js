'use strict';
// Roda dentro de cada página do WhatsApp Web. Envolve a API de notificações para:
// - adicionar o nome da conta ao título (quando há mais de uma conta);
// - trazer a janela para frente e trocar para a conta certa ao clicar na notificação;
// - respeitar a opção "Mostrar notificações".
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('__zapwin', {
  title: (t) => ipcRenderer.sendSync('wa:notification-title', String(t ?? '')),
  enabled: () => ipcRenderer.sendSync('wa:notifications-enabled') === true,
  clicked: () => ipcRenderer.send('wa:notification-click'),
});

function patchNotification() {
  const Native = window.Notification;
  const bridge = window.__zapwin;
  if (!Native || !bridge || Native.__zapwin) return;

  class ZapNotification extends Native {
    constructor(title, options) {
      if (!bridge.enabled()) {
        const silent = new EventTarget();
        silent.close = () => {};
        return silent;
      }
      super(bridge.title(title), options);
      this.addEventListener('click', () => bridge.clicked());
    }
  }
  Object.defineProperty(ZapNotification, 'permission', { get: () => Native.permission });
  Object.defineProperty(ZapNotification, 'maxActions', { get: () => Native.maxActions });
  ZapNotification.requestPermission = (...args) => Native.requestPermission(...args);
  Object.defineProperty(ZapNotification, '__zapwin', { value: true });
  window.Notification = ZapNotification;
}

if (typeof contextBridge.executeInMainWorld === 'function') {
  contextBridge.executeInMainWorld({ func: patchNotification });
} else {
  webFrame.executeJavaScript(`(${patchNotification.toString()})()`);
}
