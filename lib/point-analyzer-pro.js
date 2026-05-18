// 강화된 포인트 자막 분석 엔진 (Pro 버전)
// 키워드 + 패턴 + 문맥 + 위치 가중치를 종합적으로 분석

// ============================================
// 카테고리별 키워드 (가중치 포함)
// ============================================
const CATEGORY_KEYWORDS = {
  question: {
    high:   ['까요?', '인가요?', '있나요?', '뭘까요', '왜 그럴까', '뭘까', '뭐길래', '얼마나'],
    mid:    ['혹시', '궁금', '아시나요', '아세요', '어떻게', '어디', '뭐예요', '뭐야'],
    low:    ['?', '왜', '뭐', '어떤']
  },
  emphasis: {
    high:   ['가장 중요', '핵심은', '진짜 중요', '제일 중요', '꼭 알아', '반드시', '절대로'],
    mid:    ['중요', '핵심', '꼭', '반드시', '절대', '가장', '최고', '최대', '제일', '특히', '바로'],
    low:    ['진짜', '정말', '아주', '매우']
  },
  surprise: {
    high:   ['놀랍게도', '의외로', '뜻밖에', '사실은 아니', '오히려 반대', '믿기 어려운'],
    mid:    ['오히려', '사실은', '그런데', '하지만', '근데', '실은'],
    low:    ['대박', '헐', '와', '아니', '음']
  },
  list: {
    high:   ['첫 번째는', '두 번째는', '세 번째는', '첫째로', '둘째로', '셋째로'],
    mid:    ['첫째', '둘째', '셋째', '하나는', '둘은', '먼저는', '다음은', '마지막은'],
    low:    ['그리고', '또한', '그다음', '또']
  },
  emotion: {
    high:   ['진심으로 감사', '정말 미안', '너무 슬프', '너무 행복', '진짜 사랑'],
    mid:    ['감사', '미안', '죄송', '행복', '슬픔', '기쁨', '감동', '아쉬움', '소중', '사랑'],
    low:    ['고마', '아끼']
  },
  conclusion: {
    high:   ['결론부터', '결론은', '정리하면', '요약하면', '한마디로', '결국에는'],
    mid:    ['결론', '정리', '요약', '마지막으로', '끝으로', '그래서', '따라서', '즉'],
    low:    ['이렇게', '그러므로']
  }
};

// ============================================
// 강한 패턴 (정규식, 큰 점수)
// ============================================
const STRONG_PATTERNS = [
  // 결론/정답 표현
  { pattern: /정답[은이]/, score: 25, category: 'conclusion' },
  { pattern: /결론[은부터]/, score: 25, category: 'conclusion' },
  { pattern: /해결책[은이]/, score: 22, category: 'conclusion' },

  // 강조 패턴
  { pattern: /가장 [중요크좋효]/, score: 22, category: 'emphasis' },
  { pattern: /진짜 [중요필]/, score: 18, category: 'emphasis' },
  { pattern: /절대 (?:안|못|하지)/, score: 18, category: 'emphasis' },

  // 숫자/통계
  { pattern: /\d{2,}[%]/, score: 18, category: 'emphasis' },        // 70% 이상
  { pattern: /\d+[배]/, score: 15, category: 'emphasis' },          // 3배
  { pattern: /\d+개[월년시간일분초]/, score: 12, category: 'emphasis' },

  // 질문
  { pattern: /[까]요\?$/, score: 18, category: 'question' },
  { pattern: /\?$/, score: 12, category: 'question' },

  // 반전
  { pattern: /^(?:그런데|하지만|오히려|사실은)/, score: 15, category: 'surprise' },

  // 나열
  { pattern: /^(?:첫째|둘째|셋째|넷째)/, score: 18, category: 'list' },
  { pattern: /\d+번째[는로]/, score: 15, category: 'list' },
];

// ============================================
// 무의미한 발화 (제외)
// ============================================
const SKIP_PATTERNS = [
  /^(?:어|음|아|뭐|그|저|오|에)+\.?$/,
  /^(?:네|예|응|아니요|맞아요)\.?$/,
  /^(?:안녕하세요|반갑습니다|감사합니다|고맙습니다)\.?$/,  // 인사말은 보통 포인트 X
];

