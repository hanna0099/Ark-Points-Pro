// Premiere Points Pro
// Vrew SRT를 받아서 포인트 자막 + 효과음을 PP에 정확하게 적용

const express = require('express');
const fs = require('fs');
const path = require('path');

const bridge = require('./lib/premiere-bridge');
const srtParser = require('./lib/srt-parser');
const pointAnalyzer = require('./lib/point-analyzer-pro');
const soundMatcher = require('./lib/sound-matcher');
const summarizer = require('./lib/summarizer');

const app = express();
const PORT = 3838;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 메모리 상태
let currentState = {
  srtPath: null,
  captions: [],
  points: [],
};

// ============================================
// API: 상태 + PP 연결 확인
// ============================================
app.get('/api/status', async (req, res) => {
  try {
    const status = await bridge.ping();
    res.json({ ...status, hasSrt: !!currentState.srtPath });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

// ============================================
// API: PP 프로젝트의 SRT 파일들 자동 감지
// ============================================
app.get('/api/detect-srt', async (req, res) => {
  const allSrts = [];

  // 1) PP 프로젝트에 임포트된 SRT
  try {
    const srts = await bridge.getCurrentSrtPath();
    // 배열인 경우만 (에러 문자열 무시)
    if (Array.isArray(srts)) {
      for (const s of srts) {
        if (s && typeof s === 'object' && s.path) {
          allSrts.push({ name: s.name || path.basename(s.path), path: s.path });
        }
      }
    }
  } catch (e) {
    console.log('[detect-srt] PP 검색 실패:', e.message);
  }

  // 2) 시퀀스 소스 영상 폴더의 SRT
  try {
    const seqClips = await bridge.getSequenceClips();
    const sourceDirs = new Set();
    if (seqClips && Array.isArray(seqClips.segments)) {
      seqClips.segments.forEach(s => {
        if (s.sourcePath) sourceDirs.add(path.dirname(s.sourcePath));
      });
    }
    for (const dir of sourceDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        fs.readdirSync(dir).forEach(f => {
          if (f.toLowerCase().endsWith('.srt')) {
            const fullPath = path.join(dir, f);
            if (!allSrts.some(s => s.path === fullPath)) {
              allSrts.push({ name: f, path: fullPath, source: 'folder' });
            }
          }
        });
      } catch (e) {}
    }
  } catch (e) {
    console.log('[detect-srt] 폴더 검색 실패:', e.message);
  }

  console.log(`[detect-srt] ${allSrts.length}개 SRT 발견`);
  res.json({ srtFiles: allSrts });
});

// ============================================
// API: SRT 파일 로드
// ============================================
app.post('/api/load-srt', async (req, res) => {
  const { path: srtPath } = req.body;
  if (!srtPath || !fs.existsSync(srtPath)) {
    return res.status(400).json({ error: 'SRT 파일을 찾을 수 없음' });
  }
  try {
    const text = fs.readFileSync(srtPath, 'utf-8');
    const captions = srtParser.parseSrt(text);
    currentState.srtPath = srtPath;
    currentState.captions = captions;
    currentState.points = [];

    // 시퀀스 길이도 같이 반환
    let seqDuration = null;
    try {
      const info = await bridge.getSequenceInfo();
      seqDuration = info.duration;
    } catch (e) {}

    // 미리 분석해서 "포인트 자막 추천 개수" 추정 (내용 밀도 + 길이 기반)
    let suggestedCount = 13;
    try {
      suggestedCount = pointAnalyzer.estimatePointCount(captions);
    } catch (e) {}

    res.json({
      captions,
      path: srtPath,
      count: captions.length,
      duration: captions.length > 0 ? captions[captions.length - 1].end : 0,
      sequenceDuration: seqDuration,
      suggestedCount
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// API: 포인트 자막 추천 생성 (+ AI 요약)
// ============================================
app.post('/api/generate-points', async (req, res) => {
  const { count, regen, excludeRanges } = req.body;
  if (currentState.captions.length === 0) {
    return res.status(400).json({ error: 'SRT 먼저 로드해주세요' });
  }
  try {
    let targetCount = count;
    if (!targetCount) {
      targetCount = pointAnalyzer.estimatePointCount(currentState.captions);
    }
    // 핀 유지 범위(excludeRanges) 정리
    const cleanRanges = Array.isArray(excludeRanges) ? excludeRanges.map(r => ({ start: r.start, end: r.end })) : [];
    const seed = regen || Date.now();

    // AI가 전체 대본에서 직접 포인트 선별 + 요약 (핵심 변경)
    let points = await summarizer.selectAndSummarizePoints(currentState.captions, targetCount, {
      excludeRanges: cleanRanges,
      seed
    });
    const aiWarning = points._aiWarning || null; // fallback 경고

    currentState.points = points;
    const aiConfig = summarizer.loadAIConfig();
    res.json({
      points,
      count: points.length,
      suggested: targetCount,
      provider: aiConfig.provider,
      aiWarning
    });
  } catch (e) {
    console.error('[generate-points]', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// API: AI 설정 조회/저장
// ============================================
app.get('/api/ai-config', (req, res) => {
  const config = summarizer.loadAIConfig();
  // API 키는 마스킹
  const masked = { ...config };
  if (masked.apiKey) masked.apiKey = masked.apiKey.substring(0, 6) + '****' + masked.apiKey.slice(-4);
  res.json({ config: masked, hasKey: !!config.apiKey });
});

app.post('/api/ai-config', (req, res) => {
  const { provider, apiKey, model } = req.body;
  if (!['rule', 'gemini', 'claude'].includes(provider)) {
    return res.status(400).json({ error: '알 수 없는 provider' });
  }
  try {
    const current = summarizer.loadAIConfig();
    // 모델 자동 결정
    let defaultModel = 'gemini-2.5-flash';
    if (provider === 'claude') defaultModel = 'claude-sonnet-4-5';
    summarizer.saveAIConfig({
      provider,
      apiKey: apiKey || current.apiKey,
      model: model || defaultModel,
    });
    res.json({ saved: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API 키 검증 - provider별 분기
app.post('/api/test-ai', async (req, res) => {
  const { apiKey, provider = 'gemini', model } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API 키 필요' });
  try {
    let result;
    if (provider === 'claude') {
      result = await summarizer.callClaude(apiKey, '안녕! 짧게 인사해줘', model || 'claude-sonnet-4-5');
    } else {
      result = await summarizer.callGemini(apiKey, '안녕! 짧게 인사해줘', model || 'gemini-2.5-flash');
    }
    res.json({ ok: true, response: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 다시 요약만 하기 (포인트 다시 추출 안 함)
app.post('/api/resummarize', async (req, res) => {
  if (!currentState.points || currentState.points.length === 0) {
    return res.status(400).json({ error: '포인트 자막이 없습니다' });
  }
  try {
    const summarized = await summarizer.summarizePoints(currentState.points);
    currentState.points = summarized;
    res.json({ points: summarized });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// API: 효과음 매칭 (포인트 → 효과음)
// ============================================
app.post('/api/match-sounds', (req, res) => {
  const { points, soundDir } = req.body;
  if (!points || points.length === 0) {
    return res.status(400).json({ error: '포인트 자막 필요' });
  }
  try {
    const matched = soundMatcher.matchSounds(points, soundDir);
    res.json({ points: matched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// API: 효과음 규칙 조회/저장 (사용자 커스텀)
// ============================================
app.get('/api/sound-rules', (req, res) => {
  try {
    const rules = soundMatcher.loadRules();
    const available = soundMatcher.listAvailableSounds(rules.soundDir);
    res.json({ rules, available });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sound-rules', (req, res) => {
  const { rules } = req.body;
  if (!rules || !rules.categories || !rules.soundDir) {
    return res.status(400).json({ error: '잘못된 규칙' });
  }
  try {
    soundMatcher.saveRules(rules);
    res.json({ saved: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 현재 프로젝트의 모든 시퀀스 목록
app.get('/api/list-sequences', async (req, res) => {
  try {
    const r = await bridge.executeScript(`
      var seqs = [];
      var activeName = app.project.activeSequence ? app.project.activeSequence.name : null;
      for (var i = 0; i < app.project.sequences.numSequences; i++) {
        var s = app.project.sequences[i];
        seqs.push({
          name: s.name,
          id: s.sequenceID,
          isActive: (s.name === activeName)
        });
      }
      return __result({sequences: seqs, activeName: activeName});
    `);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message, sequences: [] });
  }
});

// 네이티브 폴더 선택 다이얼로그 - VBS BrowseForFolder (즉시 뜸, 안정적)
app.post('/api/pick-folder', (req, res) => {
  const { spawn } = require('child_process');
  const fsMod = require('fs');
  const pathMod = require('path');
  const osMod = require('os');

  const ts = Date.now();
  const resultFile = pathMod.join(osMod.tmpdir(), `arkfolder_${ts}.txt`);
  const vbsFile = pathMod.join(osMod.tmpdir(), `arkfolder_${ts}.vbs`);

  // BrowseForFolder 옵션 flag:
  // 0x0001 = 자식 폴더만, 0x0010 = 텍스트 입력 가능, 0x0040 = 새 폴더 만들기
  // 합쳐서 0x0051 = 81
  const vbsContent = `Dim objShell, objFolder, objFile, fso, p
Set objShell = CreateObject("Shell.Application")
Set objFolder = objShell.BrowseForFolder(0, "Select Sound Folder (Click OK after selecting)", 81)
If Not objFolder Is Nothing Then
  On Error Resume Next
  p = objFolder.Self.Path
  If Err.Number <> 0 Then
    Err.Clear
    p = ""
  End If
  ' Self.Path가 비면 Items().Item().Path로 대체 시도
  If p = "" Then
    p = objFolder.Items().Item().Path
    If Err.Number <> 0 Then Err.Clear : p = ""
  End If
  Set fso = CreateObject("Scripting.FileSystemObject")
  Set objFile = fso.CreateTextFile("${resultFile.replace(/\\/g, '\\\\')}", True, True)
  objFile.WriteLine p
  objFile.Close
End If`;

  try {
    // UTF-16 LE + BOM으로 저장 → 경로에 한글/특수문자 있어도 wscript가 정확히 읽음
    const BOM = Buffer.from([0xFF, 0xFE]);
    const vbsBuf = Buffer.concat([BOM, Buffer.from(vbsContent, 'utf16le')]);
    fsMod.writeFileSync(vbsFile, vbsBuf);
  } catch (e) {
    return res.status(500).json({ error: 'VBS 쓰기 실패: ' + e.message });
  }

  const proc = spawn('wscript.exe', ['//NoLogo', vbsFile], { windowsHide: false });

  const timeout = setTimeout(() => {
    try { proc.kill(); } catch (e) {}
  }, 120000);

  proc.on('close', () => {
    clearTimeout(timeout);
    let selected = null;
    try {
      if (fsMod.existsSync(resultFile)) {
        const buf = fsMod.readFileSync(resultFile);
        let text;
        if (buf[0] === 0xff && buf[1] === 0xfe) {
          text = buf.toString('utf16le', 2);
        } else {
          text = buf.toString('utf8');
        }
        selected = text.replace(/[\r\n\0]/g, '').trim();
        fsMod.unlinkSync(resultFile);
      }
      fsMod.unlinkSync(vbsFile);
    } catch (e) {}
    res.json({ path: selected || null });
  });
  proc.on('error', e => {
    clearTimeout(timeout);
    res.status(500).json({ error: e.message });
  });
});

app.get('/api/list-sounds', (req, res) => {
  res.json({ files: soundMatcher.listAvailableSounds(req.query.dir) });
});

// ============================================
// API: PP에 포인트 자막 + 효과음 모두 적용
// ============================================
app.post('/api/apply-to-pp', async (req, res) => {
  const { points, audioTrackIndex = 1, includeSounds = true, sequenceName, captionBeforeIndex = -1, clearExistingCaptions = false } = req.body;
  if (!points || points.length === 0) {
    return res.status(400).json({ error: '포인트 자막 필요' });
  }
  try {
    const result = { ok: true, captions: 0, sounds: 0 };

    // 0. 사용자가 시퀀스를 선택했으면 해당 시퀀스 활성화
    if (sequenceName) {
      await bridge.executeScript(`
        var target = ${JSON.stringify(sequenceName)};
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
          var s = app.project.sequences[i];
          if (s.name === target) {
            app.project.activeSequence = s;
            return __result({activated: target});
          }
        }
        return __error("시퀀스 '" + target + "' 찾을 수 없음");
      `);
    }

    // 1. 포인트 자막 SRT 생성 + PP 임포트
    const srtDir = currentState.srtPath ? path.dirname(currentState.srtPath) : require('os').tmpdir();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const pointsSrt = path.join(srtDir, `포인트자막_${ts}.srt`);

    // 자막 텍스트의 쉼표(,)를 SRT 줄바꿈으로 변환 (사용자 컨벤션)
    // 예: "눈 피로, 두통, 집중력 저하" → "눈 피로\n두통\n집중력 저하"
    // 단 "1. 안녕, 친구야" 같은 자연 쉼표는 보존하려면... 일단 모든 쉼표 → 줄바꿈
    // (포인트 자막에선 쉼표가 거의 시각적 분리 용도)
    const srtCaptions = points.map(p => ({
      start: p.start,
      end: p.end,
      text: (p.text || '').replace(/\s*,\s*/g, '\n')
    }));
    fs.writeFileSync(pointsSrt, srtParser.generateSrt(srtCaptions), 'utf-8');

    // (선택) 기존 캡션 트랙 모두 비우기 - C1 위치 보장하려면 필수
    if (clearExistingCaptions) {
      try {
        await bridge.executeScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("seq null");
          var cTracks = seq.captionTracks;
          var removed = 0;
          if (cTracks && cTracks.numTracks > 0) {
            for (var t = 0; t < cTracks.numTracks; t++) {
              var trk = cTracks[t];
              if (!trk || !trk.clips) continue;
              // 트랙의 모든 클립 제거
              for (var i = trk.clips.numItems - 1; i >= 0; i--) {
                try { trk.clips[i].remove(false, false); removed++; } catch(e) {}
              }
            }
          }
          return __result({clearedClips: removed});
        `);
      } catch (e) {
        result.clearWarning = e.message;
      }
    }

    const captionResult = await bridge.importAndCreateCaption(pointsSrt, captionBeforeIndex);
    result.captions = points.length;
    result.captionTrack = captionResult;
    result.srtPath = pointsSrt;
    // 폰트 변경은 PP ExtendScript API 한계로 지원 불가 — 사용자가 PP에서 직접 설정

    // 2. 효과음 - 한 번에 하나씩 임포트 + 배치 (한글 인코딩 안전)
    if (includeSounds) {
      const soundsByPath = {}; // 파일경로 → projectItem ID 캐시
      const pointsWithSound = points.filter(p => p.sound);

      for (const point of pointsWithSound) {
        const soundPath = point.sound;
        const startTicks = Math.round(point.start * 254016000000).toString();

        try {
          // 1) 파일 이미 임포트되었나 체크 (이번 회차)
          let projectItemFound = soundsByPath[soundPath];

          // 2) 없으면 임포트 - 임포트 직후 마지막 항목이 우리 파일
          if (!projectItemFound) {
            const importResult = await bridge.executeScript(`
              var pathToImport = ${JSON.stringify(soundPath)};
              var rootBefore = app.project.rootItem.children.numItems;
              app.project.importFiles([pathToImport], true, app.project.rootItem, false);
              var rootAfter = app.project.rootItem.children.numItems;
              // 마지막 추가된 항목 = 방금 임포트한 것
              if (rootAfter > rootBefore) {
                var newItem = app.project.rootItem.children[rootAfter - 1];
                return __result({
                  imported: true,
                  itemNodeId: newItem.nodeId,
                  itemName: newItem.name
                });
              }
              // 이미 존재 - 마지막 위치 찾기
              for (var i = app.project.rootItem.children.numItems - 1; i >= 0; i--) {
                var item = app.project.rootItem.children[i];
                var p = "";
                try { p = item.getMediaPath(); } catch(e) {}
                if (p === pathToImport) {
                  return __result({imported: false, alreadyExists: true, itemNodeId: item.nodeId, itemName: item.name});
                }
              }
              return __error("임포트 실패: " + pathToImport);
            `);
            soundsByPath[soundPath] = importResult.itemNodeId;
            projectItemFound = importResult.itemNodeId;
          }

          // 3) nodeId로 정확한 projectItem 찾아서 배치 - 여러 방법 시도
          const placeRes = await bridge.executeScript(`
            var nodeId = ${JSON.stringify(projectItemFound)};
            var seq = app.project.activeSequence;
            var trackIdx = ${audioTrackIndex};
            var startTicks = ${JSON.stringify(startTicks)};

            var item = null;
            for (var i = 0; i < app.project.rootItem.children.numItems; i++) {
              if (app.project.rootItem.children[i].nodeId === nodeId) {
                item = app.project.rootItem.children[i];
                break;
              }
            }
            if (!item) return __error("nodeId 매칭 실패");

            // 소스 in/out 0부터 (mediaType=2 오디오)
            try { item.setInPoint("0", 2); } catch(e) {}

            var aTrack = seq.audioTracks[trackIdx];
            var before = aTrack.clips.numItems;
            var attempts = [];

            // 방법 1: track.insertClip (트랙 수준 메서드)
            try {
              var r = aTrack.insertClip(item, startTicks);
              attempts.push("track.insertClip: " + r);
              if (aTrack.clips.numItems > before) {
                return __result({ok: true, method: "track.insertClip", attempts: attempts});
              }
            } catch(e) { attempts.push("track.insertClip ERR: " + e.message); }

            // 방법 2: track.overwriteClip
            try {
              var r = aTrack.overwriteClip(item, startTicks);
              attempts.push("track.overwriteClip: " + r);
              if (aTrack.clips.numItems > before) {
                return __result({ok: true, method: "track.overwriteClip", attempts: attempts});
              }
            } catch(e) { attempts.push("track.overwriteClip ERR: " + e.message); }

            // 방법 3: seq.overwriteClip(item, time, 0, trackIdx) - videoIdx=0
            try {
              var r = seq.overwriteClip(item, startTicks, 0, trackIdx);
              attempts.push("seq.overwriteClip(0,trk): " + r);
              if (aTrack.clips.numItems > before) {
                return __result({ok: true, method: "seq.overwriteClip(0,trk)", attempts: attempts});
              }
            } catch(e) { attempts.push("seq.overwriteClip(0,trk) ERR: " + e.message); }

            // 방법 4: seq.insertClip(item, time, 0, trackIdx)
            try {
              var r = seq.insertClip(item, startTicks, 0, trackIdx);
              attempts.push("seq.insertClip(0,trk): " + r);
              if (aTrack.clips.numItems > before) {
                return __result({ok: true, method: "seq.insertClip(0,trk)", attempts: attempts});
              }
            } catch(e) { attempts.push("seq.insertClip(0,trk) ERR: " + e.message); }

            // 방법 5: app.enableQE() + qe 시퀀스
            try {
              app.enableQE();
              var qeSeq = qe.project.getActiveSequence();
              var qeTrack = qeSeq.getAudioTrackAt(trackIdx);
              if (qeTrack && qeTrack.insertClip) {
                qeTrack.insertClip(item, startTicks);
                attempts.push("qeTrack.insertClip 호출됨");
                if (aTrack.clips.numItems > before) {
                  return __result({ok: true, method: "qeTrack.insertClip", attempts: attempts});
                }
              }
            } catch(e) { attempts.push("qeTrack.insertClip ERR: " + e.message); }

            return __error("모든 방법 실패: " + attempts.join(" | "));
          `);
          result.sounds++;
          console.log(`[효과음 ${path.basename(soundPath)}] ✅ 성공 - ${placeRes.method}`);
        } catch (e) {
          console.error(`[효과음 배치] ${path.basename(soundPath)} 실패: ${e.message}`);
        }
      }
    }

    res.json(result);
  } catch (e) {
    console.error('[apply-to-pp]', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// 서버 시작
// ============================================
app.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const lanIPs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) lanIPs.push(net.address);
    }
  }
  console.log(`\n⭐ Ark Points Pro 실행 중`);
  console.log(`   본인 PC:     http://localhost:${PORT}`);
  lanIPs.forEach(ip => console.log(`   같은 Wi-Fi:  http://${ip}:${PORT}`));
  console.log(`\n   기능: Vrew SRT → 포인트 자막 + 효과음 → PP 정확 반영\n`);
});
