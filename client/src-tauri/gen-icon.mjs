// Genera un PNG 1024x1024 con el ícono base de Forge (yunque estilizado sobre fondo oscuro).
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";

const S = 1024;
const buf = Buffer.alloc(S * S * 4);

// Fondo (dark slate) + un "anvil"/bloque claro centrado.
const bg = [24, 24, 27, 255]; // zinc-900
const fg = [250, 250, 250, 255]; // near white

function set(x, y, c) {
  const i = (y * S + x) * 4;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
  buf[i + 3] = c[3];
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) set(x, y, bg);
}

// Yunque simple: cuerpo trapezoidal + base.
function rect(x0, y0, x1, y1) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, fg);
}
// top
rect(260, 360, 764, 460);
// cuerno (lado izq inclinado) aproximado con escalones
for (let y = 360; y < 460; y++) {
  const ext = Math.round((460 - y) * 1.4);
  rect(260 - ext, y, 260, y + 1);
}
// cuello
rect(440, 460, 584, 600);
// base
rect(320, 600, 704, 680);

// PNG encode
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

// filtro 0 por scanline
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = deflateSync(raw, { level: 9 });

const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
writeFileSync(new URL("./icon-src.png", import.meta.url), png);
console.log("icon-src.png escrito:", png.length, "bytes");
