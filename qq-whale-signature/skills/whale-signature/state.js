import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const chinaDay = ms => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.trunc(Number(value)))) : fallback;
export function options(settings = {}) {
  return {
    mode: ['autonomous', 'requested', 'off'].includes(settings.signatureMode) ? settings.signatureMode : 'autonomous',
    ownerQQ: String(settings.ownerQQ ?? '').trim(),
    dailyLimit: bounded(settings.dailyChangeLimit ?? 2, 2, 1, 10),
    intervalMs: bounded(settings.changeIntervalMinutes ?? 720, 720, 10, 10080) * 60_000
  };
}
export function ownQQ(ctx) {
  const qq = String(ctx?.selfId ?? ctx?.onebot?.selfId ?? '');
  if (!/^[1-9]\d{4,11}$/.test(qq)) throw new Error('无法确认机器人自己的QQ号，未执行签名操作。');
  const connectedQQ = ctx?.onebot?.selfId;
  if (connectedQQ !== undefined && connectedQQ !== null && String(connectedQQ) !== '' && String(connectedQQ) !== qq) {
    throw new Error('当前QQ连接账号已变化，未执行签名操作；请在新会话中重新读取。');
  }
  return qq;
}
export function assertPermission(ctx, settings) {
  const cfg = options(settings);
  ownQQ(ctx);
  if (cfg.mode === 'off') throw new Error('个性签名修改已关闭。');
  if (cfg.mode === 'requested') {
    const last = (ctx.session?.trigger || []).filter(e => !e.self && !e.recalled).at(-1);
    if (!/^[1-9]\d{4,11}$/.test(cfg.ownerQQ) || String(last?.senderId ?? '') !== cfg.ownerQQ) {
      throw new Error('当前为创建者请求模式：本轮最后触发消息须由真实创建者发送。');
    }
  }
  return cfg;
}

/** Synchronous reservations serialize concurrent tools in this QQ Agent process. */
export class SignatureState {
  constructor(file, { now = Date.now } = {}) { this.file = file; this.now = now; }
  read() {
    if (!fs.existsSync(this.file)) return { version: 1, records: [] };
    let data;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('个性签名修改记录损坏，已停止修改；请保留文件检查。'); }
    if (data?.version !== 1 || !Array.isArray(data.records) || data.records.some(r =>
      typeof r?.id !== 'string' || typeof r.accountId !== 'string' || !/^[1-9]\d{4,11}$/.test(r.accountId) ||
      !Number.isFinite(r.at) || !/^[a-f0-9]{64}$/.test(r.digest) ||
      !['pending', 'verified', 'accepted', 'uncertain'].includes(r.status))) throw new Error('个性签名修改记录格式异常，已停止修改。');
    return data;
  }
  save(data) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { flag: 'wx', encoding: 'utf8' });
      fs.renameSync(temporary, this.file);
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* Remove only our own generated file. */ }
      throw new Error('无法保存签名修改记录，未继续发起新的修改。');
    }
  }
  status(accountId, settings) {
    const now = this.now(), cfg = options(settings), rows = this.read().records.filter(r => r.accountId === String(accountId));
    const last = rows.reduce((max, r) => Math.max(max, r.at), 0);
    const attempts = rows.filter(r => chinaDay(r.at) === chinaDay(now)).length;
    return { mode: cfg.mode, timezone: 'Asia/Shanghai', date: chinaDay(now), dailyLimit: cfg.dailyLimit,
      attemptsToday: attempts, remainingToday: Math.max(0, cfg.dailyLimit - attempts),
      intervalMinutes: cfg.intervalMs / 60_000,
      cooldownMinutes: last ? Math.max(0, Math.ceil((last + cfg.intervalMs - now) / 60_000)) : 0,
      lastStatus: rows.at(-1)?.status ?? 'none',
      note: '已发起的修改均占限额；超时可能已改成功，先读取签名确认，不自动重试。' };
  }
  reserve(ctx, text, settings) {
    const cfg = assertPermission(ctx, settings), now = this.now(), accountId = ownQQ(ctx), data = this.read();
    const digest = createHash('sha256').update(text).digest('hex');
    const rows = data.records.filter(r => r.accountId === accountId);
    const last = rows.reduce((max, r) => Math.max(max, r.at), 0);
    if (rows.some(r => r.digest === digest && now - r.at < cfg.intervalMs)) throw new Error('这条签名近期已发起过修改，已阻止重复请求；请先读取当前签名。');
    if (rows.filter(r => chinaDay(r.at) === chinaDay(now)).length >= cfg.dailyLimit) throw new Error('今日个性签名修改次数已达上限。');
    if (last && now - last < cfg.intervalMs) throw new Error(`签名修改正在冷却，约${Math.ceil((last + cfg.intervalMs - now) / 60_000)}分钟后可再改。`);
    const record = { id: randomUUID(), accountId, at: now, digest, status: 'pending' };
    data.records = data.records.filter(r => now - r.at < 30 * 86400_000);
    data.records.push(record);
    this.save(data);
    return record.id;
  }
  finish(id, status) {
    const data = this.read(), record = data.records.find(r => r.id === id);
    if (!record) throw new Error('签名修改记录已变化，请读取当前签名确认。');
    record.status = status;
    this.save(data);
  }
}
