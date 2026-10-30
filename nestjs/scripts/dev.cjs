const { spawn, spawnSync } = require('node:child_process');

const tsc = require.resolve('typescript/bin/tsc');

const initial = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { stdio: 'inherit' });

if (initial.status) process.exit(initial.status);

const compiler = spawn(
  process.execPath,
  [tsc, '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'],
  { stdio: 'inherit' },
);

const server = spawn(process.execPath, ['--watch', 'dist/main.js'], { stdio: 'inherit' });

let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  compiler.kill();
  server.kill();
}

process.on('SIGINT', stop);

process.on('SIGTERM', stop);

compiler.on('exit', stop);

server.on('exit', stop);
