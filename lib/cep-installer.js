/**
 * CEP 확장 자동 설치 모듈.
 *
 * Ark Points Pro는 Premiere Pro 안에서 도는 CEP 패널("MCP Bridge")을 통해
 * ExtendScript를 실행한다 (lib/premiere-bridge.js 와 짝). 이 패널은 Adobe의
 * CEP extensions 폴더에 설치되어 있어야 Premiere의 "창 > 확장" 메뉴에 나타난다.
 *
 * 이 모듈은 앱 최초 실행 시(사용자 동의를 받아):
 *   1) 번들된 cep-extension/ 을 OS별 CEP extensions 폴더로 복사
 *   2) 미서명 확장 로드를 허용하도록 PlayerDebugMode(CSXS 9~12)를 설정
 *   3) "Premiere 재시작 후 패널 열기" 안내
 *
 * 설계 원칙: 어떤 단계가 실패해도 예외를 위로 던지지 않는다(앱 시작을 막지 않음).
 * 모든 결과는 로그로만 남기고, 사용자에게는 다이얼로그로 핵심만 안내한다.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { app, dialog } = require('electron');

const log = require('./logger');

const isMac = process.platform === 'darwin';

// CEP 확장 폴더명 (manifest의 설치 디렉토리명과 일치해야 함).
const CEP_DIR_NAME = 'premiere-pro-mcp';

// 번들된 확장 콘텐츠의 버전. cep-extension/ 내용이 바뀔 때마다 +1.
// 대상 폴더의 마커 파일과 비교해, 마커 < CEP_VERSION 일 때만 재설치한다.
const CEP_VERSION = 1;
const MARKER_FILE = '.ark-cep-version';

// PlayerDebugMode를 켤 CSXS 런타임 버전 범위.
const CSXS_VERSIONS = [9, 10, 11, 12];

// ── 경로 헬퍼 ──

// 번들 원본: dev=repo의 cep-extension/, 패키지=resources/cep-extension/
function getSourceDir() {
  if (!app.isPackaged) {
    return path.join(app.getAppPath(), 'cep-extension');
  }
  return path.join(process.resourcesPath, 'cep-extension');
}

// 설치 대상: OS별 사용자 CEP extensions 폴더.
function getDestDir() {
  if (isMac) {
    return path.join(
      os.homedir(),
      'Library', 'Application Support', 'Adobe', 'CEP', 'extensions',
      CEP_DIR_NAME
    );
  }
  // Windows: %APPDATA%\Adobe\CEP\extensions\
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Adobe', 'CEP', 'extensions', CEP_DIR_NAME);
}

// 현재 설치된 확장의 버전을 읽는다.
//   -1: 대상 폴더 자체가 없음 (미설치)
//    0: 폴더는 있으나 마커 없음 (예: 사용자가 수동 설치) → 우리가 한 번 덮어쓰며 인수
//   N: 마커가 가리키는 버전
function readInstalledVersion(destDir) {
  try {
    if (!fs.existsSync(destDir)) return -1;
    const markerPath = path.join(destDir, MARKER_FILE);
    if (!fs.existsSync(markerPath)) return 0;
    const raw = fs.readFileSync(markerPath, 'utf-8').trim();
    const n = parseInt(raw, 10);
    return isNaN(n) ? 0 : n;
  } catch (e) {
    log.warn('[cep] 설치 버전 확인 실패:', e.message);
    return 0;
  }
}

// ── 동의 다이얼로그 (설치 전 1회) ──
async function askConsent(parentWindow) {
  const result = await dialog.showMessageBox(parentWindow, {
    type: 'question',
    title: 'Premiere Pro 연동 설정',
    message: 'Premiere Pro 연동 설정',
    detail:
      'Ark Points Pro가 Premiere Pro와 연동되려면:\n' +
      '1. CEP 확장 플러그인을 Adobe 폴더로 설치 (자동)\n' +
      '2. Premiere의 PlayerDebugMode 설정 켜기 (서명 안 된 확장 허용)\n\n' +
      '이 두 가지를 진행하시겠습니까?\n' +
      '(이미 설치되어 있으면 자동으로 스킵합니다)',
    buttons: ['예, 진행', '나중에'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
}

// ── 재시작 안내 다이얼로그 (설치 성공 후) ──
function showRestartNotice(parentWindow) {
  try {
    dialog.showMessageBox(parentWindow, {
      type: 'info',
      title: 'Premiere Pro 연동 설정 완료',
      message: 'Premiere Pro 연동 설정이 완료되었습니다.',
      detail:
        'Premiere Pro를 완전히 종료한 뒤 다시 실행하고,\n' +
        '상단 메뉴 [창(Window) → 확장(Extensions) → MCP Bridge] 를 클릭해\n' +
        '패널을 여세요.\n\n' +
        '(이 패널이 열려 있어야 자막·효과음 자동 반영이 동작합니다.)',
      buttons: ['확인'],
      noLink: true,
    });
  } catch (e) {
    log.warn('[cep] 재시작 안내 표시 실패:', e.message);
  }
}

// ── PlayerDebugMode 설정 (CSXS 9~12) ──
function execFileAsync(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          log.warn(`[cep] ${file} ${args.join(' ')} 실패:`, err.message);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    } catch (e) {
      log.warn(`[cep] ${file} 실행 예외:`, e.message);
      resolve(false);
    }
  });
}

async function setPlayerDebugMode() {
  let ok = 0;
  for (const v of CSXS_VERSIONS) {
    if (isMac) {
      // defaults write com.adobe.CSXS.<v> PlayerDebugMode 1
      const done = await execFileAsync('defaults', [
        'write', `com.adobe.CSXS.${v}`, 'PlayerDebugMode', '1',
      ]);
      if (done) ok++;
    } else {
      // reg add HKCU\Software\Adobe\CSXS.<v> /v PlayerDebugMode /t REG_SZ /d 1 /f
      const done = await execFileAsync('reg', [
        'add', `HKCU\\Software\\Adobe\\CSXS.${v}`,
        '/v', 'PlayerDebugMode', '/t', 'REG_SZ', '/d', '1', '/f',
      ]);
      if (done) ok++;
    }
  }

  // Mac은 변경 즉시 반영을 위해 preferences 캐시를 비운다.
  if (isMac) {
    await execFileAsync('killall', ['cfprefsd']);
  }

  log.info(`[cep] PlayerDebugMode 설정 완료 (성공 ${ok}/${CSXS_VERSIONS.length})`);
  return ok > 0;
}

// ── 확장 파일 복사 ──
function copyExtension(srcDir, destDir) {
  // 대상 상위 폴더 보장 후 재귀 복사(덮어쓰기). Node 20의 fs.cpSync 사용.
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true, force: true });
  // 설치 마커 기록 → 다음 실행부터는 최신으로 인식해 스킵.
  fs.writeFileSync(path.join(destDir, MARKER_FILE), String(CEP_VERSION), 'utf-8');
}

// ── 메인 진입점 ──
// 앱 시작 시 1회 호출. 실패해도 throw하지 않는다.
async function maybeInstallCep(parentWindow) {
  try {
    const srcDir = getSourceDir();
    const destDir = getDestDir();

    if (!fs.existsSync(srcDir)) {
      log.warn('[cep] 번들 확장 원본을 찾을 수 없음(설치 건너뜀):', srcDir);
      return;
    }

    const installed = readInstalledVersion(destDir);
    if (installed >= CEP_VERSION) {
      log.info(`[cep] 확장이 이미 최신입니다 (v${installed}). 설치 건너뜀.`);
      return;
    }

    log.info(`[cep] 설치 필요: installed=${installed}, bundled=${CEP_VERSION}`);

    // 설치 전 사용자 동의 (시스템 설정을 건드리므로).
    const consent = await askConsent(parentWindow);
    if (!consent) {
      log.info('[cep] 사용자가 "나중에" 선택 — 다음 실행 시 다시 안내.');
      return;
    }

    // 1) 확장 복사
    try {
      copyExtension(srcDir, destDir);
      log.info('[cep] 확장 복사 완료:', destDir);
    } catch (e) {
      // Premiere가 패널을 연 상태면 Win에서 파일 잠금으로 실패 가능.
      log.error('[cep] 확장 복사 실패:', e);
      try {
        dialog.showMessageBox(parentWindow, {
          type: 'warning',
          title: 'Premiere Pro 연동 설정',
          message: '확장 설치에 실패했습니다.',
          detail:
            'Premiere Pro가 실행 중이면 완전히 종료한 뒤\n' +
            'Ark Points Pro를 다시 실행해 주세요.\n\n' +
            `오류: ${e.message}`,
          buttons: ['확인'],
          noLink: true,
        });
      } catch (e2) {}
      return; // 마커 미기록 → 다음 실행 시 재시도
    }

    // 2) PlayerDebugMode (실패해도 진행 — 안내로 커버)
    await setPlayerDebugMode();

    // 3) 재시작 안내
    showRestartNotice(parentWindow);
  } catch (e) {
    log.error('[cep] 설치 처리 중 예기치 못한 오류(무시):', e);
  }
}

module.exports = {
  maybeInstallCep,
  // 테스트/진단용 export
  getSourceDir,
  getDestDir,
  readInstalledVersion,
  CEP_DIR_NAME,
  CEP_VERSION,
};
