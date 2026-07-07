// 업로드 이미지 전처리
// 원본(최대 10MB) dataURL을 그대로 들고 있으면 메모리 낭비 + 팝업 표시 시
// 대용량 디코드로 프레임 드랍이 생긴다. 업로드 시점에 두 가지 크기로
// 리사이즈해 두고 원본은 버린다.
//  - thumbUrl(480px): 갤러리·추억 팝업 등 DOM 표시용
//  - textureUrl(1024px): 3D 액자/홀로그램 텍스처용

const THUMB_MAX = 480;
const TEXTURE_MAX = 1024;

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('파일을 읽을 수 없습니다.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 불러올 수 없습니다.'));
    img.src = url;
  });
}

function resizeToDataUrl(img, maxWidth) {
  const scale = Math.min(1, maxWidth / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.82);
}

export async function processImageFile(file) {
  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);
  return {
    thumbUrl: resizeToDataUrl(img, THUMB_MAX),
    textureUrl: resizeToDataUrl(img, TEXTURE_MAX),
    width: img.naturalWidth,
    height: img.naturalHeight,
  };
}
