import fs from 'node:fs';
import path from 'node:path';

export const validId = value => /^[1-9]\d{0,14}$/.test(String(value ?? '').trim());
const clean = (value, limit = 120) => String(value ?? '').replace(/\s+/g, ' ').slice(0, limit);
const clamp = n => Math.min(100, Math.max(-100, Number(n) || 0));
const dayKey = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function level(score) {
  return score <= -35 ? '戒备' : score <= -12 ? '有点不爽' : score < 15 ? '普通'
    : score < 35 ? '熟悉' : score < 60 ? '亲近' : score < 80 ? '很亲近' : '特殊偏爱';
}

export function hint(score, owner) {
  if (owner || score >= 80) return '更纵容、更关心、更愿意主动靠近；嘴硬之后要有回护，喜欢不等于攻击力更强。';
  if (score >= 60) return '自然关心、互损，常有让步和偏心，不要一直顶嘴。';
  if (score >= 35) return '自然玩梗、主动搭话，记住小事，偶尔才考虑无害恶作剧。';
  if (score >= 15) return '像熟人相处，互损和恶作剧仍要低频、看语境。';
  if (score >= -12) return '普通群友，正常相处，不刻意亲近，不无故攻击。';
  return '疏远、克制、少主动；不羞辱、不报复，不滥用群管理能力。';
}

