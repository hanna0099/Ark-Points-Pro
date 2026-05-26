// Premiere Points Pro - Frontend
// Vrew SRT → 포인트 자막 + 효과음 → PP 정확 반영

// ============================================
// 전역 상태
// ============================================
let currentSrt = null;
let captions = [];
let pointsData = [];
let pinnedPoints = new Set(); // 사용자가 "유지"로 찍은 포인트의 (start,end) 키
let pointsWithSounds = [];
let undoStack = []; // 포인트 자막 변경 이력 (Ctrl+Z용)
const UNDO_LIMIT = 30;
let currentRules = null;
let availableSounds = [];
let currentStep = 1;

const CATEGORY_LABELS = {
  question: '❓ 질문/호기심',
  emphasis: '🎯 핵심 강조',
  surprise: '💥 놀라움/반전',
  list: '📋 정보 나열',
  emotion: '💗 감성/공감',
  conclusion: '📣 마무리/결론'
};

// ============================================
// 유틸
// ============================================
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
function fmtTime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60),
        sec = Math.floor(s % 60), ms = Math.round((s % 1) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}
function parseTime(str) {
  const m = String(str).match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return parseInt(m[1])*3600 + parseInt(m[2])*60 + parseInt(m[3]) + parseInt(m[4])/1000;
}
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  setTimeout(() => el.className = 'toast', 3000);
}

