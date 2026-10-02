import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommentClient, normalizeReply } from '../skills/whale-social/comments.js';

const SELF = '99887766';
const OWNER = '10000001';
const AUTHOR = '12345678';
const SECRET = 'PRIVATE_QZONE_KEY';
const cookies = `p_uin=o${SELF}; uin=o${SELF}; p_skey=${SECRET}; skey=OTHER_PRIVATE_KEY`;
const initial = () => ({ code: 0, tid: 'post123', uin: OWNER, content: '说说', cmtnum: 1,
  commentlist: [{ tid: '11', uin: AUTHOR, name: '朋友', content: '你好', create_time: 1700000000, reply_num: 0, list_3: [] }] });
const payload = { targetQQ: OWNER, tid: 'post123', commentId: '11', text: '你好呀' };
function response(value, extra = {}) { return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200, ...extra }); }
function harness({ results = [initial()], settings = {}, cookieResponse = { cookies }, onFetch } = {}) {
  const calls = [];
  const onebotCalls = [];
  let index = 0;
  const client = createCommentClient({ getSettings: () => settings, fetch: async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (onFetch) return onFetch(new URL(url), options, calls.length);
    const value = results[Math.min(index++, results.length - 1)];
    if (value instanceof Error) throw value;
    return response(value);
  } });
  const ctx = { selfId: SELF, onebot: { call: async (...args) => { onebotCalls.push(args); if (cookieResponse instanceof Error) throw cookieResponse; return cookieResponse; } } };
  return { client, ctx, calls, onebotCalls };
}
function verifiedReply(id = '21') {
  const data = initial();
  data.commentlist[0].reply_num = 1;
  data.commentlist[0].list_3 = [{ tid: id, uin: SELF, content: `@{uin:${AUTHOR},nick:朋友,auto:1} ${payload.text}`, create_time: Math.floor(Date.now() / 1000) }];
  return data;
}

test('comments read real detail parameters, expose thread handles and redact login fields', async () => {
  const data = initial();
  data.commentlist[0].content = `skey=${SECRET}; 外部文字`;
  data.commentlist[0].cookie = SECRET;
  data.commentlist[0].reply_num = 1;
  data.commentlist[0].list_3 = [{ tid: 7, uin: SELF, name: '鲸鱼娘', content: '回复', create_time: 1700000001 }];
  const h = harness({ results: [data] });
  const result = await h.client.comments(h.ctx, { targetQQ: OWNER, tid: 'post123', offset: 0, limit: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.items[0].commentId, '11');
  assert.equal(result.items[0].authorQQ, AUTHOR);
  assert.equal(result.items[0].replyable, true);
  assert.equal(result.items[0].replies[0].parentCommentId, '11');
  assert.equal(result.items[0].replies[0].replyable, false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.deepEqual(h.onebotCalls, [['get_cookies', { domain: 'qzone.qq.com' }, 15000]]);
  assert.equal(h.calls[0].url.origin, 'https://h5.qzone.qq.com');
  assert.equal(h.calls[0].url.pathname, '/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6');
  assert.equal(h.calls[0].url.searchParams.get('uin'), OWNER);
  assert.equal(h.calls[0].url.searchParams.get('tid'), 'post123');
  assert.equal(h.calls[0].url.searchParams.get('num'), '2');
  assert.equal(h.calls[0].options.headers.Cookie, cookies);
  assert.equal(h.calls[0].options.redirect, 'error');
});

test('raw-list fallback preserves real comment IDs and ignores arbitrary HTML comments', async () => {
  const h = harness({ results: ['<html>detail unavailable</html>', { code: 0, msglist: [initial(), { ...initial(), tid: 'otherPost' }] }] });
  const result = await h.client.comments(h.ctx, { targetQQ: OWNER, tid: 'post123' });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'qzone_post_list_json');
  assert.equal(result.items[0].commentId, '11');
  assert.equal(h.calls[1].url.searchParams.get('replynum'), '100');
  const html = harness({ results: [{ code: 0, html: '<div data-tid="11">你好</div>' }] });
  assert.equal((await html.client.comments(html.ctx, { targetQQ: OWNER, tid: 'post123' })).ok, false);
});

test('comment reading rejects cross-post identities, failed status and unknown response shapes', async () => {
  for (const bad of [{ ...initial(), uin: SELF }, { ...initial(), tid: 'otherPost' }, { ...initial(), code: -3 }, { code: 0, tid: 'post123', uin: OWNER }, { ...initial(), code: undefined }, { code: 0, msglist: [] }]) {
    const h = harness({ results: [bad] });
    const result = await h.client.comments(h.ctx, { targetQQ: OWNER, tid: 'post123' });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'qzone_comments_unavailable');
  }
  const empty = harness({ results: [{ code: 0, uin: SELF, tid: 'post123', cmtnum: 0, commentlist: null }] });
  const result = await empty.client.comments(empty.ctx, { tid: 'post123' });
  assert.equal(result.ok, true);
  assert.equal(result.targetQQ, SELF);
  assert.deepEqual(result.items, []);
});

