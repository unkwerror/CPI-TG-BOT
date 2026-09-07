import sharp from 'sharp';
import process from 'node:process';
import console from 'node:console';
import { access, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

// Format conversion only: approved user images are not regenerated or retouched.
const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/prepare-merch-assets.mjs /path/to/catalog');
const output = path.resolve('apps/web/public/merch');
await mkdir(output, { recursive: true });
for (const name of ['notebook', 'shopper', 'cardholder', 'stickers', 'pen', 'pencil']) {
  const destination = path.join(output, `${name}-catalog-v1.webp`);
  try {
    await access(destination);
    throw new Error(`Refusing to overwrite ${destination}; use a new versioned filename.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await sharp(path.join(input, `Catalyst_${name}_1536x1536.png`))
    .rotate()
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88, effort: 6 })
    .toFile(destination);
  console.log(`${path.basename(destination)}: ${(await stat(destination)).size} bytes`);
}
