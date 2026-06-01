// 포인트 자막 카테고리 → 효과음 매칭
// 사용자 커스텀 규칙 지원 (config/sound-rules.json)

const path = require('path');
const fs = require('fs');
const os = require('os');
const { getUserDataDir } = require('./paths');

// 사용자 쓰기 가능 폴더 (Program Files 권한 회피)
const USER_DATA_DIR = getUserDataDir();
const CONFIG_PATH = path.join(USER_DATA_DIR, 'sound-rules.json');
// 구버전 경로 (앱 폴더 안) - 마이그레이션용
const LEGACY_CONFIG_PATH = path.join(__dirname, '..', 'config', 'sound-rules.json');
const DEFAULT_SOUND_DIR = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Documents', '효과음')
  : 'E:\\1. 클라이언트\\효과음\\자주 사용하는 것';

// 기본 규칙 (설정 파일 없을 때 사용)
const DEFAULT_RULES = {
  soundDir: DEFAULT_SOUND_DIR,
  categories: {
    question:   ['001_뽁.wav', '038_뿅.mp3', '뽀옹.mp3', '086_팝.mp3', 'DA_-_Pop_-_6 (1).mp3'],
    emphasis:   ['082_띵.mp3', '026_띠딩2.mp3'],
    surprise:   ['038_뿅.mp3', '001_뽁.wav'],
    list:       ['085_마우스클릭.mp3', '클릭소리.aac'],
    emotion:    ['뽀옹.mp3', '086_팝.mp3'],
    conclusion: ['082_띵.mp3', '026_띠딩2.mp3'],
  }
};

const CATEGORY_LABELS = {
  question: '❓ 질문/호기심',
  emphasis: '🎯 핵심 강조',
  surprise: '💥 놀라움/반전',
  list: '📋 정보 나열',
  emotion: '💗 감성/공감',
  conclusion: '📣 마무리/결론',
};

/**
 * 규칙 로드 (없으면 기본값 자동 생성)
 */
function loadRules() {
  // 1순위: 사용자 폴더, 2순위: 구버전 앱 폴더
  let p = null;
  if (fs.existsSync(CONFIG_PATH)) p = CONFIG_PATH;
  else if (fs.existsSync(LEGACY_CONFIG_PATH)) p = LEGACY_CONFIG_PATH;
  if (!p) {
    // 기본값을 사용자 폴더에 생성 시도 (실패해도 기본값 반환)
    try { saveRules(DEFAULT_RULES); } catch (e) {}
    return { ...DEFAULT_RULES };
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    return { ...DEFAULT_RULES };
  }
}

/**
 * 규칙 저장 (항상 사용자 폴더에 - 쓰기 권한 보장)
 */
function saveRules(rules) {
  if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(rules, null, 2), 'utf-8');
}

/**
 * 카테고리에 맞는 효과음 랜덤 선택
 */
function pickSound(category, rules = null) {
  const r = rules || loadRules();
  const sounds = (r.categories[category] || r.categories.emphasis || []);
  const candidates = sounds
    .map(name => path.join(r.soundDir, name))
    .filter(p => fs.existsSync(p));

  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * 포인트 자막 배열에 효과음 매칭
 */
function matchSounds(points, soundDir = null) {
  const rules = loadRules();
  if (soundDir) rules.soundDir = soundDir;

  return points.map(p => {
    const soundPath = pickSound(p.category, rules);
    return {
      ...p,
      sound: soundPath,
      soundName: soundPath ? path.basename(soundPath) : null,
    };
  });
}

/**
 * 효과음 폴더 내 사용 가능한 모든 파일 목록
 */
function listAvailableSounds(soundDir) {
  const dir = soundDir || loadRules().soundDir;
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => /\.(mp3|wav|aac|m4a|ogg|flac)$/i.test(f))
      .sort();
  } catch (e) { return []; }
}

module.exports = {
  loadRules, saveRules, pickSound, matchSounds,
  listAvailableSounds, CATEGORY_LABELS,
  DEFAULT_RULES, DEFAULT_SOUND_DIR,
};
