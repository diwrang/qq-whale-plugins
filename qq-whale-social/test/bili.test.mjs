import assert from 'node:assert/strict';
import test from 'node:test';
import { createBilibiliClient } from '../skills/whale-social/bili.js';

const BV = 'BV17x411w7KC';
const video = { bvid: BV, aid: 170001, title: '公开视频', desc: '简介', pubdate: 1700000000, duration: 80, owner: { mid: 1, name: 'UP主' }, pages: [{ page: 1, cid: 101, part: '第一P', duration: 30 }, { page: 2, cid: 102, part: '第二P', duration: 50 }], stat: { view: 123, like: 5, reply: 1 } };
function json(data, code = 0, extra = {}) { return new Response(JSON.stringify({ code, data, ...extra }), { headers: { 'content-type': 'application/json' } }); }
function fixtures(override = () => undefined) {
  const calls = [];
  return { calls, fetch: async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    const response = await override(url, options);
    if (response) return response;
    if (url.pathname === '/x/web-interface/view') return json(video);
    if (url.pathname === '/x/v2/reply') return json({ page: { count: 1 }, replies: [{ rpid_str: '100', member: { mid: '2', uname: '观众' }, content: { message: '公开热评' }, like: 9, ctime: 1700000000 }] });
    if (url.pathname === '/x/player/v2') return json({ subtitle: { subtitles: [] }, need_login_subtitle: false, ip_info: { ip: 'private-do-not-return' } });
    if (url.pathname === '/x/player/playurl') return json({ format: 'mp4', quality: 16, timelength: 50000, durl: [{ url: 'https://cdn.bilivideo.com/video.mp4?upsig=private-signature', size: 1234 }] });
    throw new Error(`unexpected fixture: ${url.pathname}`);
  } };
}

test('reads requested part, bounded hot comments, and does not fetch playback by default', async () => {
  const mock = fixtures();
  const client = createBilibiliClient({ fetch: mock.fetch });
  const result = await client.read(BV, { page: 2, comments: 2 });
  assert.equal(result.page.cid, 102);
  assert.equal(result.page.number, 2);
  assert.equal(result.comments.items[0].text, '公开热评');
  assert.equal(result.subtitles.status, 'unavailable');
  assert.equal(result.playback.status, 'not_requested');
  assert.ok(!mock.calls.some(x => x.url.pathname === '/x/player/playurl'));
  assert.ok(mock.calls.some(x => x.url.pathname === '/x/player/v2' && x.url.searchParams.get('cid') === '102'));
  assert.ok(!JSON.stringify(result).includes('private-do-not-return'));
  await assert.rejects(() => client.read(BV, { page: 3 }), /共有 2 P/);
});

test('API risk failures are reported without repeating remote message or credentials', async () => {
  const secret = 'SESSDATA=do-not-leak';
  const mock = fixtures(url => url.pathname === '/x/web-interface/view' ? json(null, -412, { message: secret }) : undefined);
  const client = createBilibiliClient({ fetch: mock.fetch, getSettings: () => ({ biliCookie: secret }) });
  await assert.rejects(() => client.read(BV), error => /风控/.test(error.message) && !error.message.includes(secret));
  assert.equal(mock.calls[0].options.headers.Cookie, secret);
  const unsafe = fixtures(() => { throw new Error(`request error ${secret}`); });
  await assert.rejects(() => createBilibiliClient({ fetch: unsafe.fetch }).read(BV), error => !error.message.includes(secret));
});

test('only HTTPS known Bilibili video hosts accepted and shortlink redirects checked', async () => {
  const mock = fixtures(url => url.hostname === 'b23.tv' ? new Response(null, { status: 302, headers: { location: `https://www.bilibili.com/video/${BV}?p=2` } }) : url.hostname === 'www.bilibili.com' ? new Response('page') : undefined);
  const client = createBilibiliClient({ fetch: mock.fetch });
  const shortResult = await client.read('https://b23.tv/example', { comments: 0 });
  assert.equal(shortResult.bvid, BV);
  assert.equal(shortResult.page.number, 2);
  assert.equal(mock.calls[0].options.headers.Cookie, undefined);
  assert.equal(mock.calls[0].options.redirect, 'manual');
  await assert.rejects(() => client.read('http://www.bilibili.com/video/' + BV), /HTTPS/);
  await assert.rejects(() => client.read('https://bilibili.com.evil.test/video/' + BV), /允许域名/);
  await assert.rejects(() => client.read('https://user:secret@www.bilibili.com/video/' + BV), /HTTPS/);
  const evil = fixtures(url => url.hostname === 'b23.tv' ? new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } }) : undefined);
  await assert.rejects(() => createBilibiliClient({ fetch: evil.fetch }).read('https://b23.tv/example'), /允许域名/);
  assert.equal(evil.calls.length, 1);
});

