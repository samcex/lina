// Small, zero-dependency QR Model 2 byte encoder: versions 1–5, level L.
// All use one Reed–Solomon block; version 5 fits the daemon's 64-hex-token URL.
// Format/placement reference: https://www.nayuki.io/page/qr-code-generator-library
// Deliberately bounded: fail rather than silently truncate an oversized payload.
const DATA = [19, 34, 55, 80, 108];
const ECC = [7, 10, 15, 20, 26];

function multiply(a: number, b: number): number {
  let product = 0;
  while (b) {
    if (b & 1) product ^= a;
    a <<= 1;
    if (a & 256) a ^= 0x11d;
    b >>>= 1;
  }
  return product;
}

function parity(data: number[], count: number): number[] {
  let generator = [1], root = 1;
  for (let i = 0; i < count; i++) {
    const next = Array<number>(generator.length + 1).fill(0);
    generator.forEach((value, j) => { next[j] ^= value; next[j + 1] ^= multiply(value, root); });
    generator = next;
    root = multiply(root, 2);
  }
  const remainder = [...data, ...Array<number>(count).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const factor = remainder[i];
    generator.forEach((value, j) => { remainder[i + j] ^= multiply(value, factor); });
  }
  return remainder.slice(-count);
}

const MASKS = [
  (x: number, y: number) => (x + y) % 2 === 0,
  (_x: number, y: number) => y % 2 === 0,
  (x: number, _y: number) => x % 3 === 0,
  (x: number, y: number) => (x + y) % 3 === 0,
  (x: number, y: number) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x: number, y: number) => x * y % 2 + x * y % 3 === 0,
  (x: number, y: number) => (x * y % 2 + x * y % 3) % 2 === 0,
  (x: number, y: number) => ((x + y) % 2 + x * y % 3) % 2 === 0,
];

function penalty(grid: boolean[][]): number {
  const size = grid.length;
  let score = 0, dark = 0;
  for (let y = 0; y < size; y++) {
    const lines = [grid[y], grid.map((row) => row[y])];
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i < size; i++) {
        if (line[i] === line[i - 1]) { run++; if (run >= 5) score += run === 5 ? 3 : 1; }
        else run = 1;
      }
      const bits = line.map(Number).join('');
      for (let i = 0; i <= size - 11; i++) {
        if (['00001011101', '10111010000'].includes(bits.slice(i, i + 11))) score += 40;
      }
    }
    for (let x = 0; x < size; x++) {
      if (grid[y][x]) dark++;
      if (x && y && grid[y][x] === grid[y - 1][x] && grid[y][x] === grid[y][x - 1]
        && grid[y][x] === grid[y - 1][x - 1]) score += 3;
    }
  }
  return score + Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
}

export function qrMatrix(text: string): boolean[][] {
  const bytes = Buffer.from(text, 'utf8');
  const index = DATA.findIndex((capacity) => bytes.length * 8 + 12 <= capacity * 8);
  if (index < 0) throw new RangeError('QR payload exceeds 106 bytes; use lina ui --url instead.');
  const version = index + 1, size = version * 4 + 17;
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(4, 4); append(bytes.length, 8);
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, DATA[index] * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, bit) => n * 2 + bit, 0));
  for (let pad = 0; data.length < DATA[index]; pad++) data.push(pad % 2 ? 0x11 : 0xec);
  const codewords = [...data, ...parity(data, ECC[index])];
  const grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const reserved = grid.map((row) => [...row]);
  const mark = (x: number, y: number, dark: boolean) => { grid[y][x] = dark; reserved[y][x] = true; };
  for (let i = 0; i < size; i++) { mark(i, 6, i % 2 === 0); mark(6, i, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) mark(x, y, d !== 2 && d !== 4);
    }
  }
  if (version > 1) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      mark(size - 7 + dx, size - 7 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const format = (mask: number) => {
    const value = 8 | mask; // Level L = 01.
    let remainder = value;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const word = ((value << 10) | remainder) ^ 0x5412;
    const bit = (i: number) => Boolean((word >>> i) & 1);
    const first = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    first.forEach(([x, y], i) => mark(x, y, bit(i)));
    for (let i = 0; i < 15; i++) {
      if (i < 8) mark(size - 1 - i, 8, bit(i));
      else mark(8, size - 15 + i, bit(i));
    }
    mark(8, size - 8, true);
  };
  format(0);
  let cursor = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const y = ((right + 1) & 2) === 0 ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (reserved[y][x]) continue;
        grid[y][x] = Boolean((codewords[cursor >>> 3] >>> (7 - (cursor & 7))) & 1);
        cursor++;
      }
    }
  }
  const unmasked = grid.map((row) => [...row]);
  let best = grid, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (!reserved[y][x]) grid[y][x] = unmasked[y][x] !== MASKS[mask](x, y);
    }
    format(mask);
    const score = penalty(grid);
    if (score < bestScore) { bestScore = score; best = grid.map((row) => [...row]); }
  }
  return best;
}

/** Two vertical modules per terminal cell, with a four-module quiet zone.
 * Explicit black/white ANSI colours keep the code scannable on either terminal theme. */
export function terminalQr(text: string): string {
  const grid = qrMatrix(text), size = grid.length + 8;
  const dark = (x: number, y: number) => grid[y - 4]?.[x - 4] ?? false;
  const rows: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let row = '\x1b[30;107m';
    for (let x = 0; x < size; x++) row += dark(x, y) ? (dark(x, y + 1) ? '█' : '▀') : (dark(x, y + 1) ? '▄' : ' ');
    rows.push(row + '\x1b[0m');
  }
  return rows.join('\n');
}
