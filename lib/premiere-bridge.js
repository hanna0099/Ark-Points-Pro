// Premiere Pro CEP Bridge 통신 모듈
// CEP 플러그인이 감시하는 temp 디렉토리에 .jsx 명령을 작성하고
// 결과 .json 파일을 읽어와 Premiere Pro를 직접 제어합니다.

const fs = require('fs');
const path = require('path');
const os = require('os');

const BRIDGE_DIR = path.join(os.tmpdir(), 'premiere-mcp-bridge');
const TIMEOUT_MS = 10000;
const POLL_MS = 100;

// 임시 디렉토리 보장
if (!fs.existsSync(BRIDGE_DIR)) {
  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
}

let cmdCounter = 0;

/**
 * Premiere Pro에 ExtendScript 코드를 실행하고 결과를 받습니다.
 * @param {string} script - 실행할 ExtendScript 코드 (IIFE 자동 래핑됨)
 * @returns {Promise<any>} 실행 결과 객체
 */
function executeScript(script) {
  return new Promise((resolve, reject) => {
    const id = `webapp_${Date.now()}_${cmdCounter++}`;
    const cmdFile = path.join(BRIDGE_DIR, `cmd_${id}.jsx`);
    const resFile = path.join(BRIDGE_DIR, `res_${id}.json`);

    // ExtendScript 헬퍼와 함께 IIFE로 래핑
    // 주의: ExtendScript에 JSON.stringify가 안 될 수 있어 자체 구현 사용
    const wrappedScript = `
(function() {
  var TICKS_PER_SECOND = 254016000000;
  function __stringify(obj) {
    if (obj === null || typeof obj === 'undefined') return 'null';
    if (typeof obj === 'string') return '"' + String(obj).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"').replace(/\\n/g, '\\\\n').replace(/\\r/g, '\\\\r').replace(/\\t/g, '\\\\t') + '"';
    if (typeof obj === 'number') return isFinite(obj) ? String(obj) : 'null';
    if (typeof obj === 'boolean') return String(obj);
    if (obj instanceof Array || (obj.length !== undefined && typeof obj !== 'string')) {
      var arr = [];
      for (var i = 0; i < obj.length; i++) arr.push(__stringify(obj[i]));
      return '[' + arr.join(',') + ']';
    }
    if (typeof obj === 'object') {
      var pairs = [];
      for (var key in obj) {
        if (obj.hasOwnProperty(key)) {
          pairs.push('"' + key + '":' + __stringify(obj[key]));
        }
      }
      return '{' + pairs.join(',') + '}';
    }
    return 'null';
  }
  function __result(data) { return '{"success":true,"data":' + __stringify(data) + '}'; }
  function __error(msg) { return '{"success":false,"error":' + __stringify(String(msg)) + '}'; }
  try {
    ${script}
  } catch(e) {
    return __error(e.toString());
  }
})();
`;

    fs.writeFileSync(cmdFile, wrappedScript, 'utf-8');

    const startTime = Date.now();
    const interval = setInterval(() => {
      if (fs.existsSync(resFile)) {
        clearInterval(interval);
        try {
          const content = fs.readFileSync(resFile, 'utf-8');
          fs.unlinkSync(resFile);
          const result = JSON.parse(content);
          if (result.success === false) {
            reject(new Error(result.error));
          } else {
            // data가 ExtendScript 에러 문자열이면 reject
            const data = result.data;
            if (typeof data === 'string' && /^EvalScript|^Error:|undefined is not/i.test(data)) {
              reject(new Error('ExtendScript 실행 에러: ' + data));
            } else {
              resolve(data !== undefined ? data : result);
            }
          }
        } catch (e) {
          reject(new Error(`결과 파싱 실패: ${e.message}`));
        }
      } else if (Date.now() - startTime > TIMEOUT_MS) {
        clearInterval(interval);
        try { fs.unlinkSync(cmdFile); } catch (e) {}
        reject(new Error('Premiere Pro 응답 타임아웃 - CEP 플러그인이 실행 중인지 확인하세요'));
      }
    }, POLL_MS);
  });
}

/**
 * Premiere Pro 연결 상태 확인
 */
async function ping() {
  try {
    const result = await executeScript(`
      return __result({
        connected: true,
        version: app.version,
        project: app.project ? app.project.name : null,
        sequence: app.project && app.project.activeSequence ? app.project.activeSequence.name : null
      });
    `);
    return result;
  } catch (e) {
    return { connected: false, error: e.message };
  }
}

/**
 * 활성 시퀀스의 캡션 트랙을 가져옵니다 (SRT 파일을 직접 읽는 방식)
 */
async function getCurrentSrtPath() {
  return await executeScript(`
    var root = app.project.rootItem;
    var srtFiles = [];
    for (var i = 0; i < root.children.numItems; i++) {
      var item = root.children[i];
      var p = "";
      try { p = item.getMediaPath(); } catch(e) {}
      if (p && p.toLowerCase().indexOf(".srt") >= 0) {
        srtFiles.push({name: item.name, path: p});
      }
    }
    return __result(srtFiles);
  `);
}

/**
 * SRT 파일을 임포트하고 캡션 트랙을 생성합니다.
 * 같은 경로의 기존 항목은 먼저 삭제 → 새로 임포트.
 */
