// Genera un PNG 1024x1024 con el ícono de Bridges: telaraña roja (#FF0033) sobre fondo oscuro.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";

const S = 1024;
const buf = Buffer.alloc(S * S * 4);

const bg = [24, 24, 27]; // zinc-900
const web = [255, 0, 51]; // #FF0033

function set(x, y, c) {
  const i = (y * S + x) * 4;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
  buf[i + 3] = 255;
}

// fondo
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) set(x, y, bg);

// dibuja un segmento con grosor `r` y borde suave (AA), mezclando web sobre lo que haya.
function blend(x, y, t) {
  if (t <= 0) return;
  if (t > 1) t = 1;
  const i = (y * S + x) * 4;
  buf[i] = Math.round(buf[i] * (1 - t) + web[0] * t);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - t) + web[1] * t);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - t) + web[2] * t);
}

function segment(x0, y0, x1, y1, r) {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - r - 1));
  const maxX = Math.min(S - 1, Math.ceil(Math.max(x0, x1) + r + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - r - 1));
  const maxY = Math.min(S - 1, Math.ceil(Math.max(y0, y1) + r + 1));
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let tproj = ((x - x0) * dx + (y - y0) * dy) / len2;
      if (tproj < 0) tproj = 0; else if (tproj > 1) tproj = 1;
      const px = x0 + tproj * dx, py = y0 + tproj * dy;
      const dist = Math.hypot(x - px, y - py);
      blend(x, y, r + 0.5 - dist); // borde suave de ~1px
    }
  }
}

function disc(cx, cy, r) {
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      if (x < 0 || y < 0 || x >= S || y >= S) continue;
      blend(x, y, r + 0.5 - Math.hypot(x - cx, y - cy));
    }
  }
}

const cx = 512, cy = 512;
const N = 12;                 // radios
const A0 = -Math.PI / 2;      // primer radio apuntando hacia arriba
const step = (2 * Math.PI) / N;
const Rout = 478;
const rings = [82, 162, 242, 322, 402, 470];

const pt = (k, r) => [cx + r * Math.cos(A0 + k * step), cy + r * Math.sin(A0 + k * step)];

// radios (spokes)
for (let k = 0; k < N; k++) {
  const [ex, ey] = pt(k, Rout);
  segment(cx, cy, ex, ey, 5.5);
}

// anillos: polígono que une radios adyacentes a cada radio (look de tela orbicular)
for (const r of rings) {
  for (let k = 0; k < N; k++) {
    const [ax, ay] = pt(k, r);
    const [bx, by] = pt((k + 1) % N, r);
    segment(ax, ay, bx, by, 4.5);
  }
}

// hub central
disc(cx, cy, 11);

// --- PNG encode ---
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crcBuf]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = deflateSync(raw, { level: 9 });

const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
writeFileSync(new URL("./icon-src.png", import.meta.url), png);
console.log("icon-src.png escrito:", png.length, "bytes");
