import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'dist');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(path.join(root, 'extension'), destination, { recursive: true });
for (const name of ['core', 'policy', 'adapters', 'content']) {
  await cp(path.join(root, 'src', `${name}.js`), path.join(destination, `${name}.js`));
}

// Small dependency-free PNG generator for the extension's original shield mark.
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
function inside(x, y, points) {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [a, b] = points[i], [c, d] = points[j];
    if ((b > y) !== (d > y) && x < (c - a) * (y - b) / (d - b) + a) hit = !hit;
  }
  return hit;
}
function icon(size) {
  const outer = [[.5,.05],[.88,.20],[.85,.59],[.73,.79],[.5,.95],[.27,.79],[.15,.59],[.12,.20]];
  const inner = outer.map(([x,y]) => [.5 + (x-.5)*.76, .49 + (y-.49)*.76]);
  const check = [[.30,.47],[.43,.60],[.70,.33],[.75,.38],[.43,.71],[.25,.53]];
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    let covered = 0;
    for (let yy = 0; yy < 4; yy++) for (let xx = 0; xx < 4; xx++) {
      const x = (col+(xx+.5)/4)/size, y = (row+(yy+.5)/4)/size;
      if ((inside(x,y,outer) && !inside(x,y,inner)) || inside(x,y,check)) covered++;
    }
    const offset = row * (1+size*4) + 1 + col*4;
    raw.set([145 + Math.round(30*(1-row/size)), 223, 181 + Math.round(25*(1-row/size)), Math.round(covered/16*255)], offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size,4); header[8]=8; header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',header), chunk('IDAT',deflateSync(raw)), chunk('IEND',Buffer.alloc(0))]);
}
await mkdir(path.join(destination, 'icons'), { recursive: true });
for (const size of [16,48,128]) await writeFile(path.join(destination, 'icons', `shield-${size}.png`), icon(size));
const manifest = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
console.log(`Built SecretShield ${manifest.version} → ${destination}`);