test('reads available Chinese subtitle, sends no cookies to CDN, and reports truncation', async () => {
  const cookie = 'SESSDATA=private-cookie';
  const mock = fixtures((url, options) => {
    if (url.pathname === '/x/player/v2') return json({ subtitle: { subtitles: [{ lan: 'en', lan_doc: '英语', subtitle_url: '//i0.hdslb.com/en.json' }, { lan: 'zh-CN', lan_doc: '中文', subtitle_url: '//i0.hdslb.com/subtitle.json' }] } });
    if (url.hostname === 'i0.hdslb.com') {
      assert.equal(options.headers.Cookie, undefined);
      return new Response(JSON.stringify({ body: [{ from: 0, to: 2, content: '第一句' }, { from: 2, to: 3, content: 'x'.repeat(5000) }, { from: 3, to: 4, content: '最后一句' }] }));
    }
  });
  const result = await createBilibiliClient({ fetch: mock.fetch, getSettings: () => ({ biliCookie: cookie, maxTextChars: 2000 }) }).read(BV, { comments: 0 });
  assert.equal(result.subtitles.status, 'available');
  assert.equal(result.subtitles.language, 'zh-CN');
  assert.match(result.subtitles.text, /第一句/);
  assert.equal(result.subtitles.truncated, true);
  assert.ok(result.subtitles.text.length <= 2000);
  assert.ok(!JSON.stringify(result).includes(cookie));
});

test('subtitle login requirement and blocked subtitle redirects never masquerade as watched video', async () => {
  const login = fixtures(url => url.pathname === '/x/player/v2' ? json({ need_login_subtitle: true, subtitle: { subtitles: [] } }) : undefined);
  const result = await createBilibiliClient({ fetch: login.fetch }).read(BV, { comments: 0 });
  assert.equal(result.subtitles.status, 'login_required');
  const redirect = fixtures(url => {
    if (url.pathname === '/x/player/v2') return json({ subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: 'https://i0.hdslb.com/sub.json' }] } });
    if (url.hostname === 'i0.hdslb.com') return new Response(null, { status: 302, headers: { location: 'https://evil.test/leak' } });
  });
  const rejected = await createBilibiliClient({ fetch: redirect.fetch }).read(BV, { comments: 0 });
  assert.equal(rejected.subtitles.status, 'error');
  assert.match(rejected.subtitles.message, /允许域名/);
  assert.ok(!redirect.calls.some(x => x.url.hostname === 'evil.test'));
});

test('watch playback is explicitly requested and limited to single MP4 file', async () => {
  const mock = fixtures();
  const result = await createBilibiliClient({ fetch: mock.fetch }).read('av170001', { page: 2, comments: 0, playback: true });
  assert.equal(result.playback.status, 'available');
  assert.equal(result.playback.sizeBytes, 1234);
  assert.match(result.playbackUrl, /^https:\/\/cdn\.bilivideo\.com/);
  assert.ok(mock.calls.some(x => x.url.pathname === '/x/web-interface/view' && x.url.searchParams.get('aid') === '170001'));
  const dash = fixtures(url => url.pathname === '/x/player/playurl' ? json({ format: 'dash', dash: { video: [] } }) : undefined);
  assert.equal((await createBilibiliClient({ fetch: dash.fetch }).read(BV, { playback: true })).playback.status, 'unavailable');
  const split = fixtures(url => url.pathname === '/x/player/playurl' ? json({ format: 'mp4', durl: [{ url: 'https://cdn.bilivideo.com/a.mp4' }, { url: 'https://cdn.bilivideo.com/b.mp4' }] }) : undefined);
  assert.equal((await createBilibiliClient({ fetch: split.fetch }).read(BV, { playback: true })).playback.status, 'unavailable');
});

