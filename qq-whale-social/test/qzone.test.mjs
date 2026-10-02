import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneClient, normalizePublish } from '../skills/whale-social/qzone.js';

function client(settings = {}, response = {}) {
  const calls = [];
  const qzone = createQzoneClient({ getSettings: () => settings });
  const ctx = { selfId: 99887766, onebot: { call: async (...args) => { calls.push(args); if (response instanceof Error) throw response; return response; } } };
  return { qzone, ctx, calls };
}

test('QZone reads pass real SnowLuma parameters and expose only normalized fields', async () => {
  const { qzone, ctx, calls } = client({}, { total: 18, skey: 'DO_NOT_LEAK', msglist: [{ tid: 'tid1', content: '一条说说', time: 1777777777, comment_num: 2, is_private: false, images: ['https://m.qpic.cn/img.jpg?skey=DO_NOT_LEAK&bo=normal'], cookie: 'DO_NOT_LEAK' }] });
  const result = await qzone.read(ctx, { targetQQ: '10000001', offset: 2, limit: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ['get_qzone_msg_list', { target_uin: 10000001, pos: 2, num: 1 }, 20000]);
  assert.equal(result.total, 18);
  assert.equal(result.items[0].content, '一条说说');
  assert.equal(result.items[0].commentCount, 2);
  assert.equal(JSON.stringify(result).includes('DO_NOT_LEAK'), false);
  assert.equal(result.items[0].images[0], 'https://m.qpic.cn/img.jpg?bo=normal');
});

test('QZone supports documented empty lists and legacy raw fields without exposing raw objects', async () => {
  const empty = client({}, { total: 0, msglist: null });
  assert.deepEqual((await empty.qzone.read(empty.ctx)).items, []);
  assert.deepEqual(empty.calls[0][1], { pos: 0, num: 10 });
  const legacy = client({}, { data: { total: 1, msglist: [{ tid: 44, content: 'skey=secret; hello', created_time: '111', cmtnum: '2', secret: 1, pic: [{ url3: 'https://m.qpic.cn/full.jpg' }] }] } });
  const result = await legacy.qzone.read(legacy.ctx);
  assert.equal(result.items[0].private, true);
  assert.equal(result.items[0].time, 111);
  assert.equal(result.items[0].content.includes('secret'), false);
  assert.equal(result.items[0].images[0], 'https://m.qpic.cn/full.jpg');
  const unknown = client({}, { cookie: 'secret' });
  assert.equal((await unknown.qzone.read(unknown.ctx)).errorCode, 'qzone_response_unknown');
});

test('QZone feeds extract actual post paragraphs, strip scripts and avoid UI boilerplate', async () => {
  const { qzone, ctx, calls } = client({}, { feeds: [{ uin: '12345678', nickname: '朋友', time: 123, appid: 311, key: 'key1', html: '<div class="f-single-head">按钮</div><div class="f-info qz_info_cut">旧摘要</div><div class="f-info qz_info_complete">正文&lt;字&gt;<br/>下一行<script>cookie=PRIVATE</script> &amp; 测试<img alt="[笑]" src="foo"/></div><div>赞评论</div>', skey: 'PRIVATE' }], has_more: true });
  const result = await qzone.feeds(ctx, { page: 2, limit: 1 });
  assert.deepEqual(calls[0], ['get_qzone_feeds', { page_num: 2, count: 1 }, 20000]);
  assert.equal(result.ok, true);
  assert.equal(result.hasMore, true);
  assert.match(result.items[0].content, /正文<字>\n下一行 & 测试 \[笑\]/);
  assert.equal(result.items[0].content.includes('按钮'), false);
  assert.equal(result.items[0].content.includes('旧摘要'), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.match(result.warnings.join(''), /只有首页可靠/);
});

test('QZone feeds support legacy raw envelopes, holes, and empty complete blocks', async () => {
  const { qzone, ctx } = client({}, { data: { main: { hasMoreFeeds: false }, data: [null, { uin: 12345678, abstime: '555', html: '<div class="f-info qz_info_cut">摘要&#x4F60;&#22909; 展开全文</div><div class="f-info qz_info_complete none"></div>' }] } });
  const result = await qzone.feeds(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.hasMore, false);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].content, '摘要你好');
  assert.equal(result.items[0].time, 555);
  assert.equal((await qzone.feeds(ctx, { limit: 1 })).items.length, 1);
});

