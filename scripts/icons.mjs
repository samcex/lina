// Reproduce BrandMark's orbit geometry with the dark CSS tokens. No image tools or downloads.
// Run: node scripts/icons.mjs (PNGs are checked in; this is not a build prerequisite).
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const dir = new URL('../web/public/icons/', import.meta.url);
mkdirSync(dir, { recursive: true });
const bg = [13, 15, 23], iris = [154, 139, 255], hi = [198, 189, 255];
writeFileSync(new URL('lina.svg', dir), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#0d0f17"/>
  <defs><radialGradient id="core" cx="50%" cy="40%" r="60%"><stop stop-color="#c6bdff"/><stop offset="1" stop-color="#9a8bff"/></radialGradient></defs>
  <ellipse cx="16" cy="16" rx="12" ry="5.2" fill="none" stroke="#9a8bff" stroke-opacity=".5" stroke-width="1.4" transform="rotate(-30 16 16)"/>
  <circle cx="5.6" cy="22" r="2.8" fill="#4fd7e4"/>
  <circle cx="26.4" cy="10" r="2.8" fill="#ff9e6b"/>
  <path d="M16 11.2 20.8 16 16 20.8 11.2 16Z" fill="url(#core)"/>
</svg>
`);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, crc]);
}
function pixel(x, y) {
  const dx = x - 16, dy = y - 16;
  const u = Math.sqrt(3) / 2 * dx - dy / 2, v = dx / 2 + Math.sqrt(3) / 2 * dy;
  const distance = Math.abs(u * u / 144 + v * v / 27.04 - 1)
    / (2 * Math.hypot(u / 144, v / 27.04));
  let color = distance <= .7 ? bg.map((c, i) => (c + iris[i]) / 2) : bg;
  if (Math.hypot(x - 5.6, y - 22) <= 2.8) color = [79, 215, 228];
  if (Math.hypot(x - 26.4, y - 10) <= 2.8) color = [255, 158, 107];
  if (Math.abs(dx) + Math.abs(dy) <= 4.8) {
    const t = Math.min(1, Math.hypot(dx, dy + .96) / 5.76);
    color = hi.map((c, i) => c + (iris[i] - c) * t);
  }
  return color;
}
function png(size, scale) {
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const color = [0, 0, 0];
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const c = pixel(((x + (sx + .5) / 4) / size * 32 - 16) / scale + 16,
          ((y + (sy + .5) / 4) / size * 32 - 16) / scale + 16);
        for (let i = 0; i < 3; i++) color[i] += c[i] / 16;
      }
      for (let i = 0; i < 3; i++) raw[y * (size * 3 + 1) + 1 + x * 3 + i] = Math.round(color[i]);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const size of [192, 512]) writeFileSync(new URL(`lina-${size}.png`, dir), png(size, 1));
// Entire orbit lies inside the central 80% diameter maskable safe circle.
writeFileSync(new URL('lina-maskable-512.png', dir), png(512, .8));
