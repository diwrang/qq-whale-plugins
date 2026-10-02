const validId = v => /^[1-9]\d{0,14}$/.test(String(v ?? ''));
const asIds = a => Array.isArray(a) ? a.map(String) : [];

export function allowed(event, config) {
  const kind = event.message_type, chat = String(kind === 'group' ? event.group_id : event.user_id);
  if (!['group', 'private'].includes(kind) || !validId(chat)) return false;
  const listKey = kind === 'group' ? 'groups' : 'private';
  const deny = asIds(config.deny?.[kind] ?? config.deny?.[listKey]);
  const allow = asIds(config.allow?.[kind] ?? config.allow?.[listKey]);
  const sender = String(event.user_id ?? event.sender?.user_id ?? '');
  return !deny.includes(chat) && (allow.length ? allow.includes(chat) : config.allowAllWhenEmpty === true)
    && !asIds(config.globalBlocklist).includes(sender)
    && !(kind === 'group' && asIds(config.blocklist?.[chat]).includes(sender));
}

export function parseCommand(event) {
  const segments = Array.isArray(event.message) ? event.message : null;
  const text = (segments ? segments.filter(s => s?.type === 'text').map(s => s.data?.text ?? '').join('')
    : String(event.raw_message ?? event.message ?? '')).trim();
  const match = /^\/ds(?:\s+(.*))?$/.exec(text);
  if (!match) return null;
  const command = (match[1] || '').trim();
  const at = segments?.find(s => s?.type === 'at' && validId(s.data?.qq) && String(s.data.qq) !== String(event.self_id));
  const rawAt = /\[CQ:at,qq=([1-9]\d{0,14})(?:,[^\]]*)?\]/.exec(command);
  const numeric = /^mute\s+([1-9]\d{0,14})$/i.exec(command);
  return { command, target: String(at?.data?.qq ?? rawAt?.[1] ?? numeric?.[1] ?? '') };
}

export async function handleCommand(event, { config, owner, active, call, allowMute = true }) {
  if (!active() || !allowed(event, config) || !validId(owner)) return;
  const parsed = parseCommand(event);
  if (!parsed) return;
  const kind = event.message_type, chat = String(kind === 'group' ? event.group_id : event.user_id);
  const say = text => {
    if (!active()) return;
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
    return call(action, { [kind === 'group' ? 'group_id' : 'user_id']: Number(chat), message: [{ type: 'text', data: { text } }] });
  };
  const sender = String(event.user_id ?? event.sender?.user_id ?? '');
  if (sender === String(event.self_id ?? '')) return;
  if (sender !== owner) return say('你哪位');
  const lower = parsed.command.toLowerCase();
  if (lower === 'ping') return say('主人接口正常');
  if (lower === 'status') return say('活着呢');
  if (!lower) return say('可用：/ds ping、/ds status、/ds mute @某人');
  if (!/^mute(?:\s|$)/i.test(lower)) return say('这命令还不会');
  if (kind !== 'group') return say('这个只能在群里用');
  if (!allowMute) return say('专属小黑屋已关闭');
  const target = parsed.target, self = String(event.self_id ?? '');
  if (!validId(target)) return say('用 /ds mute @某人，或 /ds mute QQ号');
  if (!validId(self) || target === self || target === owner) return say('这个人不能关小黑屋');
  try {
    const info = await call('get_group_member_info', { group_id: Number(chat), user_id: Number(target), no_cache: true });
    if (info?.role !== 'member' || String(info.user_id) !== target) return say('只对普通群成员使用');
    const own = await call('get_group_member_info', { group_id: Number(chat), user_id: Number(self), no_cache: true });
    if (!['admin', 'owner'].includes(own?.role) || String(own.user_id) !== self) return say('我没有群管理权限');
    if (!active()) return;
    await call('set_group_ban', { group_id: Number(chat), user_id: Number(target), duration: 60 });
    return say('小黑屋一分钟');
  } catch { return say('禁言未确认成功，先检查权限，别重复尝试'); }
}

export class CommandBridge {
  constructor({ Socket, config, enabled, options, warn }) {
    Object.assign(this, { Socket, config, enabled, options, warn });
    this.socket = null; this.timer = null; this.current = ''; this.pending = new Map();
    this.serial = Promise.resolve(); this.sequence = 0; this.stopped = true;
    this.seen = new Map(); this.lastCommand = new Map(); this.muteCooldown = new Map(); this.queueSize = 0;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconcile();
    this.timer = setInterval(() => this.reconcile(), 5000);
    this.timer.unref?.();
  }

