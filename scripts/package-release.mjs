import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const version = manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use an Obsidian-compatible x.y.z version');
if (version !== JSON.parse(fs.readFileSync('package.json', 'utf8')).version) throw new Error('Version mismatch');
const target = path.resolve('release', version), plugin = path.join(target, 'review-center');
// This directory contains generated release files only. Recreate it so an old
// data.json or another leftover can never be included in a subsequent ZIP.
fs.rmSync(plugin, { recursive: true, force: true });
fs.mkdirSync(plugin, { recursive: true });
for (const file of ['main.js', 'styles.css', 'manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) fs.copyFileSync(file, path.join(plugin, file));
fs.copyFileSync('assets/priority-queue-2.7.0-source.zip', path.join(plugin, 'priority-queue-2.7.0-source.zip'));
fs.rmSync(path.join(target, 'docs'), { recursive: true, force: true });
fs.cpSync('docs', path.join(target, 'docs'), { recursive: true });
for (const file of ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) fs.copyFileSync(file, path.join(target, file));
fs.mkdirSync(path.join(target, 'optimizer'), { recursive: true });
fs.copyFileSync('optimizer/README.md', path.join(target, 'optimizer/README.md'));
fs.copyFileSync('README.md', path.join(target, '使用说明.md'));
fs.writeFileSync(path.join(target, '升级说明.md'), `# 升级说明\n\n请阅读 [${version} 使用与升级说明](docs/${version}-upgrade.md)。\n`);
fs.writeFileSync(path.join(target, '验证记录.md'), `# 验证记录\n\n请阅读 [${version} 验证记录](docs/${version}-validation.md)。\n`);
const zip = path.join(target, `review-center-${version}.zip`);
if (fs.existsSync(zip)) fs.unlinkSync(zip);
// Normalize archive metadata so repeated packaging produces the same checksum.
const entries = fs.readdirSync(plugin).sort(), stamp = new Date('2000-01-01T00:00:00Z');
for (const file of entries) { const full = path.join(plugin, file); fs.chmodSync(full, 0o644); fs.utimesSync(full, stamp, stamp); }
fs.chmodSync(plugin, 0o755); fs.utimesSync(plugin, stamp, stamp);
execFileSync('zip', ['-q', '-X', zip, 'review-center/', ...entries.map(file => `review-center/${file}`)], { cwd: target, env: { ...process.env, TZ: 'UTC', COPYFILE_DISABLE: '1' } });
const files = [zip, ...fs.readdirSync(plugin).sort().map(file => path.join(plugin, file))];
fs.writeFileSync(path.join(target, 'SHA256SUMS'), files.map(file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') + '  ' + path.relative(target, file)).join('\n') + '\n');
console.log(zip);