test('QZone rejects out-of-range arguments before calling the protocol', async () => {
  const { qzone, ctx, calls } = client();
  for (const args of [{ limit: 21 }, { limit: 0 }, { offset: -1 }, { offset: 10001 }, { targetQQ: 'not-a-qq' }, { targetQQ: '1234' }]) assert.equal((await qzone.read(ctx, args)).ok, false);
  for (const args of [{ page: 0 }, { page: 1001 }, { limit: 21 }, { page: 1.5 }]) assert.equal((await qzone.feeds(ctx, args)).ok, false);
  assert.equal(calls.length, 0);
});

test('QZone only publishes validated text and trusted HTTPS images with configured visibility', async () => {
  const { qzone, ctx, calls } = client({ qzoneVisibility: 4 }, { tid: 'published', time: 555, skey: 'SECRET' });
  const result = await qzone.publish(ctx, { text: '  新动态  ', images: ['https://m.qpic.cn/a.jpg#fragment'], ugc_right: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.published, true);
  assert.equal(result.visibility, 4);
  assert.deepEqual(calls, [['send_qzone_msg', { content: '新动态', images: ['https://m.qpic.cn/a.jpg'], ugc_right: 4 }, 45000]]);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.deepEqual(normalizePublish({ text: '🙂'.repeat(2000) }), { text: '🙂'.repeat(2000), images: [] });
  const nested = client({}, { data: { tid: 'nested', time: 888 } });
  assert.equal((await nested.qzone.publish(nested.ctx, { text: 'okay' })).tid, 'nested');
});

test('QZone publish validation blocks empty text, oversized payloads, local paths and unsafe images', async () => {
  const { qzone, ctx, calls } = client();
  const invalid = [{ text: '' }, { text: '  ' }, { text: 'a'.repeat(2001) }, { text: 'a\0' }, { text: 'okay', images: 'bad' }, { text: 'okay', images: Array(10).fill('https://m.qpic.cn/a.jpg') }];
  for (const image of ['file:///C:/secret.txt', 'base64://secret', 'http://m.qpic.cn/a.jpg', 'https://127.0.0.1/a.jpg', 'https://192.168.1.1/a.jpg', 'https://[::1]/a.jpg', 'https://169.254.169.254/a.jpg', 'https://localhost/a.jpg', 'https://m.qpic.cn.evil.test/a.jpg', 'https://evil.invalid/a.jpg', 'https://u:p@m.qpic.cn/a.jpg', 'https://m.qpic.cn:8443/a.jpg', 'https://m.qpic.cn/a.jpg?skey=SECRET']) invalid.push({ text: 'okay', images: [image] });
  for (const args of invalid) {
    assert.equal((await qzone.publish(ctx, args)).errorCode, 'invalid_arguments');
    assert.throws(() => normalizePublish(args), { name: 'QzoneValidationError' });
  }
  assert.equal(calls.length, 0);
  for (const visibility of [16, 128, 999]) assert.throws(() => normalizePublish({ text: 'okay' }, { qzoneVisibility: visibility }), { name: 'QzoneValidationError' });
});

test('QZone network errors are redacted, unsupported reads explain the dependency, publishing never retries', async () => {
  const missing = client({}, new Error('404 unknown action cookie=VERY_SECRET'));
  assert.equal((await missing.qzone.read(missing.ctx)).errorCode, 'unsupported_action');
  assert.equal((await missing.qzone.feeds(missing.ctx)).errorCode, 'unsupported_action');
  const timeout = client({}, new Error('timeout: skey=VERY_SECRET'));
  const read = await timeout.qzone.read(timeout.ctx);
  assert.equal(read.errorCode, 'qzone_timeout');
  const publish = await timeout.qzone.publish(timeout.ctx, { text: 'one post' });
  assert.equal(publish.ok, false);
  assert.equal(publish.uncertain, true);
  assert.match(publish.error, /不要立即重发/);
  assert.equal(JSON.stringify([read, publish]).includes('VERY_SECRET'), false);
  assert.equal(timeout.calls.filter(([action]) => action === 'send_qzone_msg').length, 1);
});

test('QZone publication without a returned tid remains unconfirmed and lists remain bounded', async () => {
  const uncertain = client({}, { code: 0, skey: 'SECRET' });
  assert.equal((await uncertain.qzone.publish(uncertain.ctx, { text: 'post' })).uncertain, true);
  const many = client({}, { total: 999, msglist: Array.from({ length: 1000 }, (_, n) => ({ tid: String(n), content: 'x'.repeat(100000), images: Array(50).fill('https://m.qpic.cn/a.jpg') })) });
  const result = await many.qzone.read(many.ctx, { limit: 2 });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].content.length, 1001);
  assert.equal(result.items[0].images.length, 3);
  assert.equal(result.items[0].complete, false);
});

