// SRT 파일 파서/생성기

function parseTime(timeStr) {
  const m = timeStr.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000;
}

function fmtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * SRT 파일 텍스트를 파싱하여 캡션 배열로 반환
 */
function parseSrt(srtText) {
  const blocks = srtText.split(/\n\s*\n/).filter(b => b.trim());
  const captions = [];

  blocks.forEach((block, idx) => {
    const lines = block.trim().split('\n');
    if (lines.length < 3) return;

    const timeMatch = lines[1].match(/([\d:,]+)\s*-->\s*([\d:,]+)/);
    if (!timeMatch) return;

    captions.push({
      id: idx + 1,
      start: parseTime(timeMatch[1]),
      end: parseTime(timeMatch[2]),
      text: lines.slice(2).join(' ').trim()
    });
  });

  return captions;
}

/**
 * 캡션 배열을 SRT 형식으로 직렬화
 */
function generateSrt(captions) {
  let output = '';
  captions.forEach((c, idx) => {
    output += `${idx + 1}\n`;
    output += `${fmtTime(c.start)} --> ${fmtTime(c.end)}\n`;
    output += `${c.text}\n\n`;
  });
  return output;
}

/**
 * 글자 수 단위로 자막 분할
 * @param {Array} wordTimestamps - Whisper 단어 타임스탬프 [{start, end, word}]
 *   제공 시 단어 경계에서 정확하게 분할 (정확도 ↑)
 */
function splitByLength(captions, maxLen = 26, wordTimestamps = []) {
  // 단어 타임스탬프 인덱스 (start time 기준 빠른 검색)
  const hasWords = wordTimestamps && wordTimestamps.length > 0;

  function findClosestWordTime(targetTime, captionStart, captionEnd) {
    if (!hasWords) return null;
    let closest = null;
    let minDiff = Infinity;
    for (const w of wordTimestamps) {
      if (w.start < captionStart || w.start > captionEnd) continue;
      const diff = Math.abs(w.start - targetTime);
      if (diff < minDiff) {
        minDiff = diff;
        closest = w;
      }
    }
    return closest;
  }

  const result = [];
  captions.forEach(c => {
    if (c.text.length <= maxLen) {
      result.push(c);
      return;
    }
    // 단어 단위로 청크 만들기
    const ws = c.text.split(' ');
    const chunks = [];
    let curr = '';
    ws.forEach(w => {
      if ((curr + ' ' + w).trim().length <= maxLen) {
        curr = (curr + ' ' + w).trim();
      } else {
        if (curr) chunks.push(curr);
        curr = w;
      }
    });
    if (curr) chunks.push(curr);

    // 시간 분할: 단어 타임스탬프가 있으면 정확하게, 없으면 비율로
    if (hasWords) {
      // 캡션 범위 내 단어들 가져오기
      const captionWords = wordTimestamps.filter(w =>
        w.start >= c.start - 0.05 && w.end <= c.end + 0.05
      );

      if (captionWords.length >= chunks.length) {
        // 각 청크의 텍스트 길이 비율로 단어 분배
        let wordIdx = 0;
        let chunkStartTime = c.start;

        chunks.forEach((chunk, ci) => {
          const chunkWordCount = Math.round((chunk.split(' ').length / ws.length) * captionWords.length);
          const endWordIdx = Math.min(wordIdx + chunkWordCount - 1, captionWords.length - 1);

          let chunkEnd;
          if (ci === chunks.length - 1) {
            chunkEnd = c.end;
          } else {
            // 다음 청크의 시작은 현재 청크의 마지막 단어 끝
            chunkEnd = captionWords[endWordIdx]?.end || (c.start + (c.end - c.start) * ((ci + 1) / chunks.length));
          }

          result.push({
            start: chunkStartTime,
            end: chunkEnd,
            text: chunk
          });

          chunkStartTime = chunkEnd;
          wordIdx = endWordIdx + 1;
        });
      } else {
        // 단어 정보 부족 → 비율 분할 fallback
        const dur = c.end - c.start;
        const chunkDur = dur / chunks.length;
        chunks.forEach((chunk, i) => {
          result.push({
            start: c.start + chunkDur * i,
            end: c.start + chunkDur * (i + 1),
            text: chunk
          });
        });
      }
    } else {
      // 단어 타임스탬프 없음 → 비율 분할
      const dur = c.end - c.start;
      const chunkDur = dur / chunks.length;
      chunks.forEach((chunk, i) => {
        result.push({
          start: c.start + chunkDur * i,
          end: c.start + chunkDur * (i + 1),
          text: chunk
        });
      });
    }
  });
  return result.map((c, i) => ({ ...c, id: i + 1 }));
}

/**
 * 자막 사이의 갭을 채워서 항상 자막이 표시되도록 함
 * (앞 자막의 end를 다음 자막의 start까지 연장)
 * @param {number} maxExtend - 한 자막을 최대 몇 초 연장 가능 (기본 5초)
 * @param {number} totalDuration - 영상 전체 길이 (마지막 자막 처리용)
 */
function fillGaps(captions, maxExtend = 5, totalDuration = null) {
  const result = captions.map(c => ({ ...c }));
  for (let i = 0; i < result.length - 1; i++) {
    const gap = result[i + 1].start - result[i].end;
    if (gap > 0 && gap <= maxExtend) {
      result[i].end = result[i + 1].start;
    }
  }
  // 마지막 자막을 영상 끝까지 (또는 +maxExtend초까지)
  if (result.length > 0 && totalDuration) {
    const last = result[result.length - 1];
    if (last.end < totalDuration) {
      last.end = Math.min(totalDuration, last.end + maxExtend);
    }
  }
  return result;
}

/**
 * 영상 전체 길이를 넘는 자막 잘라내기
 */
function clampToDuration(captions, totalDuration) {
  return captions
    .filter(c => c.start < totalDuration)
    .map(c => ({ ...c, end: Math.min(c.end, totalDuration) }));
}

module.exports = { parseTime, fmtTime, parseSrt, generateSrt, splitByLength, fillGaps, clampToDuration };
