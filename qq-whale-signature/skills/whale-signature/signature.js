import { ownQQ } from './state.js';

function fail(errorCode, error, uncertain = false) { return { ok: false, errorCode, error, uncertain }; }
export function normalizeSignature(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('请提供非空个性签名；此工具不清空签名。');
  const normalized = text.trim();
  if (Array.from(normalized).length > 80) throw new Error('个性签名最多80个字符。');
  if (/[\r\n\u0000-\u001f\u007f]/.test(normalized)) throw new Error('个性签名须为一行，不能含控制字符。');
  return normalized;
}
function checkConnection(ctx) {
  ownQQ(ctx);
  if (!ctx.onebot || typeof ctx.onebot.call !== 'function') throw new Error('当前QQ协议连接不可用。');
}
function readFailure(error) {
  const text = String(error?.message ?? '');
  if (/unknown action|unsupported|not supported|action.*not found|接口不存在|不支持|404/i.test(text)) return fail('unsupported_action', 'QQ协议端不支持读取个性签名资料，请检查协议端版本。');
  return fail('signature_read_failed', '未能读取当前签名，请检查QQ登录和协议端连接。');
}
function unwrap(value) { return value?.data && typeof value.data === 'object' ? value.data : value; }
export function createSignatureClient() {
  return {
    async read(ctx) {
      let accountQQ;
      try { checkConnection(ctx); accountQQ = ownQQ(ctx); } catch (error) { return fail('not_connected', error.message); }
      let response;
      try { response = await ctx.onebot.call('get_stranger_info', { user_id: Number(accountQQ) }, 15000); }
      catch (error) { return readFailure(error); }
      try {
        if (ownQQ(ctx) !== accountQQ) return fail('signature_account_mismatch', '资料查询期间QQ连接账号发生变化，未采用返回资料。');
      } catch { return fail('signature_account_mismatch', '资料查询期间QQ连接账号发生变化，未采用返回资料。'); }
      const data = unwrap(response);
      const signature = typeof data?.long_nick === 'string' ? data.long_nick : (typeof data?.longNick === 'string' ? data.longNick : undefined);
      if (signature === undefined) return fail('signature_field_unavailable', '协议端返回的资料没有签名字段，不能把它当成空签名。');
      const qq = data?.user_id ?? data?.uin;
      if (qq !== undefined && String(qq) !== accountQQ) return fail('signature_account_mismatch', '协议端返回的账号不是当前机器人，未采用该签名。');
      return { ok: true, accountQQ, signature: signature.slice(0, 500), truncated: signature.length > 500,
        note: '这是协议端返回的当前账号资料；QQ资料缓存可能存在更新延迟。' };
    },
    async set(ctx, text) {
      try { checkConnection(ctx); text = normalizeSignature(text); } catch (error) { return fail('invalid_arguments', error.message); }
      try {
        // This action targets the currently logged-in QQ, never an LLM-supplied target.
        await ctx.onebot.call('set_self_longnick', { longNick: text }, 20000);
      } catch (error) {
        const message = String(error?.message ?? '');
        if (/unknown action|unsupported|not supported|action.*not found|接口不存在|不支持|404/i.test(message)) return fail('unsupported_action', '当前QQ协议端未提供set_self_longnick，请升级支持个性签名修改的SnowLuma或兼容协议端。', false);
        return fail('signature_change_unconfirmed', '签名修改结果未确认，可能已经修改；请先读取当前签名，不要立即重试。', true);
      }
      // One read, no write retries. Absence of a signature field is not success.
      const current = await this.read(ctx);
      if (current.ok && !current.truncated && current.signature === text) return { ok: true, status: 'verified', changed: true, verified: true, signature: text,
        note: '修改请求已接受，已读取资料核对为新签名。' };
      return { ok: true, status: 'accepted', changed: null, verified: false, requestedSignature: text,
        ...(current.ok ? { observedSignature: current.signature } : {}),
        note: '协议端已接受修改请求，但尚未读到新签名；可能存在资料缓存或更新延迟。不要反复修改，稍后读取或到QQ个人资料确认。' };
    }
  };
}
