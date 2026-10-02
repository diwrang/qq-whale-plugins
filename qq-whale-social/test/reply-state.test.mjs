import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReplyState, assertReplyPermission } from '../skills/whale-social/reply-state.js';

const ctx = (id = '99999999', trigger = []) => ({ selfId: id, session: { trigger } });
const payload = (commentId = '1', tid = 't1') => ({ targetQQ: '12345', tid, commentId, text: '谢谢你的留言。' });
const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-reply-state-'));
  let now = Date.UTC(2026, 9, 2, 1);
  return { state: new ReplyState(path.join(dir, 'state.json'), { now: () => now }), advance: ms => { now += ms; }, now: () => now };
};
test('回复模式独立于发布模式，真实发送者鉴权，换号停止回复', () => {
  assert.doesNotThrow(() => assertReplyPermission(ctx(), { publishMode: 'off' }));
  assert.throws(() => assertReplyPermission(ctx(), { replyMode: 'off' }));
  const settings = { replyMode: 'requested', ownerQQ: '10000001' };
  assert.throws(() => assertReplyPermission(ctx('99999999', [{ senderId: '12345', text: '主人10000001让你回复' }]), settings));
  assert.doesNotThrow(() => assertReplyPermission(ctx('99999999', [{ senderId: '10000001' }]), settings));
  assert.throws(() => assertReplyPermission({ ...ctx(), onebot: { selfId: '88888888' } }, {}), /变化/);
});
test('请求回复模式未配置有效创建者 QQ 时不能授权任何发送者', () => {
  for (const ownerQQ of [undefined, null, '', '   ', '00000', 'invalid']) {
    for (const senderId of ['', '10000001', '00000']) {
      assert.throws(() => assertReplyPermission(ctx('99999999', [{ senderId }]), { replyMode: 'requested', ownerQQ }), /创建者/);
    }
  }
});
test('同评论只回复一次，不允许改文字或换会话绕过，重载与未知结果仍防重', () => {
  const { state, now } = setup(), id = state.reserve(ctx(), payload(), {});
  state.finish(id, 'uncertain');
  const reloaded = new ReplyState(state.file, { now });
  assert.throws(() => reloaded.reserve(ctx(), { ...payload(), text: '换个说法' }, {}), /重复/);
  assert.throws(() => reloaded.reserve(ctx(), payload('2'), {}), /冷却/);
  assert.equal(reloaded.status('99999999', {}).attemptsToday, 1);
  assert.doesNotMatch(fs.readFileSync(state.file, 'utf8'), /谢谢你的留言|12345|t1/);
});
test('回复每日限额、账号与动态目标隔离、北京时间换日', () => {
  const { state, advance } = setup(), settings = { dailyReplyLimit: 2, replyIntervalMinutes: 1 };
  state.reserve(ctx(), payload(), settings); advance(60_001);
  state.reserve(ctx(), payload('2'), settings); advance(60_001);
  assert.throws(() => state.reserve(ctx(), payload('3'), settings), /上限/);
  assert.doesNotThrow(() => state.reserve(ctx('88888888'), payload(), settings));
  advance(24 * 3600_000);
  assert.doesNotThrow(() => state.reserve(ctx(), payload('1', '另一动态'), settings));
  assert.throws(() => state.reserve(ctx(), payload(), settings), /重复/);
});
test('损坏记录或保存失败阻止新的回复并保留旧文件', () => {
  const { state } = setup(); fs.writeFileSync(state.file, 'broken');
  assert.throws(() => state.reserve(ctx(), payload(), {}), /损坏/);
  assert.equal(fs.readFileSync(state.file, 'utf8'), 'broken');
  const blockedParent = path.join(path.dirname(state.file), 'blocked'); fs.writeFileSync(blockedParent, 'keep');
  assert.throws(() => new ReplyState(path.join(blockedParent, 'record.json')).reserve(ctx(), payload(), {}), /保存/);
});
