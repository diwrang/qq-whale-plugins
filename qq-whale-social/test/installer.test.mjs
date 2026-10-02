import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installer = path.join(packageRoot, 'install.ps1');
const windows = { skip: process.platform !== 'win32' };
const psQuote = value => `'${value.replaceAll("'", "''")}'`;
const output = result => `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

function fixture({ packaged = true, packageName = 'qq-agent', withApi = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-whale-social-installer-'));
  const target = path.join(root, 'QQ Agent');
  const app = packaged ? path.join(target, 'resources', 'app') : target;
  const bundle = path.join(root, 'social bundle');
  const source = path.join(bundle, 'skills', 'whale-social');
  fs.mkdirSync(path.join(app, 'src', 'skills'), { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.copyFileSync(installer, path.join(bundle, 'install.ps1'));
  fs.writeFileSync(path.join(app, 'src', 'plugin-loader.js'), withApi ? 'createSkillApi' : 'old API');
  fs.writeFileSync(path.join(app, 'src', 'skills', 'manager.js'), 'runHook');
  const appPackage = {
    name: packageName, version: '0.4.0', type: 'module',
    description: 'QQ 群 AI 机器人（桌面版）：事件驱动的无状态 Agent，接 OpenAI 兼容 API，带会话式控制台。'
  };
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(appPackage, null, 2), 'utf8');
  fs.writeFileSync(path.join(source, 'skill.json'), JSON.stringify({ id: 'whale-social', apiVersion: 1, name: '鲸鱼娘社交' }), 'utf8');
  fs.writeFileSync(path.join(source, 'index.js'), 'export function setup() {}\n');
  fs.mkdirSync(path.join(source, 'lib'));
  fs.writeFileSync(path.join(source, 'lib', 'reader.js'), 'export const fixture = true;\n');
  fs.mkdirSync(path.join(target, 'data'), { recursive: true });
  fs.writeFileSync(path.join(target, 'data', 'config.json'), '{"existingConfig":"保留配置"}');
  fs.writeFileSync(path.join(target, 'data', 'affection.json'), 'old affection state');
  fs.writeFileSync(path.join(target, 'data', 'whale-social.json'), 'existing publish state');
  for (const [kind, id] of [['plugins', 'whale-relations'], ['plugins', 'whale-owner-controls'], ['skills', 'whale-actions']]) {
    fs.mkdirSync(path.join(app, kind, id), { recursive: true });
    fs.writeFileSync(path.join(app, kind, id, 'keep.txt'), `${id} stays unchanged`);
  }
  const files = [
    path.join(app, 'src', 'plugin-loader.js'), path.join(app, 'src', 'skills', 'manager.js'), path.join(app, 'package.json'),
    path.join(target, 'data', 'config.json'), path.join(target, 'data', 'affection.json'), path.join(target, 'data', 'whale-social.json'),
    path.join(app, 'plugins', 'whale-relations', 'keep.txt'), path.join(app, 'plugins', 'whale-owner-controls', 'keep.txt'),
    path.join(app, 'skills', 'whale-actions', 'keep.txt')
  ];
  const protectedFiles = () => files.map(file => [file, fs.readFileSync(file)]);
  const unchanged = before => before.forEach(([file, bytes]) => assert.deepEqual(fs.readFileSync(file), bytes, file));
  const run = (args = [], script = path.join(bundle, 'install.ps1')) => spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Target', target, ...args
  ], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, QQ_AGENT_DATA_DIR: '', QQ_AGENT_PROFILE: '' } });
  return { root, target, app, bundle, source, protectedFiles, unchanged, run };
}

test('Windows PowerShell 5.1 安装无 BOM 中文 JSON，完整复制自身技能，重装备份且保留核心与已有数据', windows, () => {
  const f = fixture();
  const before = f.protectedFiles();
  const first = f.run();
  assert.equal(first.status, 0, output(first));
  const installed = path.join(f.app, 'skills', 'whale-social');
  assert.deepEqual(fs.readFileSync(path.join(installed, 'lib', 'reader.js')), fs.readFileSync(path.join(f.source, 'lib', 'reader.js')));
  f.unchanged(before);
  fs.writeFileSync(path.join(installed, 'previous.txt'), 'prior extension customization');
  const packageFile = path.join(f.app, 'package.json');
  fs.writeFileSync(packageFile, '\uFEFF' + fs.readFileSync(packageFile, 'utf8'), 'utf8');
  const beforeSecond = f.protectedFiles();
  const second = f.run();
  assert.equal(second.status, 0, output(second));
  f.unchanged(beforeSecond);
  assert.equal(fs.existsSync(path.join(installed, 'previous.txt')), false);
  const backupRoot = path.join(f.target, 'data', 'extension-backups');
  const backups = fs.readdirSync(backupRoot);
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^whale-social-/);
  assert.equal(fs.readFileSync(path.join(backupRoot, backups[0], 'skills', 'whale-social', 'previous.txt'), 'utf8'), 'prior extension customization');
});

test('源码布局同样可以安装；错误应用或缺失接口在任何修改之前被拒绝', windows, () => {
  const sourceLayout = fixture({ packaged: false });
  const valid = sourceLayout.run();
  assert.equal(valid.status, 0, output(valid));
  assert.ok(fs.existsSync(path.join(sourceLayout.app, 'skills', 'whale-social', 'index.js')));
  for (const settings of [{ packageName: 'unrelated-app' }, { withApi: false }]) {
    const f = fixture(settings);
    const before = f.protectedFiles();
    const result = f.run();
    assert.equal(result.status, 1, output(result));
    f.unchanged(before);
    assert.equal(fs.existsSync(path.join(f.app, 'skills', 'whale-social')), false);
    assert.equal(fs.readdirSync(f.app).some(name => name.startsWith('.whale-social-staging-')), false);
  }
});

test('替换期间新目录移动失败时回滚原技能，不触碰其它扩展或数据', windows, () => {
  const f = fixture();
  assert.equal(f.run().status, 0);
  const installed = path.join(f.app, 'skills', 'whale-social');
  fs.writeFileSync(path.join(installed, 'previous.txt'), 'restore this prior extension');
  const before = f.protectedFiles();
  const harness = path.join(f.root, 'inject-failure.ps1');
  fs.writeFileSync(harness, [
    'param([string]$Target)',
    'function Move-Item {',
    '  [CmdletBinding()] param([string]$LiteralPath, [string]$Destination)',
    '  if ($LiteralPath -like "*\\.whale-social-staging-*\\skills\\whale-social") { throw "Simulated staged move failure" }',
    '  Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination -ErrorAction Stop',
    '}',
    `& ${psQuote(path.join(f.bundle, 'install.ps1'))} -Target $Target`,
    'exit $LASTEXITCODE'
  ].join('\n'), 'ascii');
  const failed = f.run([], harness);
  assert.equal(failed.status, 1, output(failed));
  assert.match(output(failed), /Simulated staged move failure/);
  assert.equal(fs.readFileSync(path.join(installed, 'previous.txt'), 'utf8'), 'restore this prior extension');
  f.unchanged(before);
});

test('目录联接不能将技能安装或移动到应用目录之外', windows, () => {
  const f = fixture();
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  const linked = path.join(f.app, 'skills', 'whale-social');
  fs.symlinkSync(outside, linked, 'junction');
  const before = f.protectedFiles();
  const result = f.run();
  assert.equal(result.status, 1, output(result));
  assert.match(output(result), /directory link is not allowed/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.ok(fs.lstatSync(linked).isSymbolicLink());
  f.unchanged(before);
});
