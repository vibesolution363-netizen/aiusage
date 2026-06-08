/*
 * make-icon.js
 * Generates assets/icon.ico (multi-size) and assets/icon.png (256px) from
 * scratch using only Node built-ins (zlib). No external image libraries.
 *
 * The icon is an amber -> red rounded square with a white lightning bolt,
 * matching the dock's header badge.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- CRC32 (for PNG chunks) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- PNG encoder (RGBA, 8-bit) ----------
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- ICO container (PNG entries) ----------
function encodeIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const datas = [];

  images.forEach((img, i) => {
    const e = i * 16;
    entries[e] = img.size >= 256 ? 0 : img.size; // width (0 == 256)
    entries[e + 1] = img.size >= 256 ? 0 : img.size; // height
    entries[e + 2] = 0; // color palette
    entries[e + 3] = 0; // reserved
    entries.writeUInt16LE(1, e + 4); // color planes
    entries.writeUInt16LE(32, e + 6); // bits per pixel
    entries.writeUInt32LE(img.png.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += img.png.length;
    datas.push(img.png);
  });

  return Buffer.concat([header, entries, ...datas]);
}

// ---------- Drawing helpers ----------
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

// Rounded-rect signed distance test (inside if distance from inner rect <= r).
function inRoundRect(x, y, S) {
  const m = S * 0.05; // outer margin (transparent)
  const r = S * 0.24; // corner radius
  const nx = clamp(x, m + r, S - m - r);
  const ny = clamp(y, m + r, S - m - r);
  const dx = x - nx;
  const dy = y - ny;
  return dx * dx + dy * dy <= r * r;
}

// Lightning bolt polygon in normalized [0,1] coordinates.
const BOLT = [
  [0.58, 0.10],
  [0.31, 0.53],
  [0.47, 0.53],
  [0.40, 0.90],
  [0.73, 0.45],
  [0.55, 0.45],
  [0.65, 0.10],
];

function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function renderRGBA(S) {
  const buf = Buffer.alloc(S * S * 4);
  // amber #f59e0b -> red #ef4444
  const A = [245, 158, 11];
  const B = [239, 68, 68];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      if (!inRoundRect(x + 0.5, y + 0.5, S)) {
        buf[i + 3] = 0; // transparent outside the badge
        continue;
      }
      const t = clamp((x + y) / (2 * S), 0, 1);
      let r = lerp(A[0], B[0], t);
      let g = lerp(A[1], B[1], t);
      let b = lerp(A[2], B[2], t);
      if (pointInPoly((x + 0.5) / S, (y + 0.5) / S, BOLT)) {
        r = 255;
        g = 252;
        b = 245;
      }
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

// ---------- Main ----------
function main() {
  const assetsDir = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map((size) => ({ size, png: encodePng(size, size, renderRGBA(size)) }));

  const ico = encodeIco(images);
  fs.writeFileSync(path.join(assetsDir, 'icon.ico'), ico);

  // 256px PNG for the system tray / window use.
  const png256 = images[images.length - 1].png;
  fs.writeFileSync(path.join(assetsDir, 'icon.png'), png256);

  console.log(`icon.ico (${ico.length} bytes, ${sizes.length} sizes) and icon.png written to assets/`);
}

main();
