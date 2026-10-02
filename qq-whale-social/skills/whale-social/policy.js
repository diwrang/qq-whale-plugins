import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const day = ms => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const numeric = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
};
export function publishSettings(settings = {}) {
  return {
    mode: ['autonomous', 'requested', 'off'].includes(settings.publishMode) ? settings.publishMode : 'autonomous',
    ownerQQ: String(settings.ownerQQ ?? '').trim(),
    dailyLimit: numeric(settings.dailyPostLimit ?? 3, 3, 1, 20),
    intervalMs: numeric(settings.postIntervalMinutes ?? 240, 240, 10, 10080) * 60_000
  };
}

export function assertPublishPermission(ctx, settings) {
  const cfg = publishSettings(settings);
  if (cfg.mode === 'off') throw new Error('空间发布已在设置中关闭。');
  if (cfg.mode === 'requested') {
    // Real session metadata comes from QQ Agent; LLM arguments and quoted text cannot supply identity.
    const last = (ctx.session?.trigger || []).filter(e => !e.self && !e.recalled).at(-1);
    if (!/^[1-9]\d{4,11}$/.test(cfg.ownerQQ) || String(last?.senderId) !== cfg.ownerQQ) {
      throw new Error('当前为创建者请求发布模式：本轮最后一条触发消息须由创建者发送。');
    }
  }
  if (!/^\d{5,12}$/.test(String(ctx.selfId ?? ''))) throw new Error('无法确认当前登录的机器人 QQ，未发布。');
  return cfg;
}

/** Write a reservation BEFORE calling QQ. A timeout may still have created the post. */
export class PublishState {
  constructor(file, { now = Date.now } = {}) { this.file = file; this.now = now; }
  read() {
    if (!fs.existsSync(this.file)) return { version: 1, records: [] };
    let value;
    try { value = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('空间发布记录损坏，已停止发布；请保留文件并检查，不能直接重置重试。'); }
    if (value?.version !== 1 || !Array.isArray(value.records) || value.records.some(r =>
      !r || typeof r.id !== 'string' || !/^\d{5,12}$/.test(String(r.accountId)) ||
      !Number.isFinite(r.at) || !/^[a-f0-9]{64}$/.test(r.digest) ||
      !['pending', 'published', 'uncertain'].includes(r.status))) {
      throw new Error('空间发布记录格式异常，已停止发布。');
    }
    return value;
  }
  save(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temporary, this.file);
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* Only remove our own temporary file. */ }
      throw new Error('无法保存空间发布记录，未继续发起新的发布。');
    }
  }
  status(accountId, settings) {
    const now = this.now(), cfg = publishSettings(settings);
    const records = this.read().records.filter(r => r.accountId === String(accountId));
    const last = records.reduce((n, r) => Math.max(n, r.at), 0);
    const attempts = records.filter(r => day(r.at) === day(now)).length;
    return {
      mode: cfg.mode, timezone: 'Asia/Shanghai', date: day(now),
      dailyLimit: cfg.dailyLimit, attemptsToday: attempts,
      remainingToday: Math.max(0, cfg.dailyLimit - attempts),
      intervalMinutes: cfg.intervalMs / 60_000,
      cooldownMinutes: last ? Math.max(0, Math.ceil((last + cfg.intervalMs - now) / 60_000)) : 0,
      lastStatus: records.at(-1)?.status || 'none',
      note: '发起过的发布均计入限额；超时或返回异常可能已发出，先到空间确认，禁止自动重发。'
    };
  }
  reserve(ctx, payload, settings) {
    const cfg = assertPublishPermission(ctx, settings), now = this.now();
    const data = this.read(), accountId = String(ctx.selfId);
    const digest = createHash('sha256').update(JSON.stringify({
      text: payload.text.normalize('NFKC').replace(/\s+/g, ' ').trim(), images: payload.images
    })).digest('hex');
    const recent = data.records.filter(r => r.accountId === accountId);
    if (recent.some(r => r.digest === digest && now - r.at < 7 * 86400_000)) {
      throw new Error('这条内容在最近 7 天已发起过发布，已阻止重复发出；若上次结果未知，请先查看空间。');
    }
    if (recent.filter(r => day(r.at) === day(now)).length >= cfg.dailyLimit) throw new Error('今日空间发布次数已达上限。');
    const last = recent.reduce((n, r) => Math.max(n, r.at), 0);
    if (last && now - last < cfg.intervalMs) throw new Error(`空间发布正在冷却，约 ${Math.ceil((last + cfg.intervalMs - now) / 60_000)} 分钟后可再发。`);
    const record = { id: randomUUID(), accountId, digest, at: now, status: 'pending' };
    data.records = data.records.filter(r => now - r.at < 30 * 86400_000);
    data.records.push(record);
    this.save(data);
    return record.id;
  }
  finish(id, status, postId = '') {
    const data = this.read(), record = data.records.find(r => r.id === id);
    if (!record) throw new Error('空间发布记录已变化，请直接检查空间确认结果。');
    record.status = status;
    if (postId) record.postId = String(postId).slice(0, 120);
    this.save(data);
  }
}
