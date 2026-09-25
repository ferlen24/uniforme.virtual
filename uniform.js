// Uniforme real recortado de fotos (gorra y chaqueta por separado).
// Las medidas están en píxeles de la foto original; SCALE es la reducción aplicada a los .webp.

const SCALE = 0.7;

const META = {
  m: {
    eyes: [707.5, 662.5], d: 215.06, visorY: 566, neckY: 1040,
    cap: [361, 189, 703, 429], body: [0, 992, 1401, 1008],
    plate: { center: [506.5, 1532.5], w: 127, h: 61, angle: -0.016 },
  },
  f: {
    eyes: [632.5, 638.5], d: 195.02, visorY: 526, neckY: 1000,
    cap: [287, 162, 696, 438], body: [0, 934, 1266, 1066],
    plate: { center: [344.5, 1477.5], w: 131, h: 57, angle: -0.106 },
  },
};

const assets = {};

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Difumina los costados (las mangas están cortadas en la foto) y estira el borde
// inferior para que la chaqueta no se corte cuando la persona está lejos.
function extendBody(img) {
  const iw = img.width, ih = img.height, padY = ih;
  const c = document.createElement('canvas');
  c.width = iw;
  c.height = ih + padY;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  x.drawImage(img, 0, ih - 2, iw, 1, 0, ih - 1, iw, padY + 1);
  const fade = x.createLinearGradient(0, 0, iw, 0);
  fade.addColorStop(0, 'rgba(0,0,0,1)');
  fade.addColorStop(0.07, 'rgba(0,0,0,0)');
  fade.addColorStop(0.93, 'rgba(0,0,0,0)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  x.globalCompositeOperation = 'destination-out';
  x.fillStyle = fade;
  x.fillRect(0, 0, iw, c.height);
  return { canvas: c, padY: padY / SCALE };
}

export const uniformsReady = Promise.all(Object.keys(META).map(async g => {
  const [cap, body] = await Promise.all([
    loadImage(`assets/gorra-${g}.webp`),
    loadImage(`assets/chaqueta-${g}.webp`),
  ]);
  assets[g] = { cap, body: extendBody(body) };
}));

function softShadow(c, x, y, rx, ry, alpha) {
  c.save();
  c.translate(x, y);
  c.scale(rx, ry);
  const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, `rgba(0,0,0,${alpha})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g;
  c.beginPath();
  c.arc(0, 0, 1, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

function plateText(c, p, surname, role) {
  const lines = [
    [surname, -0.27, 0.3, '800'],
    [role, -0.02, 0.17, '700'],
    ['I.E.S.P', 0.2, 0.15, '700'],
    ['Ntra. Sra. del Carmen', 0.39, 0.16, '600'],
  ];
  c.save();
  c.translate(p.center[0], p.center[1]);
  c.rotate(p.angle);
  c.fillStyle = '#f1f1ef';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (const [str, dy, size, weight] of lines) {
    if (!str) continue;
    c.font = `${weight} ${size * p.h}px "Arial Narrow", Arial, sans-serif`;
    const maxW = p.w * 0.9, m = c.measureText(str).width;
    c.save();
    c.translate(0, dy * p.h);
    if (m > maxW) c.scale(maxW / m, 1);
    c.fillText(str, 0, 0);
    c.restore();
  }
  c.restore();
}

// pose: { x, y, d, roll } en píxeles del canvas. opts: { gender: 'm'|'f', surname }.
export function drawUniform(c, pose, opts) {
  const g = opts.gender === 'f' ? 'f' : 'm';
  const a = assets[g], m = META[g];
  if (!a) return;
  const s = pose.d / m.d;
  const [ex, ey] = m.eyes;

  // chaqueta: acompaña sólo un poco la inclinación de la cabeza
  c.save();
  c.translate(pose.x, pose.y);
  c.rotate(pose.roll);
  c.scale(s, s);
  c.translate(0, m.neckY - ey);
  c.rotate(-pose.roll * 0.7);
  c.translate(-ex, -m.neckY);
  const [bx, by, bw, bh] = m.body, b = a.body;
  // un poco más ancha que la foto original para cubrir hombros anchos
  c.translate(ex, 0);
  c.scale(1.1, 1);
  c.translate(-ex, 0);
  c.drawImage(b.canvas, bx, by, bw, bh + b.padY);
  plateText(c, m.plate, opts.surname || 'CADETE', opts.surname ? 'CADETE' : 'ASPIRANTE');
  c.restore();

  // gorra
  c.save();
  c.translate(pose.x, pose.y);
  c.rotate(pose.roll);
  c.scale(s, s);
  c.translate(-ex, -ey);
  softShadow(c, ex, m.visorY + 22, m.cap[2] * 0.4, 45, 0.35);
  const [cx, cy, cw, ch] = m.cap;
  c.drawImage(a.cap, cx, cy, cw, ch);
  c.restore();
}