export class RelationshipState {
  constructor(file, config, now = Date.now) {
    this.file = file;
    this.config = config;
    this.now = now;
    this.timer = null;
    this.dirty = false;
    this.data = { version: 1, chats: {}, whaleExtension: { cursors: {}, cooldowns: {}, cards: {} } };
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (!raw || !raw.chats || typeof raw.chats !== 'object' || Array.isArray(raw.chats)) {
        throw new Error('affection.json 格式无效；已停止加载，原文件未改动');
      }
      this.data = raw;
      if (!raw.whaleExtension) {
        const backup = `${file}.before-whale-plugin.bak`;
        if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
      }
      this.data.whaleExtension ??= {};
      for (const key of ['cursors', 'cooldowns', 'cards']) {
        this.data.whaleExtension[key] ??= {};
        if (typeof this.data.whaleExtension[key] !== 'object' || Array.isArray(this.data.whaleExtension[key])) {
          throw new Error('关系扩展元数据格式无效，原文件未改动');
        }
      }
    }
  }

  owner(userId) {
    const owner = String(this.config().ownerQQ ?? '').trim();
    return validId(owner) && validId(userId) && String(userId).trim() === owner;
  }

  entry(chatKey, userId, name = '') {
    if (!/^(group|private):[1-9]\d{0,14}$/.test(chatKey) || !validId(userId)) throw new Error('会话或 QQ 号无效');
    const chat = this.data.chats[chatKey] ??= {};
    const e = chat[userId] ??= {
      userId: String(userId), name: clean(name, 80), score: this.owner(userId) ? 90 : 0,
      interactions: 0, directInteractions: 0, lastInteractionAt: 0, lastAdjustedAt: 0,
      lastDelta: 0, lastReason: '', day: dayKey(this.now()), dayMessages: 0, updatedAt: this.now()
    };
    if (name) e.name = clean(name, 80);
    e.score = clamp(e.score);
    if (this.owner(userId)) e.score = Math.max(80, e.score);
    return e;
  }

  get(chatKey, userId, name) {
    const e = this.entry(chatKey, userId, name);
    return { ...e, score: Math.round(e.score * 10) / 10, level: level(e.score),
      isOwner: this.owner(userId), behaviorHint: hint(e.score, this.owner(userId)) };
  }

  observe(chatKey, message) {
    if (message.self || message.recalled || !validId(message.senderId)) return;
    // 拍别人是背景事件，不能算和机器人的一次真实互动。
    if (message.isPoke && !/拍了拍\s*我/.test(String(message.text))) return;
    const e = this.entry(chatKey, String(message.senderId), message.senderName);
    const ts = Number(message.ts) || this.now();
    const day = dayKey(ts);
    if (e.day !== day) { e.day = day; e.dayMessages = 0; }
    e.dayMessages = (Number(e.dayMessages) || 0) + 1;
    e.interactions = (Number(e.interactions) || 0) + 1;
    const direct = chatKey.startsWith('private:') || message.atMe === true || message.isPoke;
    if (direct) e.directInteractions = (Number(e.directInteractions) || 0) + 1;
    const factor = e.dayMessages <= 12 ? 1 : e.dayMessages <= 30 ? 0.45 : 0.08;
    const gain = this.owner(message.senderId) ? (direct ? 0.05 : 0.02)
      : (e.score < 15 ? (direct ? 0.22 : 0.11) : e.score < 30 ? (direct ? 0.10 : 0.04)
        : e.score < 40 ? (direct ? 0.04 : 0.01) : 0) * factor;
    e.score = clamp(e.score + gain);
    // 自动熟悉度不能越过 40；语境调整仍可达到 100。
    if (!this.owner(message.senderId) && gain > 0) e.score = Math.min(40, e.score);
    e.lastInteractionAt = ts;
    e.updatedAt = this.now();
    this.changed();
  }

  ingest(chatKey, messages, { baseline = false, blocked = [] } = {}) {
    const meta = this.data.whaleExtension;
    const list = messages.filter(m => Number.isSafeInteger(m.id) && m.id > 0).sort((a, b) => a.id - b.id);
    const cursor = Number(meta.cursors[chatKey]) || 0;
    const max = list.at(-1)?.id ?? cursor;
    if (!baseline) {
      const denied = new Set(blocked.map(String));
      for (const m of list) if (m.id > cursor && !denied.has(String(m.senderId))) this.observe(chatKey, m);
    }
    // 清空存档保持 nextLocalId，不会重置游标。
    if (max > cursor) { meta.cursors[chatKey] = max; this.changed(); }
  }

  adjust(chatKey, userId, delta, reason, name) {
    if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 3) throw new Error('delta 必须为 -3~3 的非零数字');
    if (!clean(reason).trim()) throw new Error('关系变化需要内部理由');
    const e = this.entry(chatKey, userId, name);
    const now = this.now();
    if (e.lastAdjustedAt && now - Number(e.lastAdjustedAt) < 20_000) return { ...this.get(chatKey, userId), changed: false, cooldown: true };
    const before = e.score;
    e.score = clamp(e.score + delta);
    if (this.owner(userId)) e.score = Math.max(80, e.score);
    Object.assign(e, { lastAdjustedAt: now, lastDelta: e.score - before, lastReason: clean(reason), updatedAt: now });
    this.changed();
    this.flush();
    return { ...this.get(chatKey, userId), before, changed: before !== e.score };
  }

  cooldown(chatKey, userId, type) {
    const c = this.data.whaleExtension.cooldowns;
    const now = this.now();
    const groupWait = 120_000 - (now - (c[`${chatKey}:${type}`] ?? 0));
    const targetWait = 600_000 - (now - (c[`${chatKey}:${type}:${userId}`] ?? 0));
    return Math.max(0, Math.ceil(Math.max(groupWait, targetWait) / 1000));
  }

  markAttempt(chatKey, userId, type, oldCard = null) {
    const c = this.data.whaleExtension.cooldowns;
    c[`${chatKey}:${type}`] = c[`${chatKey}:${type}:${userId}`] = this.now();
    if (oldCard !== null) this.data.whaleExtension.cards[`${chatKey}:${userId}`] = { oldCard, at: this.now() };
    this.changed();
    this.flush();
  }

  format(chatKey, ids) {
    const lines = ids.map(id => this.get(chatKey, id)).map(e =>
      `- QQ:${e.userId}：${e.score}/100 · ${e.level} · 已互动 ${e.interactions} 次。${e.isOwner ? '按 QQ 号确认的创建者；' : ''}${e.behaviorHint}`);
    return lines.length ? `【隐藏关系温度 · 本轮】\n以下只供内部判断，不向群友透露数值、分级、算法。记忆是对人的了解，关系温度是当前亲近程度。\n${lines.join('\n')}` : '';
  }

  changed() {
    this.dirty = true;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        try { this.flush(); } catch (e) { this.onError?.(e); }
      }, 250);
      this.timer.unref?.();
    }
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(temp, this.file);
    this.dirty = false;
  }
}

export class ArchiveObserver {
  constructor(dataDir, state) { this.dataDir = dataDir; this.state = state; this.stamps = new Map(); }

  scan({ baseline = false, chatKey = null } = {}) {
    const directory = path.join(this.dataDir, 'messages');
    if (!fs.existsSync(directory)) return;
    let config = {};
    const configFile = path.join(this.dataDir, 'config.json');
    if (fs.existsSync(configFile)) config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
    this.coreConfig = config;
    for (const file of fs.readdirSync(directory)) {
      const match = /^(group|private)_([1-9]\d{0,14})\.json$/.exec(file);
      if (!match) continue;
      const key = `${match[1]}:${match[2]}`;
      if (chatKey && key !== chatKey) continue;
      const full = path.join(directory, file);
      const stat = fs.statSync(full);
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (!baseline && !chatKey && this.stamps.get(key) === stamp) continue;
      const raw = JSON.parse(fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, ''));
      if (raw.chatKey !== key || !Array.isArray(raw.messages)) continue;
      const blocked = [...(config.globalBlocklist || []), ...(match[1] === 'group' ? config.blocklist?.[match[2]] || [] : [])];
      this.state.ingest(key, raw.messages, { baseline, blocked });
      this.stamps.set(key, stamp);
    }
  }
}
