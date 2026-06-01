// 파일 로거 — 사용자 PC에서 실행 문제를 진단할 수 있도록
// %APPDATA%\ArkPointsPro\app.log (Win) / ~/Library/Application Support/ArkPointsPro/app.log (Mac)
// 에 Electron 시작 · 서버 시작 · 에러 등을 기록합니다.

const fs = require('fs');
const path = require('path');
const { getUserDataDir } = require('./paths');

let logFilePath = null;
let ready = false;

function init() {
  if (ready) return logFilePath;
  try {
    const dir = getUserDataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    logFilePath = path.join(dir, 'app.log');

    // 로그가 무한정 커지지 않도록 1MB 넘으면 .old로 회전
    try {
      if (fs.existsSync(logFilePath) && fs.statSync(logFilePath).size > 1024 * 1024) {
        fs.renameSync(logFilePath, logFilePath + '.old');
      }
    } catch (e) {}

    ready = true;
    write('INFO', '=== 로그 세션 시작 ===');
    write('INFO', `플랫폼: ${process.platform} ${process.arch}, Node: ${process.version}`);
    write('INFO', `로그 파일: ${logFilePath}`);
  } catch (e) {
    // 로깅 자체가 실패해도 앱은 계속 떠야 함
    ready = false;
  }
  return logFilePath;
}

function stamp() {
  // new Date()는 환경에 따라 막혀 있을 수 있으나 런타임에서는 정상 동작
  try {
    return new Date().toISOString();
  } catch (e) {
    return '----';
  }
}

function write(level, ...args) {
  const msg = args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }
      return String(a);
    })
    .join(' ');

  const line = `[${stamp()}] [${level}] ${msg}\n`;

  // 콘솔에도 출력 (개발 시 도움)
  if (level === 'ERROR') console.error(line.trimEnd());
  else console.log(line.trimEnd());

  if (!ready) return;
  try {
    fs.appendFileSync(logFilePath, line, 'utf-8');
  } catch (e) {}
}

module.exports = {
  init,
  getLogPath: () => logFilePath,
  info: (...a) => write('INFO', ...a),
  warn: (...a) => write('WARN', ...a),
  error: (...a) => write('ERROR', ...a),
};