// ============================================
// 텍스트 점수 계산
// ============================================
function scoreText(text, position, totalCount) {
  const t = text.trim();
  if (!t || t.length < 5) return { score: 0, category: 'emphasis' };
  if (t.length > 80) return { score: 0, category: 'emphasis' };

  // 무의미 발화 제외
  for (const p of SKIP_PATTERNS) {
    if (p.test(t)) return { score: 0, category: 'emphasis' };
  }

  let score = 0;
  const catScores = {};
  for (const cat of Object.keys(CATEGORY_KEYWORDS)) catScores[cat] = 0;

  // 1. 카테고리별 키워드 점수
  for (const [cat, levels] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of levels.high) if (t.includes(kw)) catScores[cat] += 18;
    for (const kw of levels.mid) if (t.includes(kw)) catScores[cat] += 10;
    for (const kw of levels.low) if (t.includes(kw)) catScores[cat] += 4;
  }

  // 2. 강한 패턴 매칭
  for (const { pattern, score: ps, category } of STRONG_PATTERNS) {
    if (pattern.test(t)) {
      catScores[category] += ps;
    }
  }

  // 3. 가장 높은 카테고리 선택
  let maxCat = 'emphasis', maxCatScore = 0;
  for (const [cat, s] of Object.entries(catScores)) {
    if (s > maxCatScore) { maxCatScore = s; maxCat = cat; }
  }
  score = maxCatScore;
  let category = maxCatScore > 0 ? maxCat : 'emphasis';

  // 4. 위치 가중치
  const positionRatio = position / Math.max(1, totalCount - 1);
  if (positionRatio < 0.05) score += 12;       // 인트로 강조
  else if (positionRatio < 0.15) score += 6;
  if (positionRatio > 0.9) {
    score += 12;                                // 아웃트로 강조
    if (category === 'emphasis' && score > 25) category = 'conclusion';
  }

  // 5. 길이 보너스 (15-40자가 황금 길이)
  if (t.length >= 15 && t.length <= 40) score += 10;
  else if (t.length >= 10 && t.length <= 50) score += 5;

  // 6. 특수 문자 보너스
  if (t.endsWith('?')) { score += 8; if (category !== 'question') category = 'question'; }
  if (t.endsWith('!')) { score += 6; }

  return { score, category };
}

// ============================================
// 짧은 자막 의미 단위로 합치기
// ============================================
function mergeShortCaptions(captions, maxLen = 60) {
  const result = [];
  let buffer = null;

  for (const c of captions) {
    const text = c.text.trim();
    if (!text) continue;

    if (!buffer) {
      buffer = { ...c, text };
      continue;
    }

    const buffEnds = /[.?!]\s*$/.test(buffer.text);
    const gapTooLarge = (c.start - buffer.end) > 1.5;
    const tooLong = (buffer.text + ' ' + text).length > maxLen;

    if (!buffEnds && !gapTooLarge && !tooLong && buffer.text.length < 30) {
      buffer.text = buffer.text + ' ' + text;
      buffer.end = c.end;
    } else {
      result.push(buffer);
      buffer = { ...c, text };
    }
  }
  if (buffer) result.push(buffer);
  return result;
}

// ============================================
// 텍스트 정제 (포인트 자막용)
// ============================================
function refineText(text, category) {
  let t = text.trim();

  // 너무 길면 줄이기 (최대 35자)
  if (t.length > 35) {
    // 첫 의미단위 또는 마지막 의미단위 사용
    const sentences = t.split(/[.,]/).map(s => s.trim()).filter(Boolean);
    if (sentences.length > 1) {
      // 가장 긴 의미단위 선택
      sentences.sort((a, b) => b.length - a.length);
      t = sentences[0];
    }
    if (t.length > 35) {
      t = t.substring(0, 33) + '..';
    }
  }

  // 끝에 마침표 정리
  t = t.replace(/\.+$/, '');

  return t;
}

// ============================================
// 시간 분포 균형 - 영상 전체에 골고루 분배 (랜덤성 추가)
// ============================================
function balanceDistribution(scoredItems, count, totalDuration, seed = 0) {
  // 각 버킷 후보 풀을 키워서 더 다양한 결과
  const buckets = Math.min(count * 2, scoredItems.length);
  const bucketDur = totalDuration / buckets;
  const bucketCandidates = {};

  // 시드 기반 의사난수 (deterministic 하지만 seed에 따라 다름)
  function rand(input) {
    const x = Math.sin(input * 9999 + seed * 7919) * 10000;
    return x - Math.floor(x);
  }

  // 각 버킷에 모든 후보 모으기
  scoredItems.forEach(item => {
    const bucketIdx = Math.floor(item.start / bucketDur);
    if (!bucketCandidates[bucketIdx]) bucketCandidates[bucketIdx] = [];
    // 점수에 큰 노이즈 (-15 ~ +15)
    const noise = (rand(item.start) - 0.5) * 30;
    bucketCandidates[bucketIdx].push({ ...item, _adjScore: item.score + noise });
  });

  // 각 버킷에서 점수 + 노이즈 기준 1등 선택 (매번 다른 1등)
  const winners = [];
  for (const bucketIdx in bucketCandidates) {
    const sorted = bucketCandidates[bucketIdx].sort((a, b) => b._adjScore - a._adjScore);
    winners.push(sorted[0]);
  }

  // 상위 count개 + 시간 정렬
  return winners.sort((a, b) => b._adjScore - a._adjScore)
    .slice(0, count)
    .sort((a, b) => a.start - b.start);
}

