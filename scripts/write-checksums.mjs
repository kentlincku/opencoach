import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(process.argv[2] || 'dist');
const releaseExtensions = new Set(['.dmg', '.zip', '.exe']);
const entries = (await fs.readdir(directory, {withFileTypes: true}))
  .filter(entry => entry.isFile() && releaseExtensions.has(path.extname(entry.name).toLowerCase()))
  .sort((a, b) => a.name.localeCompare(b.name));
const lines = [];
for (const entry of entries) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(path.join(directory, entry.name), 'r');
  for await (const chunk of handle.createReadStream()) hash.update(chunk);
  await handle.close();
  lines.push(`${hash.digest('hex')}  ${entry.name}`);
}
if (!lines.length) throw new Error(`No release files in ${directory}`);
await fs.writeFile(path.join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
