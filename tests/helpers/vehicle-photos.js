/**
 * Photos used for Images-tab uploads.
 *
 * Resolution order, so the suite runs on any machine:
 *   1. DMS_PHOTOS_DIR / DMS_JAGUAR_IMAGES / DMS_LANDROVER_IMAGES (comma separated)
 *   2. tests/fixtures/vehicle-photos inside this repo
 *   3. the original OneDrive folders, when they exist on this machine
 *   4. generated PNGs, so a fresh clone still uploads valid images
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// images.js only accepts image/jpeg, image/jpg and image/png.
const IMAGE_EXT = /\.(jpe?g|png)$/i;
const REPO_PHOTO_DIR = path.join(__dirname, '..', 'fixtures', 'vehicle-photos');
const ONEDRIVE_DIRS = [
  'c:\\Users\\Gayatri\\OneDrive\\Pictures\\Jaguar Latest',
  'c:\\Users\\Gayatri\\OneDrive\\Pictures\\Land Rover Images',
];
const GENERATED_COUNT = 16;

function splitDirs(value) {
  return String(value || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

function photoDirs() {
  const fromEnv = [
    ...splitDirs(process.env.DMS_PHOTOS_DIR),
    ...splitDirs(process.env.DMS_JAGUAR_IMAGES),
    ...splitDirs(process.env.DMS_LANDROVER_IMAGES),
  ];
  if (fromEnv.length) return fromEnv;
  return [REPO_PHOTO_DIR, ...ONEDRIVE_DIRS];
}

function listDirPhotos(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => IMAGE_EXT.test(name) && !/ - Copy/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try {
        const stat = fs.statSync(file);
        return stat.isFile() && stat.size > 0;
      } catch {
        return false;
      }
    });
}

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

/** Minimal truecolour PNG encoder — avoids shipping binaries in the repo. */
function makePng(width, height, rgbAt) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let pos = 0;
  for (let y = 0; y < height; y++) {
    raw[pos++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbAt(x, y);
      raw[pos++] = r;
      raw[pos++] = g;
      raw[pos++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function generatedDir() {
  const dir = path.join(process.cwd(), 'test-results', 'fixtures');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function generatePhoto(index) {
  const file = path.join(generatedDir(), `vehicle-${String(index + 1).padStart(2, '0')}.png`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  const width = 1024;
  const height = 768;
  const hue = (index * 37) % 256;
  fs.writeFileSync(file, makePng(width, height, (x, y) => [
    (hue + ((x / width) * 90)) & 0xff,
    (120 + ((y / height) * 90)) & 0xff,
    (200 - ((x / width) * 60)) & 0xff,
  ]));
  return file;
}

function generatedPhotos(count = GENERATED_COUNT) {
  return Array.from({ length: count }, (_, i) => generatePhoto(i));
}

function dummyImagePath() {
  return generatePhoto(0);
}

let cachedPhotos = null;
let photoIndex = 0;

function vehiclePhotos() {
  if (cachedPhotos) return cachedPhotos;

  const dirs = photoDirs();
  const found = dirs.map((dir) => ({ dir, files: listDirPhotos(dir) })).filter((d) => d.files.length);

  const mixed = [];
  const max = Math.max(0, ...found.map((d) => d.files.length));
  for (let i = 0; i < max; i++) {
    for (const { files } of found) {
      if (files[i]) mixed.push(files[i]);
    }
  }

  if (mixed.length) {
    cachedPhotos = mixed;
    console.log(`  Vehicle photos: ${mixed.length} from ${found.map((d) => path.basename(d.dir)).join(' + ')}`);
  } else {
    cachedPhotos = generatedPhotos();
    console.log(`  Vehicle photos: no folder found (${dirs.join(' | ')}) — using ${cachedPhotos.length} generated photos. Set DMS_PHOTOS_DIR to use your own.`);
  }
  return cachedPhotos;
}

function nextVehiclePhoto() {
  const photos = vehiclePhotos();
  const file = photos[photoIndex % photos.length];
  photoIndex += 1;
  return file;
}

module.exports = {
  dummyImagePath,
  vehiclePhotos,
  nextVehiclePhoto,
  photoDirs,
};