// ============================================
// 단계 관리
// ============================================
function goToStep(n) {
  if (n === 2 && captions.length === 0) { toast('SRT를 먼저 선택하세요', 'error'); return; }
  if (n === 3 && pointsData.length === 0) { toast('포인트 자막 먼저 생성하세요', 'error'); return; }
  if (n === 4 && pointsWithSounds.length === 0) { toast('효과음 매칭 먼저 하세요', 'error'); return; }

  currentStep = n;
  // 페이지 표시
  for (let i = 1; i <= 4; i++) {
    const p = document.getElementById(`page-${i}`);
    if (p) p.style.display = i === n ? 'block' : 'none';
  }
  // 단계 표시 업데이트
  for (let i = 1; i <= 4; i++) {
    const s = document.getElementById(`step${i}`);
    if (!s) continue;
    s.classList.remove('active', 'done');
    if (i === n) s.classList.add('active');
    else if (i < n) s.classList.add('done');
  }
  // 홈 버튼
  const homeBtn = document.getElementById('home-btn');
  if (n === 1) homeBtn.classList.add('hidden');
  else homeBtn.classList.remove('hidden');

  // 페이지 진입 시 자동 동작
  if (n === 2) {
    // AI 상태 배너 업데이트 (현재 provider 기준)
    fetch('/api/ai-config').then(r => r.json()).then(r => {
      const active = (r.config.provider === 'gemini' || r.config.provider === 'claude') && r.hasKey;
      updateAIBanner(active ? r.config.provider : 'rule');
    });
    // 자동 생성 X — 사용자가 AI/개수 설정 후 "생성하기" 직접 클릭
    if (pointsData.length === 0) renderPointsEmptyState();
  }
  if (n === 3) {
    if (!currentRules) loadSoundRules();
    if (pointsWithSounds.length === 0) rematchSounds();
  }
  if (n === 4) { renderApplySummary(); refreshSequences(); }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goHome() {
  if (captions.length > 0 && !confirm('처음으로 돌아가시겠어요? (저장되지 않은 변경 사항이 있을 수 있어요)')) return;
  captions = []; pointsData = []; pointsWithSounds = [];
  pinnedPoints = new Set();
  undoStack = [];
  currentSrt = null;
  document.getElementById('srt-list').innerHTML = '';
  goToStep(1);
}

// ============================================
// 상태 폴링
// ============================================
async function checkStatus() {
  try {
    const r = await fetch('/api/status').then(r => r.json());
    const dot = document.getElementById('dot');
    const txt = document.getElementById('status-text');
    if (r.connected) {
      dot.className = 'dot connected';
      txt.textContent = `${r.project || ''} - ${r.sequence || ''}`;
    } else {
      dot.className = 'dot disconnected';
      txt.textContent = 'PP 연결 끊김 - MCP Bridge 확인';
    }
  } catch (e) {
    document.getElementById('dot').className = 'dot disconnected';
    document.getElementById('status-text').textContent = '서버 오류';
  }
}
setInterval(checkStatus, 5000);
checkStatus();

// ============================================
// 1단계: SRT 자동 감지
// ============================================
async function detectSrt() {
  toast('PP 프로젝트 검색 중...');
  try {
    const r = await fetch('/api/detect-srt').then(r => r.json());
    const list = document.getElementById('srt-list');

    // path 없는 항목 필터 + 중복 제거
    const validSrts = (r.srtFiles || [])
      .filter(f => f && f.path && typeof f.path === 'string' && f.path.length > 0);
    const seen = new Set();
    const uniqueSrts = validSrts.filter(f => {
      if (seen.has(f.path)) return false;
      seen.add(f.path);
      return true;
    });

    if (uniqueSrts.length === 0) {
      list.innerHTML = '<div class="hint">📭 SRT 파일이 없어요. Vrew에서 SRT를 다운받아 PP 프로젝트에 임포트한 다음 다시 시도하세요.</div>';
      return;
    }

    list.innerHTML = uniqueSrts.map(f => {
      const safePath = f.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const name = f.name || f.path.split(/[\\/]/).pop();
      return `
        <div class="srt-item" onclick="loadSrt('${safePath}')">
          <div>
            <div class="name">📄 ${escapeHtml(name)}</div>
            <div class="path">${escapeHtml(f.path)}</div>
          </div>
          <div class="arrow">선택 →</div>
        </div>
      `;
    }).join('');
  } catch (e) {
    toast('감지 실패: ' + e.message, 'error');
  }
}

async function loadSrt(srtPath) {
  toast('SRT 로딩 중...');
  try {
    const r = await fetch('/api/load-srt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: srtPath })
    }).then(r => r.json());
    if (r.error) { toast(r.error, 'error'); return; }

    captions = r.captions;
    currentSrt = r.path;
    pointsData = []; // 초기화
    pointsWithSounds = [];

    document.getElementById('srt-info').textContent =
      `📄 ${currentSrt.split(/[\\/]/).pop()} (${captions.length}개 자막, ${(r.duration / 60).toFixed(1)}분)`;

    // 추천 개수 자동 설정 + 안내 메시지
    if (r.suggestedCount && r.suggestedCount > 0) {
      const input = document.getElementById('point-count');
      input.value = r.suggestedCount;
      const hint = document.getElementById('count-hint');
      if (hint) {
        hint.innerHTML = `🤖 이 영상에서 포인트로 쓸만한 구간 약 <b style="color:#6a4ce0">${r.suggestedCount}개</b> 발견! (필요 시 직접 조정 가능)`;
      }
    }

    toast(`자막 ${captions.length}개 로드됨! 포인트 후보 ${r.suggestedCount || '?'}개 추정`, 'success');
    goToStep(2);
    renderTranscript();
  } catch (e) {
    toast('로드 실패: ' + e.message, 'error');
  }
}

// ============================================
// AI 설정 패널
// ============================================
let aiSettingsOpen = false;
async function toggleAISettings() {
  aiSettingsOpen = !aiSettingsOpen;
  const panel = document.getElementById('ai-settings-panel');
  panel.style.display = aiSettingsOpen ? 'block' : 'none';
  if (aiSettingsOpen) await loadAISettings();
}

async function loadAISettings() {
  try {
    const r = await fetch('/api/ai-config').then(r => r.json());
    const provider = r.config.provider || 'rule';
    document.querySelector(`input[value="${provider}"]`).checked = true;
    updateKeyRowUI(provider);
    if (r.hasKey && r.config.apiKey) {
      document.getElementById('ai-api-key').placeholder = r.config.apiKey + ' (저장됨)';
    }
  } catch (e) {}
}

function updateKeyRowUI(provider) {
  const row = document.getElementById('ai-key-row');
  const label = document.getElementById('ai-key-label');
  const input = document.getElementById('ai-api-key');
  if (provider === 'rule') { row.style.display = 'none'; return; }
  row.style.display = 'flex';
  if (provider === 'gemini') {
    label.innerHTML = 'Gemini API 키: <input type="password" id="ai-api-key" placeholder="AIza...">';
  } else if (provider === 'claude') {
    label.innerHTML = 'Claude API 키: <input type="password" id="ai-api-key" placeholder="sk-ant-...">';
  }
}

