/**
 * Ark Points Pro — Electron main process.
 *
 * Express 서버를 내장하고, BrowserWindow로 UI를 띄움.
 * exe/dmg 하나로 설치/실행 가능 (Node.js 별도 설치 불필요).
 */

const { app, BrowserWindow, shell, Tray, Menu, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;
const isMac = process.platform === 'darwin';
let mainWindow = null;
let tray = null;

const PORT = 3838;

// ── Express 서버 시작 ──
function startServer() {
  const appRoot = isDev
    ? path.join(__dirname, '..')
    : path.join(process.resourcesPath, 'app');
  process.chdir(appRoot);

  const serverPath = path.join(appRoot, 'server.js');
  try {
    require(serverPath);
    console.log('[Electron] Express server started on port', PORT);
  } catch (e) {
    console.error('[Electron] Server start failed:', e);
  }
}

// ── 아이콘 경로 헬퍼 ──
function getIconPath(name) {
  return isDev
    ? path.join(__dirname, '..', name)
    : path.join(process.resourcesPath, 'app', name);
}

// ── UI 윈도우 ──
function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const iconPath = getIconPath(isMac ? 'public/logo.png' : 'logo.ico');

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Ark Points Pro',
    icon: iconPath,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => (mainWindow = null));

  if (!isMac) {
    mainWindow.setMenuBarVisibility(false);
  }
}

// ── 트레이 아이콘 ──
function createTray() {
  let trayIcon;
  if (isMac) {
    // Mac: Template image로 만들면 다크/라이트 모드 자동 대응
    const trayPath = getIconPath('trayTemplate.png');
    if (fs.existsSync(trayPath)) {
      trayIcon = nativeImage.createFromPath(trayPath);
      trayIcon.setTemplateImage(true);
    } else {
      // fallback: logo.png 리사이즈
      trayIcon = nativeImage.createFromPath(getIconPath('public/logo.png')).resize({ width: 18, height: 18 });
      trayIcon.setTemplateImage(true);
    }
  } else {
    trayIcon = getIconPath('logo.ico');
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Ark Points Pro');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '열기', click: createWindow },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ]));
  tray.on('double-click', createWindow);
}

// ── IPC 핸들러 ──
function setupIPC() {
  ipcMain.handle('pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '효과음 폴더 선택',
    });
    if (result.canceled || result.filePaths.length === 0) return { path: null };
    return { path: result.filePaths[0] };
  });
}

// ── App lifecycle ──
app.whenReady().then(() => {
  setupIPC();
  startServer();

  setTimeout(() => {
    createWindow();
    createTray();
  }, 1000);
});

app.on('window-all-closed', () => {
  // 트레이에 남아있으므로 종료하지 않음 (Mac/Win 동일)
});

app.on('activate', () => {
  createWindow();
});