test('PCDN首选地址不可用时选择可信备用MP4；保留签名且不访问PCDN', async () => {
  const mock = fixtures(url => url.pathname === '/x/player/playurl' ? json({
    format: 'mp4', quality: 16, timelength: 87000,
    durl: [{ url: 'https://node.edge.mountaintoys.cn:4483/a.mp4?upsig=pcdn-secret', size: 5017247,
      backup_url: ['https://upos-sz-mirrorhwo1.bilivideo.com/a.mp4?upsig=cdn-signature', 'https://upos-sz-mirrorhw.bilivideo.com/a.mp4'] }]
  }) : undefined);
  const result = await createBilibiliClient({ fetch: mock.fetch }).read(BV, { playback: true });
  assert.equal(result.playback.status, 'available');
  assert.equal(result.playback.sizeBytes, 5017247);
  assert.equal(result.playbackUrl, 'https://upos-sz-mirrorhwo1.bilivideo.com/a.mp4?upsig=cdn-signature');
  assert.ok(mock.calls.every(x => !x.url.hostname.endsWith('mountaintoys.cn')));
});

test('仅官方CDN的HTTP地址升级HTTPS，未知线路与异常端口仍不能用', async () => {
  const responses = [
    { url: 'http://upos-sz-mirrorhw.bilivideo.com/a.mp4?upsig=keep', backup_url: [] },
    { url: 'https://bilivideo.com.evil.test/a.mp4', backup_url: ['https://cdn.bilivideo.com:4483/a.mp4', 'https://user:secret@cdn.bilivideo.com/a.mp4', 'https://127.0.0.1/a.mp4'] },
    { url: 'http://node.edge.example/a.mp4', backup_url: ['https://cdn.bilivideo.com/not-video.txt'] }
  ];
  for (const [i, item] of responses.entries()) {
    const mock = fixtures(url => url.pathname === '/x/player/playurl' ? json({ format: 'mp4', durl: [item] }) : undefined);
    const result = await createBilibiliClient({ fetch: mock.fetch }).read(BV, { playback: true });
    if (i === 0) {
      assert.equal(result.playback.status, 'available');
      assert.equal(result.playbackUrl, 'https://upos-sz-mirrorhw.bilivideo.com/a.mp4?upsig=keep');
    } else {
      assert.equal(result.playback.status, 'unavailable');
      assert.equal(result.playbackUrl, undefined);
      assert.doesNotMatch(JSON.stringify(result.playback), /secret|127\.0\.0\.1|example|evil/);
    }
    assert.ok(mock.calls.every(x => x.url.hostname === 'api.bilibili.com'));
  }
});

test('WBI search signs query, accepts anonymous nav keys and strips HTML', async () => {
  const calls = [];
  const client = createBilibiliClient({ fetch: async (input, options) => {
    const url = new URL(input); calls.push(url);
    if (url.pathname === '/x/web-interface/nav') return json({ wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/' + 'a'.repeat(32) + '.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/' + 'b'.repeat(32) + '.png' } }, -101);
    assert.equal(url.pathname, '/x/web-interface/wbi/search/type');
    assert.match(url.searchParams.get('w_rid'), /^[a-f0-9]{32}$/);
    assert.equal(url.searchParams.get('page_size'), '2');
    assert.equal(url.searchParams.get('keyword'), '机器学习');
    return json({ numResults: 1, result: [{ bvid: BV, aid: 170001, title: '<em class="keyword">机器</em>学习 &amp; 科普', author: 'UP', mid: 1, description: '简介', play: 123, pubdate: 1700000000 }] });
  } });
  const result = await client.search('机器学习', { limit: 2 });
  assert.equal(result.results[0].title, '机器学习 & 科普');
  await client.search('机器学习', { limit: 2 });
  assert.equal(calls.filter(x => x.pathname === '/x/web-interface/nav').length, 1);
});

test('rejects large responses, HTTP risk blocks, and non-JSON without exposing body', async () => {
  const large = createBilibiliClient({ fetch: async () => new Response('secret', { headers: { 'content-length': '9999999' } }) });
  await assert.rejects(() => large.read(BV), /响应过大/);
  const html = createBilibiliClient({ fetch: async () => new Response('<html>secret token</html>') });
  await assert.rejects(() => html.read(BV), error => /非 JSON/.test(error.message) && !error.message.includes('secret'));
  const blocked = createBilibiliClient({ fetch: async () => new Response('secret', { status: 412 }) });
  await assert.rejects(() => blocked.read(BV), /HTTP 412/);
});