  active() {
    if (this.stopped || !this.enabled()) return false;
    try { return validId(String(this.config().skills?.['whale-relations']?.ownerQQ ?? '').trim()); }
    catch { return false; }
  }

  reconcile() {
    if (!this.active()) { this.disconnect(); return; }
    try {
      const cfg = this.config();
      const profile = /^\d+$/.test(String(process.env.QQ_AGENT_PROFILE ?? '')) ? Number(process.env.QQ_AGENT_PROFILE) : 0;
      const url = new URL(cfg.snowluma?.wsUrl || `ws://127.0.0.1:${3001 + profile * 100}`);
      if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('OneBot WS 地址无效');
      const token = String(cfg.snowluma?.accessToken || '');
      if (token) url.searchParams.set('access_token', token);
      const identity = url.href;
      if (this.socket && this.current === identity && [0, 1].includes(this.socket.readyState)) return;
      this.disconnect(); this.current = identity;
      const socket = this.socket = new this.Socket(identity);
      socket.addEventListener('message', event => this.receive(event.data, socket));
      socket.addEventListener('error', () => this.warn('创建者接口连接失败；请检查 QQ Agent 的 OneBot 设置，5 秒后重连。'));
      socket.addEventListener('close', () => { if (this.socket === socket) this.disconnect(); });
    } catch { this.warn('创建者接口配置不可用，请检查 OneBot 设置。'); }
  }

  call(action, params) {
    if (!this.active() || !this.socket || this.socket.readyState !== 1) return Promise.reject(new Error('OneBot 未连接'));
    const echo = `whale-owner-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new Error('OneBot 请求超时')); }, 5000);
      timer.unref?.();
      this.pending.set(echo, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ action, params, echo })); }
      catch (error) { clearTimeout(timer); this.pending.delete(echo); reject(error); }
    });
  }

  receive(data, source) {
    if (source !== this.socket || !this.active()) return;
    let event;
    try { event = JSON.parse(String(data)); } catch { return; }
    if (event.echo && this.pending.has(event.echo)) {
      const pending = this.pending.get(event.echo); this.pending.delete(event.echo); clearTimeout(pending.timer);
      if (Number(event.retcode) === 0 && event.status === 'ok') pending.resolve(event.data);
      else pending.reject(new Error('OneBot 接口返回失败'));
      return;
    }
    if (event.post_type !== 'message' || !parseCommand(event)) return;
    const cfg = this.config();
    if (!allowed(event, cfg)) return;
    const chat = String(event.message_type === 'group' ? event.group_id : event.user_id);
    const key = `${event.message_type}:${chat}:${event.message_id}`;
    if (event.message_id === undefined || this.seen.has(key)) return;
    this.seen.set(key, Date.now());
    for (const [id, at] of this.seen) if (Date.now() - at > 600_000 || this.seen.size > 2000) this.seen.delete(id);
    const userKey = `${event.message_type}:${chat}:${event.user_id}`;
    const owner = String(cfg.skills?.['whale-relations']?.ownerQQ ?? '').trim();
    const gap = String(event.user_id) === owner ? Math.max(2000, Number(cfg.send?.minGapMs) || 1000) : 30_000;
    if (Date.now() - (this.lastCommand.get(userKey) || 0) < gap || this.queueSize >= 20) return;
    this.lastCommand.set(userKey, Date.now());
    this.queueSize += 1;
    this.serial = this.serial.then(async () => {
      const latest = this.config();
      await handleCommand(event, {
        config: latest, owner: String(latest.skills?.['whale-relations']?.ownerQQ ?? '').trim(),
        active: () => this.active() && this.socket === source,
        allowMute: this.options().allowOwnerMute !== false,
        call: (action, params) => {
          if (action === 'set_group_ban') {
            const cooldownKey = `${params.group_id}:${params.user_id}`;
            if (Date.now() - (this.muteCooldown.get(cooldownKey) || 0) < 10_000) return Promise.reject(new Error('命令冷却'));
            this.muteCooldown.set(cooldownKey, Date.now());
          }
          return this.call(action, params);
        }
      });
    }).catch(() => this.warn('创建者命令未完成；请检查 OneBot 连接。'))
      .finally(() => { this.queueSize -= 1; });
  }

  disconnect() {
    const old = this.socket; this.socket = null;
    try { old?.close(); } catch { /* 已断开 */ }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('接口已关闭')); }
    this.pending.clear();
  }

  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; this.disconnect(); }
}
