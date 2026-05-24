/**
 * GamerWikiHub — Main Process (v4)
 *
 * Changelog from v3:
 *  ✅ FIXED  WebGL re-enabled (MapGenie requires it — `webgl:false` caused the warning)
 *  ✅ NEW    FMG extension ported natively via a custom `fmg-ext://` protocol that
 *             serves the extension's bundled files to the wiki WebContentsView
 *  ✅ CHANGE stardewvalleywiki.com → stardew.wiki
 */

'use strict';

const {
  app, BrowserWindow, WebContentsView,
  ipcMain, shell, session, protocol,
  net,
} = require('electron');
const path = require('path');
const fs   = require('fs');

// ─── CPU & Performance Tweaks ─────────────────────────────────────────────────
app.commandLine.appendSwitch('disable-background-timer-throttling', 'false');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=1024');

// ─── Layout Constants (must match CSS) ───────────────────────────────────────
const TITLEBAR_H = 46;
const SIDEBAR_W  = 230;

// ─── Globals ──────────────────────────────────────────────────────────────────
/** @type {BrowserWindow}   */ let win      = null;
/** @type {WebContentsView} */ let wikiView = null;

let sidebarCollapsed = false;

// ─── Wiki domain list ─────────────────────────────────────────────────────────
const WIKI_HOSTS = new Set([
  'wiki.gg',            'www.wiki.gg',
  'fandom.com',         'www.fandom.com',
  'fextralife.com',     'www.fextralife.com',
  // ✅ Updated: stardew.wiki (was stardewvalleywiki.com)
  'stardew.wiki',       'www.stardew.wiki',
  'mapgenie.io',        'www.mapgenie.io',
  'arcraiders.wiki',    'www.arcraiders.wiki',
]);

function isWikiUrl(url) {
  try {
    const host = new URL(url).hostname;
    if (WIKI_HOSTS.has(host)) return true;
    for (const h of WIKI_HOSTS) {
      if (host.endsWith('.' + h)) return true;
    }
    return false;
  } catch { return false; }
}

function isFandomUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'fandom.com' || host.endsWith('.fandom.com')
        || host === 'wikia.com'  || host.endsWith('.wikia.com');
  } catch { return false; }
}

function isMapGenieUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'mapgenie.io' || host.endsWith('.mapgenie.io');
  } catch { return false; }
}

// ─── FMG Extension Protocol ───────────────────────────────────────────────────
// Files in fmg-ext/ are served as fmg-ext://host/path so the injected
// content script can load page.js and assets via XMLHttpRequest / fetch.
//
// MIME-type map — kept minimal, only what FMG actually loads.
const FMG_EXT_DIR = path.join(__dirname, 'fmg-ext');

const MIME_MAP = {
  '.js':    'application/javascript',
  '.css':   'text/css',
  '.svg':   'image/svg+xml',
  '.ttf':   'font/ttf',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.png':   'image/png',
};

/**
 * Register the custom fmg-ext:// protocol.
 * Must be called BEFORE app.whenReady() resolves (inside app.whenReady handler
 * is fine; Electron allows registration of privileged schemes before first use).
 */
function registerFmgExtProtocol() {
  // Register as a privileged scheme so fetch/XHR work without CORS issues
  protocol.registerSchemesAsPrivileged([
    {
      scheme:     'fmg-ext',
      privileges: {
        standard:          true,
        secure:            true,
        supportFetchAPI:   true,
        corsEnabled:       false,
        bypassCSP:         true,
        allowServiceWorkers: false,
        stream:            true,
      },
    },
  ]);
}