test('QZone without connected OneBot returns a useful error', async () => {
  const qzone = createQzoneClient();
  assert.equal((await qzone.read({})).errorCode, 'onebot_unavailable');
  assert.equal((await qzone.feeds({})).errorCode, 'onebot_unavailable');
  assert.equal((await qzone.publish({}, { text: 'valid text' })).errorCode, 'onebot_unavailable');
});

test('QZone read and feeds enforce the live shared text budget across text and nickname', async () => {
  const settings = { maxTextChars: 2000 };
  const entries = Array.from({ length: 20 }, (_, n) => ({ tid: `id${n}`, key: `id${n}`, content: 'x'.repeat(1000), nickname: 'n'.repeat(80) }));
  const read = client(settings, { total: 20, msglist: entries });
  const first = await read.qzone.read(read.ctx, { limit: 20 });
  assert.equal(first.ok, true);
  assert.equal(first.maxTextChars, 2000);
  assert.equal(first.textTruncated, true);
  assert.equal(first.items.reduce((sum, item) => sum + item.content.length + item.nickname.length, 0), 2000);
  assert.equal(first.items.length, 20);
  assert.equal(first.items.at(-1).content, '');
  assert.equal(first.items.at(-1).complete, false);
  settings.maxTextChars = 30000;
  const second = await read.qzone.read(read.ctx, { limit: 20 });
  assert.equal(second.maxTextChars, 30000);
  assert.equal(second.textTruncated, false);
  assert.equal(second.items.at(-1).content.length, 1000);
  const feeds = client({ maxTextChars: 2000 }, { feeds: entries.map(({ content, ...entry }) => ({ ...entry, html: `<div class="f-info">${content}</div>` })) });
  const feedResult = await feeds.qzone.feeds(feeds.ctx, { limit: 20 });
  assert.equal(feedResult.textTruncated, true);
  assert.equal(feedResult.items.reduce((sum, item) => sum + item.content.length + item.nickname.length, 0), 2000);
});

test('QZone uses a default 12000 text budget and bounds invalid configuration', async () => {
  const entries = Array.from({ length: 20 }, () => ({ content: 'x'.repeat(1000), nickname: 'n'.repeat(80) }));
  for (const [configured, expected] of [[undefined, 12000], [NaN, 12000], [1, 2000], [999999, 30000]]) {
    const read = client({ maxTextChars: configured }, { total: 20, msglist: entries });
    const result = await read.qzone.read(read.ctx, { limit: 20 });
    assert.equal(result.maxTextChars, expected);
    assert.ok(result.items.reduce((sum, item) => sum + item.content.length + item.nickname.length, 0) <= expected);
  }
});