test('validation rejects invalid IDs, unsupported mentions and oversized replies before getting cookies', async () => {
  const h = harness();
  for (const args of [{ ...payload, text: '' }, { ...payload, text: 'x'.repeat(1001) }, { ...payload, text: 'bad\0' }, { ...payload, text: '@{uin:11111,nick:other} reply' },
    { ...payload, tid: '../secret' }, { ...payload, commentId: 'https://evil.invalid' }, { ...payload, targetQQ: '1234' }]) {
    assert.throws(() => normalizeReply(args), { name: 'QzoneValidationError' });
    assert.equal((await h.client.reply(h.ctx, args)).errorCode, 'invalid_arguments');
  }
  for (const args of [{ tid: 'post123', limit: 21 }, { tid: 'post123', offset: -1 }]) assert.equal((await h.client.comments(h.ctx, args)).errorCode, 'invalid_arguments');
  assert.equal(h.calls.length, 0);
  assert.equal(h.onebotCalls.length, 0);
  assert.deepEqual(normalizeReply({ tid: 'post123', commentId: 11, text: '  🙂  ' }), { tid: 'post123', commentId: '11', text: '🙂' });
});

test('credentials are account-checked, domain-fixed and errors never disclose their body', async () => {
  for (const cookieResponse of [{ cookies: `p_uin=o${OWNER}; p_skey=${SECRET}` }, { cookies: `p_uin=o${SELF}` }, { cookies: `${cookies}\r\nX-Evil: yep` }, new Error(`get_cookies failed ${SECRET}`)]) {
    const h = harness({ cookieResponse });
    const result = await h.client.reply(h.ctx, payload);
    assert.equal(result.ok, false);
    assert.equal(h.calls.length, 0);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
  const client = createCommentClient();
  assert.equal((await client.comments({}, { tid: 'post123' })).errorCode, 'onebot_unavailable');
  assert.equal((await client.reply({}, payload)).errorCode, 'onebot_unavailable');
});

test('reply posts explicit thread parameters only after policy callback and verifies nested readback', async () => {
  const events = [];
  const h = harness({ results: [initial(), { code: 0, subcode: 0, commentid: 21 }, verifiedReply()] });
  const result = await h.client.reply(h.ctx, { ...payload, replyUin: OWNER }, { beforeWrite(resolved) {
    events.push('reserve');
    assert.equal(h.calls.length, 1);
    assert.deepEqual(resolved, { ...payload, authorQQ: AUTHOR });
  } });
  assert.deepEqual(events, ['reserve']);
  assert.equal(result.ok, true);
  assert.equal(result.replied, true);
  assert.equal(result.verified, true);
  assert.equal(result.parentCommentId, '11');
  assert.equal(result.commentId, '21');
  assert.equal(result.replyToQQ, AUTHOR);
  const post = h.calls[1];
  assert.equal(post.options.method, 'POST');
  assert.equal(post.url.pathname, '/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds');
  const body = new URLSearchParams(post.options.body);
  assert.equal(body.get('paramstr'), '2');
  assert.equal(body.get('commentId'), '11');
  assert.equal(body.get('commentUin'), AUTHOR);
  assert.equal(body.get('t1_uin'), OWNER);
  assert.equal(body.get('t1_tid'), 'post123');
  assert.equal(body.get('t2_uin'), AUTHOR);
  assert.equal(body.get('t2_tid'), '11');
  assert.equal(body.get('topicId'), `${OWNER}_post123__1`);
  assert.equal(body.get('uin'), SELF);
  assert.match(body.get('content'), /^@\{uin:12345678,nick:朋友,auto:1\} 你好呀$/);
  assert.equal(h.calls.filter((call) => call.options.method === 'POST').length, 1);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('last-moment policy errors propagate with no POST', async () => {
  const h = harness();
  const block = new Error('已关闭回复');
  await assert.rejects(h.client.reply(h.ctx, payload, { beforeWrite() { throw block; } }), (error) => error === block);
  assert.equal(h.calls.filter((call) => call.options.method === 'POST').length, 0);
});

test('missing comments, own comments and already identical replies do not reserve or write', async () => {
  const own = initial();
  own.commentlist[0].uin = SELF;
  for (const [data, code] of [[{ ...initial(), commentlist: [] }, 'qzone_comment_not_found'], [own, 'qzone_self_reply'], [verifiedReply(), 'qzone_reply_exists']]) {
    const h = harness({ results: [data] });
    let reserved = false;
    const result = await h.client.reply(h.ctx, payload, { beforeWrite() { reserved = true; } });
    assert.equal(result.errorCode, code);
    assert.equal(reserved, false);
    assert.equal(h.calls.filter((call) => call.options.method === 'POST').length, 0);
  }
});

test('code-zero acknowledgment does not count as verified threading; unknown replies never retry', async () => {
  for (const ack of [{ code: 0, commentid: 21 }, {}, '<html>PRIVATE_QZONE_KEY</html>', new Error(`timeout cookie=${SECRET}`)]) {
    const h = harness({ results: [initial(), ack, initial()] });
    const result = await h.client.reply(h.ctx, payload);
    assert.equal(result.ok, false);
    assert.equal(result.replied, false);
    assert.equal(result.uncertain, true);
    assert.equal(result.accepted === true, Boolean(ack.code === 0));
    assert.equal(h.calls.filter((call) => call.options.method === 'POST').length, 1);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});

test('an explicit negative CGI result remains a redacted rejection', async () => {
  const h = harness({ results: [initial(), { code: 0, subcode: -3, message: `permission cookie=${SECRET}` }] });
  const result = await h.client.reply(h.ctx, payload);
  assert.equal(result.errorCode, 'qzone_reply_rejected');
  assert.equal(result.uncertain, false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(h.calls.length, 2);
});

test('a top-level comment or a reply under a different parent never verifies the requested reply', async () => {
  const topLevel = initial();
  topLevel.commentlist.push({ tid: '21', uin: SELF, content: payload.text });
  const wrongThread = initial();
  wrongThread.commentlist.push({ tid: '12', uin: AUTHOR, content: '其他评论', list_3: verifiedReply().commentlist[0].list_3 });
  const oldReplay = initial();
  oldReplay.commentlist[0].list_3 = [{ tid: '21', uin: SELF, content: payload.text, create_time: 1700000000 }];
  for (const data of [topLevel, wrongThread, oldReplay]) {
    const h = harness({ results: [initial(), { code: 0 }, data] });
    const result = await h.client.reply(h.ctx, payload);
    assert.equal(result.ok, false);
    assert.equal(result.accepted, true);
    assert.equal(result.uncertain, true);
  }
});

test('missing returned id is allowed only with a new recent nested reply matching author and text', async () => {
  const h = harness({ results: [initial(), { code: 0 }, verifiedReply()] });
  const result = await h.client.reply(h.ctx, payload);
  assert.equal(result.ok, true);
  assert.equal(result.commentId, '21');
});

test('detail pagination locates later real comments before reserving once', async () => {
  const page1 = initial();
  page1.cmtnum = 25;
  page1.commentlist = Array.from({ length: 20 }, (_, i) => ({ tid: String(i + 100), uin: AUTHOR, name: '朋友', content: '评论', list_3: [] }));
  const page2 = initial();
  page2.cmtnum = 25;
  const h = harness({ results: [page1, page2, { code: 0, commentid: 21 }, verifiedReply()] });
  let reserved = 0;
  const result = await h.client.reply(h.ctx, payload, { beforeWrite() { reserved++; } });
  assert.equal(result.ok, true);
  assert.equal(reserved, 1);
  assert.equal(h.calls[1].url.searchParams.get('pos'), '20');
  assert.equal(h.calls[3].url.searchParams.get('pos'), '20');
});

test('comment responses bound text including nested replies and reject oversized bodies', async () => {
  const data = initial();
  data.commentlist = Array.from({ length: 20 }, (_, i) => ({ tid: String(i + 1), uin: AUTHOR, name: 'n'.repeat(80), content: 'x'.repeat(2000), reply_num: 10,
    list_3: Array.from({ length: 10 }, (_, j) => ({ tid: String(j + 1), uin: SELF, name: 'r'.repeat(80), content: 'y'.repeat(2000) })) }));
  const h = harness({ results: [data], settings: { maxTextChars: 2000 } });
  const result = await h.client.comments(h.ctx, { ...payload, limit: 20 });
  assert.equal(result.ok, true);
  assert.equal(result.textTruncated, true);
  const chars = result.items.reduce((sum, item) => sum + item.nickname.length + item.text.length + item.replies.reduce((a, reply) => a + reply.nickname.length + reply.text.length, 0), 0);
  assert.equal(chars, 2000);
  const huge = harness({ results: ['x'.repeat(1024 * 1024 + 1)] });
  assert.equal((await huge.client.comments(huge.ctx, payload)).ok, false);
});

test('credentialed requests cannot follow redirects and include only fixed QQ origins', async () => {
  const h = harness({ onFetch: async (url, options) => {
    assert.equal(url.origin, 'https://h5.qzone.qq.com');
    assert.equal(options.redirect, 'error');
    return response({ code: 0 }, { status: 302, headers: { location: 'https://evil.invalid' } });
  } });
  const result = await h.client.reply(h.ctx, payload);
  assert.equal(result.ok, false);
  assert.equal(h.calls.filter((call) => call.options.method === 'POST').length, 0);
});
