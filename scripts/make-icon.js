// Gera o ícone do app (PNG) sem dependências externas.
// Uso: node scripts/make-icon.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- Formas (coordenadas de 0 a 1) ----
function inRoundedRect(x, y) {
  const inset = 0.04, r = 0.22, half = 0.5 - inset;
  const qx = Math.abs(x - 0.5) - (half - r);
  const qy = Math.abs(y - 0.5) - (half - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r <= 0;
}
function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const TAIL = [[0.30, 0.63], [0.43, 0.73], [0.23, 0.81]];
const BOLT = [[0.56, 0.26], [0.39, 0.51], [0.49, 0.51], [0.44, 0.68], [0.62, 0.42], [0.52, 0.42], [0.60, 0.26]];
const inBubble = (x, y) => Math.hypot(x - 0.5, y - 0.47) <= 0.29 || inPolygon(x, y, TAIL);

const TOP = [0x2b, 0xd4, 0x6e];
const BOTTOM = [0x0b, 0x86, 0x6a];
function bgColor(x, y) {
  const t = Math.min(1, Math.max(0, y * 0.85 + x * 0.15));
  return TOP.map((c, i) => c + (BOTTOM[i] - c) * t);
}

function render(size) {
  const SS = 4; // supersampling para bordas suaves
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!inRoundedRect(x, y)) continue;
          let col = bgColor(x, y);
          if (inBubble(x, y) && !inPolygon(x, y, BOLT)) col = [255, 255, 255];
          r += col[0]; g += col[1]; b += col[2]; a += 1;
        }
      }
      const i = (py * size + px) * 4;
      const n = SS * SS;
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePng(size, out);
}

const root = path.join(__dirname, '..');
const targets = [
  [path.join(root, 'build', 'icon.png'), 512],
  [path.join(root, 'src', 'assets', 'icon.png'), 256],
];
for (const [file, size] of targets) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, render(size));
  console.log(`ícone gerado: ${path.relative(root, file)} (${size}px)`);
}
