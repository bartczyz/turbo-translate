#!/usr/bin/env node
/**
 * Renders the toolbar icons (public/icon/{16,32,48,128}.png) without any image libraries:
 * a rounded square with a coral gradient and a white lightning bolt — same as src/assets/Logo.svelte.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icon');
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling per axis

// Geometry in a 32×32 design space.
const RADIUS = 8.5;
const BOLT = [
  [18.2, 4.8],
  [8.6, 18],
  [14.8, 18],
  [12.7, 27.2],
  [23.4, 13.4],
  [17.1, 13.4],
];
const FROM = [0xff, 0x8a, 0x4c];
const TO = [0xff, 0x3d, 0x6e];

function inRoundedSquare(x, y) {
  const cx = Math.min(Math.max(x, RADIUS), 32 - RADIUS);
  const cy = Math.min(Math.max(y, RADIUS), 32 - RADIUS);
  return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS ** 2 && x >= 0 && y >= 0 && x <= 32 && y <= 32;
}

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const scale = 32 / size;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let bg = 0;
      let bolt = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (pxl + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;
          if (inRoundedSquare(x, y)) {
            bg++;
            if (inPolygon(x, y, BOLT)) bolt++;
          }
        }
      }
      const n = SS * SS;
      const t = (pxl + py) / (2 * size);
      const grad = FROM.map((c, i) => c + (TO[i] - c) * t);
      const k = bolt / Math.max(bg, 1);
      const o = (py * size + pxl) * 4;
      px[o] = Math.round(grad[0] + (255 - grad[0]) * k);
      px[o + 1] = Math.round(grad[1] + (255 - grad[1]) * k);
      px[o + 2] = Math.round(grad[2] + (255 - grad[2]) * k);
      px[o + 3] = Math.round((bg / n) * 255);
    }
  }
  return png(size, size, px);
}

// --- Minimal PNG encoder (RGBA, 8-bit) ---
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
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const s of SIZES) writeFileSync(join(OUT, `${s}.png`), render(s));
console.log(`Wrote ${SIZES.map((s) => `${s}.png`).join(', ')} to public/icon/`);