async function importAndCreateCaption(srtPath) {
  return await executeScript(`
    var srtPath = ${JSON.stringify(srtPath)};
    var debug = [];

    // 1. 같은 경로의 기존 SRT 항목 삭제 (중복 방지)
    var root = app.project.rootItem;
    var toRemove = [];
    for (var i = 0; i < root.children.numItems; i++) {
      var p = "";
      try { p = root.children[i].getMediaPath(); } catch(e) {}
      if (p === srtPath) {
        toRemove.push(root.children[i]);
      }
    }
    debug.push("기존 SRT " + toRemove.length + "개 발견");
    for (var i = 0; i < toRemove.length; i++) {
      try {
        toRemove[i].deleteBin();
      } catch(e) {
        debug.push("삭제 실패: " + e.message);
      }
    }

    // 2. 새로 임포트
    var imported = app.project.importFiles([srtPath], true, app.project.rootItem, false);
    debug.push("임포트 결과: " + imported);

    // 3. 임포트된 항목 찾기
    var srtItem = null;
    for (var i = root.children.numItems - 1; i >= 0; i--) {
      var p = "";
      try { p = root.children[i].getMediaPath(); } catch(e) {}
      if (p === srtPath) {
        srtItem = root.children[i];
        break;
      }
    }
    if (!srtItem) return __error("SRT 항목을 찾을 수 없음. " + debug.join(" | "));
    debug.push("SRT 항목 찾음: " + srtItem.name);

    var seq = app.project.activeSequence;
    if (!seq) return __error("활성 시퀀스 없음");

    // 4. 캡션 트랙 생성 - 다양한 시그니처 시도
    var trackCreated = false;
    var lastErr = "";

    // 시도 1: createCaptionTrack(item, captionFormat, beforeIndex, replace)
    try {
      seq.createCaptionTrack(srtItem, 0, -1, false);
      trackCreated = true;
      debug.push("방식1 성공");
    } catch(e1) {
      lastErr = e1.message;
      // 시도 2: createCaptionTrack(item, captionFormat)
      try {
        seq.createCaptionTrack(srtItem, 0);
        trackCreated = true;
        debug.push("방식2 성공");
      } catch(e2) {
        lastErr = e2.message;
        // 시도 3: createCaptionTrack(item, "0", false)
        try {
          seq.createCaptionTrack(srtItem, "0", false);
          trackCreated = true;
          debug.push("방식3 성공");
        } catch(e3) {
          lastErr = e3.message;
          // 시도 4: createCaptionTrack(item)
          try {
            seq.createCaptionTrack(srtItem);
            trackCreated = true;
            debug.push("방식4 성공");
          } catch(e4) {
            lastErr = e4.message;
          }
        }
      }
    }

    if (!trackCreated) {
      return __error("캡션 트랙 생성 실패: " + lastErr + " | " + debug.join(" | "));
    }

    return __result({imported: true, path: srtPath, debug: debug});
  `);
}

/**
 * 무음 구간을 자동 컷합니다 (in/out + extract)
 */
async function autoSilenceCut(cuts) {
  return await executeScript(`
    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    var seqDOM = app.project.activeSequence;
    var TICKS = 254016000000;
    var cuts = ${JSON.stringify(cuts)};
    cuts.sort(function(a,b){ return b.start - a.start; });

    var success = 0;
    for (var i = 0; i < cuts.length; i++) {
      try {
        seqDOM.setInPoint(Math.round(cuts[i].start * TICKS).toString());
        seqDOM.setOutPoint(Math.round(cuts[i].end * TICKS).toString());
        qeSeq.extract();
        success++;
      } catch(e) {}
    }

    // 갭 닫기 (V1 + A1 동시)
    var v1 = seqDOM.videoTracks[0];
    var a1 = seqDOM.audioTracks[0];
    var moved = 0;
    for (var i = 0; i < v1.clips.numItems; i++) {
      var vClip = v1.clips[i];
      var aClip = a1.clips[i];
      var target = (i === 0) ? 0 : v1.clips[i-1].end.seconds;
      var shift = vClip.start.seconds - target;
      if (shift > 0.001) {
        try {
          vClip.move(-shift);
          if (aClip) aClip.move(-shift);
          moved++;
        } catch(e) {}
      }
    }

    return __result({cutSuccess: success, gapsClosed: moved, finalDuration: seqDOM.end / TICKS});
  `);
}

/**
 * 현재 시퀀스의 V1+A1 클립 구조를 가져옵니다.
 * Whisper용 오디오 조립에 사용됩니다.
 */
async function getSequenceClips() {
  return await executeScript(`
    var seq = app.project.activeSequence;
    if (!seq) return __error("활성 시퀀스 없음");

    var v1 = seq.videoTracks[0];
    var a1 = seq.audioTracks[0];
    var segments = [];

    // V1을 우선으로, 없으면 A1 사용
    var track = v1.clips.numItems > 0 ? v1 : a1;
    for (var c = 0; c < track.clips.numItems; c++) {
      var clip = track.clips[c];
      var src = "";
      try { src = clip.projectItem.getMediaPath(); } catch(e) {}
      segments.push({
        timelineStart: clip.start.seconds,
        timelineEnd: clip.end.seconds,
        sourceIn: clip.inPoint.seconds,
        sourceOut: clip.outPoint.seconds,
        sourcePath: src,
        name: clip.name
      });
    }

    return __result({
      sequenceName: seq.name,
      duration: seq.end / 254016000000,
      segments: segments
    });
  `);
}

/**
 * 시퀀스 정보 가져오기
 */
async function getSequenceInfo() {
  return await executeScript(`
    var seq = app.project.activeSequence;
    if (!seq) return __error("No active sequence");
    return __result({
      name: seq.name,
      duration: seq.end / 254016000000,
      videoTracks: seq.videoTracks.numTracks,
      audioTracks: seq.audioTracks.numTracks
    });
  `);
}

module.exports = {
  ping,
  executeScript,
  getCurrentSrtPath,
  importAndCreateCaption,
  autoSilenceCut,
  getSequenceInfo,
  getSequenceClips
};
