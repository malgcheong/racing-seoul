// 샘플 사진 생성기 — 실제 사진 없이도 기능을 체험할 수 있도록
// 캔버스로 여행 사진 느낌의 그라디언트+실루엣 이미지를 만든다.

const SCENES = [
  { name: '제주 바다 2024', top: '#7ec8e3', bottom: '#f7e8c8', shapes: 'sea' },
  { name: '강릉 노을 드라이브', top: '#ff9a6c', bottom: '#5c3a6e', shapes: 'sunset' },
  { name: '남산 야경 데이트', top: '#1a1f4a', bottom: '#3d2f66', shapes: 'city' },
  { name: '봄 벚꽃 나들이', top: '#ffd3e0', bottom: '#c9ecc4', shapes: 'trees' },
  { name: '가을 단풍 산행', top: '#ffb347', bottom: '#8c3b1f', shapes: 'trees' },
  { name: '한강 피크닉', top: '#a8d8ff', bottom: '#7bc47f', shapes: 'sea' },
  { name: '부산 광안리 불꽃', top: '#151a35', bottom: '#2c4a7c', shapes: 'city' },
  { name: '카페 브런치', top: '#f2e3cf', bottom: '#c9a878', shapes: 'food' },
];

function drawScene(ctx, w, h, scene, rand) {
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, scene.top);
  grad.addColorStop(1, scene.bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  ctx.globalAlpha = 0.8;
  if (scene.shapes === 'city') {
    for (let i = 0; i < 12; i++) {
      const bw = 30 + rand() * 50;
      const bh = 60 + rand() * 160;
      ctx.fillStyle = 'rgba(10,12,28,0.9)';
      ctx.fillRect(i * (w / 12), h - bh, bw, bh);
      ctx.fillStyle = '#ffd76a';
      for (let win = 0; win < 6; win++) {
        if (rand() > 0.5) ctx.fillRect(i * (w / 12) + 6 + (win % 2) * 14, h - bh + 10 + Math.floor(win / 2) * 22, 8, 10);
      }
    }
  } else if (scene.shapes === 'sunset') {
    ctx.fillStyle = '#fff3b8';
    ctx.beginPath();
    ctx.arc(w * 0.6, h * 0.55, 50, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(30,15,40,0.85)';
    ctx.fillRect(0, h * 0.75, w, h * 0.25);
  } else if (scene.shapes === 'sea') {
    ctx.fillStyle = 'rgba(30,90,140,0.7)';
    ctx.fillRect(0, h * 0.6, w, h * 0.4);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 3;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      const y = h * 0.65 + i * 20;
      ctx.moveTo(0, y);
      for (let x = 0; x <= w; x += 40) ctx.quadraticCurveTo(x + 20, y - 8, x + 40, y);
      ctx.stroke();
    }
  } else if (scene.shapes === 'trees') {
    for (let i = 0; i < 8; i++) {
      const x = rand() * w;
      const size = 30 + rand() * 50;
      ctx.fillStyle = 'rgba(60,30,20,0.9)';
      ctx.fillRect(x - 4, h - 80, 8, 80);
      ctx.fillStyle = `rgba(${180 + rand() * 60},${80 + rand() * 90},${60 + rand() * 60},0.85)`;
      ctx.beginPath();
      ctx.arc(x, h - 90 - size / 2, size, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (scene.shapes === 'food') {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(w / 2, h * 0.62, 130, 60, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e8933a';
    ctx.beginPath();
    ctx.ellipse(w / 2, h * 0.6, 95, 42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#7a3b1d';
    for (let i = 0; i < 8; i++) {
      ctx.beginPath();
      ctx.arc(w / 2 - 70 + rand() * 140, h * 0.6 - 20 + rand() * 40, 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // 라벨
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = 'bold 26px sans-serif';
  ctx.fillText(scene.name, 20, 40);
}

export function generateDemoPhotos(count = 8) {
  const photos = [];
  let seed = 12345;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  for (let i = 0; i < count; i++) {
    const scene = SCENES[i % SCENES.length];
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 384;
    drawScene(canvas.getContext('2d'), 512, 384, scene, rand);
    const url = canvas.toDataURL('image/jpeg', 0.85);
    photos.push({
      id: `demo-${i}`,
      thumbUrl: url,   // 512px이라 썸네일/텍스처 겸용
      textureUrl: url,
      width: 512,
      height: 384,
      name: `${scene.name}.jpg`,
      memo: scene.name,
      selected: true,
    });
  }
  return photos;
}
