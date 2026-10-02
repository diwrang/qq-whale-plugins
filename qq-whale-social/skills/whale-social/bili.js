import { createHash } from 'node:crypto';

// These are the read-only endpoints used by Bilibili's own web player.
// They are not a contractual Open Platform API and may reject anonymous access.
const API = 'https://api.bilibili.com';
const WEB_HOSTS = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv']);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const WBI_ORDER = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

class BiliError extends Error {
  constructor(message) { super(message); this.name = 'BiliError'; }
}

function integer(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}

function cleanText(value, max = 1000) {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, x => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }[x])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
}

function videoId(value) {
  const text = String(value ?? '').trim();
  if (/^BV[0-9A-Za-z]{10}$/.test(text)) return { bvid: text };
  if (/^av[1-9]\d{0,15}$/i.test(text)) return { aid: text.slice(2) };
  return null;
}

function domain(host, suffix) { return host === suffix || host.endsWith(`.${suffix}`); }

function checkedUrl(value, kind) {
  let url;
  try { url = new URL(value); } catch { throw new BiliError('B 站地址格式无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new BiliError('仅支持无账号信息的 HTTPS B 站地址。');
  const allowed = kind === 'api' ? url.hostname === 'api.bilibili.com'
    : kind === 'web' ? WEB_HOSTS.has(url.hostname)
      : kind === 'subtitle' ? domain(url.hostname, 'hdslb.com') || domain(url.hostname, 'bilibili.com')
        : ['bilivideo.com', 'bilivideo.cn', 'bilivideo.net'].some(x => domain(url.hostname, x));
  if (!allowed) throw new BiliError('拒绝访问非 B 站允许域名。');
  return url;
}

// Player responses may put a PCDN node first, followed by normal Bilibili mirrors.
// Use only our existing CDN allowlist; never loosen it for the first candidate.
export function normalizePlaybackUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new BiliError('B站播放地址格式无效。'); }
  if (url.protocol === 'http:' && !url.username && !url.password && !url.port &&
      ['bilivideo.com', 'bilivideo.cn', 'bilivideo.net'].some(host => domain(url.hostname, host))) {
    url.protocol = 'https:';
  }
  return checkedUrl(url.href, 'playback');
}

function apiFailure(code) {
  if ([-352, -412, -403].includes(Number(code))) return 'B 站风控或访问验证拦截了请求；请稍后重试，或在设置中配置有权限的 B 站 Cookie。';
  if (Number(code) === -101) return '此 B 站接口要求登录，请在设置中配置 B 站 Cookie。';
  if ([-404, 62002, 62004, 62012].includes(Number(code))) return '视频不存在、已删除或当前账号无权读取。';
  return `B 站接口未成功（代码 ${Number.isFinite(Number(code)) ? Number(code) : '未知'}）。`;
}

