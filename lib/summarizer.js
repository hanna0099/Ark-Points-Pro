// 포인트 자막 요약 엔진
// 1. 규칙 기반 (무료, 즉시 동작) - 한국어 패턴 분석
// 2. AI 기반 (Gemini API, 무료) - 더 자연스러운 요약

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

// 사용자 쓰기 가능 폴더 (Program Files는 권한 막혀서 못 씀)
// %APPDATA%\ArkPointsPro\ai-config.json
const USER_DATA_DIR = path.join(process.env.APPDATA || os.homedir(), 'ArkPointsPro');
const CONFIG_PATH = path.join(USER_DATA_DIR, 'ai-config.json');
// 구버전 경로 (앱 폴더 안) - 마이그레이션용
const LEGACY_CONFIG_PATH = path.join(__dirname, '..', 'config', 'ai-config.json');

// ============================================
// AI 설정 관리
// ============================================
function loadAIConfig() {
  // 1순위: 사용자 폴더, 2순위: 구버전 앱 폴더
  let p = null;
  if (fs.existsSync(CONFIG_PATH)) p = CONFIG_PATH;
  else if (fs.existsSync(LEGACY_CONFIG_PATH)) p = LEGACY_CONFIG_PATH;
  if (!p) {
    return { provider: 'rule', apiKey: '', model: 'gemini-2.5-flash' };
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    return { provider: 'rule', apiKey: '', model: 'gemini-2.5-flash' };
  }
}