document.addEventListener('change', (e) => {
  if (e.target.name === 'ai-provider') {
    updateKeyRowUI(e.target.value);
  }
});

async function testAI() {
  const apiKey = document.getElementById('ai-api-key').value;
  if (!apiKey) { toast('API 키를 입력해주세요', 'error'); return; }
  const provider = document.querySelector('input[name="ai-provider"]:checked')?.value || 'gemini';
  const providerName = provider === 'claude' ? 'Claude' : 'Gemini';
  toast(`${providerName} API 테스트 중...`);
  try {
    const r = await fetch('/api/test-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, provider })
    }).then(r => r.json());
    const result = document.getElementById('ai-test-result');
    if (r.error) {
      result.innerHTML = `<div class="result-error">❌ ${escapeHtml(r.error)}</div>`;
    } else {
      result.innerHTML = `<div class="result-success">✅ 정상! 응답: "${escapeHtml(r.response)}"</div>`;
      toast(`${providerName} API 키 정상!`, 'success');
    }
  } catch (e) { toast(e.message, 'error'); }
}

async function saveAIConfig() {
  const provider = document.querySelector('input[name="ai-provider"]:checked')?.value || 'rule';
  const apiKey = document.getElementById('ai-api-key').value;
  try {
    const r = await fetch('/api/ai-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, apiKey: apiKey || undefined })
    }).then(r => r.json());
    if (r.error) { toast(r.error, 'error'); return; }
    toast('AI 설정 저장 완료!', 'success');
    if (pointsData.length > 0) {
      // 다시 요약
      toast('새 설정으로 다시 요약 중...');
      await resummarize();
    }
  } catch (e) { toast(e.message, 'error'); }
}

