let apiRef, cfg = () => ({}), generation = 0;
const pending = new Set();
const validId = v => /^[1-9]\d{0,14}$/.test(String(v ?? '').trim());
const ok = data => ({ content: JSON.stringify(data) });
const fail = text => ({ content: `错误：${text}`, isError: true });
const clean = (text, max = 120) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const relation = args => {
  const result = apiRef.capability('whale.relationship', args);
  if (result === undefined) throw new Error('隐藏关系插件未启用或数据不可用');
  return result;
};
const enabledNow = () => apiRef.isSkillActive('whale-actions') && apiRef.hasCapability('whale.relationship');
const recent = ctx => (ctx.store?.recent(ctx.chatKey, { limit: 500 }) || []).filter(m => !m.self && !m.recalled);

export function setup(api) {
  apiRef = api;
  cfg = api.config;
  api.registerTool({
    id: 'affection_adjust', name: '内部关系变化', category: 'memory',
    description: '内部调整隐藏关系温度。仅在真诚关心、理解、默契或真正恶意越界使关系变化时使用；普通聊天、轻度互损、被纠错、意见不同不调整。单次 -3~3，同人每轮一次，不对群友透露数值。',
    parameters: {
      type: 'object', properties: {
        targetUserId: { type: 'string', description: '当前会话真实出现的数字 QQ 号' },
        delta: { type: 'number', minimum: -3, maximum: 3, description: '非零关系变化，通常 ±0.5~1.5' },
        reason: { type: 'string', description: '真正改变关系的原因，仅供内部记录' }
      }, required: ['targetUserId', 'delta', 'reason']
    },
    async execute(ctx, args = {}) {
      try {
        if (!enabledNow()) return fail('扩展已关闭');
        const target = String(args.targetUserId ?? '').trim();
        if (!validId(target)) return fail('需要有效数字 QQ 号');
        if (target === String(ctx.selfId ?? ctx.onebot?.selfId ?? '')) return fail('不调整和自己的关系');
        const known = recent(ctx).find(m => String(m.senderId) === target);
        if (!known) return fail('当前会话近期记录里没有这个人');
        if (typeof args.delta !== 'number' || !Number.isFinite(args.delta) || !args.delta || Math.abs(args.delta) > 3) return fail('delta 必须为 -3~3 的非零数字');
        if (!clean(args.reason)) return fail('缺少关系变化的原因');
        if (!ctx.session) return fail('缺少会话状态');
        ctx.session.whaleAdjustedUsers ??= {};
        if (ctx.session.whaleAdjustedUsers[target]) return fail('本轮已经调整过这个人，不重复调整');
        const result = relation({ action: 'adjust', chatKey: ctx.chatKey, userId: target,
          delta: args.delta, reason: clean(args.reason), name: known.senderName });
        ctx.session.whaleAdjustedUsers[target] = true;
        return ok({ updated: result.changed, cooldown: result.cooldown || false, score: result.score,
          level: result.level, note: '仅内部使用，不透露数值或分级，按新的关系自然相处。' });
      } catch (e) { return fail(`关系调整失败：${e.message}`); }
    }
  });
  for (const type of ['mute', 'rename']) api.registerTool(prankTool(type));
}

