/**
 * Ark Points Pro — Electron main process.
 *
 * Express 서버를 내장하고, BrowserWindow로 UI를 띄움.
 * exe/dmg 하나로 설치/실행 가능 (Node.js 별도 설치 불필요).
 *
 * 안정성 설계 원칙:
 *  - 실행 즉시 무조건 창이 보인다 (스플래시 → 본 화면 또는 오류 화면).
 *  - 어떤 단계가 실패해도 프로세스가 조용히 죽지 않고 로그 + 안내를 남긴다.
 *  - 모든 단계를 app.log에 기록해 사용자 PC에서도 원인 진단이 가능하다.
 */

const { app, BrowserWindow, shell, Tray, Menu, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const log = require('../lib/logger');

const isDev = !app.isPackaged;
const isMac = process.platform === 'darwin';
let mainWindow = null;
let tray = null;
let serverPort = null;
let startupFailed = false;

const PREFERRED_PORT = 3838;

// ── 앱 루트 경로 ──
// dev: 프로젝트 루트, 패키지(asar): …/resources/app.asar 를 반환.
// process.resourcesPath/'app'은 asar 빌드에서 존재하지 않으므로 절대 쓰면 안 됨.
function getAppRoot() {
  return app.getAppPath();
}

// ── 전역 에러 핸들러 (조용한 크래시 방지) ──
process.on('uncaughtException', (err) => {
  log.error('[main] uncaughtException:', err);
  showFatalError(`예기치 못한 오류: ${err && err.message ? err.message : err}`);
});
process.on('unhandledRejection', (reason) => {
  log.error('[main] unhandledRejection:', reason instanceof Error ? reason : String(reason));
});

// ── Express 서버 시작 (포트 폴백 포함) ──
async function startServer() {
  // 모든 모듈이 __dirname / 절대경로(%APPDATA%)만 쓰므로 cwd 변경 불필요.
  // (asar는 디렉토리가 아니라 파일이라 chdir도 불가능)
  const appRoot = getAppRoot();
  const serverPath = path.join(appRoot, 'server.js');
  log.info('[main] 서버 모듈 로드:', serverPath);

  let serverModule;
  try {
    serverModule = require(serverPath);
  } catch (e) {
    log.error('[main] server.js require 실패:', e);
    throw new Error('server.js 로드 실패: ' + e.message);
  }

  if (!serverModule || typeof serverModule.startServer !== 'function') {
    throw new Error('server.js 형식 오류: startServer를 찾을 수 없습니다.');
  }

  const { port } = await serverModule.startServer(PREFERRED_PORT);
  serverPort = port;
  log.info('[main] Express 서버 시작 완료, 포트:', port);
  return port;
}

// ── 아이콘 경로 헬퍼 ──
function getIconPath(name) {
  return path.join(getAppRoot(), name);
}

// ── UI 윈도우 생성 (즉시 스플래시 표시) ──
function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
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
    show: true, // 즉시 보이기 — "아무 동작 없음" 방지
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // 실행하자마자 스플래시(로딩 화면)부터 띄운다.
  // 서버가 빨리 떠서 곧바로 loadURL로 전환되면 splash 로드가 ERR_ABORTED로
  // 중단되는데, 이는 정상 동작이므로 에러로 취급하지 않는다.
  mainWindow.loadFile(path.join(__dirname, 'splash.html')).catch((e) => {
    if (e && /ERR_ABORTED/.test(String(e.message))) return;
    log.warn('[main] splash 로드 실패(무시):', e.message);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => (mainWindow = null));

  if (!isMac) {
    mainWindow.setMenuBarVisibility(false);
  }

  mainWindow.show();
  mainWindow.focus();
  return mainWindow;
}

// ── 서버 준비 완료 → 본 화면 로드 (실패 시 재시도) ──
async function loadApp(port, attempt = 0) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const url = `http://localhost:${port}`;
  try {
    await mainWindow.loadURL(url);
    log.info('[main] UI 로드 완료:', url);
  } catch (e) {
    log.warn(`[main] UI 로드 실패(시도 ${attempt + 1}):`, e.message);
    if (attempt < 5) {
      setTimeout(() => loadApp(port, attempt + 1), 600);
    } else {
      showFatalError(`화면을 불러오지 못했습니다: ${e.message}`);
    }
  }
}

// ── 치명적 오류 화면 + 다이얼로그 ──
function showFatalError(message) {
  startupFailed = true;
  const logPath = log.getLogPath() || '(로그 파일 없음)';
  log.error('[main] 치명적 오류:', message);

  // 1) 창에 오류 화면 표시 (창이 비어 보이지 않게)
  try {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    }
    const errPage = path.join(__dirname, 'error.html');
    const hash = `#error=${encodeURIComponent(message)}&log=${encodeURIComponent(logPath)}`;
    mainWindow.loadFile(errPage, { hash: hash.slice(1) }).catch(() => {});
    mainWindow.show();
    mainWindow.focus();
  } catch (e) {
    log.error('[main] 오류 화면 표시 실패:', e);
  }

  // 2) 네이티브 오류 다이얼로그
  try {
    dialog.showMessageBox({
      type: 'error',
      title: 'Ark Points Pro — 실행 오류',
      message: '앱을 시작하지 못했습니다.',
      detail: `${message}\n\n로그 파일:\n${logPath}\n\n이 내용을 개발자에게 전달해 주세요.`,
      buttons: ['확인'],
    });
  } catch (e) {}
}

// ── 트레이 아이콘 ──
function createTray() {
  try {
    let trayIcon;
    if (isMac) {
      const trayPath = getIconPath('trayTemplate.png');
      if (fs.existsSync(trayPath)) {
        trayIcon = nativeImage.createFromPath(trayPath);
        trayIcon.setTemplateImage(true);
      } else {
        trayIcon = nativeImage.createFromPath(getIconPath('public/logo.png')).resize({ width: 18, height: 18 });
        trayIcon.setTemplateImage(true);
      }
    } else {
      trayIcon = getIconPath('logo.ico');
    }

    tray = new Tray(trayIcon);
    tray.setToolTip('Ark Points Pro');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '열기', click: () => createWindow() },
      { label: '로그 폴더 열기', click: () => {
        const lp = log.getLogPath();
        if (lp) shell.showItemInFolder(lp);
      } },
      { type: 'separator' },
      { label: '종료', click: () => app.quit() },
    ]));
    tray.on('double-click', () => createWindow());
    log.info('[main] 트레이 생성 완료');
  } catch (e) {
    log.error('[main] 트레이 생성 실패(무시):', e);
  }
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

// ── 단일 인스턴스 보장 ──
// 이미 실행 중인데 또 더블클릭하면 → 새 프로세스를 띄우지 않고 기존 창을 살린다.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      createWindow();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // ── App lifecycle ──
  app.whenReady().then(async () => {
    log.init();
    log.info('[main] Electron 준비 완료. isDev=' + isDev + ', appRoot=' + getAppRoot());

    setupIPC();
    createWindow(); // 즉시 스플래시 표시 (창이 무조건 보인다)
    createTray();

    try {
      const port = await startServer();
      await loadApp(port);
    } catch (e) {
      showFatalError('서버 시작 실패: ' + (e && e.message ? e.message : String(e)));
    }
  });

  app.on('window-all-closed', () => {
    // 트레이에 남아있으므로 종료하지 않음 (Mac/Win 동일)
  });

  app.on('activate', () => {
    if (serverPort && !startupFailed) {
      createWindow();
      loadApp(serverPort);
    } else {
      createWindow();
    }
  });
}