async function resummarize() {
  try {
    const r = await fetch('/api/resummarize', { method: 'POST' }).then(r => r.json());
    if (r.error) { toast(r.error, 'error'); return; }
    pointsData = r.points;
    renderPoints();
    toast('요약 완료!', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// ============================================
// 2단계: 포인트 자막 추천
// ============================================
function renderPointsEmptyState() {
  const list = document.getElementById('point-list');
  if (!list) return;
  list.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">📝</div>
      <h3>포인트 자막을 생성할 준비가 됐어요</h3>
      <p>위에서 <b>AI 종류</b>와 <b>추천 개수</b>를 먼저 확인한 후, 아래 버튼을 눌러주세요.</p>
      <button class="primary big" onclick="regeneratePoints()">✨ 포인트 자막 생성하기</button>
      <p class="muted" style="margin-top:14px">💡 Claude/Gemini AI를 활성화하면 훨씬 자연스러운 요약을 얻을 수 있어요</p>
    </div>
  `;
}

function renderPointsLoadingState(isAI) {
  const list = document.getElementById('point-list');
  if (!list) return;
  const label = isAI ? 'AI가 자막을 분석하고 요약 중이에요' : '자막을 분석하는 중이에요';
  const sub = isAI ? '잠시만 기다려 주세요 (보통 10~30초)' : '곧 결과가 나와요';
  list.innerHTML = `
    <div class="empty-state loading">
      <div class="loading-spin"></div>
      <h3>${label}</h3>
      <p>${sub}</p>
    </div>
  `;
}

function pinKey(p) { return `${p.start}_${p.end}`; }

// ⭐ 별표 친 자막만 다음 단계로
function proceedWithStarsOnly() {
  const starred = pointsData.filter(p => pinnedPoints.has(pinKey(p)));
  if (starred.length === 0) {
    toast('⭐ 별표 친 자막이 없어요. 먼저 좋은 자막에 별표를 찍어주세요', 'error');
    return;
  }
  if (!confirm(`⭐ 별표 친 ${starred.length}개만 효과음 매칭 단계로 넘어갑니다.\n나머지 ${pointsData.length - starred.length}개는 사라져요.\n\n계속할까요?\n(Ctrl+Z로 되돌릴 수 있어요)`)) return;
  pushUndoSnapshot('별표만 선택');
  pointsData = starred;
  pointsWithSounds = [];
  renderPoints();
  goToStep(3);
}

function togglePin(i) {
  const p = pointsData[i];
  if (!p) return;
  const k = pinKey(p);
  if (pinnedPoints.has(k)) pinnedPoints.delete(k);
  else pinnedPoints.add(k);
  renderPoints();
}

// mode: 'all' (전체 다시) | 'keep' (선택 외만 다시) | undefined (첫 생성)
async function regeneratePoints(mode) {
  const count = parseInt(document.getElementById('point-count').value, 10) || undefined;
  const isAI = await isAIActive();

  // 핀 유지 포인트들 (전체 다시 추천일 땐 무시)
  const keptPoints = (mode === 'keep')
    ? pointsData.filter(p => pinnedPoints.has(pinKey(p)))
    : [];
  const excludeRanges = keptPoints.map(p => ({ start: p.start, end: p.end, originalText: p.originalText || p.text }));
  const remainingCount = count ? Math.max(1, count - keptPoints.length) : undefined;

  if (mode === 'keep' && keptPoints.length === 0) {
    toast('유지할 포인트를 ⭐ 별 아이콘으로 먼저 선택해주세요', 'error');
    return;
  }

  // AI 미활성화 시 다시 추천은 경고
  if (!isAI && mode) {
    if (!confirm('🤖 AI가 비활성화 상태예요!\n\n현재 규칙 기반으로만 동작 중이라 자막 내용이 거의 같을 거예요. 진짜 포인트 자막처럼 압축하려면 Gemini AI 활성화 필요합니다.\n\n그래도 다시 추천할까요?\n(취소: AI 설정 열기 / 확인: 그냥 진행)')) {
      toggleAISettings();
      document.getElementById('ai-settings-panel').scrollIntoView({ behavior: 'smooth' });
      return;
    }
  }

  // 첫 생성이 아니라면 현재 상태 스냅샷 (다시 추천 후 Ctrl+Z로 복구 가능)
  if (pointsData.length > 0) {
    pushUndoSnapshot(mode === 'keep' ? '선택 외 다시 추천' : '전체 다시 추천');
  }

  renderPointsLoadingState(isAI);
  toast(isAI ? '✨ AI로 포인트 자막 분석/요약 중...' : '포인트 자막 분석 중...');
  try {
    const r = await fetch('/api/generate-points', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        count: remainingCount,
        regen: Date.now(),
        excludeRanges
      })
    }).then(r => r.json());
    if (r.error) { renderPointsEmptyState(); toast(r.error, 'error'); return; }

    // 유지 + 새 추천 머지 후 시간순 정렬
    const merged = [...keptPoints, ...(r.points || [])];
    merged.sort((a, b) => a.start - b.start);
    pointsData = merged;
    pointsWithSounds = [];
    renderPoints();
    updateAIBanner(r.provider);

    // AI 실패 경고 (크레딧 소진 등) - 눈에 띄게 표시
    if (r.aiWarning) {
      alert(r.aiWarning + '\n\n현재 자막은 규칙 기반(저품질)이에요.\nAI 설정에서 크레딧 충전 또는 다른 AI로 전환하세요.');
      toast(r.aiWarning, 'error');
    } else {
      const provLabel = r.provider === 'claude' ? '🏆 Claude' : (r.provider === 'gemini' ? '✨ Gemini' : '📐 규칙 기반');
      const note = mode === 'keep' ? ` (⭐ ${keptPoints.length}개 유지 + 새 ${r.points.length}개)` : '';
      toast(`${pointsData.length}개 추천 완료${note}! (${provLabel})`, 'success');
    }
  } catch (e) {
    renderPointsEmptyState();
    toast('실패: ' + e.message, 'error');
  }
}

async function isAIActive() {
  try {
    const r = await fetch('/api/ai-config').then(r => r.json());
    return (r.config.provider === 'gemini' || r.config.provider === 'claude') && r.hasKey;
  } catch (e) { return false; }
}

function updateAIBanner(provider) {
  const banner = document.getElementById('ai-status-banner');
  const text = document.getElementById('ai-status-text');
  if (!banner || !text) return;
  if (provider === 'claude') {
    banner.className = 'ai-status-banner active';
    text.innerHTML = '🏆 <b>Claude Sonnet 4.5 활성화됨</b> - 최고 품질 한국어 요약';
    banner.querySelector('button').style.display = 'none';
  } else if (provider === 'gemini') {
    banner.className = 'ai-status-banner active';
    text.innerHTML = '✨ <b>Gemini AI 활성화됨</b> - 자연스러운 한국어 요약 사용 중';
    banner.querySelector('button').style.display = 'none';
  } else {
    banner.className = 'ai-status-banner';
    text.innerHTML = '⚠️ 현재 <b>규칙 기반 모드</b>입니다. 진짜 자연스러운 요약을 원하면 <b>Claude/Gemini AI</b>를 활성화하세요!';
    const btn = banner.querySelector('button');
    if (btn) btn.style.display = '';
  }
}

function renderPoints() {
  const list = document.getElementById('point-list');
  list.innerHTML = pointsData.map((p, i) => {
    const isPinned = pinnedPoints.has(pinKey(p));
    return `
    <div class="point-item ${isPinned ? 'pinned' : ''}"
         onmouseenter="highlightTranscript(${p.start}, ${p.end})"
         onfocusin="highlightTranscript(${p.start}, ${p.end})">
      <div class="point-num">${i + 1}</div>
      <button class="point-pin ${isPinned ? 'on' : ''}" onclick="togglePin(${i})" title="${isPinned ? '유지 선택됨 (다시 추천해도 보존)' : '이 자막 유지하기'}">${isPinned ? '⭐' : '☆'}</button>
      <input class="point-time" value="${fmtTime(p.start)}" onchange="pointsData[${i}].start = parseTime(this.value)">
      <input class="point-time" value="${fmtTime(p.end)}" onchange="pointsData[${i}].end = parseTime(this.value)">
      <select class="point-cat" onchange="pointsData[${i}].category = this.value">
        ${Object.entries(CATEGORY_LABELS).map(([k, v]) => `<option value="${k}" ${p.category === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
      <input class="point-text" value="${escapeHtml(p.text)}"
        oninput="pointsData[${i}].text = this.value">
      <button class="point-del" onclick="deletePoint(${i})" title="삭제">×</button>
    </div>
    ${p.originalText && p.originalText !== p.text ? `<div class="point-original">원문: ${escapeHtml(p.originalText)}</div>` : ''}
  `;
  }).join('');
}

// 원문(트랜스크립트) 패널 렌더링
function renderTranscript() {
  const body = document.getElementById('transcript-body');
  if (!body || !captions || captions.length === 0) { if (body) body.innerHTML = '<div style="padding:12px;color:#888">SRT를 먼저 로드하세요</div>'; return; }
  body.innerHTML = captions.map((c, i) => `
    <div class="transcript-line" data-start="${c.start}" data-end="${c.end}" data-idx="${i}">
      <span class="ts">${fmtMMSS(c.start)}</span>
      <span class="tx">${escapeHtml(c.text)}</span>
    </div>
  `).join('');
}

function fmtMMSS(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

// 해당 시간대 자막을 하이라이트하고 원문 패널 내에서만 스크롤
let _highlightTimer = null;
function highlightTranscript(start, end) {
  clearTimeout(_highlightTimer);
  _highlightTimer = setTimeout(() => {
    const body = document.getElementById('transcript-body');
    if (!body) return;
    const lines = body.querySelectorAll('.transcript-line');
    let firstHit = null;
    lines.forEach(line => {
      const s = parseFloat(line.dataset.start);
      const e = parseFloat(line.dataset.end);
      const hit = s < end && e > start; // 시간 겹침
      line.classList.toggle('highlight', hit);
      if (hit && !firstHit) firstHit = line;
    });
    if (firstHit) {
      // scrollIntoView 대신 부모(transcript-body) 안에서만 스크롤
      const bodyRect = body.getBoundingClientRect();
      const lineRect = firstHit.getBoundingClientRect();
      const offset = lineRect.top - bodyRect.top + body.scrollTop - (bodyRect.height / 2) + (lineRect.height / 2);
      body.scrollTo({ top: offset, behavior: 'smooth' });
    }
  }, 50);
}

// ============================================
// Undo 스택 (Ctrl+Z)
// ============================================
function pushUndoSnapshot(label) {
  undoStack.push({
    label: label || '변경',
    points: JSON.parse(JSON.stringify(pointsData)),
    pinned: Array.from(pinnedPoints),
    at: Date.now()
  });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function undo() {
  if (undoStack.length === 0) {
    toast('되돌릴 작업이 없어요', 'error');
    return;
  }
  const snap = undoStack.pop();
  pointsData = snap.points;
  pinnedPoints = new Set(snap.pinned);
  pointsWithSounds = [];
  renderPoints();
  toast(`↩️ ${snap.label} 되돌림 (${undoStack.length}개 남음)`, 'success');
}

// Ctrl+Z / Cmd+Z 단축키
document.addEventListener('keydown', (e) => {
  const isUndo = (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z' || e.key === 'ㅋ');
  if (!isUndo) return;
  // 입력 필드 안에서 Ctrl+Z 누른 경우 → 기본 동작(텍스트 undo) 유지
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  e.preventDefault();
  undo();
});

function deletePoint(i) {
  pushUndoSnapshot(`"${(pointsData[i] && pointsData[i].text || '').substring(0, 15)}..." 삭제`);
  pointsData.splice(i, 1);
  pointsWithSounds = [];
  renderPoints();
}

// ============================================
// 3단계: 효과음 규칙 + 매칭
// ============================================
async function loadSoundRules() {
  try {
    const r = await fetch('/api/sound-rules').then(r => r.json());
    currentRules = r.rules;
    availableSounds = r.available || [];
    renderRuleDisplay();
  } catch (e) { console.error(e); }
}

function renderRuleDisplay() {
  if (!currentRules) return;
  const html = Object.entries(CATEGORY_LABELS).map(([cat, label]) => {
    const sounds = currentRules.categories[cat] || [];
    return `<li><strong>${label}</strong> → ${sounds.length > 0 ? sounds.join(', ') : '<em style="color:#7d8590">설정 없음</em>'}</li>`;
  }).join('');
  document.getElementById('rule-display').innerHTML = `<ul class="rule-list">${html}</ul>`;
}

let ruleEditorOpen = false;
async function toggleRuleEditor() {
  ruleEditorOpen = !ruleEditorOpen;
  const editor = document.getElementById('rule-editor');
  const display = document.getElementById('rule-display');
  if (ruleEditorOpen) {
    if (!currentRules) await loadSoundRules();
    renderRuleEditor();
    editor.style.display = 'block';
    display.style.display = 'none';
    document.getElementById('edit-btn').textContent = '✕ 닫기';
  } else {
    editor.style.display = 'none';
    display.style.display = 'block';
    document.getElementById('edit-btn').textContent = '⚙️ 규칙 편집';
  }
}

function renderRuleEditor() {
  const editor = document.getElementById('rule-editor');
  editor.innerHTML = `
    <div class="rule-editor-folder">
      <span style="font-size:12px;color:#7d8590">📂 폴더:</span>
      <input type="text" id="rule-sound-dir" value="${escapeHtml(currentRules.soundDir)}"
        placeholder="예: C:\\Users\\본인\\Documents\\효과음" onkeyup="if(event.key==='Enter') rescanSounds()">
      <button onclick="pickSoundFolder()" title="윈도우 폴더 선택 창 열기">📁 찾아보기</button>
      <button onclick="rescanSounds()" title="입력한 폴더의 파일 다시 스캔">🔄 다시 스캔</button>
      <span class="muted">(${availableSounds.length}개 발견)</span>
    </div>
    <div class="muted" style="margin-top:6px;font-size:11px">
      💡 폴더 경로를 직접 붙여넣어도 돼요. 윈도우 탐색기 주소창에서 복사 → 여기 붙여넣기 → "다시 스캔" 클릭
    </div>
    <div class="rule-editor-categories">
      ${Object.entries(CATEGORY_LABELS).map(([cat, label]) => `
        <div class="rule-cat">
          <h4>${label}</h4>
          <div class="rule-cat-sounds">
            ${(currentRules.categories[cat] || []).map((s, i) => `
              <span class="rule-sound-tag">${escapeHtml(s)}
                <button onclick="removeSoundFromCat('${cat}', ${i})" title="제거">×</button>
              </span>
            `).join('')}
          </div>
          <select onchange="if(this.value){addSoundToCat('${cat}', this.value); this.value='';}">
            <option value="">+ 효과음 추가</option>
            ${availableSounds.filter(s => !(currentRules.categories[cat] || []).includes(s))
              .map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}
          </select>
        </div>
      `).join('')}
    </div>
    <div class="rule-editor-actions">
      <button class="primary" onclick="saveRules()" title="현재 폴더 + 규칙을 내 기본값으로 저장">💾 내 기본값으로 저장</button>
      <button onclick="resetRules()" title="공장 출고 기본 규칙으로 되돌리기">🔄 공장 기본값</button>
    </div>
  `;
}

function addSoundToCat(cat, sound) {
  if (!currentRules.categories[cat]) currentRules.categories[cat] = [];
  if (!currentRules.categories[cat].includes(sound)) {
    currentRules.categories[cat].push(sound);
    renderRuleEditor();
  }
}
function removeSoundFromCat(cat, idx) {
  currentRules.categories[cat].splice(idx, 1);
  renderRuleEditor();
}
async function pickSoundFolder() {
  toast('폴더 선택 창을 여는 중...');
  try {
    const r = await fetch('/api/pick-folder', { method: 'POST' }).then(r => r.json());
    if (r.path) {
      document.getElementById('rule-sound-dir').value = r.path;
      currentRules.soundDir = r.path;
      await rescanSounds();
      toast(`폴더 선택됨: ${r.path}`, 'success');
    } else {
      toast('취소됨', '');
    }
  } catch (e) { toast('폴더 선택 실패: ' + e.message, 'error'); }
}

async function rescanSounds() {
  const newDir = document.getElementById('rule-sound-dir').value;
  currentRules.soundDir = newDir;
  try {
    const r = await fetch('/api/list-sounds?dir=' + encodeURIComponent(newDir)).then(r => r.json());
    availableSounds = r.files || [];
    renderRuleEditor();
    toast(`효과음 ${availableSounds.length}개 발견`, 'success');
  } catch (e) { toast('스캔 실패: ' + e.message, 'error'); }
}
async function saveRules() {
  currentRules.soundDir = document.getElementById('rule-sound-dir').value;
  try {
    await fetch('/api/sound-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: currentRules })
    });
    toast('규칙 저장 완료!', 'success');
    renderRuleDisplay();
    toggleRuleEditor();
    pointsWithSounds = []; // 매칭 다시
    rematchSounds();
  } catch (e) { toast('저장 실패: ' + e.message, 'error'); }
}
async function resetRules() {
  if (!confirm('기본 규칙으로 되돌립니다. 진행할까요?')) return;
  await fetch('/api/sound-rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rules: {
        soundDir: currentRules.soundDir,
        categories: {
          question:   ['001_뽁.wav', '038_뿅.mp3', '뽀옹.mp3', '086_팝.mp3', 'DA_-_Pop_-_6 (1).mp3'],
          emphasis:   ['082_띵.mp3', '026_띠딩2.mp3'],
          surprise:   ['038_뿅.mp3', '001_뽁.wav'],
          list:       ['085_마우스클릭.mp3', '클릭소리.aac'],
          emotion:    ['뽀옹.mp3', '086_팝.mp3'],
          conclusion: ['082_띵.mp3', '026_띠딩2.mp3'],
        }
      }
    })
  });
  await loadSoundRules();
  renderRuleEditor();
  toast('기본값 복원!', 'success');
}

async function rematchSounds() {
  if (!currentRules) await loadSoundRules();
  toast('효과음 매칭 중...');
  try {
    const r = await fetch('/api/match-sounds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: pointsData, soundDir: currentRules.soundDir })
    }).then(r => r.json());
    if (r.error) { toast(r.error, 'error'); return; }
    pointsWithSounds = r.points;
    renderSounds();
    toast('효과음 매칭 완료!', 'success');
  } catch (e) {
    toast('실패: ' + e.message, 'error');
  }
}

