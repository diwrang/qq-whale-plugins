import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const chinaDay = ms => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.trunc(Number(value)))) : fallback;
export function replyOptions(settings = {}) {
  return {
    mode: ['autonomous', 'requested', 'off'].includes(settings.replyMode) ? settings.replyMode : 'autonomous',
    ownerQQ: String(settings.ownerQQ ?? '').trim(),
    dailyLimit: bounded(settings.dailyReplyLimit ?? 10, 10, 1, 100),
    intervalMs: bounded(settings.replyIntervalMinutes ?? 10, 10, 1, 10080) * 60_000
  };
}
function ownAccount(ctx) {
  const qq = String(ctx?.selfId ?? ctx?.onebot?.selfId ?? '');
  if (!/^[1-9]\d{4,11}$/.test(qq)) throw new Error('无法确认机器人账号，未回复评论。');
  const live = ctx?.onebot?.selfId;
  if (live !== undefined && String(live) !== '' && String(live) !== qq) throw new Error('机器人账号已变化，未回复评论，请重新读取。');
  return qq;
}
export function assertReplyPermission(ctx, settings) {
  const cfg = replyOptions(settings); ownAccount(ctx);
  if (cfg.mode === 'off') throw new Error('空间评论回复已关闭。');
  if (cfg.mode === 'requested') {
    const last = (ctx.session?.trigger || []).filter(e => !e.self && !e.recalled).at(-1);
    if (!/^[1-9]\d{4,11}$/.test(cfg.ownerQQ) || String(last?.senderId) !== cfg.ownerQQ) throw new Error('当前为创建者请求回复模式，本轮最后触发消息须来自创建者。');
  }
  return cfg;
}

export class ReplyState {
  constructor(file, { now = Date.now } = {}) { this.file = file; this.now = now; }
  read() {
    if (!fs.existsSync(this.file)) return { version: 1, records: [] };
    let data;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('空间回复记录损坏，已停止回复，请保留文件检查。'); }
    if (data?.version !== 1 || !Array.isArray(data.records) || data.records.length > 100000 || data.records.some(r =>
      typeof r?.id !== 'string' || !/^[1-9]\d{4,11}$/.test(r.accountId) || !/^[a-f0-9]{64}$/.test(r.thread) ||
      !Number.isFinite(r.at) || !['pending', 'replied', 'accepted', 'uncertain'].includes(r.status))) throw new Error('空间回复记录格式异常，已停止回复。');
    return data;
  }
  save(data) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temporary, this.file);
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* Own generated file only. */ }
      throw new Error('无法保存回复记录，未继续发送评论回复。');
    }
  }
  status(accountId, settings) {
    const now = this.now(), cfg = replyOptions(settings), rows = this.read().records.filter(r => r.accountId === String(accountId));
    const last = rows.reduce((value, r) => Math.max(value, r.at), 0), count = rows.filter(r => chinaDay(r.at) === chinaDay(now)).length;
    return { mode: cfg.mode, timezone: 'Asia/Shanghai', date: chinaDay(now), dailyLimit: cfg.dailyLimit,
      attemptsToday: count, remainingToday: Math.max(0, cfg.dailyLimit - count), intervalMinutes: cfg.intervalMs / 60_000,
      cooldownMinutes: last ? Math.max(0, Math.ceil((last + cfg.intervalMs - now) / 60_000)) : 0,
      note: '不同会话共用限额，同一评论一年内最多发起一次回复；超时或结果未知也占次数，不自动重发。' };
  }
  reserve(ctx, payload, settings) {
    const cfg = assertReplyPermission(ctx, settings), now = this.now(), data = this.read(), accountId = ownAccount(ctx);
    if (!payload || !/^[1-9]\d{4,11}$/.test(String(payload.targetQQ)) || !String(payload.tid || '') || !String(payload.commentId ?? '')) throw new Error('缺少已核对的评论目标，未回复。');
    const thread = createHash('sha256').update(JSON.stringify([String(payload.targetQQ), String(payload.tid), String(payload.commentId)])).digest('hex');
    const rows = data.records.filter(r => r.accountId === accountId);
    if (rows.some(r => r.thread === thread && now - r.at < 365 * 86400_000)) throw new Error('这条评论已发起过回复，已阻止重复作答；若上次超时，请先读取评论确认。');
    if (rows.filter(r => chinaDay(r.at) === chinaDay(now)).length >= cfg.dailyLimit) throw new Error('今日空间评论回复次数已达上限。');
    const last = rows.reduce((value, r) => Math.max(value, r.at), 0);
    if (last && now - last < cfg.intervalMs) throw new Error(`空间回复正在冷却，约${Math.ceil((last + cfg.intervalMs - now) / 60_000)}分钟后可回复。`);
    const record = { id: randomUUID(), accountId, thread, at: now, status: 'pending' };
    data.records = data.records.filter(r => now - r.at < 365 * 86400_000);
    data.records.push(record); this.save(data); return record.id;
  }
  finish(id, status) {
    const data = this.read(), record = data.records.find(r => r.id === id);
    if (!record) throw new Error('回复记录已变化，请读取空间评论确认。');
    record.status = status; this.save(data);
  }
}