function saveAIConfig(config) {
  // 항상 사용자 폴더에 저장 (쓰기 권한 보장)
  if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

// ============================================
// 규칙 기반 요약 (무료, 즉시)
// ============================================

// 제거할 무의미한 단어들
const FILLER_WORDS = [
  '정말', '굉장히', '아주', '매우', '되게', '엄청', '진짜', '완전',
  '그냥', '좀', '조금', '약간', '뭔가', '뭐', '음', '어',
  '저는', '제가', '내가', '우리는', '우리가',
  '여러분', '여러분도', '여러분은', '여러분이'
];

// 시작 부분 connectors (제거 대상)
const START_CONNECTORS = [
  '그래서', '그런데', '하지만', '그리고', '또한', '그러면',
  '그러니까', '그러므로', '따라서', '근데', '그래도', '이게',
  '이것이', '이것은', '바로', '사실', '실제로', '대체로',
  '근본적으로', '결국', '그냥', '뭐냐면', '왜냐하면'
];

// 종결 어미 단순화
const ENDING_REPLACEMENTS = [
  [/입니다\.?$/, ''],
  [/있습니다\.?$/, '있다'],
  [/없습니다\.?$/, '없다'],
  [/합니다\.?$/, '한다'],
  [/됩니다\.?$/, '된다'],
  [/이에요\.?$/, ''],
  [/예요\.?$/, ''],
  [/이죠\.?$/, ''],
  [/이거든요\.?$/, ''],
  [/거든요\.?$/, ''],
  [/하잖아요\.?$/, ''],
  [/잖아요\.?$/, ''],
  [/싶어요\.?$/, '싶다'],
  [/주세요\.?$/, '!'],
  [/하세요\.?$/, '!'],
];

/**
 * 한국어 핵심 명사구 추출 (간단 버전)
 */
function extractKeyPhrase(text) {
  let t = text.trim();

  // 1. 시작 connector 제거
  for (const conn of START_CONNECTORS) {
    if (t.startsWith(conn + ' ') || t.startsWith(conn + ',')) {
      t = t.substring(conn.length).replace(/^[\s,]+/, '');
      break;
    }
  }

  // 2. 무의미 단어 제거 (단어 단위)
  const words = t.split(/\s+/);
  const filtered = words.filter(w => !FILLER_WORDS.includes(w));
  t = filtered.join(' ');

  // 3. 종결 어미 정리
  for (const [pattern, replacement] of ENDING_REPLACEMENTS) {
    if (pattern.test(t)) {
      t = t.replace(pattern, replacement);
      break;
    }
  }

  return t.trim();
}

/**
 * 카테고리에 따라 어미 스타일 변경
 */
function applyStyle(text, category) {
  let t = text.trim();
  if (!t) return t;

  switch (category) {
    case 'question':
      if (!t.endsWith('?')) t = t + '?';
      break;
    case 'emphasis':
      if (!t.endsWith('!') && !t.endsWith('?')) t = t + '!';
      break;
    case 'surprise':
      // 반전은 "→" 사용해 강조
      t = t.replace(/^/, '');
      if (!t.endsWith('!')) t = t + '!';
      break;
    case 'list':
      // 나열은 "/" 또는 "→"로 압축 시도
      t = t.replace(/[,]/g, ' /');
      break;
    case 'emotion':
      if (!t.endsWith('!') && !t.endsWith('?')) t = t + '...';
      break;
    case 'conclusion':
      if (!t.endsWith('!')) t = t + '!';
      break;
  }

  // 너무 길면 자르기
  if (t.length > 32) {
    t = t.substring(0, 30) + '..';
  }

  return t;
}

/**
 * 핵심 패턴 변환 (자주 나오는 표현 압축)
 */
function compressPatterns(text) {
  let t = text;

  // "X가 가장 중요합니다" → "X가 핵심!"
  t = t.replace(/(.+?)가 가장 중요/g, '$1가 핵심');
  // "X을/를 해야 합니다" → "X 필수"
  t = t.replace(/(.+?)을 해야|(.+?)를 해야/g, '$1$2 필수');
  // "X은/는 Y입니다" → "X = Y"
  // (복잡하므로 일단 패스)

  return t;
}

/**
 * 규칙 기반 요약 (메인)
 */
function summarizeByRule(text, category = 'emphasis', originalText = '') {
  // text가 없으면 originalText 사용 (방어)
  const src = (text && String(text).trim()) ? text : (originalText || '');
  if (!src) return '';
  let t = extractKeyPhrase(src);
  t = compressPatterns(t);
  t = applyStyle(t, category);
  return t;
}

// ============================================
// AI 기반 요약 (Claude API)
// ============================================
async function callClaude(apiKey, prompt, model = 'claude-sonnet-4-5') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const json = JSON.parse(body);
          if (json.error) return reject(new Error(json.error.message));
          const text = json.content?.[0]?.text || '';
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ============================================
// AI 기반 요약 (Gemini API)
// ============================================

async function callGemini(apiKey, prompt, model = 'gemini-2.5-flash') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const json = JSON.parse(body);
          if (json.error) return reject(new Error(json.error.message));
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 공통 스타일 가이드 (요약 프롬프트 + 선별 프롬프트가 함께 사용)
const STYLE_GUIDE = `## 절대 원칙 (어기면 안 됨)
1. **화살표(→) 사용 금지**. "A → B" 같은 도식 절대 NO. (단 "A + B = C" 같은 등식 + 합 표기는 OK)
2. **AI 티 나는 패턴 금지**: "~의 진실", "~의 비밀" 클리셰 NO.
3. **원본의 핵심 구절을 최대한 살려서** 자연스럽게 다듬기. 너무 의역하지 말 것.
4. 한국어 입말 그대로. "~할까?", "~네요", "~인 것 같다" 등 사람이 쓰는 톤 유지.
5. **태그에 "번호=N"이 있으면 반드시 "N. ~" 형식으로 출력**. 절대 누락 금지. 예: 번호=2 → "2. 두통과 어지러움"
6. **상품명/브랜드명/고유명사 절대 의역 X**. "센서티 3", "Pretendard", "호야렌즈" 그대로 보존.
7. **숫자는 그대로 살리고 "UP!", "배", "%", 단위로 임팩트**. 예: "2배 UP!", "30% 유지", "3배"
8. **!!, "" 자유롭게 사용 OK**. 강조 필요하면 느낌표 2개도 가능, 핵심 키워드 따옴표 감싸기도 가능.
9. **원본이 이미 짧고 좋으면 거의 그대로** 두기. 강제로 손대지 말 것.
10. **쉼표(,)는 자막의 줄바꿈을 의미함**. 시각적으로 두 줄로 보여주고 싶으면 쉼표로 구분. 예: "눈 피로, 두통, 집중력 저하"는 3줄로 표시됨. 자연 쉼표("안녕, 여러분") 의도라면 쉼표 빼고 다른 표현으로.
11. **맥락 보강 가능**: 원문이 너무 짧거나 모호하면 앞뒤 맥락을 보고 주어/대상 보강 OK. 예: "과연 괜찮을까요?" → "안경 도수를 낮추는 것... 과연 괜찮을까요?"
12. **반어/뒤집기 OK**: 시청자 통념을 흔드는 표현이 임팩트 있음. 예: "더 좋을까요?" → "더 안 좋을까요?"

## 스타일 가이드 (이 톤으로 맞춰주세요)

### 질문형 (question)
원본의 끝부분 "~할까요?", "~인가요?" → "~할까?", "~인가?"로 간결화
- 원본: "그렇다면 실제로 과교정 상태가 계속되면 눈에는 어떤 변화가 생길까요?"
  자막: "눈에 어떤 변화가 생길까?"
- 원본: "그렇다면 이 과교정은 왜 생기는 걸까요?"
  자막: "왜 과교정이 생기는 걸까?"
- 원본: "이런 경우에 그럼 어떻게 해결을 해야 할까요?"
  자막: "과교정, 어떻게 해결해야 할까?"

### 번호 나열형 (list 또는 emphasis 중 순서 항목)
"첫 번째는 ~", "두 번째는 ~"로 시작하는 항목 → "1. ~", "2. ~" 명사형
- 원본: "첫 번째, 눈의 피로입니다"
  자막: "1. 눈의 피로 상태"
- 원본: "두 번째는 두통과 어지러움입니다"
  자막: "2. 두통과 어지러움"
- 원본: "세 번째, 초점의 전환이 느려지는 증상이 생깁니다"
  자막: "3. 초점 전환이 느려지는 증상"
- 원본: "마지막 다섯 번째는 눈이 더 나빠진 것 같은 착각이 듭니다"
  자막: "5. 시력이 더 나빠진 것 같은 느낌"
- 원본: "두 번째는 상황별로 안경을 좀 분리해서 사용하는 것도 좋은 방법이에요"
  자막: "2. 상황별 안경 분리 사용"
- 원본: "두 번째는 근거리 볼 때 피로도를 체크해보세요"
  자막: "2. 근거리 피로도를 체크!"

### 핵심 강조형 (emphasis, conclusion)
원본의 핵심 명제를 그대로 또는 살짝 다듬어 ! 또는 명사형 종결
- 원본: "하루 종일 편안하게 사용할 수 있는가가 핵심입니다"
  자막: "하루 종일 편안한가가 진짜 핵심!"
- 원본: "중요한 것 선명함보다 편안함입니다"
  자막: "시력 검사에서 중요한 것은 편안함"
- 원본: "가장 중요한 기준은 선명하게 보는 게 아니라 편안함입니다"
  자막: "선명함이 아닌 편안함"
- 원본: "잘 보이는 안경보다 편안한 안경이 좋은 안경입니다"
  자막: "잘 보이는 안경보다, 편안한 안경이 좋은 안경"
- 원본: "결국 과교정이 또 다른 과교정을 부르는 악순환에 빠지게 되는 경우가 있어요"
  자막: "과교정이 과교정을 부르는 악순환"
- 원본: "결국은 도수만 맞춘다가 아니라 눈과 내 얼굴에 맞게 완성하는 과정입니다"
  자막: "눈과 얼굴에 맞게 완성하는 과정!"

### 정보 명제형 (list, surprise — 사실/원인 설명)
"~입니다", "~수 있어요"를 깎고 명사형/짧은 평서문으로
- 원본: "가장 큰 원인은 선명함 중심의 검사 방식입니다"
  자막: "선명함 중심의 검사 방식이 원인"
- 원본: "그냥 검사를 진행하게 되면 이 눈이 긴장된 채로 측정이 되어서 실제보다 더 높은 도수가 나올 수 있어요"
  자막: "실제보다 도수가 높게 측정될 수 있음"
- 원본: "충분한 시간을 들여서 다양한 거리와 상황을 확인하는 것이 중요한 것 같아요"
  자막: "도수 검사에 충분한 시간을 들여 확인하는 것이 중요!"

### 상품명/고유명사 보존형 (emphasis)
브랜드명, 제품명, 기술명은 의역하지 말고 그대로 + 강조 마무리
- 원본: "바로 변색렌즈입니다"
  자막: "바로 변색렌즈!!"
- 원본: "바로 센서티3와 센서티 컬러 입니다"
  자막: "센서티 3 & 센서티 컬러"
- 원본: "더 빠르게 안정적으로 반응한다"
  자막: "더 빠르게 안정적으로 반응한다"
  (원본이 이미 짧고 임팩트 있으면 거의 그대로 두기)

### 수치/통계 강조형 (emphasis, list)
숫자는 그대로 살리고 "UP!", "배", 단위로 강조
- 원본: "착색 속도가 약 2배 정도 빨라졌다고 해요"
  자막: "착색 속도 2배 UP!"
- 원본: "경쟁사 대비 내구성은 2배"
  자막: "내구성 2배"
- 원본: "변색 기능의 지속력은 3배 수준으로 설계되었어요"
  자막: "지속력 3배"
- 원본: "실내에서도 약 30% 정도의 틴트 컬러를 유지해요"
  자막: "실내 30% 틴트 유지"

### 추천 대상형 (list, conclusion)
"~분들이에요" / "~분들에게" → "~분 추천!"으로 임팩트
- 원본: "실내에서도 눈부심을 자주 느끼는 분들이에요"
  자막: "실내 눈부심 느끼는 분 추천!"
- 원본: "두 번째는 패션과 기능을 동시에 원하시는 분들이에요."
  자막: "패션과 기능을 동시에 원하는 분 추천!"
- 원본: "깔끔하고 세련된 스타일을 연출하고 싶으신 분들에게"
  자막: "깔끔하고 세련된 스타일 연출!"

### 키워드 따옴표/등호 강조형 (emphasis)
핵심 단어를 따옴표나 +/= 기호로 시각적 분리
- 원본: "바로 성능의 지속력이에요"
  자막: "성능의 \"지속력\""
- 원본: "틴트와 변색 기능이 합쳐진 구조예요"
  자막: "틴트 + 변색 = 센서티 컬러"
- 원본: "코팅력 기술력으로 높은 평가를 받아온 브랜드예요"
  자막: "코팅 기술력이 최상급!"

### 감성/변화 묘사형 (surprise, emotion)
"변신", "발휘" 같은 동적 단어로 활기 부여
- 원본: "그레이 계열로 변한다는 점이에요."
  자막: "그레이 계열로 변신한다"
- 원본: "이처럼 실내와 야외에서 각기 다른 매력을 발휘하는 컬러 변화는"
  자막: "실내외마다 다른 매력을 발휘!"
- 원본: "세련되고 고급스러운 분위기가 있는 톤을 연출합니다"
  자막: "세련되고 고급진 분위기 연출!"

### 상품 마무리형 (conclusion)
"제품명, 핵심 강점" 형태로 정리
- 원본: "성능 중심으로 완성도를 끌어올린 변색렌즈"
  자막: "센서티 3, 성능 중심으로 완성도 up"
- 원본: "스타일과 기능을 동시에 만족시키는 변색렌즈예요"
  자막: "센서티 컬러, 스타일과 기능 동시 해결!"

### 반어/뒤집기형 (question, surprise)
시청자 통념을 흔들어 호기심 유발
- 원본: "안경 도수 일부러 낮춰 쓰면 더 좋을까요?"
  자막: "안경 도수 일부러 낮춰 쓰면 더 안 좋을까요?"

### 맥락 보강형 (question)
원문이 모호하면 앞뒤 맥락을 보고 주어/대상 보강
- 원본: "과연 괜찮을까요?"
  자막: "안경 도수를 낮추는 것... 과연 괜찮을까요?"
- 원본: "그러면 우리 눈은 어떻게 할까요?"
  자막: "그럴 때 우리 눈은 어떻게 할까요?"
- 원본: "왜 어떤 경우에는 도수를 낮춰주기도 할까요?"
  자막: "어떤 경우에 도수를 낮춰줄까?"

### 명사형 종결 압축 (list, emphasis)
"~수가 있어요", "~보입니다" → "~보임" 등 명사형으로 깎기
- 원본: "글자가 번져 보이고,"
  자막: "글자가 번져 보임"
- 원본: "선이 두 개로 보이고,"
  자막: "선이 두 개로 보임"
- 원본: "화면이 뿌옇게 보일 수가 있어요"
  자막: "화면이 뿌옇게 보임"
- 원본: "정확한 도수를 쓰시는 것이 더 좋습니다"
  자막: "정확한 도수가 더 좋습니다"

### 나열형 (list) - 쉼표는 줄바꿈
조사("와/과", "이/가") 제거하고 쉼표로 항목 구분 (각 쉼표 = 줄바꿈)
- 원본: "눈 피로와 두통, 집중력 저하가 생길 수가 있어요"
  자막: "눈 피로, 두통, 집중력 저하"
- 원본: "생활패턴과 눈 피로도, 난시 여부, 적응 능력"
  자막: "생활패턴, 눈피로, 난시, 적응능력"
- 원본: "안경 피팅과 렌즈 초점, 난시 교정"
  자막: "안경 피팅, 렌즈 초점, 난시 교정"

### 핵심 명제 강조 + 쉼표 줄바꿈 (emphasis, conclusion)
원본의 핵심을 그대로 살리고 쉼표로 분리해 강조
- 원본: "안경 도수의 기본 원칙은 정확 도수, 정교정입니다"
  자막: "안경 도수의 기본 원칙, 정확한 도수, 정교정"
- 원본: "도수 숫자가 아니라 편안하고 안정적인 시야입니다"
  자막: "도수 숫자가 아닌, 편안하고 안정적인 시야"
- 원본: "그래서 난시는 정확한 교정이 훨씬 중요합니다"
  자막: "난시는 정확한 교정이 훨씬 중요!"

### 주어 보강 / 강한 명제 (emphasis)
원문에 주어가 빠져있으면 보강해서 의미 명확
- 원본: "눈을 더 피곤하게 만들 수도 있습니다"
  자막: "도수를 낮추면 눈이 더 피곤해져요"

### 번호 시리즈 강제 (list)
"첫 번째/두 번째/세 번째"는 반드시 "1./2./3." 명사형으로. 번호 생략 절대 금지.
- 원본: "첫 번째는 안경을 처음 쓰는 경우예요"
  자막: "1. 안경을 처음 사용하는 경우"
- 원본: "자 우리 두 번째는 근거리 작업이 많은 경우예요"
  자막: "2. 근거리 작업이 많은 경우"
- 원본: "그리고 세 번째, 고도근시인 경우"
  자막: "3. 고도근시인 경우"

### ⚠️ 번호는 화자가 명시적으로 말할 때만!
**"첫 번째/두 번째/세 번째/마지막" 같은 서수를 화자가 실제로 말한 경우에만 "1./2./3." 번호를 붙이세요.**
화자가 서수를 말하지 않았으면 **절대 번호를 멋대로 붙이지 마세요.** (뜬금없는 번호 = 오류)
- 잘못된 예: 원본 "성공한 구조를 가져와 내 스토리로 바꾸는 겁니다" → ❌ "1. 성공한 구조를..." (서수 없는데 번호 붙임)
- 올바른 예: 원본 "성공한 구조를 가져와 내 스토리로 바꾸는 겁니다" → ✅ "성공한 구조를 내 스토리로"

### 반문형 후킹 (question)
"~뭔지 아세요?", "~할 건가요?" → 짧은 반문으로 호기심 폭발
- 원본: "그런데 그 시간을 가장 많이 잡아먹는 게 뭔지 아세요?"
  자막: "시간 잡아먹는 진짜 이유는?"
- 원본: "유튜브에서 가장 중요한 건 뭘까요?"
  자막: "유튜브에서 가장 중요한 건?"
- 원본: "그런데 사실 그 고민 자체가 정말 필요한 고민인지"
  자막: "그 고민, 정말 필요한 걸까?"

### Q. 접두사형 (question) - 탐구 주제 제시
"이제 ~방법을 알아보겠습니다" 같은 도입부 → "Q. ~" 형태로 질문 던지기
- 원본: "그러면 실질적으로 여러분들이 이 편집을 어떻게 레버리지 할 수 있는지 실질적인 방법에 대해서 말해보겠습니다"
  자막: "Q. 이 편집을 어떻게 레버리지할 수 있을지, 실질적인 방법을 알아보기"

### 강조형 (emphasis) - 인과/본질
"바로 ~입니다", "~본질이 아니구나" → 단호한 명제로
- 원본: "바로 편집입니다!"
  자막: "바로 편집 때문!"
- 원본: "유튜브 편집 잘하려고 하지 마세요"
  자막: "유튜브 편집 잘하려고 하지 마세요!"
- 원본: "편집은 정말 유튜브의 본질이 아니구나 컨텐츠의 본질이 아니구나 라는 걸 많이 느꼈습니다"
  자막: "편집은 유튜브의 본질이 아니다!"
- 원본: "왜냐하면 편집은 핵심 전략이 아니라 실행의 단계이기 때문입니다"
  자막: "편집은 콘텐츠의 핵심 전략이 아닌, 실행의 단계일뿐!"
- 원본: "이게 바로 콘텐츠의 성패를 결정짓는 가장 중요한 변수입니다"
  자막: "콘텐츠 성패, 결정하는 핵심 변수!"
- 원본: "편집은 가장 쉽게 레버리지를 할 수 있는 부분입니다"
  자막: "가장 쉬운 레버리지는 편집"

### 주제 보강형 (emphasis, conclusion) - 주어 추가 + 쉼표
화자가 주어를 생략하면 무엇에 관한 얘긴지 보강하고 쉼표로 분리
- 원본: "잘 전달되게 만드는 데 있습니다"
  자막: "편집의 본질, 잘 전달되게 만드는 것!"
- 원본: "우리가 어디에 시간을 쓰느냐가 더 중요한 거거든요"
  자막: "유튜브 콘텐츠 제작은, 어디에 시간을 쓰느냐가 중요"
- 원본: "내가 실행하기 위해 필요한 영역만큼만 배우는 거예요"
  자막: "끝이 있는 배움, 실행에 필요한 만큼의 배움"

### 구어체 압축 (question, emphasis)
긴 구어체 질문/평서를 짧고 임팩트 있게
- 원본: "내가 말하고 싶은 메시지가 시청자들한테 잘 전달이 되냐?"
  자막: "내 메시지 제대로 전달되나?"
- 원본: "시청자가 원하는 내용을 얼마나 올바르게 전달을 하느냐"
  자막: "시청자가 원하는 내용을 올바르게 전달하기"

### 여운형 (emotion) - ...로 마무리
깨달음/한탄은 "..."로 여운 남기기
- 원본: "이거는 정말 끝이 없는 배움이더라고요"
  자막: "편집 공부는 끝이 없다..."

### 긴 명제 보존형 (conclusion) - 거의 그대로 + 쉼표
핵심 명언/명제는 의역하지 말고 쉼표로 호흡만 나누기
- 원본: "좋은 콘텐츠의 기준은 내가 정하는 게 아니라 시장이 정한다"
  자막: "좋은 콘텐츠의 기준은, 내가 정하는 게 아니라 시장이 정한다"
- 원본: "대부분 그렇지 않습니다"
  자막: "대부분 그렇지 않습니다"  (이미 짧으면 그대로)

### 숫자 보존형 (emphasis) - 비즈니스 수치
"단돈 N만원", "영상 N개" 같은 수치는 그대로 살려 임팩트
- 원본: "그런데 단돈 100만원으로 여러분들이 이 편집 준수한 퀄리티의 편집 영상 10개를 얻을 수가 있습니다"
  자막: "단돈 100만원으로, 편집 영상 10개 얻을 수 있음"

## 길이
- 보통 10~25자가 자연스러움. 의미 살리려고 30자 가까이 가도 OK.
- 너무 짧게 잘라서 핵심이 빠지면 안 됨. 핵심 살리는 게 우선.`;

// 요약 전용 프롬프트 (이미 선별된 포인트를 다듬기만)
function buildPrompt(points) {
  const numbered = points.map((p, i) => {
    const tag = p.ordinal ? `[list, 번호=${p.ordinal}, 필수: "${p.ordinal}. ~"로 시작]` : `[${p.category}]`;
    return `${i + 1}. ${tag} "${p.originalText || p.text}"`;
  }).join('\n');

  return `당신은 유튜브 정보성 영상의 화면 포인트 자막을 만드는 전문가입니다.
영상에서 화자가 한 말을 보고, 영상 위에 띄울 **포인트 자막** 한 줄을 만들어주세요.

${STYLE_GUIDE}

## 출력 형식 (반드시 지킬 것)
- 입력 순서대로 정확히 ${points.length}개
- 한 줄에 하나, **반드시 "<번호>| <자막내용>" 형식**으로 출력
- 인사말/설명/빈줄 절대 금지. 오직 "N| 자막" 줄만 출력.

## 원본 (총 ${points.length}개)
${numbered}

## 포인트 자막 ${points.length}개 (반드시 "1| ...", "2| ..." 형식):`;
}

// AI 선별+요약 프롬프트 (전체 대본에서 포인트감 있는 것 직접 고르기)
function buildSelectionPrompt(segments, count) {
  const list = segments.map((s, i) => {
    const mm = Math.floor(s.start / 60);
    const ss = String(Math.floor(s.start % 60)).padStart(2, '0');
    return `${i}| [${mm}:${ss}] ${s.text}`;
  }).join('\n');

  return `당신은 유튜브 영상의 화면 포인트 자막 전문가입니다.
아래는 영상 대본 전체를 의미 단위로 나눈 세그먼트입니다.
이 중에서 시청자가 화면 강조 자막으로 보면 좋을 **가장 포인트감 있는 ${count}개**를 직접 골라서, 각각 포인트 자막으로 만들어주세요.

## 선별 기준 (매우 중요)
- 핵심 메시지, 질문 후킹, 강조점, 결론, 의미 있는 명제, 번호 나열 항목을 우선 선택
- **인사말, 자기소개, 단순 상황 나레이션, 추임새, 연결어, 맥락 없는 토막은 제외**
- 예시(제외 대상): "오늘 ~ 얘기 하려고요", "촬영하러 갔습니다", "~한 적이 있어요", "안녕하세요 ~입니다"
- **의미가 깊은 문장은 키워드가 없어도 반드시 선택** (예: "편집은 유튜브의 본질이 아니다", "좋은 콘텐츠의 기준은 시장이 정한다")
- "첫 번째/두 번째/세 번째.." 번호 나열 항목은 **반드시 세트로 다 같이** 선택

${STYLE_GUIDE}

## 카테고리 분류 (각 자막마다 하나 지정)
- 질문 : 호기심 유발 질문, 반문 ("~할까?", "~는?")
- 강조 : 핵심 메시지, 단호한 명제 ("~다!", "바로 ~")
- 반전 : 의외성, 통념 뒤집기 ("사실은 아니다", "오히려~")
- 나열 : 번호 항목(1./2./3.), 여러 개 열거
- 감성 : 공감, 여운, 감정 ("끝이 없다...", 깨달음)
- 결론 : 영상 정리, 마무리 한마디

## 출력 형식 (반드시 지킬 것)
- 고른 세그먼트마다 한 줄: **"세그먼트번호| 카테고리| 포인트자막"**
- 카테고리는 위 6개 중 하나(질문/강조/반전/나열/감성/결론)
- 예시: \`5| 강조| 편집은 유튜브의 본질이 아니다!\`, \`12| 질문| 유튜브에서 가장 중요한 건?\`
- 세그먼트번호는 아래 대본 맨 앞 번호 그대로 사용
- 시간순(번호 오름차순)으로 정렬해서 출력
- **정확히 ${count}개 내외**. 단, 진짜 포인트감 있는 게 적으면 더 적게 골라도 됨 (억지로 약한 구간 채우지 말 것)
- 설명/인사/빈줄 금지. 오직 "번호| 카테고리| 자막" 줄만.

## 대본 세그먼트
${list}

## 선별된 포인트 자막 (번호| 카테고리| 자막):`;
}

// 한글 카테고리 → 내부 키 매핑
const CAT_MAP = {
  '질문': 'question', '강조': 'emphasis', '반전': 'surprise',
  '나열': 'list', '감성': 'emotion', '결론': 'conclusion'
};

// 선별 결과 파싱: "세그먼트번호| 카테고리| 자막" → [{segIndex, category, text}]
function parseSelectionResult(result) {
  const lines = result.split('\n').map(l => l.trim()).filter(Boolean);
  const picks = [];
  for (const l of lines) {
    // "번호| 카테고리| 자막" (3필드) 또는 "번호| 자막" (2필드, 카테고리 누락 대비)
    let m = l.match(/^(\d+)\s*[|│｜:]\s*([가-힣]{2})\s*[|│｜:]\s*(.+)$/);
    if (m) {
      const segIndex = parseInt(m[1], 10);
      const category = CAT_MAP[m[2]] || 'emphasis';
      let text = m[3].trim().replace(/^["'`]|["'`]$/g, '').replace(/�/g, '').trim();
      if (text) picks.push({ segIndex, category, text });
      continue;
    }
    // 카테고리 누락한 2필드 형식 fallback
    m = l.match(/^(\d+)\s*[|│｜:]\s*(.+)$/);
    if (m) {
      const segIndex = parseInt(m[1], 10);
      let text = m[2].trim().replace(/^["'`]|["'`]$/g, '').replace(/�/g, '').trim();
      if (text) picks.push({ segIndex, category: null, text });
    }
  }
  return picks;
}

function parseAIResult(result, expectedCount) {
  // "N| 자막" 형식 강제 파싱 — 인덱스 누락/순서 어긋남 방지
  const lines = result.split('\n').map(l => l.trim()).filter(Boolean);
  const indexed = {}; // {1: "자막", 2: "자막", ...}
  const looseFallback = []; // 형식 안 맞는 줄들 (백업용)

  for (const l of lines) {
    const m = l.match(/^(\d+)\s*[|│｜:]\s*(.+)$/);
    if (m) {
      const idx = parseInt(m[1], 10);
      let text = m[2].trim().replace(/^["'`]|["'`]$/g, '');
      if (text) indexed[idx] = text;
    } else if (!/^[#*\-=]/.test(l) && !/포인트|자막|결과|다음과|아래|위의/.test(l)) {
      // 해설/제목으로 보이지 않는 일반 텍스트만 백업으로 저장
      looseFallback.push(l.replace(/^[\d]+[.)\s|-]+/, '').replace(/^["'`]|["'`]$/g, '').trim());
    }
  }

  // expectedCount 만큼 순서대로 채움. indexed[i+1]이 있으면 사용, 없으면 fallback에서 가져옴
  const result_arr = [];
  let fallbackIdx = 0;
  for (let i = 1; i <= (expectedCount || Object.keys(indexed).length); i++) {
    if (indexed[i]) {
      result_arr.push(indexed[i]);
    } else if (fallbackIdx < looseFallback.length) {
      result_arr.push(looseFallback[fallbackIdx++]);
    } else {
      result_arr.push(''); // 빈 자리 (호출자가 fallback 처리)
    }
  }
  return result_arr;
}

async function summarizeByAI(points, apiKey, model, provider = 'gemini') {
  const prompt = buildPrompt(points);
  let result;
  if (provider === 'claude') {
    result = await callClaude(apiKey, prompt, model || 'claude-sonnet-4-5');
  } else {
    result = await callGemini(apiKey, prompt, model || 'gemini-2.5-flash');
  }
  return parseAIResult(result, points.length);
}

/**
 * 메인 요약 함수
 */
async function summarizePoints(points) {
  const config = loadAIConfig();

  // 규칙 기반 (기본)
  if (config.provider === 'rule' || !config.apiKey) {
    return points.map(p => ({
      ...p,
      text: summarizeByRule(p.text, p.category, p.originalText)
    }));
  }

  // AI 사용 (Gemini 또는 Claude)
  if ((config.provider === 'gemini' || config.provider === 'claude') && config.apiKey) {
    try {
      const summaries = await summarizeByAI(points, config.apiKey, config.model, config.provider);
      return points.map((p, i) => {
        let text = (summaries[i] && summaries[i].trim()) ? summaries[i].trim() : summarizeByRule(p.text, p.category, p.originalText);
        // 깨진 문자(U+FFFD) 제거
        text = text.replace(/�/g, '').trim();
        if (!text) text = summarizeByRule(p.text, p.category, p.originalText);
        // ordinal 안전망: 번호가 있으면 반드시 "N. ~"으로 시작하게 강제
        if (p.ordinal && p.ordinal > 0) {
          const ordPattern = new RegExp(`^\\s*${p.ordinal}[.)]`);
          if (!ordPattern.test(text)) {
            // 다른 번호/접두사 제거하고 올바른 번호 prepend
            text = text.replace(/^\s*\d+[.)]\s*/, '');
            text = `${p.ordinal}. ${text.trim()}`;
          }
        }
        return { ...p, text };
      });
    } catch (e) {
      console.error(`[summarize] ${config.provider} 실패, 규칙 기반으로 fallback:`, e.message);
      // 크레딧 부족 / 키 오류 등은 사용자에게 알려야 함
      let warning = null;
      const msg = e.message || '';
      if (/credit balance is too low/i.test(msg)) {
        warning = `⚠️ ${config.provider === 'claude' ? 'Claude' : 'Gemini'} API 크레딧이 소진됐어요! 규칙 기반(저품질)으로 대체 생성됨. 크레딧 충전 또는 다른 AI로 전환 필요.`;
      } else if (/api key|invalid|unauthorized|authentication/i.test(msg)) {
        warning = `⚠️ API 키 오류: ${msg}. 규칙 기반으로 대체됨. AI 설정에서 키 확인 필요.`;
      } else if (/quota|rate limit|429/i.test(msg)) {
        warning = `⚠️ API 사용량 한도 초과. 잠시 후 다시 시도하거나 다른 AI로 전환하세요.`;
      } else {
        warning = `⚠️ AI 요약 실패 (${msg}). 규칙 기반으로 대체됨.`;
      }
      const fallback = points.map(p => ({
        ...p,
        text: summarizeByRule(p.text, p.category, p.originalText)
      }));
      fallback._aiWarning = warning; // 배열에 경고 첨부
      return fallback;
    }
  }

  return points;
}

// AI 실패 경고 메시지 생성
function buildAIWarning(provider, msg) {
  msg = msg || '';
  if (/credit balance is too low/i.test(msg)) {
    return `⚠️ ${provider === 'claude' ? 'Claude' : 'Gemini'} API 크레딧이 소진됐어요! 규칙 기반(저품질)으로 대체됨. 크레딧 충전 또는 다른 AI로 전환 필요.`;
  } else if (/api key|invalid|unauthorized|authentication/i.test(msg)) {
    return `⚠️ API 키 오류: ${msg}. 규칙 기반으로 대체됨. AI 설정에서 키 확인 필요.`;
  } else if (/quota|rate limit|429/i.test(msg)) {
    return `⚠️ API 사용량 한도 초과. 잠시 후 다시 시도하거나 다른 AI로 전환하세요.`;
  }
  return `⚠️ AI 요약 실패 (${msg}). 규칙 기반으로 대체됨.`;
}

/**
 * AI가 전체 대본에서 직접 포인트 자막을 선별 + 요약
 * @param {Array} captions - 원본 캡션 [{start, end, text}]
 * @param {number} count - 목표 개수
 * @param {object} opts - { excludeRanges: [{start,end}], seed }
 */
async function selectAndSummarizePoints(captions, count, opts = {}) {
  const pointAnalyzer = require('./point-analyzer-pro.js');
  const config = loadAIConfig();
  const { excludeRanges = [] } = opts;

  // 1. 캡션 병합 (의미 단위)
  let segments = pointAnalyzer.mergeShortCaptions(captions);

  // 2. 명백한 정크 제거 (인사/추임새/초단문)
  segments = segments.filter(s => !pointAnalyzer.isJunk(s.text));

  // 3. excludeRanges(핀 유지)와 겹치는 세그먼트 제외
  if (excludeRanges.length > 0) {
    segments = segments.filter(seg =>
      !excludeRanges.some(r => seg.start < r.end && seg.end > r.start)
    );
  }

  if (segments.length === 0) return [];

  // AI 미사용 시 → 기존 규칙 기반으로 fallback
  const useAI = (config.provider === 'gemini' || config.provider === 'claude') && config.apiKey;
  if (!useAI) {
    const pts = pointAnalyzer.extractPoints(captions, count, opts.seed);
    return summarizePoints(pts);
  }

  // 4. AI 선별 + 요약
  try {
    const prompt = buildSelectionPrompt(segments, count);
    let raw;
    if (config.provider === 'claude') {
      raw = await callClaude(config.apiKey, prompt, config.model || 'claude-sonnet-4-5');
    } else {
      raw = await callGemini(config.apiKey, prompt, config.model || 'gemini-2.5-flash');
    }
    const picks = parseSelectionResult(raw);
    if (picks.length === 0) throw new Error('AI 선별 결과 파싱 실패 (빈 결과)');

    // 5. segIndex → 세그먼트 매핑, 포인트 객체 생성
    const points = [];
    const seenTexts = []; // 중복 제거용
    for (const pick of picks) {
      const seg = segments[pick.segIndex];
      if (!seg) continue;
      let text = pick.text;
      const ord = pointAnalyzer.detectOrdinal(seg.text);

      if (ord && ord > 0) {
        // 원문에 진짜 서수가 있으면 → 올바른 번호 강제
        const ordPattern = new RegExp(`^\\s*${ord}[.)]`);
        if (!ordPattern.test(text)) {
          text = text.replace(/^\s*\d+[.)]\s*/, '');
          text = `${ord}. ${text.trim()}`;
        }
      } else {
        // 원문에 서수가 없으면 → AI가 멋대로 붙인 "N." 제거 (뜬금없는 번호 방지)
        text = text.replace(/^\s*\d+[.)]\s*/, '');
      }

      // 중복 제거: 자막 텍스트나 원문이 거의 같으면 스킵
      const norm = text.replace(/\s+/g, '').replace(/[?!.,]/g, '');
      const isDup = seenTexts.some(prev => {
        if (prev === norm) return true;
        // 앞 12자 일치하면 중복 취급
        const a = prev.substring(0, 12), b = norm.substring(0, 12);
        return a.length >= 8 && a === b;
      });
      if (isDup) continue;
      seenTexts.push(norm);

      let category = pick.category || 'emphasis';
      if (ord && ord > 0) category = 'list';
      points.push({
        start: seg.start,
        end: seg.end,
        text,
        originalText: seg.text,
        category,
        ordinal: (ord && ord > 0) ? ord : undefined,
      });
    }
    // 시간순 정렬
    points.sort((a, b) => a.start - b.start);
    return points;
  } catch (e) {
    console.error(`[selectAndSummarize] ${config.provider} 실패, 규칙 기반 fallback:`, e.message);
    const pts = pointAnalyzer.extractPoints(captions, count, opts.seed);
    const fallback = pts.map(p => ({ ...p, text: summarizeByRule(p.text, p.category, p.originalText) }));
    fallback._aiWarning = buildAIWarning(config.provider, e.message);
    return fallback;
  }
}

module.exports = {
  summarizePoints,
  selectAndSummarizePoints,
  summarizeByRule,
  summarizeByAI,
  loadAIConfig,
  saveAIConfig,
  callGemini,
  callClaude,
};
