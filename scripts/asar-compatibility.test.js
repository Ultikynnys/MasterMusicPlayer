const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const asar = require('@electron/asar');
const { checkFileInArchive } = require('app-builder-lib/out/asar/asarFileChecker');

test('ASAR supports archive round trips and electron-builder archive checks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmp-asar-'));
  t.after(() => {
    asar.uncacheAll();
    return fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source');
  const archive = path.join(root, 'app.asar');
  const output = path.join(root, 'extracted');
  await fs.mkdir(source);
  const metadata = JSON.stringify({ name: 'fixture', main: 'index.js' });
  await fs.writeFile(path.join(source, 'package.json'), metadata);
  await fs.writeFile(path.join(source, 'index.js'), 'module.exports = 42;');
  await asar.createPackage(source, archive);
  assert.equal(asar.extractFile(archive, 'package.json').toString(), metadata);
  assert.ok(asar.listPackage(archive).map((file) => file.replaceAll('\\', '/')).includes('/index.js'));
  assert.ok(asar.getRawHeader(archive).headerString);
  assert.equal(asar.statFile(archive, 'index.js').size, 20);
  assert.equal((await checkFileInArchive(archive, 'index.js', 'Entry point')).size, 20);
  asar.extractAll(archive, output);
  assert.equal(await fs.readFile(path.join(output, 'index.js'), 'utf8'), 'module.exports = 42;');
  const unpackedArchive = path.join(root, 'unpacked.asar');
  await asar.createPackageWithOptions(source, unpackedArchive, { unpack: '*.js' });
  assert.equal(asar.statFile(unpackedArchive, 'index.js').unpacked, true);
  assert.equal(await fs.readFile(`${unpackedArchive}.unpacked/index.js`, 'utf8'), 'module.exports = 42;');
});
