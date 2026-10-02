import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = process.env.QQ_WHALE_UPSTREAM;
test('真实加载器和完整安装包：签名工具、写前读、重载限频、开关与鉴权', { skip: !upstream && '需设置QQ_WHALE_UPSTREAM为源码路径' }, async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-signature-integration-'));
  let skillsRoot = path.join(packageRoot, 'skills');
  if (process.platform === 'win32') {
    const app = path.join(fixture, 'resources', 'app');
    fs.mkdirSync(path.join(app, 'src', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'qq-agent', type: 'module', description: 'QQ 群 AI 机器人（桌面版）：个性签名扩展测试。' }));
    fs.writeFileSync(path.join(app, 'src', 'plugin-loader.js'), 'createSkillApi');
    fs.writeFileSync(path.join(app, 'src', 'skills', 'manager.js'), 'runHook');
    const install = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(packageRoot, 'install.ps1'), '-Target', fixture], { encoding: 'utf8', env: { ...process.env, QQ_AGENT_PROFILE: '', QQ_AGENT_DATA_DIR: '' } });
    assert.equal(install.status, 0, install.stdout + install.stderr);
    skillsRoot = path.join(app, 'skills');
    for (const file of ['index.js', 'skill.json', 'state.js', 'signature.js']) assert.equal(fs.readFileSync(path.join(skillsRoot, 'whale-signature', file), 'utf8'), fs.readFileSync(path.join(packageRoot, 'skills', 'whale-signature', file), 'utf8'));
  }
  process.env.QQ_AGENT_DATA_DIR = path.join(fixture, 'data');
  const plugins = path.join(fixture, 'plugins'); fs.mkdirSync(plugins);
  const url = file => pathToFileURL(path.join(upstream, file)).href;
  const { loadPlugins, unloadSkill } = await import(url('src/plugin-loader.js'));
  const { skillManager } = await import(url('src/skills/manager.js'));
  const { getTool, listTools, getToolAvailability } = await import(url('src/tool-registry.js'));
  const { setSkillConfig, setSkillEnabled } = await import(url('src/skills/config.js'));
  const load = async () => {
    const lines = [];
    const loaded = await loadPlugins({ roots: { skills: skillsRoot, plugins }, log: line => lines.push(line) });
    assert.equal(loaded.failed.length, 0); assert.equal(loaded.loaded.length, 1);
    assert.equal(lines.some(line => line.includes('⚠️')), false, lines.join('\n'));
    for (const st of skillManager.list()) if (st.active) skillManager.activate(st.id);
  };
  await load(); t.after(() => unloadSkill('whale-signature'));
  assert.equal(listTools().filter(x => x.skillId === 'whale-signature').length, 3);
  const tool = id => getTool(`whale-signature__${id}`);
  const calls = []; let signature = '原签名', release, heldRead = null, failWrite = false;
  const ctx = { selfId: '99999999', chatKey: 'group:88', session: { id: 's1', trigger: [{ senderId: '12345' }] }, onebot: { selfId: '99999999', async call(action, params) {
    calls.push({ action, params });
    if (action === 'get_stranger_info') {
      if (heldRead) await heldRead;
      return { user_id: 99999999, long_nick: signature };
    }
    if (action === 'set_self_longnick') {
      if (failWrite) throw new Error('Timed out with secret-token');
      signature = params.longNick; return {};
    }
    throw new Error('Unknown action');
  } } };
  await t.test('签名已相同不发送写请求、不占次数；非法参数不触发QQ', async () => {
    const unchanged = JSON.parse((await tool('set_signature').execute(ctx, { text: '原签名' })).content);
    assert.equal(unchanged.changed, false);
    assert.equal(JSON.parse((await tool('signature_status').execute(ctx)).content).attemptsToday, 0);
    const before = calls.length;
    assert.equal((await tool('set_signature').execute(ctx, { text: '' })).isError, true);
    assert.equal(calls.length, before);
  });
  await t.test('并发跨会话最多一次写；三工具和持久冷却在热重载后仍有效', async () => {
    heldRead = new Promise(resolve => { release = resolve; });
    const first = tool('set_signature').execute(ctx, { text: '新的签名甲' });
    const second = tool('set_signature').execute({ ...ctx, chatKey: 'private:12345' }, { text: '新的签名乙' });
    release(); heldRead = null;
    const results = await Promise.all([first, second]);
    assert.equal(results.filter(x => x.isError).length, 1);
    assert.equal(calls.filter(c => c.action === 'set_self_longnick').length, 1);
    assert.equal(JSON.parse(results.find(x => !x.isError).content).verified, true);
    await load();
    assert.equal((await tool('set_signature').execute(ctx, { text: '重载后试图再改' })).isError, true);
    assert.equal(calls.filter(c => c.action === 'set_self_longnick').length, 1);
  });
  await t.test('读请求等待期间关闭技能阻止写；请求模式拒绝伪造身份；停用联动', async () => {
    heldRead = new Promise(resolve => { release = resolve; });
    const pending = tool('set_signature').execute(ctx, { text: '关闭后不能改' });
    setSkillEnabled('whale-signature', false); skillManager.deactivate('whale-signature');
    release(); heldRead = null;
    assert.equal((await pending).isError, true);
    assert.equal(getToolAvailability('whale-signature__set_signature').enabled, false);
    setSkillEnabled('whale-signature', true); skillManager.activate('whale-signature');
    setSkillConfig('whale-signature', { signatureMode: 'requested' });
    assert.equal((await tool('set_signature').execute(ctx, { text: '假主人不能改' })).isError, true);
    setSkillConfig('whale-signature', { signatureMode: 'off' });
    assert.equal((await tool('set_signature').execute(ctx, { text: '关闭模式不能改' })).isError, true);
    assert.equal(JSON.parse((await tool('get_signature').execute(ctx)).content).ok, true);
    assert.equal(calls.filter(c => c.action === 'set_self_longnick').length, 1);
    unloadSkill('whale-signature');
    assert.equal(listTools().filter(x => x.skillId === 'whale-signature').length, 0);
  });
});
