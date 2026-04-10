import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();

function runTsc(args) {
  return execFileSync('tsc', args, { encoding: 'utf8' });
}

function writeWrapper(tempDir, configName, config) {
  const wrapperPath = join(tempDir, configName);
  writeFileSync(wrapperPath, JSON.stringify(config));
  return wrapperPath;
}

function assertContains(text, expected) {
  if (!text.includes(expected)) {
    throw new Error(`expected output to include: ${expected}`);
  }
}

const tempDir = mkdtempSync(join(root, '.tmp-config-typescript-'));

try {
  writeFileSync(join(tempDir, 'index.ts'), 'export {}\n');
  writeFileSync(join(tempDir, 'next.tsx'), [
    "import type { ReactNode } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    '',
    'const node: ReactNode = <div />;',
    'createRoot(document.createElement("div")).render(node);',
    '',
  ].join('\n'));

  const baseFail = writeWrapper(tempDir, 'base.fail.json', {
    extends: resolve(root, 'base.json'),
    files: ['base.fail.ts'],
  });
  writeFileSync(join(tempDir, 'base.fail.ts'), 'document;\n');

  let baseFailed = false;
  try {
    runTsc(['-p', baseFail, '--noEmit', '--pretty', 'false']);
  } catch (error) {
    baseFailed = true;
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    assertContains(output, "Cannot find name 'document'");
  }

  if (!baseFailed) {
    throw new Error('base config should not include DOM globals');
  }

  const libraryWrapper = writeWrapper(tempDir, 'library.json', {
    extends: resolve(root, 'library.json'),
    compilerOptions: {
      outDir: 'dist',
    },
    files: ['library.ts'],
  });
  writeFileSync(join(tempDir, 'library.ts'), 'export const value = 1;\n');
  runTsc(['-b', libraryWrapper, '--pretty', 'false']);
  if (!existsSync(join(tempDir, 'dist', 'library.js'))) {
    throw new Error('library config did not emit JavaScript');
  }
  if (!existsSync(join(tempDir, 'dist', 'library.d.ts'))) {
    throw new Error('library config did not emit declarations');
  }

  const nodeWrapper = writeWrapper(tempDir, 'node.json', {
    extends: resolve(root, 'node.json'),
    compilerOptions: {
      outDir: 'node-dist',
    },
    files: ['node.ts'],
  });
  writeFileSync(join(tempDir, 'node.ts'), [
    "import { readFileSync } from 'node:fs';",
    '',
    'export const cwd = process.cwd();',
    'export const read = readFileSync;',
    '',
  ].join('\n'));
  runTsc(['-b', nodeWrapper, '--pretty', 'false']);
  if (!existsSync(join(tempDir, 'node-dist', 'node.js'))) {
    throw new Error('node config did not emit JavaScript');
  }
  if (!existsSync(join(tempDir, 'node-dist', 'node.d.ts'))) {
    throw new Error('node config did not emit declarations');
  }

  const nextWrapper = writeWrapper(tempDir, 'nextjs.json', {
    extends: resolve(root, 'nextjs.json'),
    files: ['next.tsx'],
  });
  runTsc(['-p', nextWrapper, '--noEmit', '--pretty', 'false']);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
