const fs = require('node:fs');

const crypto = require('node:crypto');

const baseline = JSON.parse(
  fs.readFileSync(__dirname + '/original-files.sha256.json', 'utf8').replace(/^\uFEFF/, ''),
);

const changed = baseline.filter(
  ({ path, hash }) =>
    !fs.existsSync(path) ||
    crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex').toUpperCase() !== hash,
);

if (changed.length) {
  console.error(changed.map((x) => x.path));
  process.exitCode = 1;
} else console.log(`原目录 ${baseline.length} 个文件 SHA-256 一致`);