function renderSounds() {
  const list = document.getElementById('sound-list');
  list.innerHTML = pointsWithSounds.map((p, i) => `
    <div class="sound-item">
      <div class="point-num">${i + 1}</div>
      <span class="point-time">${fmtTime(p.start)}</span>
      <span class="point-cat-badge cat-${p.category}">${CATEGORY_LABELS[p.category] || p.category}</span>
      <span>${escapeHtml(p.text)}</span>
      <span class="sound-name">🔊 ${p.soundName || '<em style="color:#6e7681">없음</em>'}</span>
    </div>
  `).join('');
}

// ============================================
// 4단계: PP 적용
// ============================================
function renderApplySummary() {
  const withSound = pointsWithSounds.filter(p => p.sound).length;
  const cats = {};
  pointsWithSounds.forEach(p => cats[p.category] = (cats[p.category] || 0) + 1);

  const catRows = Object.entries(cats)
    .map(([c, n]) => `<div class="row"><span>${CATEGORY_LABELS[c] || c}</span><strong>${n}개</strong></div>`)
    .join('');

  document.getElementById('apply-summary').innerHTML = `
    <h3>📊 적용 요약</h3>
    <div class="row"><span>총 포인트 자막</span><strong>${pointsWithSounds.length}개</strong></div>
    <div class="row"><span>효과음 있는 자막</span><strong>${withSound}개</strong></div>
    ${catRows}
  `;
}