function handleFmgExtRequests() {
  protocol.handle('fmg-ext', (request) => {
    // fmg-ext://extension/assets/page.css  →  fmg-ext/<path>
    const url      = new URL(request.url);
    const filePath = path.join(FMG_EXT_DIR, url.pathname);

    // Security: ensure path stays inside fmg-ext/
    if (!filePath.startsWith(FMG_EXT_DIR)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const data     = fs.readFileSync(filePath);
      const ext      = path.extname(filePath).toLowerCase();
      const mimeType = MIME_MAP[ext] || 'application/octet-stream';
      return new Response(data, {
        headers: {
          'Content-Type':                mimeType,
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}

// ─── FMG Content-Script Injector ─────────────────────────────────────────────
//
// The FMG Chrome extension works by:
//   1. Running content.js at document_start (messaging plumbing + ad removal)
//   2. Injecting page.js (the 771 kB main enhancer bundle)
//
// In Electron we replicate this without chrome.* APIs:
//   • We inject content.css (UI styles)
//   • We inject a polyfill for chrome.runtime.getURL → fmg-ext:// URLs
//   • We inject a simplified bootstrap that mimics what content.js does:
//       – sets up storage shim (always "enabled")
//       – starts the AdBlocker interval
//       – loads page.js via a <script> tag pointed at fmg-ext://
//   • page.js itself works fine because internally it uses the window
//     postMessage adapter (no chrome.runtime.connect needed for rendering)

const FMG_CONTENT_CSS = fs.readFileSync(
  path.join(FMG_EXT_DIR, 'content-scripts', 'content.css'),
  'utf8'
);

/**
 * Build the bootstrap JS that is injected into every MapGenie page.
 * The ID guard prevents double-injection on in-page SPA navigation.
 */
function buildFmgBootstrap() {
  return `(function() {
  if (window.__GWH_fmg_injected) return;
  window.__GWH_fmg_injected = true;

  /* ── 1. Chrome API Polyfill ──────────────────────────────────────────────
     page.js calls chrome.runtime.getURL(path) to load assets.
     We redirect those to our custom fmg-ext:// protocol.                  */
  const FMG_BASE = 'fmg-ext://extension';

  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = {};

  // getURL: translate extension-relative paths to fmg-ext:// URLs
  window.chrome.runtime.getURL = function(path) {
    return FMG_BASE + (path.startsWith('/') ? path : '/' + path);
  };

  // id: page.js checks this to know it's inside an extension
  window.chrome.runtime.id = 'gamerwikhub-fmg-polyfill';

  // Minimal storage.local shim — always reports extension as enabled
  window.chrome.storage = {
    local: {
      get: function(_keys, cb) {
        if (typeof cb === 'function') cb({ enabled: true });
        return Promise.resolve({ enabled: true });
      },
      set: function(_obj, cb) {
        if (typeof cb === 'function') cb();
        return Promise.resolve();
      },
      onChanged: { addListener: function() {}, removeListener: function() {} },
    },
    onChanged: { addListener: function() {}, removeListener: function() {} },
  };

  // Stub runtime.connect / onMessage so port-based messaging doesn't throw
  window.chrome.runtime.connect    = function() {
    return {
      postMessage: function() {},
      onMessage:   { addListener: function() {}, removeListener: function() {} },
      onDisconnect:{ addListener: function() {}, removeListener: function() {} },
      disconnect:  function() {},
    };
  };
  window.chrome.runtime.onMessage  = { addListener: function() {}, removeListener: function() {} };
  window.chrome.runtime.sendMessage = function() { return Promise.resolve(); };

  /* ── 2. Declare a fake 'browser' global some FMG code paths prefer ──── */
  if (!window.browser) window.browser = window.chrome;

  /* ── 3. Inject the FMG page.js enhancer bundle ──────────────────────── */
  function injectPageJs() {
    if (document.querySelector('[data-fmg-page-js]')) return;
    const s = document.createElement('script');
    s.src = FMG_BASE + '/page.js';
    s.setAttribute('data-fmg-page-js', '1');
    // Inject into <head> as early as possible
    (document.head || document.documentElement).appendChild(s);
  }

  /* ── 4. Lightweight ad-removal loop (mirrors FMG AdBlocker class) ────── */
  const AD_SELECTORS = [
    '#nitro-floating-wrapper',
    '#blobby-left',
    '#button-upgrade',
    'iframe[name^="ifrm_"]',
    'div[class^="adsbygoogle"]',
    'div[id^="google_ads_iframe_"]',
    'iframe[src*="safeframe.googlesyndication"]',
    'iframe[name*="goog"]',
    'html > iframe[sandbox="allow-scripts allow-same-origin"]',
    '#onetrust-consent-sdk',
    '[data-tracking-id="railbanner-ad"]',
  ].join(', ');

  let lastRemoval = Date.now();
  const STOP_AFTER = 15000; // stop polling after 15 s of no removals

  function removeAds() {
    const nodes = document.querySelectorAll(AD_SELECTORS);
    if (nodes.length) {
      nodes.forEach(n => n.remove());
      lastRemoval = Date.now();
    }
    if (Date.now() - lastRemoval < STOP_AFTER) {
      setTimeout(removeAds, 500);
    }
  }

  /* ── 5. Boot ─────────────────────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      injectPageJs();
      removeAds();
    }, { once: true });
  } else {
    injectPageJs();
    removeAds();
  }
})();`;
}

const FMG_BOOTSTRAP = buildFmgBootstrap();

/** Inject FMG styles + bootstrap script into the current MapGenie page. */
async function injectFmgExtension() {
  if (!wikiView) return;
  const url = wikiView.webContents.getURL();
  if (!isMapGenieUrl(url)) return;

  try {
    await wikiView.webContents.insertCSS(FMG_CONTENT_CSS);
    await wikiView.webContents.executeJavaScript(FMG_BOOTSTRAP);
  } catch (err) {
    console.warn('[GamerWikiHub] FMG injection skipped:', err.message);
  }
}

// ─── Fandom Settings ──────────────────────────────────────────────────────────
const FANDOM_SETTINGS_DEFAULTS = {
  'show-nav-bar':         false,
  'use-minified-nav-bar': false,
  'show-wikiabar':        false,
};
let fandomSettings = { ...FANDOM_SETTINGS_DEFAULTS };

function getFandomSettingsPath() {
  return path.join(app.getPath('userData'), 'fandom-settings.json');
}

function loadFandomSettings() {
  try {
    const raw = fs.readFileSync(getFandomSettingsPath(), 'utf8');
    fandomSettings = { ...FANDOM_SETTINGS_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    fandomSettings = { ...FANDOM_SETTINGS_DEFAULTS };
  }
}

function saveFandomSettings() {
  try {
    fs.writeFileSync(getFandomSettingsPath(), JSON.stringify(fandomSettings, null, 2), 'utf8');
  } catch (err) {
    console.error('[GamerWikiHub] Failed to save fandom settings:', err.message);
  }
}

// ─── Fandom CSS (ported from nobloatfandom extension) ────────────────────────
const FANDOM_CSS = `
.global-navigation--hidden ~ .main-container {
  margin-left: auto !important; margin-right: auto !important; width: 100% !important;
}
.fandom-sticky-header--navbar-modified { left: 0 !important; }
.global-navigation--hidden      { display: none !important; }
.global-navigation--minified    { max-height: fit-content !important; }
.global-navigation__top--hidden { display: none !important; }
.wikia-bar--hidden              { display: none !important; }
.fandom-hiring-banner           { display: none !important; }
.wiki-recs-header               { display: none !important; }
`;

function buildFandomScript(cfg) {
  return `(function() {
  'use strict';
  if (window.__GWH_fandom_loaded) {
    window.__GWH_fandom && window.__GWH_fandom.update(${JSON.stringify(cfg)});
    return;
  }
  window.__GWH_fandom_loaded = true;
  const REMOVE = [
    '.global-footer','#highlight__main-container','.page__right-rail',
    '.render-wiki-recommendations','#mixed-content-footer','.marketing-notifications',
    '#featured-video__player','#featured-video__player-container',
    '.top-ads-container','.bottom-ads-container','#mw-data-after-content',
    '.trending-articles','.mcf-wrapper','[data-tracking-id="railbanner-ad"]',
  ].join(',');
  const SEL_NAV    = '.global-navigation';
  const SEL_NAVTOP = '.global-navigation__top';
  const SEL_WIKIA  = '#WikiaBar';
  const SEL_STICKY = '.fandom-sticky-header';
  const qs = sel => document.querySelector(sel);

  function applyNavBar(cfg) {
    const nav = qs(SEL_NAV); if (!nav) return;
    if (!cfg['show-nav-bar']) {
      nav.classList.add('global-navigation--hidden');
      nav.classList.remove('global-navigation--minified');
      qs(SEL_NAVTOP)?.classList.remove('global-navigation__top--hidden');
    } else {
      nav.classList.remove('global-navigation--hidden');
      if (cfg['use-minified-nav-bar']) {
        nav.classList.add('global-navigation--minified');
        qs(SEL_NAVTOP)?.classList.add('global-navigation__top--hidden');
      } else {
        nav.classList.remove('global-navigation--minified');
        qs(SEL_NAVTOP)?.classList.remove('global-navigation__top--hidden');
      }
    }
  }

  function applyStickyHeader(cfg) {
    const s = qs(SEL_STICKY); if (!s) return;
    const mod = !cfg['show-nav-bar'] || cfg['use-minified-nav-bar'];
    s.classList.toggle('fandom-sticky-header--navbar-modified', mod);
  }

  function applyWikiaBar(cfg) {
    const b = qs(SEL_WIKIA); if (!b) return;
    b.classList.toggle('wikia-bar--hidden', !cfg['show-wikiabar']);
  }

  function applyAll(cfg) { applyNavBar(cfg); applyStickyHeader(cfg); applyWikiaBar(cfg); }

  let _cfg = ${JSON.stringify(cfg)};

  const observer = new MutationObserver(mutations => {
    mutations.flatMap(m => Array.from(m.addedNodes)).forEach(node => {
      if (!node.matches) return;
      if (node.matches(REMOVE))         { node.remove(); return; }
      if (node.matches(SEL_NAV))        { applyNavBar(_cfg); applyStickyHeader(_cfg); }
      if (node.matches(SEL_WIKIA))      { applyWikiaBar(_cfg); }
      if (node.matches(SEL_STICKY))     { applyStickyHeader(_cfg); }
    });
  });

  document.querySelectorAll(REMOVE).forEach(el => el.remove());
  applyAll(_cfg);
  observer.observe(document, { subtree: true, childList: true });

  window.__GWH_fandom = {
    update(newCfg) { _cfg = newCfg; document.querySelectorAll(REMOVE).forEach(el => el.remove()); applyAll(_cfg); }
  };
})();`;
}

async function injectFandomEnhancements() {
  if (!wikiView) return;
  const url = wikiView.webContents.getURL();
  if (!isFandomUrl(url)) return;
  try {
    await wikiView.webContents.insertCSS(FANDOM_CSS);
    await wikiView.webContents.executeJavaScript(buildFandomScript(fandomSettings));
  } catch (err) {
    console.warn('[GamerWikiHub] Fandom injection skipped:', err.message);
  }
}

// ─── Ad Blocker ───────────────────────────────────────────────────────────────
function setupBaselineAdBlock(s) {
  const BLOCKED = [
    '*://*.doubleclick.net/*', '*://*.googlesyndication.com/*',
    '*://*.googletagservices.com/*', '*://*.googletagmanager.com/*',
    '*://*.google-analytics.com/*', '*://*.adservice.google.com/*',
    '*://*.moatads.com/*', '*://*.scorecardresearch.com/*',
    '*://*.adsafeprotected.com/*', '*://*.advertising.com/*',
    '*://*.adnxs.com/*', '*://*.taboola.com/*', '*://*.outbrain.com/*',
    '*://*.criteo.com/*', '*://*.rubiconproject.com/*', '*://*.openx.net/*',
    '*://*.pubmatic.com/*', '*://*.33across.com/*', '*://*.casalemedia.com/*',
    '*://*.spotxchange.com/*', '*://*.lijit.com/*', '*://*.sonobi.com/*',
    '*://*.undertone.com/*', '*://*.intentiq.com/*', '*://*.adfox.ru/*',
    '*://*.hotjar.com/*', '*://cdn.confiant-integrations.net/*',
    '*://unified.fandom.com/api/v1/media*',
    '*://services.fandom.com/iceweasel-api/ads*',
    '*://*.fandom.com/*video*', '*://*.jwplayer.com/*',
    '*://content.jwplatform.com/*',
    // MapGenie ad networks
    '*://*.nitropay.com/*', '*://d.nitropay.com/*',
  ];
  s.webRequest.onBeforeRequest({ urls: BLOCKED }, (_, cb) => cb({ cancel: true }));
  console.log('[GamerWikiHub] Baseline ad blocker active');
}

async function setupEnhancedAdBlock(s) {
  try {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const cacheDir  = app.getPath('userData');
    const cachePath = path.join(cacheDir, 'adblocker-v2.bin');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(
      globalThis.fetch.bind(globalThis),
      { path: cachePath, read: fs.promises.readFile, write: fs.promises.writeFile }
    );
    blocker.enableBlockingInSession(s);
    console.log('[GamerWikiHub] Enhanced ad blocker (EasyList) active');
  } catch (err) {
    console.warn('[GamerWikiHub] Enhanced ad blocker unavailable:', err.message);
  }
}

// ─── WikiView bounds ──────────────────────────────────────────────────────────
function repositionWikiView() {
  if (!win || !wikiView) return;
  const { width, height } = win.getContentBounds();
  const x = sidebarCollapsed ? 0 : SIDEBAR_W;
  wikiView.setBounds({
    x, y: TITLEBAR_H,
    width:  Math.max(0, width - x),
    height: Math.max(0, height - TITLEBAR_H),
  });
}

// ─── Window Factory ───────────────────────────────────────────────────────────
async function createWindow() {
  loadFandomSettings();

  const wikiSession = session.fromPartition('persist:wikis');

  // Allow the fmg-ext:// protocol in the wiki session
  handleFmgExtRequests();

  setupBaselineAdBlock(wikiSession);
  setupEnhancedAdBlock(wikiSession);

  // ── BrowserWindow (UI shell) ──
  win = new BrowserWindow({
    width: 1280, height: 800,
    minWidth: 600, minHeight: 440,
    frame: false,
    backgroundColor: '#060810',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      nodeIntegration:  false,
      contextIsolation: true,
    },
    show: false,
  });

  // ── WebContentsView (wiki browser) ──
  wikiView = new WebContentsView({
    webPreferences: {
      session:              wikiSession,
      nodeIntegration:      false,
      contextIsolation:     true,
      backgroundThrottling: true,
      autoplayPolicy:       'user-gesture-required',
      // ✅ FIXED: WebGL re-enabled — MapGenie needs it for interactive maps.
      // The old `webgl: false` caused the "WebGL disabled" warning dialog.
      // webgl defaults to true so we simply omit it.
    },
  });

  wikiView.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36'
  );

  win.contentView.addChildView(wikiView);
  repositionWikiView();

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  win.on('resize', repositionWikiView);
  win.on('maximize',   () => win.webContents.send('window-state', { maximized: true  }));
  win.on('unmaximize', () => win.webContents.send('window-state', { maximized: false }));

  // ── wikiView lifecycle events ──

  wikiView.webContents.on('did-start-loading', () => {
    win.webContents.send('wv-did-start-loading');
  });

  wikiView.webContents.on('did-finish-load', async () => {
    const url          = wikiView.webContents.getURL();
    const isMapGenie   = isMapGenieUrl(url);
    const isFandom     = isFandomUrl(url);

    if (isFandom)   await injectFandomEnhancements();
    if (isMapGenie) await injectFmgExtension();

    win.webContents.send('wv-did-finish-load', {
      url,
      canGoBack:    wikiView.webContents.canGoBack(),
      canGoForward: wikiView.webContents.canGoForward(),
      isFandom,
      isMapGenie,
    });
  });

  wikiView.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return;
    win.webContents.send('wv-did-fail-load', { errorCode, errorDescription, url: validatedURL });
  });

  wikiView.webContents.on('did-navigate', (_, url) => {
    win.webContents.send('wv-did-navigate', {
      url,
      canGoBack:    wikiView.webContents.canGoBack(),
      canGoForward: wikiView.webContents.canGoForward(),
      isFandom:     isFandomUrl(url),
      isMapGenie:   isMapGenieUrl(url),
    });
  });

  wikiView.webContents.on('did-navigate-in-page', (_, url, isMainFrame) => {
    if (!isMainFrame) return;
    win.webContents.send('wv-did-navigate', {
      url,
      canGoBack:    wikiView.webContents.canGoBack(),
      canGoForward: wikiView.webContents.canGoForward(),
      isFandom:     isFandomUrl(url),
      isMapGenie:   isMapGenieUrl(url),
    });
  });

  wikiView.webContents.on('page-title-updated', (_, title) => {
    win.setTitle(title ? `${title} — GamerWikiHub` : 'GamerWikiHub');
  });

  wikiView.webContents.setWindowOpenHandler(({ url }) => {
    if (!url || url === 'about:blank') return { action: 'deny' };
    if (isWikiUrl(url)) {
      setImmediate(() => wikiView.webContents.loadURL(url));
    } else {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
    wikiView.webContents.openDevTools({ mode: 'detach' });
  }
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────
// ⚠️  registerSchemesAsPrivileged MUST be called before app.whenReady()
registerFmgExtProtocol();

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ─── IPC: Navigation ─────────────────────────────────────────────────────────
ipcMain.handle('wv-navigate',   (_, url) => { wikiView.webContents.loadURL(url); });
ipcMain.handle('wv-go-back',    ()       => { if (wikiView.webContents.canGoBack())    wikiView.webContents.goBack();    });
ipcMain.handle('wv-go-forward', ()       => { if (wikiView.webContents.canGoForward()) wikiView.webContents.goForward(); });
ipcMain.handle('wv-reload',     ()       => { wikiView.webContents.reload(); });
ipcMain.handle('wv-stop',       ()       => { wikiView.webContents.stop();   });
ipcMain.handle('wv-get-url',    ()       => wikiView.webContents.getURL());

// ─── IPC: Layout ─────────────────────────────────────────────────────────────
ipcMain.handle('set-sidebar-collapsed', (_, collapsed) => {
  sidebarCollapsed = collapsed;
  repositionWikiView();
});

// ─── IPC: PiP / Overlay ──────────────────────────────────────────────────────
ipcMain.handle('set-always-on-top', (_, enabled) => {
  enabled ? win.setAlwaysOnTop(true, 'screen-saver') : win.setAlwaysOnTop(false);
});
ipcMain.handle('set-opacity', (_, value) => {
  win.setOpacity(Math.max(0.1, Math.min(1.0, parseFloat(value))));
});

// ─── IPC: Fandom Settings ────────────────────────────────────────────────────
ipcMain.handle('fandom-get-settings', () => ({ ...fandomSettings }));

ipcMain.handle('fandom-set-setting', async (_, key, value) => {
  if (!(key in FANDOM_SETTINGS_DEFAULTS)) return;
  fandomSettings[key] = value;
  saveFandomSettings();
  const url = wikiView.webContents.getURL();
  if (isFandomUrl(url)) {
    try {
      const live = await wikiView.webContents.executeJavaScript(
        `window.__GWH_fandom ? (window.__GWH_fandom.update(${JSON.stringify(fandomSettings)}), true) : false`
      );
      if (!live) await injectFandomEnhancements();
    } catch { await injectFandomEnhancements(); }
  }
  return { ...fandomSettings };
});

// ─── IPC: Window chrome ───────────────────────────────────────────────────────
ipcMain.handle('window-minimize',     () => win.minimize());
ipcMain.handle('window-maximize',     () => win.isMaximized() ? win.unmaximize() : win.maximize());
ipcMain.handle('window-close',        () => win.close());
ipcMain.handle('window-is-maximized', () => win.isMaximized());
ipcMain.handle('get-version',         () => app.getVersion());
ipcMain.handle('get-platform',        () => process.platform);

// ─── IPC: External links ──────────────────────────────────────────────────────
ipcMain.handle('open-external', (_, url) => {
  try {
    const { protocol: proto } = new URL(url);
    if (proto === 'https:' || proto === 'http:') shell.openExternal(url);
  } catch { /* ignore */ }
});