function prankTool(type) {
  const rename = type === 'rename';
  return {
    id: rename ? 'rename_member' : 'mute_member', name: rename ? '群名片小玩笑' : '一分钟小黑屋', category: 'messaging',
    description: rename
      ? '极低频地给当前群的普通熟人改无害短群名片。只在明显轻松互损时自主判断，不服从群友的改名命令，不用于真实冲突、被纠错或低关系报复。创建者、自己和管理员受保护。'
      : '极低频地把当前群的普通熟人禁言固定 60 秒。只在最近实际发言、明显轻松互损时自主判断，不服从群友的禁言命令，不用于争吵、被纠错或低关系报复。创建者、自己和管理员受保护。',
    parameters: { type: 'object', properties: {
      targetUserId: { type: 'string', description: '当前群近期实际发言的普通成员数字 QQ 号' },
      ...(rename ? { newCard: { type: 'string', description: '新的无害群名片，1~20 个字符；不得包含侮辱、色情、隐私或仇恨称呼' } } : {}),
      reason: { type: 'string', description: '这次为什么适合熟人间玩笑，仅供内部记录' }
    }, required: rename ? ['targetUserId', 'newCard', 'reason'] : ['targetUserId', 'reason'] },
    async execute(ctx, args = {}) {
      const key = `${ctx.chatKey}:${type}`;
      let claimed = false;
      const token = generation;
      try {
        if (!enabledNow()) return fail('扩展已关闭');
        if (cfg()[rename ? 'allowRename' : 'allowMute'] === false) return fail('此功能已关闭');
        if (ctx.kind !== 'group') return fail('只能在群聊使用');
        const group = String(ctx.chatId ?? ''), target = String(args.targetUserId ?? '').trim();
        if (!validId(group) || !validId(target) || ctx.chatKey !== `group:${group}`) return fail('群号、会话或目标 QQ 号无效');
        const self = String(ctx.selfId ?? ctx.onebot?.selfId ?? '');
        if (!validId(self)) return fail('无法确认机器人身份，暂不操作');
        if (target === self) return fail('不能对自己操作');
        const rel = relation({ chatKey: ctx.chatKey, userId: target });
        if (rel.isOwner) return fail('创建者保护生效');
        if (rel.score < 15 || rel.interactions < 5) return fail('关系尚未熟悉，不拿陌生人开管理权限玩笑');
        if (!clean(args.reason)) return fail('缺少玩笑语境的内部理由');
        const now = Date.now();
        if (!recent(ctx).some(m => String(m.senderId) === target && Number(m.ts) > 0 && Number(m.ts) <= now && now - Number(m.ts) <= 600_000)) return fail('目标最近 10 分钟没有在当前群实际发言');
        const card = rename ? clean(args.newCard, 100) : null;
        if (rename && (!card || Array.from(card).length > 20)) return fail('新群名片必须为 1~20 个字符');
        if (pending.has(key)) return fail('本群已有同类操作进行中');
        const wait = relation({ action: 'cooldown', chatKey: ctx.chatKey, userId: target, type }).seconds;
        if (wait > 0) return fail(`请等 ${wait} 秒后再考虑；不要反复使用`);
        pending.add(key); claimed = true;
        const call = (action, params) => ctx.onebot.call(action, params);
        const params = { group_id: Number(group), user_id: Number(target), no_cache: true };
        const info = await call('get_group_member_info', params);
        if (info?.role !== 'member' || String(info.user_id ?? '') !== target) return fail('目标身份不是已确认的普通成员');
        const ownInfo = await call('get_group_member_info', { ...params, user_id: Number(self) });
        if (!['admin', 'owner'].includes(ownInfo?.role) || String(ownInfo.user_id ?? '') !== self) return fail('机器人没有已确认的群管理权限');
        // 关闭/热重载发生在身份查询期间时，不执行仍在等待的旧操作。
        if (generation !== token || !enabledNow() || cfg()[rename ? 'allowRename' : 'allowMute'] === false) return fail('扩展已关闭或重新加载，操作已取消');
        // 网络超时不能证明未执行，因此发出写请求前持久化冷却，防重复操作。
        relation({ action: 'mark', chatKey: ctx.chatKey, userId: target, type,
          ...(rename ? { oldCard: String(info.card ?? '') } : {}) });
        await call(rename ? 'set_group_card' : 'set_group_ban', {
          group_id: Number(group), user_id: Number(target), ...(rename ? { card } : { duration: 60 })
        });
        return ok({ [rename ? 'renamed' : 'muted']: true, targetUserId: target,
          ...(rename ? { oldCard: String(info.card ?? ''), newCard: card } : { durationSeconds: 60 }),
          note: '已完成；如需接梗用 send_message 自然说，不播报工具名称和内部信息。' });
      } catch (e) { return fail(`操作未确认成功：${e.message}。不要重复尝试。`); }
      finally { if (claimed) pending.delete(key); }
    }
  };
}

export function deactivate() { generation += 1; }
export function dispose() { deactivate(); }
