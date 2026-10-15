// Bake the subtle panel grain once; runtime SVG feTurbulence repaints are expensive.
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const size = 180, pixels = Buffer.alloc(size * (size * 4 + 1));
let seed = 1963024;
for (let y = 0; y < size; y++) {
  const row = y * (size * 4 + 1); pixels[row] = 0;
  for (let x = 0; x < size; x++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const shade = 68 + (seed >>> 24) * .46, i = row + 1 + x * 4;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = Math.round(shade); pixels[i + 3] = 7;
  }
}
function chunk(type, data) {
  const name = Buffer.from(type), body = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'), chunk('IHDR',header), chunk('IDAT',zlib.deflateSync(pixels)), chunk('IEND',Buffer.alloc(0))]);
fs.mkdirSync(path.join(__dirname,'assets'),{recursive:true}); fs.writeFileSync(path.join(__dirname,'assets/panel-noise.png'),png);
process.stdout.write(`Static panel grain: ${size}×${size}, ${png.length} bytes\n`);
