// 사진 분석 모듈 (명세 1.1)
// 브라우저 캔버스만으로 사진별 지배 색상·평균 밝기·채도를 추출해
// 맵 팔레트(하늘/지면/구조물 색)를 만든다.
// AI 객체 인식(1.1.2)·EXIF(1.1.4)는 백엔드 단계에서 확장한다.

const SAMPLE_SIZE = 48;

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 불러올 수 없습니다.'));
    img.src = dataUrl;
  });
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

// 단일 사진 분석: 지배 색상(양자화 버킷 최빈값), 평균색, 밝기
export async function analyzePhoto(photo) {
  const img = await loadImage(photo.dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

  const buckets = new Map(); // 4bit/채널 양자화
  let sumR = 0, sumG = 0, sumB = 0, count = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    sumR += r; sumG += g; sumB += b; count++;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += r; bucket.g += g; bucket.b += b; bucket.n++;
    buckets.set(key, bucket);
  }

  // 극단적 무채색(거의 흰/검) 버킷은 지배색 후보에서 후순위로
  let best = null, bestScore = -1;
  for (const bucket of buckets.values()) {
    const r = bucket.r / bucket.n, g = bucket.g / bucket.n, b = bucket.b / bucket.n;
    const { s, l } = rgbToHsl(r, g, b);
    const chromaWeight = 0.35 + s * (1 - Math.abs(l - 0.5) * 1.4);
    const score = bucket.n * Math.max(0.05, chromaWeight);
    if (score > bestScore) {
      bestScore = score;
      best = { r, g, b };
    }
  }

  const avg = { r: sumR / count, g: sumG / count, b: sumB / count };
  const luminance = (0.299 * avg.r + 0.587 * avg.g + 0.114 * avg.b) / 255;

  return {
    dominant: best || avg,
    avg,
    luminance,
    hsl: rgbToHsl(best.r, best.g, best.b),
    width: img.naturalWidth,
    height: img.naturalHeight,
  };
}

function lighten(c, amount) {
  return {
    r: c.r + (255 - c.r) * amount,
    g: c.g + (255 - c.g) * amount,
    b: c.b + (255 - c.b) * amount,
  };
}

function darken(c, amount) {
  return { r: c.r * (1 - amount), g: c.g * (1 - amount), b: c.b * (1 - amount) };
}

function toHexNum(c) {
  return (Math.round(c.r) << 16) | (Math.round(c.g) << 8) | Math.round(c.b);
}

// 전체 사진 세트 → 맵 팔레트 (명세 1.2.2 배경/스카이박스 근거 데이터)
export function buildPalette(analyses) {
  const sorted = [...analyses].sort((a, b) => b.hsl.s - a.hsl.s);
  const vivid = sorted[0].dominant;
  const second = (sorted[1] || sorted[0]).dominant;

  const avgLum = analyses.reduce((s, a) => s + a.luminance, 0) / analyses.length;
  const isDusk = avgLum < 0.42; // 어두운 사진이 많으면 노을/저녁 무드

  const skyTop = isDusk ? darken(vivid, 0.45) : lighten(vivid, 0.35);
  const skyHorizon = isDusk ? lighten(second, 0.25) : lighten(second, 0.65);
  const groundBase = darken(analyses[0].avg, 0.55);

  const accents = sorted.slice(0, Math.min(6, sorted.length)).map((a) => toHexNum(a.dominant));

  return {
    skyTop: toHexNum(skyTop),
    skyHorizon: toHexNum(skyHorizon),
    ground: toHexNum(darken({ r: groundBase.r * 0.7 + 40, g: groundBase.g * 0.7 + 55, b: groundBase.b * 0.7 + 35 }, 0.1)),
    fog: toHexNum(isDusk ? darken(skyHorizon, 0.2) : skyHorizon),
    accents,
    isDusk,
    avgLuminance: avgLum,
  };
}

// 진행률 콜백과 함께 전체 세트 분석 (명세 1.3 진행 모니터링)
export async function analyzePhotos(photos, onProgress) {
  const results = [];
  for (let i = 0; i < photos.length; i++) {
    results.push(await analyzePhoto(photos[i]));
    onProgress?.((i + 1) / photos.length);
    // UI가 그려질 틈을 준다
    await new Promise((r) => setTimeout(r, 0));
  }
  return results;
}
