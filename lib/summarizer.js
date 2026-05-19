// 포인트 자막 요약 엔진
// 1. 규칙 기반 (무료, 즉시 동작) - 한국어 패턴 분석
// 2. AI 기반 (Gemini API, 무료) - 더 자연스러운 요약

const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'ai-config.json');

// ============================================
// AI 설정 관리
// ============================================
function loadAIConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { provider: 'rule', apiKey: '', model: 'gemini-2.5-flash' };
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    return { provider: 'rule', apiKey: '', model: 'gemini-2.5-flash' };
  }
}

function saveAIConfig(config) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
  let t = extractKeyPhrase(text);
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

function buildPrompt(points) {
  const numbered = points.map((p, i) => {
    const tag = p.ordinal ? `[list, 번호=${p.ordinal}, 필수: "${p.ordinal}. ~"로 시작]` : `[${p.category}]`;
    return `${i + 1}. ${tag} "${p.originalText || p.text}"`;
  }).join('\n');

  return `당신은 유튜브 정보성 영상의 화면 포인트 자막을 만드는 전문가입니다.
영상에서 화자가 한 말을 보고, 영상 위에 띄울 **포인트 자막** 한 줄을 만들어주세요.

## 절대 원칙 (어기면 안 됨)
1. **화살표(→) 사용 금지**. "A → B" 같은 도식 절대 NO. (단 "A + B = C" 같은 등식 + 합 표기는 OK)
2. **AI 티 나는 패턴 금지**: "A, B, C 변화", "~의 진실", "~의 비밀" 클리셰 NO.
3. **원본의 핵심 구절을 최대한 살려서** 자연스럽게 다듬기. 너무 의역하지 말 것.
4. 한국어 입말 그대로. "~할까?", "~네요", "~인 것 같다" 등 사람이 쓰는 톤 유지.
5. **태그에 "번호=N"이 있으면 반드시 "N. ~" 형식으로 출력**. 절대 누락 금지. 예: 번호=2 → "2. 두통과 어지러움"
6. **상품명/브랜드명/고유명사 절대 의역 X**. "센서티 3", "Pretendard", "호야렌즈" 그대로 보존.
7. **숫자는 그대로 살리고 "UP!", "배", "%", 단위로 임팩트**. 예: "2배 UP!", "30% 유지", "3배"
8. **!!, "" 자유롭게 사용 OK**. 강조 필요하면 느낌표 2개도 가능, 핵심 키워드 따옴표 감싸기도 가능.
9. **원본이 이미 짧고 좋으면 거의 그대로** 두기. 강제로 손대지 말 것.

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

## 길이
- 보통 10~25자가 자연스러움. 의미 살리려고 30자 가까이 가도 OK.
- 너무 짧게 잘라서 핵심이 빠지면 안 됨. 핵심 살리는 게 우선.

## 출력 형식 (반드시 지킬 것)
- 입력 순서대로 정확히 ${points.length}개
- 한 줄에 하나, **반드시 "<번호>| <자막내용>" 형식**으로 출력
- 예시: \`1| 도수 낮춰 쓰면 좋다고?\`, \`2| 1. 눈의 피로\`, \`3| 결론, 정확한 도수!\`
- 인사말/설명/빈줄/요약 절대 추가 금지. 오직 "N| 자막" 줄만 출력.

## 원본 (총 ${points.length}개)
${numbered}

## 포인트 자막 ${points.length}개 (반드시 "1| ...", "2| ..." 형식):`;
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
        // ordinal 안전망: 번호가 있는데 "N." 으로 시작하지 않으면 강제 추가
        if (p.ordinal && p.ordinal > 0) {
          const ordPattern = new RegExp(`^\\s*${p.ordinal}[.)]`);
          if (!ordPattern.test(text)) {
            text = text.replace(/^\s*\d+[.)]\s*/, '');
            text = `${p.ordinal}. ${text.trim()}`;
          }
        }
        return { ...p, text };
      });
    } catch (e) {
      console.error(`[summarize] ${config.provider} 실패, 규칙 기반으로 fallback:`, e.message);
      return points.map(p => ({
        ...p,
        text: summarizeByRule(p.text, p.category, p.originalText)
      }));
    }
  }

  return points;
}

module.exports = {
  summarizePoints,
  summarizeByRule,
  summarizeByAI,
  loadAIConfig,
  saveAIConfig,
  callGemini,
  callClaude,
};
