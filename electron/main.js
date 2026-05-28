/**
 * Ark Points Pro — Electron main process.
 *
 * Express 서버를 내장하고, BrowserWindow로 UI를 띄움.
 * exe 하나로 설치/실행 가능 (Node.js 별도 설치 불필요).
 */

const { app, BrowserWindow, shell, Tray, Menu } = require('electron');
const path = require('path');

const isDev = !app.isPackaged;
let mainWindow = null;
let tray = null;
let server = null;

const PORT = 3838;

// ── Express 서버 시작 ──
function startServer() {
  // server.js의 express app을 직접 require
  // server.js가 app.listen()을 호출하므로, 그냥 require하면 서버가 뜸
  const serverPath = isDev
    ? path.join(__dirname, '..', 'server.js')
    : path.join(process.resourcesPath, 'app', 'server.js');

  // working directory를 앱 루트로 설정 (config/, public/ 등 상대경로 해결)
  const appRoot = isDev
    ? path.join(__dirname, '..')
    : path.join(process.resourcesPath, 'app');
  process.chdir(appRoot);

  try {
    require(serverPath);
    console.log('[Electron] Express server started on port', PORT);
  } catch (e) {
    console.error('[Electron] Server start failed:', e);
  }
}

// ── UI 윈도우 ──
function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const iconPath = isDev
    ? path.join(__dirname, '..', 'logo.ico')
    : path.join(process.resourcesPath, 'app', 'logo.ico');

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
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // 외부 링크는 기본 브라우저로
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => (mainWindow = null));

  // 메뉴 숨기기 (깔끔한 UX)
  mainWindow.setMenuBarVisibility(false);
}

// ── 트레이 아이콘 ──
function createTray() {
  const iconPath = isDev
    ? path.join(__dirname, '..', 'logo.ico')
    : path.join(process.resourcesPath, 'app', 'logo.ico');

  tray = new Tray(iconPath);
  tray.setToolTip('Ark Points Pro');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '열기', click: createWindow },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ]));
  tray.on('double-click', createWindow);
}

// ── App lifecycle ──
app.whenReady().then(() => {
  startServer();

  // 서버 뜰 때까지 잠깐 대기
  setTimeout(() => {
    createWindow();
    createTray();
  }, 1000);
});

app.on('window-all-closed', () => {
  // 트레이에 남아있으므로 종료하지 않음 (Windows 관례)
});

app.on('activate', () => {
  createWindow();
});
