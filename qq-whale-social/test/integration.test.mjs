import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = process.env.QQ_WHALE_UPSTREAM;
test('实际安装包与真实加载器：十个工具、指定评论回复、并发防重、热重载与禁用', { skip: !upstream && '请设置QQ_WHALE_UPSTREAM为QQ Agent源码路径' }, async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-social-integration-'));
  let skillsRoot = path.join(packageRoot, 'skills');
  if (process.platform === 'win32') {
    const app = path.join(fixture, 'resources', 'app');
    fs.mkdirSync(path.join(app, 'src', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'qq-agent', type: 'module', description: 'QQ 群 AI 机器人（桌面版）：事件驱动的无状态 Agent，接 OpenAI 兼容 API，带会话式控制台。' }), 'utf8');
    fs.writeFileSync(path.join(app, 'src', 'plugin-loader.js'), 'createSkillApi');
    fs.writeFileSync(path.join(app, 'src', 'skills', 'manager.js'), 'runHook');
    const install = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(packageRoot, 'install.ps1'), '-Target', fixture], { encoding: 'utf8', env: { ...process.env, QQ_AGENT_DATA_DIR: '', QQ_AGENT_PROFILE: '' } });
    assert.equal(install.status, 0, install.stdout + install.stderr);
    skillsRoot = path.join(app, 'skills');
    for (const file of ['index.js', 'skill.json', 'bili.js', 'qzone.js', 'policy.js', 'watch.js', 'comments.js', 'reply-state.js']) assert.equal(fs.readFileSync(path.join(skillsRoot, 'whale-social', file), 'utf8'), fs.readFileSync(path.join(packageRoot, 'skills', 'whale-social', file), 'utf8'));
  }
  process.env.QQ_AGENT_DATA_DIR = path.join(fixture, 'data');
  fs.mkdirSync(path.join(fixture, 'plugins'));
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  let detailGate, replyWrites = 0;
  const detail = () => ({ code: 0, uin: 99999999, tid: 'reply-post', cmtnum: 3, commentlist: [
    { tid: 'comment-1', uin: 12345, name: '朋友', content: '你好', list_3: replyWrites ? [{ tid: 'reply-1', uin: 99999999, content: '谢谢你的评论', create_time: Math.floor(Date.now() / 1000) }] : [] },
    { tid: 'comment-2', uin: 12345, content: '另一条评论', list_3: [] },
    { tid: 'comment-self', uin: 99999999, content: '自己', list_3: [] }
  ] });
  globalThis.fetch = async (input, options) => {
    const url = new URL(input); fetchCalls.push(url);
    if (url.hostname === 'h5.qzone.qq.com' && url.pathname.endsWith('emotion_cgi_msgdetail_v6')) {
      if (detailGate) await detailGate;
      return Response.json(detail());
    }
    if (url.hostname === 'h5.qzone.qq.com' && url.pathname.endsWith('emotion_cgi_re_feeds')) {
      assert.equal(options.method, 'POST');
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('commentId'), 'comment-1');
      assert.equal(form.get('t2_tid'), 'comment-1');
      replyWrites++;
      return Response.json({ code: 0, commentid: 'reply-1' });
    }
    if (url.pathname === '/x/web-interface/view') return Response.json({ code: 0, data: { bvid: 'BV17x411w7KC', aid: 170001, title: '公开视频', desc: '简介', owner: { mid: 12345, name: 'UP' }, pubdate: 1_600_000_000, duration: 120,
      pages: [{ cid: 11, page: 1, part: '第一P', duration: 60 }, { cid: 22, page: 2, part: '第二P', duration: 60 }], stat: {} } });
    if (url.pathname === '/x/player/v2') return Response.json({ code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } });
    if (url.pathname === '/x/player/playurl') return Response.json({ code: 0, data: { format: 'mp4', durl: [{ url: 'https://cn-test.bilivideo.com/video.mp4?secret=abc', size: 4 }], timelength: 60000 } });
    throw new Error('Unexpected network request');
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const url = file => pathToFileURL(path.join(upstream, file)).href;
  const { loadPlugins, unloadSkill } = await import(url('src/plugin-loader.js'));
  const { skillManager } = await import(url('src/skills/manager.js'));
  const { getTool, listTools, getToolAvailability } = await import(url('src/tool-registry.js'));
  const { setSkillEnabled, setSkillConfig } = await import(url('src/skills/config.js'));
  const load = async () => {
    const log = [];
    const loaded = await loadPlugins({ roots: { skills: skillsRoot, plugins: path.join(fixture, 'plugins') }, log: line => log.push(line) });
    for (const st of skillManager.list()) if (st.active) skillManager.activate(st.id);
    assert.equal(loaded.failed.length, 0); assert.equal(loaded.loaded.length, 1);
    assert.equal(log.some(line => line.includes('⚠️')), false, log.join('\n'));
  };
  await load();
  t.after(() => unloadSkill('whale-social'));
  assert.equal(listTools().filter(tool => tool.skillId === 'whale-social').length, 10);
  const tool = name => getTool(`whale-social__${name}`);
  const calls = []; let release;
  const publishResponse = new Promise(resolve => { release = resolve; });
  const ctx = { selfId: '99999999', chatKey: 'group:88', kind: 'group', chatId: '88', session: { id: 's1', trigger: [{ senderId: '12345' }] }, onebot: { async call(action, args) {
    calls.push({ action, args });
    if (action === 'send_qzone_msg') return publishResponse;
    if (action === 'get_qzone_msg_list') return { total: 1, msglist: [{ tid: 'tid1', content: '公开动态', time: 1_600_000_000 }] };
    if (action === 'get_qzone_feeds') return { feeds: [{ key: 'key1', uin: 12345, nickname: '好友', html: '<p class="f-info">好友动态</p>' }], has_more: false };
    if (action === 'get_cookies') return { cookies: 'uin=o99999999; p_uin=o99999999; p_skey=internal-test-secret' };
    throw new Error('Unsupported action');
  } } };
  await t.test('分P链接不被默认参数覆盖；没有字幕不会声称看过视频', async () => {
    const read = JSON.parse((await tool('bili_read').execute(ctx, { input: 'https://www.bilibili.com/video/BV17x411w7KC/?p=2', comments: 0 })).content);
    assert.equal(read.page.number, 2); assert.equal(read.subtitles.status, 'login_required');
    assert.equal(read.visualStatus, 'not_requested'); assert.equal(read.playbackUrl, undefined);
    assert.equal(fetchCalls.find(u => u.pathname === '/x/player/v2').searchParams.get('cid'), '22');
    const watch = JSON.parse((await tool('bili_watch').execute(ctx, { input: 'BV17x411w7KC', comments: 0 })).content);
    assert.equal(watch.visualStatus, 'unavailable'); assert.doesNotMatch(JSON.stringify(watch), /secret=abc/);
  });
  await t.test('空间列表与动态接到真实动作；未知返回不当作空空间', async () => {
    assert.equal(JSON.parse((await tool('qzone_read').execute(ctx, { targetQQ: '12345', limit: 1 })).content).items[0].content, '公开动态');
    assert.deepEqual(calls.at(-1).args, { target_uin: 12345, pos: 0, num: 1 });
    assert.equal(JSON.parse((await tool('qzone_feeds').execute(ctx, { limit: 1 })).content).items[0].content, '好友动态');
  });
  await t.test('非法参数不占限额；自主发布只执行一次；不同会话共享冷却', async () => {
    assert.equal((await tool('qzone_publish').execute(ctx, { text: '', images: [] })).isError, true);
    assert.equal(JSON.parse((await tool('qzone_status').execute(ctx)).content).attemptsToday, 0);
    const first = tool('qzone_publish').execute(ctx, { text: '今天读到有趣的视频。' });
    const duplicate = await tool('qzone_publish').execute({ ...ctx, chatKey: 'private:12345', session: { id: 's2' } }, { text: '今天读到有趣的视频。' });
    assert.equal(duplicate.isError, true); assert.match(duplicate.content, /重复/);
    release({ tid: 'published-test', time: 1_600_000_000 });
    assert.equal(JSON.parse((await first).content).published, true);
    assert.equal(calls.filter(c => c.action === 'send_qzone_msg').length, 1);
    assert.deepEqual(calls.find(c => c.action === 'send_qzone_msg').args, { content: '今天读到有趣的视频。', images: [], ugc_right: 1 });
    assert.equal((await tool('qzone_publish').execute(ctx, { text: '另一条感想' })).isError, true);
    await load();
    assert.equal((await tool('qzone_publish').execute(ctx, { text: '重载后再发' })).isError, true);
    assert.equal(JSON.parse((await tool('qzone_status').execute(ctx)).content).attemptsToday, 1);
  });
  await t.test('指定评论回复与发说说额度独立；在途关闭阻止写入；核验回复且重载防重', async () => {
    const read = JSON.parse((await tool('qzone_comments').execute(ctx, { tid: 'reply-post' })).content);
    assert.equal(read.items[0].commentId, 'comment-1');
    assert.doesNotMatch(JSON.stringify(read), /internal-test-secret/);
    assert.equal((await tool('qzone_reply').execute(ctx, { tid: 'reply-post', commentId: 'missing', text: '你好' })).isError, true);
    assert.equal((await tool('qzone_reply').execute(ctx, { tid: 'reply-post', commentId: 'comment-self', text: '你好' })).isError, true);
    assert.equal(JSON.parse((await tool('qzone_reply_status').execute(ctx)).content).attemptsToday, 0);
    let unblock;
    detailGate = new Promise(resolve => { unblock = resolve; });
    const inFlight = tool('qzone_reply').execute(ctx, { tid: 'reply-post', commentId: 'comment-1', text: '谢谢你的评论' });
    await new Promise(resolve => setImmediate(resolve));
    setSkillConfig('whale-social', { replyMode: 'off' });
    detailGate = undefined; unblock();
    assert.equal((await inFlight).isError, true);
    assert.equal(replyWrites, 0);
    assert.equal(JSON.parse((await tool('qzone_reply_status').execute(ctx)).content).attemptsToday, 0);
    setSkillConfig('whale-social', { replyMode: 'autonomous' });
    const posted = JSON.parse((await tool('qzone_reply').execute(ctx, { tid: 'reply-post', commentId: 'comment-1', text: '谢谢你的评论' })).content);
    assert.equal(posted.replied, true);
    assert.equal(posted.parentCommentId, 'comment-1');
    assert.equal(replyWrites, 1);
    assert.equal(JSON.parse((await tool('qzone_status').execute(ctx)).content).attemptsToday, 1);
    await load();
    const duplicate = await tool('qzone_reply').execute({ ...ctx, chatKey: 'private:12345' }, { tid: 'reply-post', commentId: 'comment-1', text: '换一句也不能重发' });
    assert.equal(duplicate.isError, true); assert.match(duplicate.content, /重复/);
    assert.equal((await tool('qzone_reply').execute(ctx, { tid: 'reply-post', commentId: 'comment-2', text: '另一条回复' })).isError, true);
    assert.equal(replyWrites, 1);
    assert.equal(JSON.parse((await tool('qzone_reply_status').execute(ctx)).content).attemptsToday, 1);
  });
  await t.test('关闭设置即时生效；卸载撤下工具，密钥不进入错误输出', async () => {
    setSkillConfig('whale-social', { publishMode: 'off', enableBilibili: false });
    assert.equal((await tool('qzone_publish').execute(ctx, { text: '关闭后不能发' })).isError, true);
    const before = fetchCalls.length;
    assert.equal((await tool('bili_read').execute(ctx, { input: 'BV17x411w7KC' })).isError, true);
    assert.equal(fetchCalls.length, before);
    setSkillEnabled('whale-social', false); skillManager.deactivate('whale-social');
    assert.equal(getToolAvailability('whale-social__qzone_feeds').enabled, false);
    assert.equal((await tool('qzone_read').execute(ctx)).isError, true);
    unloadSkill('whale-social');
    assert.equal(listTools().filter(t => t.skillId === 'whale-social').length, 0);
  });
});