// ============================================
// 한국어 서수 감지 ("첫 번째" / "두 번째" / "마지막" 등 → 숫자)
// ============================================
const ORDINAL_MAP = {
  '첫 번째': 1, '첫번째': 1, '첫째': 1, '하나는': 1, '먼저는': 1, '먼저': 1,
  '두 번째': 2, '두번째': 2, '둘째': 2, '두 번재': 2, '두번재': 2,
  '세 번째': 3, '세번째': 3, '셋째': 3, '세 번재': 3, '세번재': 3,
  '네 번째': 4, '네번째': 4, '넷째': 4, '네 번재': 4, '네번재': 4,
  '다섯 번째': 5, '다섯번째': 5, '다섯째': 5,
  '여섯 번째': 6, '여섯번째': 6, '여섯째': 6,
  '일곱 번째': 7, '일곱번째': 7, '일곱째': 7,
};
function detectOrdinal(text) {
  if (!text) return null;
  const t = text.trim();
  // "자 첫 번째는", "그리고 두 번째는" 같이 앞에 부사가 있어도 매칭
  for (const [key, num] of Object.entries(ORDINAL_MAP)) {
    // 텍스트 앞 20자 이내에서 키워드 시작
    const idx = t.indexOf(key);
    if (idx >= 0 && idx < 20) return num;
  }
  // 마지막은 별도로 처리 (시리즈 끝)
  if (/^(?:자 )?마지막(?:으로|은| )/.test(t)) return -1; // 시리즈의 끝 표시
  return null;
}

// ============================================
// 시리즈(번호 나열) 묶기 - 한 번 뽑히면 형제도 같이
// ============================================
function bundleNumberedSeries(scoredItems, selectedItems) {
  // 각 아이템에 ordinal 부여
  scoredItems.forEach(s => { s._ordinal = detectOrdinal(s.text); });
  selectedItems.forEach(s => { s._ordinal = detectOrdinal(s.text); });

  // 선택된 것 중 ordinal 있는 게 있나?
  const selectedOrdinals = selectedItems.filter(s => s._ordinal !== null);
  if (selectedOrdinals.length === 0) return selectedItems;

  // 가까운 시간대(60초 이내)의 ordinal 시리즈 클러스터 찾기
  const clusters = []; // [{items: [...], startTime, endTime}]
  for (const ord of selectedOrdinals) {
    // 이 ordinal이 속한 클러스터 찾기 (start ±90초 내 ordinal 모음)
    const cluster = scoredItems.filter(s =>
      s._ordinal !== null &&
      Math.abs(s.start - ord.start) < 120
    );
    if (cluster.length > 1) clusters.push(cluster);
  }

  // 클러스터 멤버를 selected에 추가 (중복 제거)
  const result = [...selectedItems];
  const seen = new Set(result.map(r => `${r.start}_${r.end}`));
  for (const cluster of clusters) {
    for (const item of cluster) {
      const k = `${item.start}_${item.end}`;
      if (!seen.has(k)) {
        result.push(item);
        seen.add(k);
      }
    }
  }
  return result.sort((a, b) => a.start - b.start);
}

// ============================================
// 메인 추출 함수
// ============================================
function extractPoints(captions, count = 13, seed = null) {
  if (!captions || captions.length === 0) return [];

  // 매번 다른 결과 위해 seed 사용 (없으면 랜덤)
  const actualSeed = seed !== null ? seed : Math.random() * 1000;

  const merged = mergeShortCaptions(captions);
  const scored = merged.map((c, i) => {
    const { score, category } = scoreText(c.text, i, merged.length);
    return { ...c, score, category, originalText: c.text };
  });

  const filtered = scored.filter(s => s.score >= 8);
  if (filtered.length === 0) return [];

  const totalDuration = merged[merged.length - 1].end;
  let selected = balanceDistribution(filtered, count, totalDuration, actualSeed);

  // 번호 나열 시리즈(첫번째/두번째/...) 묶기 - 한 번 뽑히면 형제도 같이
  selected = bundleNumberedSeries(filtered, selected);

  // ordinal=-1(마지막) 항목은 같은 클러스터의 최대 ordinal+1로 추론
  const ordinalsByTime = selected.filter(s => s._ordinal && s._ordinal > 0).sort((a, b) => a.start - b.start);
  selected.forEach(s => {
    if (s._ordinal === -1) {
      // 가까운(120초 내) 가장 큰 ordinal + 1
      const near = ordinalsByTime.filter(o => Math.abs(o.start - s.start) < 120);
      if (near.length > 0) {
        s._ordinal = Math.max(...near.map(o => o._ordinal)) + 1;
      } else {
        s._ordinal = null;
      }
    }
  });

  return selected.map(p => ({
    start: p.start,
    end: p.end,
    text: refineText(p.text, p.category),
    originalText: p.originalText,
    category: (p._ordinal && p._ordinal > 0) ? 'list' : p.category,
    score: Math.round(p.score),
    ordinal: (p._ordinal && p._ordinal > 0) ? p._ordinal : undefined,
  }));
}

module.exports = { extractPoints, scoreText, CATEGORY_KEYWORDS };