function timestamp(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function isoDate(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 && n <= 8.64e12 ? new Date(n * 1000).toISOString() : null;
}

function number(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }

export function createBilibiliClient({ fetch: fetchImpl, getSettings = () => ({}) } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
  let wbiCache;

  async function request(value, { kind = 'api', probe = false, allowAnonymousNav = false } = {}) {
    let url = checkedUrl(value, kind);
    const settings = getSettings() || {};
    const cookie = kind === 'api' ? String(settings.biliCookie || '').trim() : '';
    if (/\r|\n/.test(cookie) || cookie.length > 16384) throw new BiliError('B 站 Cookie 设置无效，请重新填写。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), integer(settings.requestTimeoutSeconds, 15, 3, 45) * 1000);
    try {
      for (let redirects = 0; redirects <= 4; redirects++) {
        const headers = { 'User-Agent': 'Mozilla/5.0 QQWhaleSocial/1.0', Referer: 'https://www.bilibili.com/', Accept: 'application/json,text/html;q=0.5' };
        if (cookie && url.hostname === 'api.bilibili.com') headers.Cookie = cookie;
        const response = await fetchImpl(url.href, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || redirects === 4) throw new BiliError('B 站链接重定向次数过多或没有目标。');
          url = checkedUrl(new URL(location, url).href, kind);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          if ([403, 412, 429].includes(response.status)) throw new BiliError(`B 站访问被拦截（HTTP ${response.status}），请稍后重试或配置有权限的 Cookie。`);
          throw new BiliError(`B 站请求失败（HTTP ${response.status}）。`);
        }
        if (probe) { await response.body?.cancel(); return url; }
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw new BiliError('B 站响应过大，已停止读取。'); }
        const reader = response.body?.getReader();
        if (!reader) throw new BiliError('B 站返回了空响应。');
        let bytes = 0;
        const chunks = [];
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new BiliError('B 站响应过大，已停止读取。'); }
          chunks.push(chunk.value);
        }
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BiliError('B 站返回了非 JSON 响应，可能需要访问验证。'); }
        if (kind !== 'api') return parsed;
        if (Number(parsed.code) !== 0 && !(allowAnonymousNav && Number(parsed.code) === -101 && parsed.data?.wbi_img)) throw new BiliError(apiFailure(parsed.code));
        if (!parsed.data || typeof parsed.data !== 'object') throw new BiliError('B 站接口缺少数据。');
        return parsed.data;
      }
      throw new BiliError('B 站链接重定向失败。');
    } catch (error) {
      if (error instanceof BiliError) throw error;
      if (controller.signal.aborted || error?.name === 'AbortError') throw new BiliError('B 站请求超时，请稍后重试。');
      // Do not repeat fetch error messages: they may contain a URL or credentials.
      throw new BiliError('无法连接 B 站，请检查服务器网络后重试。');
    } finally { clearTimeout(timer); }
  }

  async function resolve(input) {
    const id = videoId(input);
    if (id) return id;
    let url = checkedUrl(String(input ?? '').trim(), 'web');
    if (url.hostname === 'b23.tv') url = await request(url.href, { kind: 'web', probe: true });
    const match = url.pathname.match(/^\/video\/((?:BV[0-9A-Za-z]{10})|(?:av[1-9]\d{0,15}))(?:\/|$)/i);
    if (!match) throw new BiliError('请提供 BV 号、av 号、B 站视频链接或 b23.tv 视频短链。');
    const normalized = match[1].replace(/^bv/i, 'BV');
    const resolved = videoId(normalized);
    const linkedPage = Number(url.searchParams.get('p'));
    if (Number.isSafeInteger(linkedPage) && linkedPage > 0) resolved.linkedPage = linkedPage;
    return resolved;
  }

  function budget() {
    let remaining = integer(getSettings()?.maxTextChars, 16000, 2000, 50000);
    return { take(value, max) { const text = cleanText(value, Math.min(max, remaining)); remaining -= text.length; return text; }, left() { return remaining; } };
  }

  async function subtitles(bvid, cid, textBudget) {
    try {
      const data = await request(`${API}/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`);
      const list = Array.isArray(data.subtitle?.subtitles) ? data.subtitle.subtitles : [];
      if (!list.length) return { status: data.need_login_subtitle ? 'login_required' : 'unavailable', message: data.need_login_subtitle ? '此视频字幕需要登录后读取。' : '播放器没有返回可读取的字幕；未读取视频语音。' };
      const sorted = [...list].sort((a, b) => (String(a.lan).startsWith('zh') ? -1 : 0) - (String(b.lan).startsWith('zh') ? -1 : 0));
      const chosen = sorted[0];
      const rawUrl = String(chosen.subtitle_url || '');
      const url = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
      const transcript = await request(url, { kind: 'subtitle' });
      const body = Array.isArray(transcript.body) ? transcript.body : [];
      const lines = [];
      let segmentCount = 0;
      let truncated = false;
      for (const entry of body) {
        if (textBudget.left() < 40 || segmentCount >= 3000) { truncated = true; break; }
        const marker = textBudget.take(`[${timestamp(entry.from)}] `, 20);
        if (lines.length) textBudget.take('\n', 1);
        const original = cleanText(entry.content, 10000);
        const content = textBudget.take(original, 3000);
        lines.push(`${marker}${content}`);
        segmentCount++;
        if (content.length < original.length) truncated = true;
      }
      return { status: 'available', language: cleanText(chosen.lan, 30), languageName: cleanText(chosen.lan_doc, 100), text: lines.join('\n'), segmentCount, totalSegments: body.length, truncated: truncated || segmentCount < body.length, languages: list.slice(0, 20).map(x => ({ code: cleanText(x.lan, 30), name: cleanText(x.lan_doc, 100) })) };
    } catch (error) { return { status: 'error', message: error.message }; }
  }

  async function comments(aid, count, textBudget) {
    if (count === 0) return { status: 'not_requested', items: [], total: 0 };
    try {
      const data = await request(`${API}/x/v2/reply?type=1&oid=${encodeURIComponent(aid)}&sort=2&pn=1&ps=${count}`);
      const rows = Array.isArray(data.replies) ? data.replies : [];
      const items = rows.slice(0, count).map(x => ({ id: cleanText(x.rpid_str || x.rpid, 30), user: { id: cleanText(x.member?.mid || x.mid, 30), name: textBudget.take(x.member?.uname, 80) }, text: textBudget.take(x.content?.message, 1000), likes: number(x.like), publishedAt: isoDate(x.ctime) }));
      return { status: 'available', items, total: number(data.page?.count), order: 'hot' };
    } catch (error) { return { status: 'error', items: [], message: error.message }; }
  }

  async function playback(bvid, cid) {
    try {
      const data = await request(`${API}/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&qn=16&fnval=1&fnver=0&fourk=0`);
      if (!Array.isArray(data.durl) || data.durl.length !== 1 || !String(data.format || '').toLowerCase().includes('mp4')) return { playback: { status: 'unavailable', message: '播放器没有返回可完整读取的单段 MP4（可能为 DASH、多段、付费或受限视频）。' } };
      const part = data.durl[0];
      const candidates = [part.url, ...(Array.isArray(part.backup_url) ? part.backup_url.slice(0, 8) : [])];
      let url;
      for (const candidate of candidates) {
        try {
          const checked = normalizePlaybackUrl(candidate);
          if (/\.mp4$/i.test(checked.pathname)) { url = checked; break; }
        } catch { /* Skip unknown PCDN nodes, credentials and nonstandard ports. */ }
      }
      if (!url) return { playback: { status: 'unavailable', message: '播放器没有返回可用的B站HTTPS MP4线路（已检查备用地址）。' } };
      return { playbackUrl: url.href, playback: { status: 'available', format: 'mp4', sizeBytes: number(data.durl[0].size), durationMs: number(data.timelength), quality: number(data.quality) } };
    } catch (error) { return { playback: { status: 'error', message: error.message } }; }
  }

  async function read(input, { page, comments: commentCount = 5, playback: getPlayback = false } = {}) {
    const id = await resolve(input);
    const query = id.bvid ? `bvid=${encodeURIComponent(id.bvid)}` : `aid=${encodeURIComponent(id.aid)}`;
    const data = await request(`${API}/x/web-interface/view?${query}`);
    const rows = Array.isArray(data.pages) && data.pages.length ? data.pages : [{ page: 1, cid: data.cid, part: data.title, duration: data.duration }];
    const pageNumber = Number(page === undefined ? id.linkedPage || 1 : page);
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > rows.length) throw new BiliError(`分 P 页码超出范围，此视频共有 ${rows.length} P。`);
    const selected = rows[pageNumber - 1];
    if (!data.bvid || !selected.cid || !data.aid) throw new BiliError('B 站返回的视频标识不完整。');
    const textBudget = budget();
    const count = integer(commentCount, 5, 0, 20);
    const result = { source: 'bilibili', url: `https://www.bilibili.com/video/${data.bvid}/?p=${pageNumber}`, bvid: cleanText(data.bvid, 12), aid: number(data.aid), title: textBudget.take(data.title, 300), description: textBudget.take(data.desc, 4000), up: { id: number(data.owner?.mid), name: textBudget.take(data.owner?.name, 80), url: `https://space.bilibili.com/${number(data.owner?.mid)}` }, publishedAt: isoDate(data.pubdate), durationSeconds: number(data.duration), page: { number: pageNumber, total: rows.length, cid: number(selected.cid), title: textBudget.take(selected.part, 200), durationSeconds: number(selected.duration) }, pages: rows.slice(0, 50).map(x => ({ number: number(x.page), title: textBudget.take(x.part, 100), durationSeconds: number(x.duration) })), pagesTruncated: rows.length > 50, statistics: { views: number(data.stat?.view), likes: number(data.stat?.like), coins: number(data.stat?.coin), favorites: number(data.stat?.favorite), comments: number(data.stat?.reply), shares: number(data.stat?.share) } };
    // Keep the shared text budget deterministic: comments first, then transcript.
    result.comments = await comments(data.aid, count, textBudget);
    result.subtitles = await subtitles(data.bvid, selected.cid, textBudget);
    Object.assign(result, getPlayback ? await playback(data.bvid, selected.cid) : { playback: { status: 'not_requested' } });
    return result;
  }

  async function wbiKey() {
    if (wbiCache && Date.now() < wbiCache.expires) return wbiCache.key;
    const nav = await request(`${API}/x/web-interface/nav`, { allowAnonymousNav: true });
    const names = [nav.wbi_img?.img_url, nav.wbi_img?.sub_url].map(x => {
      const url = checkedUrl(x, 'subtitle');
      return url.pathname.split('/').pop().split('.')[0];
    });
    const raw = names.join('');
    if (!/^[a-f0-9]{64}$/i.test(raw)) throw new BiliError('B 站搜索签名信息不可用。');
    const key = WBI_ORDER.map(i => raw[i]).join('').slice(0, 32);
    wbiCache = { key, expires: Date.now() + 10 * 60 * 1000 };
    return key;
  }

  async function search(query, { limit = 5 } = {}) {
    const keyword = cleanText(query, 120).trim();
    if (!keyword) throw new BiliError('请提供 B 站搜索关键词。');
    const count = integer(limit, 5, 1, 20);
    const key = await wbiKey();
    const params = { keyword, page: '1', page_size: String(count), search_type: 'video', wts: String(Math.floor(Date.now() / 1000)) };
    const signedQuery = Object.keys(params).sort().map(name => `${encodeURIComponent(name)}=${encodeURIComponent(params[name].replace(/[!'()*]/g, ''))}`).join('&');
    const rid = createHash('md5').update(signedQuery + key).digest('hex');
    const data = await request(`${API}/x/web-interface/wbi/search/type?${signedQuery}&w_rid=${rid}`);
    const textBudget = budget();
    const results = (Array.isArray(data.result) ? data.result : []).slice(0, count).filter(x => /^BV[0-9A-Za-z]{10}$/.test(x.bvid || '')).map(x => ({ bvid: x.bvid, aid: number(x.aid), url: `https://www.bilibili.com/video/${x.bvid}/`, title: textBudget.take(x.title, 300), description: textBudget.take(x.description, 600), up: { id: number(x.mid), name: textBudget.take(x.author, 80) }, duration: cleanText(x.duration, 30), views: number(x.play), publishedAt: isoDate(x.pubdate) }));
    return { source: 'bilibili', query: keyword, page: 1, total: number(data.numResults), results };
  }

  return { read, search };
}