async function refreshSequences() {
  try {
    const r = await fetch('/api/list-sequences').then(r => r.json());
    const sel = document.getElementById('target-sequence');
    const seqs = r.sequences || [];
    sel.innerHTML = '<option value="">(현재 활성 시퀀스 자동)</option>' +
      seqs.map(s => `<option value="${escapeHtml(s.name)}" ${s.isActive ? 'selected' : ''}>${escapeHtml(s.name)}${s.isActive ? ' ● 현재' : ''}</option>`).join('');
    toast(`시퀀스 ${seqs.length}개 발견`, 'success');
  } catch (e) { toast('시퀀스 조회 실패: ' + e.message, 'error'); }
}

async function applyToPP() {
  const includeSounds = document.getElementById('include-sounds').checked;
  const audioTrack = parseInt(document.getElementById('audio-track').value, 10);
  const sequenceName = document.getElementById('target-sequence').value || null;
  const captionBeforeIndex = parseInt(document.getElementById('caption-track-pos').value, 10);
  const clearExistingCaptions = document.getElementById('clear-existing-captions').checked;

  showLoading('PP에 적용 중...');
  try {
    const r = await fetch('/api/apply-to-pp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        points: pointsWithSounds,
        audioTrackIndex: audioTrack,
        includeSounds,
        sequenceName,
        captionBeforeIndex,
        clearExistingCaptions
      })
    }).then(r => r.json());

    hideLoading();

    if (r.error) {
      document.getElementById('apply-result').innerHTML = `
        <div class="result-error">❌ 실패: ${escapeHtml(r.error)}</div>
      `;
      return;
    }

    document.getElementById('apply-result').innerHTML = `
      <div class="result-success">
        ✅ <strong>완료!</strong><br>
        • 캡션 트랙 ${r.captions}개 추가<br>
        • 효과음 ${r.sounds}개 배치<br>
        • SRT 파일: ${escapeHtml(r.srtPath || '')}
      </div>
    `;
    toast('PP 반영 완료! ✨', 'success');
  } catch (e) {
    hideLoading();
    document.getElementById('apply-result').innerHTML = `
      <div class="result-error">❌ 에러: ${escapeHtml(e.message)}</div>
    `;
  }
}

// ============================================
// 로딩 오버레이
// ============================================
function showLoading(msg) {
  let el = document.getElementById('loading-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loading-overlay';
    el.className = 'loading-overlay';
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="loading-box"><div class="loading-spin"></div><h2>${msg}</h2></div>`;
  el.style.display = 'flex';
}
function hideLoading() {
  const el = document.getElementById('loading-overlay');
  if (el) el.style.display = 'none';
}

// 초기 페이지
goToStep(1);
