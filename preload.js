/**
 * GamerWikiHub — Preload Script
 *
 * Exposes a narrow, typed API to the renderer via contextBridge.
 * Added in this version: fandom settings channels.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {

  // ── WikiView navigation ─────────────────────────────────────────────────────
  navigate:   (url) => ipcRenderer.invoke('wv-navigate', url),
  goBack:     ()    => ipcRenderer.invoke('wv-go-back'),
  goForward:  ()    => ipcRenderer.invoke('wv-go-forward'),
  reload:     ()    => ipcRenderer.invoke('wv-reload'),
  stop:       ()    => ipcRenderer.invoke('wv-stop'),
  getUrl:     ()    => ipcRenderer.invoke('wv-get-url'),

  // ── Layout ──────────────────────────────────────────────────────────────────
  setSidebarCollapsed: (c) => ipcRenderer.invoke('set-sidebar-collapsed', c),

  // ── PiP / Overlay ───────────────────────────────────────────────────────────
  setAlwaysOnTop: (e) => ipcRenderer.invoke('set-always-on-top', e),
  setOpacity:     (v) => ipcRenderer.invoke('set-opacity', v),

  // ── Fandom enhancement settings ─────────────────────────────────────────────
  /** Returns the full settings object: { 'show-nav-bar', 'use-minified-nav-bar', 'show-wikiabar' } */
  fandomGetSettings: ()       => ipcRenderer.invoke('fandom-get-settings'),
  /** Set a single key and apply live. Returns the updated full settings object. */
  fandomSetSetting:  (k, v)   => ipcRenderer.invoke('fandom-set-setting', k, v),

  // ── Window chrome ───────────────────────────────────────────────────────────
  minimize:    () => ipcRenderer.invoke('window-minimize'),
  maximize:    () => ipcRenderer.invoke('window-maximize'),
  close:       () => ipcRenderer.invoke('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  getVersion:  () => ipcRenderer.invoke('get-version'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),

  // ── External links ──────────────────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // ── Events: main → renderer ─────────────────────────────────────────────────
  onLoadStart: (cb) => {
    const fn = () => cb();
    ipcRenderer.on('wv-did-start-loading', fn);
    return () => ipcRenderer.removeListener('wv-did-start-loading', fn);
  },
  onLoadFinish: (cb) => {
    const fn = (_, d) => cb(d);
    ipcRenderer.on('wv-did-finish-load', fn);
    return () => ipcRenderer.removeListener('wv-did-finish-load', fn);
  },
  onLoadFail: (cb) => {
    const fn = (_, d) => cb(d);
    ipcRenderer.on('wv-did-fail-load', fn);
    return () => ipcRenderer.removeListener('wv-did-fail-load', fn);
  },
  onNavigate: (cb) => {
    const fn = (_, d) => cb(d);
    ipcRenderer.on('wv-did-navigate', fn);
    return () => ipcRenderer.removeListener('wv-did-navigate', fn);
  },
  onWindowState: (cb) => {
    const fn = (_, d) => cb(d);
    ipcRenderer.on('window-state', fn);
    return () => ipcRenderer.removeListener('window-state', fn);
  },
});
