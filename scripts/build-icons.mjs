import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'build/icon-source.svg');
const out = path.join(root, 'build/icons');
const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
await fs.mkdir(out, { recursive: true });
for (const size of sizes) await sharp(source).resize(size, size).png().toFile(path.join(out, `${size}x${size}.png`));
await fs.writeFile(path.join(root, 'build/icon.ico'), await pngToIco([16, 32, 48, 64, 128, 256].map(s => path.join(out, `${s}x${s}.png`))));
if (process.platform === 'darwin') {
  const iconset = path.join(root, 'build/icon.iconset');
  await fs.rm(iconset, { recursive: true, force: true });
  await fs.mkdir(iconset);
  const copies = [[16,'icon_16x16.png'],[32,'icon_16x16@2x.png'],[32,'icon_32x32.png'],[64,'icon_32x32@2x.png'],[128,'icon_128x128.png'],[256,'icon_128x128@2x.png'],[256,'icon_256x256.png'],[512,'icon_256x256@2x.png'],[512,'icon_512x512.png'],[1024,'icon_512x512@2x.png']];
  for (const [size, name] of copies) await fs.copyFile(path.join(out, `${size}x${size}.png`), path.join(iconset, name));
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'build/icon.icns')], { stdio: 'inherit' });
  await fs.rm(iconset, { recursive: true, force: true });
} else {
  console.warn(`ICNS not generated on ${os.platform()}; run npm run build:icons on macOS before pack:mac.`);
}
