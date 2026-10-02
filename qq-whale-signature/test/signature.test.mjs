import test from 'node:test';
import assert from 'node:assert/strict';
import { createSignatureClient, normalizeSignature } from '../skills/whale-signature/signature.js';

const client = createSignatureClient();
function context(handler) {
  const calls = [];
  const ctx = { selfId: '99999999', onebot: { selfId: '99999999', async call(action, params) { calls.push({ action, params }); return handler(action, params); } } };
  return { ctx, calls };
}
test('个性签名文字是非空单行，80字符按码点限制，不会默默截断', () => {
  assert.equal(normalizeSignature('  今天先吃饭吧。  '), '今天先吃饭吧。');
  assert.equal(normalizeSignature('🐳'.repeat(80)).length, 160);
  for (const text of ['', ' ', 'a\nb', 'a\u0000b', '🐳'.repeat(81), 123]) assert.throws(() => normalizeSignature(text));
});
test('只读机器人本人，使用真实user_id和long_nick，不回显资料中的密钥', async () => {
  const { ctx, calls } = context(() => ({ user_id: 99999999, long_nick: '在海里游泳', cookie: 'private-cookie', token: 'private-token' }));
  const read = await client.read(ctx);
  assert.equal(read.signature, '在海里游泳');
  assert.deepEqual(calls[0], { action: 'get_stranger_info', params: { user_id: 99999999 } });
  assert.doesNotMatch(JSON.stringify(read), /private-cookie|private-token/);
  assert.equal((await client.read({ ...ctx, selfId: '88888888' })).ok, false);
  assert.equal(calls.length, 1);
});
test('真实修改只调用set_self_longnick一次；成功后只读核验', async () => {
  let signature = '原签名';
  const { ctx, calls } = context((action, params) => {
    if (action === 'set_self_longnick') { signature = params.longNick; return {}; }
    return { data: { user_id: 99999999, long_nick: signature } };
  });
  const changed = await client.set(ctx, '新的签名');
  assert.equal(changed.verified, true); assert.equal(changed.changed, true);
  assert.deepEqual(calls, [
    { action: 'set_self_longnick', params: { longNick: '新的签名' } },
    { action: 'get_stranger_info', params: { user_id: 99999999 } }
  ]);
});
test('已接受但缓存尚未更新时不声称已核验；缺字段不当空签名', async () => {
  const old = context(action => action === 'set_self_longnick' ? {} : { long_nick: '原签名' });
  const changed = await client.set(old.ctx, '新签名');
  assert.equal(changed.status, 'accepted'); assert.equal(changed.verified, false); assert.equal(changed.changed, null);
  assert.match(changed.note, /缓存/);
  const missing = context(() => ({ nickname: '小鲸鱼' }));
  assert.equal((await client.read(missing.ctx)).errorCode, 'signature_field_unavailable');
  assert.equal((await client.set(missing.ctx, '新签名')).verified, false);
  const wrong = context(() => ({ user_id: 88888888, long_nick: '新签名' }));
  assert.equal((await client.read(wrong.ctx)).errorCode, 'signature_account_mismatch');
});
test('超时不重试、错误中的密钥不泄露、未支持接口说明原因', async () => {
  const timeout = context(() => { throw new Error('Timeout authorization: SECRET https://server.example/?token=SECRET'); });
  const result = await client.set(timeout.ctx, '新签名');
  assert.equal(result.ok, false); assert.equal(result.uncertain, true);
  assert.equal(timeout.calls.length, 1); assert.doesNotMatch(JSON.stringify(result), /SECRET|server\.example/);
  const missing = context(() => { throw new Error('unsupported action'); });
  assert.equal((await client.set(missing.ctx, '新签名')).errorCode, 'unsupported_action');
  assert.equal(missing.calls.length, 1);
});
test('查询期间账号变化不会采用错误资料，写后发生变化仍报告已接受但未核验', async () => {
  let ctx;
  const fixture = context(action => {
    if (action === 'get_stranger_info') { ctx.onebot.selfId = '88888888'; return { user_id: 99999999, long_nick: '新签名' }; }
    return {};
  });
  ctx = fixture.ctx;
  assert.equal((await client.read(ctx)).errorCode, 'signature_account_mismatch');
  ctx.onebot.selfId = '99999999';
  const changed = await client.set(ctx, '新签名');
  assert.equal(changed.status, 'accepted');
  assert.equal(changed.verified, false);
  assert.equal(fixture.calls.filter(c => c.action === 'set_self_longnick').length, 1);
});
