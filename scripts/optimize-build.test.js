const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { removeGlobPattern } = require('./optimize-build');

test('optimizer removes matching files and directories while preserving runtime files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmp-optimizer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = [
    'pkg/test/fixture.js',
    '@scope/pkg/tests/fixture.js',
    'pkg/README.txt',
    'pkg/guide.md',
    'pkg/index.d.ts',
    'pkg/index.js',
    'pkg/package.json',
    'pkg/.hidden/guide.md',
  ];
  for (const file of files) {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'fixture');
  }
  for (const pattern of ['**/test', '**/tests', '**/README*', '**/*.md', '**/*.d.ts']) {
    await removeGlobPattern(root, pattern);
  }
  for (const file of files.slice(0, 5)) {
    await assert.rejects(fs.access(path.join(root, file)), { code: 'ENOENT' });
  }
  for (const file of files.slice(5)) {
    await fs.access(path.join(root, file));
  }
});

test('optimizer handles explicit hidden-directory patterns and unmatched patterns', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmp-optimizer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'pkg/.github/workflows'), { recursive: true });
  await fs.writeFile(path.join(root, 'pkg/.github/workflows/build.yml'), 'fixture');
  await removeGlobPattern(root, '**/.github');
  await assert.rejects(fs.access(path.join(root, 'pkg/.github')), { code: 'ENOENT' });
  await removeGlobPattern(root, '**/missing');
});
