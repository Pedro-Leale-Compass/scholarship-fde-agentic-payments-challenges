import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const agentDir = join(scriptDir, '..', '..', 'agent');
const buildDir = join(agentDir, 'dist');
const sourceFile = join(agentDir, 'main.py');
const lockFile = join(agentDir, 'uv.lock');

if (!existsSync(lockFile)) {
  throw new Error('Missing agent/uv.lock; run "uv lock" before packaging.');
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'alan-lorenz-agent-'));
const requirementsFile = join(temporaryDirectory, 'requirements.txt');

try {
  execFileSync(
    'uv',
    [
      'export',
      '--locked',
      '--no-dev',
      '--format',
      'requirements.txt',
      '--output-file',
      requirementsFile,
    ],
    { cwd: agentDir, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  execFileSync(
    'uv',
    [
      'pip',
      'install',
      '--python-platform',
      'aarch64-manylinux2014',
      '--python-version',
      '3.13',
      '--target',
      buildDir,
      '--only-binary=:all:',
      '-r',
      requirementsFile,
    ],
    { cwd: agentDir, stdio: 'inherit' },
  );
  copyFileSync(sourceFile, join(buildDir, 'main.py'));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
