import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { builtinModules } from 'node:module';
import { execFileSync } from 'node:child_process';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const manifest = read('manifest.json'), pkg = read('package.json'), lock = read('package-lock.json');
const version = manifest.version;
assert.match(version, /^\d+\.\d+\.\d+$/);
assert.equal(pkg.version, version);
assert.equal(lock.version, version);
assert.equal(lock.packages[''].version, version);
assert.equal(read('versions.json')[version], manifest.minAppVersion);
assert.equal(manifest.id, 'review-center');
assert.equal(manifest.isDesktopOnly, false);
assert.ok(manifest.description.length <= 250 && manifest.description.endsWith('.'));
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'README.md', `docs/${version}-upgrade.md`, `docs/${version}-validation.md`]) {
  assert.ok(fs.statSync(file).size > 0, file);
}
const code = fs.readFileSync('main.js', 'utf8');
assert.ok(code.includes(fs.readFileSync('assets/optimizer.wasm').toString('base64')), 'Optimizer must be embedded, not fetched');
const nodeModules = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
for (const [, imported] of code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
  assert.ok(!nodeModules.has(imported) && imported !== 'electron', `Desktop-only module in runtime: ${imported}`);
}
assert.ok(!fs.readFileSync('optimizer/worker.cjs', 'utf8').includes('require('), 'Runtime Web Worker must not depend on Node');

const docs = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', ...fs.readdirSync('docs').filter(name => name.endsWith('.md')).map(name => `docs/${name}`)];
function checkDocLinks(file) {
  const content = fs.readFileSync(file, 'utf8');
  for (const [, link] of content.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)) {
    if (/^[a-z]+:|^#/i.test(link)) continue;
    const target = decodeURIComponent(link.split('#')[0]);
    assert.ok(fs.existsSync(path.resolve(path.dirname(file), target)), `${file}: missing link ${link}`);
  }
}
docs.forEach(checkDocLinks);

const result = { version, manifestAndLockAligned: true, runtimeUsesWebApis: true, documentationLinksChecked: docs.length };
if (process.argv.includes('--package')) {
  const target = path.resolve('release', version), zipName = `review-center-${version}.zip`, archive = path.join(target, zipName);
  [...docs, '使用说明.md', '升级说明.md', '验证记录.md', 'optimizer/README.md'].forEach(file => checkDocLinks(path.join(target, file)));
  const files = ['main.js', 'manifest.json', 'styles.css', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'priority-queue-2.7.0-source.zip'].sort();
  assert.deepEqual(fs.readdirSync(path.join(target, 'review-center')).sort(), files);
  const listing = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(listing.filter(name => !name.endsWith('/')).sort(), files.map(name => `review-center/${name}`).sort());
  execFileSync('unzip', ['-tq', archive]);
  for (const name of files) {
    const source = name.endsWith('-source.zip') ? `assets/${name}` : name;
    const expected = fs.readFileSync(source);
    assert.ok(expected.equals(fs.readFileSync(path.join(target, 'review-center', name))), `Staged ${name} mismatch`);
    assert.ok(expected.equals(execFileSync('unzip', ['-p', archive, `review-center/${name}`], { maxBuffer: 20 * 1024 * 1024 })), `ZIP ${name} mismatch`);
  }
  const sums = fs.readFileSync(path.join(target, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const names = [];
  for (const line of sums) {
    const [hash, name] = line.split('  '); names.push(name);
    assert.equal(sha(fs.readFileSync(path.join(target, name))), hash, name);
  }
  assert.deepEqual(names.sort(), [zipName, ...files.map(name => `review-center/${name}`)].sort());
  Object.assign(result, { zipName, zipFilesChecked: files.length, bytes: fs.statSync(archive).size, sha256: sha(fs.readFileSync(archive)), checksumsVerified: true });
  fs.writeFileSync(path.join(target, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result, null, 2));
