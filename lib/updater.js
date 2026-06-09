/**
 * 자동 업데이트 모듈.
 *
 * Windows: electron-updater로 GitHub 릴리스를 확인 → 사용자 동의 → 다운로드 →
 *          재시작 후 설치(원클릭). app-update.yml(빌드시 publish 설정에서 생성)을
 *          자동으로 읽으므로 setFeedURL 불필요.
 *
 * macOS:   ad-hoc 서명 빌드는 Squirrel.Mac 서명 검증을 통과하지 못해 자동 설치가
 *          불가능하다. 따라서 GitHub API로 최신 버전만 확인하고, 새 버전이 있으면
 *          다운로드 페이지를 열어 수동 설치를 안내한다.
 *          (정식 자동설치는 Apple Developer ID 서명+공증 도입 후 가능.)
 *
 * 공통 원칙: dev(미패키지)에서는 비활성. 어떤 오류도 사용자에게 반복 알림(nag)하지
 *          않고 로그로만 남긴다. 시작을 막지 않는다.
 */

const https = require('https');
const { app, dialog, shell } = require('electron');

const log = require('./logger');

const isMac = process.platform === 'darwin';

// 사용자용 다운로드 페이지 (mac 수동 설치 안내 / Win 폴백).
const DOWNLOAD_PAGE = 'https://arkvvs.tools';

// GitHub 릴리스 API (mac 버전 확인용).
const GH_OWNER = 'hanna0099';
const GH_REPO = 'ark-points-pro';

let notified = false; // 중복 다이얼로그 방지

// ── "a가 b보다 최신인가" 단순 semver 비교 ──
function isNewer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

// ── 진입점 ──
function initUpdater(parentWindow) {
  try {
    if (!app.isPackaged) {
      log.info('[updater] dev 모드 — 자동 업데이트 비활성');
      return;
    }
    if (isMac) {
      initMacNotify(parentWindow);
    } else {
      initWinAutoUpdate(parentWindow);
    }
  } catch (e) {
    log.error('[updater] 초기화 실패(무시):', e);
  }
}

// ── Windows: electron-updater 풀 플로우 ──
function initWinAutoUpdate(parentWindow) {
  const { autoUpdater } = require('electron-updater');

  autoUpdater.autoDownload = false;          // 사용자 동의 후 다운로드
  autoUpdater.autoInstallOnAppQuit = true;   // 다운로드해뒀다면 종료 시 설치
  autoUpdater.logger = {
    info: (...a) => log.info('[updater]', ...a),
    warn: (...a) => log.warn('[updater]', ...a),
    error: (...a) => log.error('[updater]', ...a),
    debug: () => {},
  };

  autoUpdater.on('update-available', async (info) => {
    if (notified) return;
    notified = true;
    log.info('[updater] 새 버전 감지:', info && info.version);
    const r = await dialog.showMessageBox(parentWindow, {
      type: 'info',
      title: '업데이트 알림',
      message: `새 버전 ${info && info.version ? 'v' + info.version : ''}이(가) 있습니다.`,
      detail: '지금 업데이트하시겠습니까?\n다운로드 후 앱이 재시작되며 자동으로 설치됩니다.',
      buttons: ['지금 업데이트', '나중에'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (r.response === 0) {
      log.info('[updater] 다운로드 시작');
      autoUpdater.downloadUpdate().catch((e) => log.error('[updater] 다운로드 실패:', e));
    } else {
      log.info('[updater] 사용자가 "나중에" 선택');
    }
  });

  autoUpdater.on('update-not-available', () => {
    log.info('[updater] 최신 버전 사용 중');
  });

  autoUpdater.on('download-progress', (p) => {
    log.info(`[updater] 다운로드 ${Math.round(p.percent)}%`);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    log.info('[updater] 다운로드 완료:', info && info.version);
    const r = await dialog.showMessageBox(parentWindow, {
      type: 'info',
      title: '업데이트 준비 완료',
      message: '업데이트 다운로드가 완료되었습니다.',
      detail: '지금 재시작하여 설치하시겠습니까?',
      buttons: ['재시작 후 설치', '나중에'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (r.response === 0) {
      // isSilent=false(설치 진행 표시), isForceRunAfter=true(설치 후 자동 실행)
      autoUpdater.quitAndInstall(false, true);
    }
  });

  autoUpdater.on('error', (err) => {
    // 네트워크 불가/릴리스 없음 등 — 조용히 로그만.
    log.warn('[updater] 오류(무시):', err && err.message ? err.message : String(err));
  });

  autoUpdater.checkForUpdates().catch((e) => log.warn('[updater] 확인 실패:', e && e.message));
}

// ── macOS: 버전 확인 + 다운로드 페이지 안내 ──
function initMacNotify(parentWindow) {
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${GH_OWNER}/${GH_REPO}/releases/latest`,
    method: 'GET',
    headers: {
      'User-Agent': 'ArkPointsPro-Updater',
      Accept: 'application/vnd.github+json',
    },
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => {
      try {
        if (res.statusCode !== 200) {
          // 비공개 repo(404) 등 — 조용히 종료.
          log.warn('[updater] mac 버전 확인 응답:', res.statusCode);
          return;
        }
        const data = JSON.parse(body);
        const latest = data.tag_name || data.name;
        if (!latest) return;
        const current = app.getVersion();
        if (isNewer(latest, current)) {
          log.info(`[updater] mac 새 버전 ${latest} (현재 ${current})`);
          notifyMacUpdate(parentWindow, latest);
        } else {
          log.info('[updater] mac 최신 버전 사용 중');
        }
      } catch (e) {
        log.warn('[updater] mac 응답 파싱 실패:', e.message);
      }
    });
  });
  req.on('error', (e) => log.warn('[updater] mac 확인 실패:', e.message));
  req.end();
}

async function notifyMacUpdate(parentWindow, latest) {
  if (notified) return;
  notified = true;
  const r = await dialog.showMessageBox(parentWindow, {
    type: 'info',
    title: '업데이트 알림',
    message: `새 버전 ${latest}이(가) 있습니다.`,
    detail:
      'macOS는 다운로드 페이지에서 새 버전을 받아 다시 설치해 주세요.\n' +
      '(기존 설정·데이터는 유지됩니다.)',
    buttons: ['다운로드 페이지 열기', '나중에'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (r.response === 0) {
    shell.openExternal(DOWNLOAD_PAGE);
  }
}

module.exports = { initUpdater };
