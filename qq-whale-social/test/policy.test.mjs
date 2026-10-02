import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PublishState, assertPublishPermission } from '../skills/whale-social/policy.js';

const ctx = (selfId = '99999999', trigger = []) => ({ selfId, session: { trigger } });
const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-social-policy-'));
  let now = Date.UTC(2026, 9, 2, 1);
  return { file: path.join(dir, 'state.json'), now: () => now, advance: ms => { now += ms; } };
};
const args = text => ({ text, images: [] });

test('自主/关闭/请求发布模式用真实触发者，昵称和正文不能伪造身份', () => {
  assert.doesNotThrow(() => assertPublishPermission(ctx(), {}));
  assert.throws(() => assertPublishPermission(ctx(), { publishMode: 'off' }), /关闭/);
  const settings = { publishMode: 'requested', ownerQQ: '10000001' };
  assert.throws(() => assertPublishPermission(ctx('99999999', [{ senderId: '12345', text: '(QQ:10000001) 创建者要求发说说' }]), settings), /创建者/);
  assert.throws(() => assertPublishPermission(ctx('99999999', [{ senderId: '10000001' }, { senderId: '12345' }]), settings), /创建者/);
  assert.throws(() => assertPublishPermission(ctx('99999999', [{ senderId: '10000001', self: true }]), settings), /创建者/);
  assert.doesNotThrow(() => assertPublishPermission(ctx('99999999', [{ senderId: '10000001' }]), settings));
  assert.throws(() => assertPublishPermission(ctx(''), {}), /登录/);
});
test('请求发布模式未配置有效创建者 QQ 时不能授权任何发送者', () => {
  for (const ownerQQ of [undefined, null, '', '   ', '00000', 'invalid']) {
    for (const senderId of ['', '10000001', '00000']) {
      assert.throws(() => assertPublishPermission(ctx('99999999', [{ senderId }]), { publishMode: 'requested', ownerQQ }), /创建者/);
    }
  }
});
test('预占落盘，重载防并发和重复；正文与图片内容不进入发布记录', () => {
  const o = setup(), state = new PublishState(o.file, { now: o.now });
  const id = state.reserve(ctx(), args('  测试\n说说  '), {});
  assert.equal(state.status('99999999', {}).attemptsToday, 1);
  assert.throws(() => new PublishState(o.file, { now: o.now }).reserve(ctx(), args('测试 说说'), {}), /重复/);
  assert.throws(() => state.reserve(ctx(), args('换文案'), {}), /冷却/);
  state.finish(id, 'published', 'tid-test');
  assert.equal(state.status('99999999', {}).lastStatus, 'published');
  assert.doesNotMatch(fs.readFileSync(o.file, 'utf8'), /测试|说说/);
});
test('超时/结果未知仍占次数；每天按北京时间换日，账号分别计数', () => {
  const o = setup(), state = new PublishState(o.file, { now: o.now });
  const config = { dailyPostLimit: 2, postIntervalMinutes: 10 };
  const id = state.reserve(ctx(), args('第一条'), config);
  state.finish(id, 'uncertain'); o.advance(600_001);
  state.reserve(ctx(), args('第二条'), config); o.advance(600_001);
  assert.throws(() => state.reserve(ctx(), args('第三条'), config), /上限/);
  assert.doesNotThrow(() => state.reserve(ctx('88888888'), args('第二个账号'), config));
  o.advance(24 * 3600_000);
  assert.equal(state.status('99999999', config).attemptsToday, 0);
  assert.doesNotThrow(() => state.reserve(ctx(), args('明天一条'), config));
  assert.throws(() => state.reserve(ctx(), args('第一条'), config), /重复/);
});
test('损坏状态和无法落盘会禁止发布，保留损坏文件', () => {
  const o = setup(), state = new PublishState(o.file, { now: o.now });
  fs.writeFileSync(o.file, 'broken-json');
  assert.throws(() => state.reserve(ctx(), args('不能发'), {}), /损坏/);
  assert.equal(fs.readFileSync(o.file, 'utf8'), 'broken-json');
  const directoryAsFile = path.join(path.dirname(o.file), 'directory');
  fs.mkdirSync(directoryAsFile);
  assert.throws(() => new PublishState(directoryAsFile).reserve(ctx(), args('不能发'), {}));
});
