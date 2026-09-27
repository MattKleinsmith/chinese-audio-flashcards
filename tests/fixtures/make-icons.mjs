// Generates site/icons/icon-192.png and icon-512.png: a rounded square in the accent colour with
// a white play-circle glyph. Pure Node (zlib), no dependencies. `node tests/fixtures/make-icons.mjs`.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const ACCENT = [0xb9, 0xa6, 0xe6];
const GLYPH = [0x2a, 0x1f, 0x45];
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = size * 0.22, cx = size / 2, cy = size / 2, cr = size * 0.28; // corner radius, play circle
  const tri = [[cx - cr * 0.42, cy - cr * 0.55], [cx - cr * 0.42, cy + cr * 0.55], [cx + cr * 0.6, cy]];
  const inTri = (x, y) => { const [[ax, ay], [bx, by], [px, py]] = tri; const d = (bx - ax) * (py - ay) - (px - ax) * (by - ay); const s1 = (bx - ax) * (y - ay) - (x - ax) * (by - ay); const s2 = (px - bx) * (y - by) - (x - bx) * (py - by); const s3 = (ax - px) * (y - py) - (x - px) * (ay - py); return d > 0 ? s1 >= 0 && s2 >= 0 && s3 >= 0 : s1 <= 0 && s2 <= 0 && s3 <= 0; };
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      // rounded square mask
      const dx = Math.max(r - px, px - (size - r), 0), dy = Math.max(r - py, py - (size - r), 0);
      const inside = dx * dx + dy * dy <= r * r;
      let rgba = [0, 0, 0, 0];
      if (inside) {
        const d = Math.hypot(px - cx, py - cy);
        rgba = d <= cr ? (inTri(px, py) ? [...ACCENT, 255] : [...GLYPH, 255]) : [...ACCENT, 255];
      }
      raw.set(rgba, y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const size of [192, 512]) writeFileSync(new URL(`../../site/icons/icon-${size}.png`, import.meta.url), png(size));
console.log('icons written');
