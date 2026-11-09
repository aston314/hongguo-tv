// Run only when the branding sources change; builds use the committed PNGs.
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require(process.env.HONGGUO_SHARP_MODULE || 'sharp');
const root = new URL('../', import.meta.url);
const file = path => fileURLToPath(new URL(path, root));
const square = await readFile(file('assets/branding/hongguo-icon-square.svg'));
const banner = await readFile(file('assets/branding/hongguo-tv-banner.svg'));

await mkdir(file('webos/resources'), { recursive: true });
await sharp(square).resize(1024, 1024).png().toFile(file('desktop/resources/appicon.png'));
// Preserve the existing macOS optical size (854px artwork in a 1024px canvas).
await sharp(square).resize(854, 854).extend({ top: 85, bottom: 85, left: 85, right: 85,
  background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(file('desktop/resources/appicon-macos.png'));
await sharp(square).resize(80, 80).png().toFile(file('webos/resources/icon.png'));
await sharp(square).resize(130, 130).png().toFile(file('webos/resources/largeIcon.png'));
await sharp(banner).resize(320, 180).flatten({ background: '#DB411E' }).png()
  .toFile(file('android/app/src/main/res/drawable-xhdpi/tv_banner.png'));
console.log('Rendered desktop, macOS, webOS and Android TV branding assets.');
