import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizePlaybackUrl } from './bili.js';

const clamp = (n, fallback, min, max) => Number.isFinite(Number(n)) ? Math.max(min, Math.min(max, Number(n))) : fallback;
const permitted = normalizePlaybackUrl;

/** Own only the temporary MP4. The core remains responsible for model/video settings. */
export async function watchVideo({ fetch, videoReader, metadata, settings = {}, frames = 4, isActive = () => true }) {
  const url = metadata.playbackUrl;
  const fallback = message => ({ visualStatus: 'unavailable', message, parts: [] });
  if (!url) return fallback(metadata.playback?.message || '没有可直接读取的单段MP4，已保留简介和字幕。');
  if (!videoReader?.probe) return fallback('QQ Agent的视频读取服务未启用，已保留简介和字幕。');
  const duration = Number(metadata.page?.durationSeconds ?? metadata.durationSeconds);
  const maxMinutes = clamp(settings.maxVideoMinutes ?? 15, 15, 1, 60);
  if (!Number.isFinite(duration) || duration <= 0 || duration > maxMinutes * 60) return fallback(`视频时长未知或超过${maxMinutes}分钟上限，未下载画面。`);
  const maxBytes = clamp(settings.maxVideoMegabytes ?? 64, 64, 8, 200) * 1024 * 1024;
  if (Number(metadata.playback?.sizeBytes) > maxBytes) return fallback('视频超过下载体积上限，已保留简介和字幕。');
  const file = path.join(os.tmpdir(), `qq-whale-social-${randomUUID()}.mp4`);
  let fileHandle, response;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  try {
    let current = permitted(url);
    for (let hops = 0; hops <= 3; hops++) {
      response = await fetch(current.href, {
        redirect: 'manual', signal: abort.signal,
        headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0 QQ-Whale-Social/1.0' }
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      if (hops === 3) throw new Error('播放地址重定向次数过多。');
      current = permitted(new URL(response.headers.get('location'), current).href);
    }
    if (!response.ok) throw new Error(`B站视频下载失败（HTTP ${response.status}），没有获得画面。`);
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('视频超过下载体积上限。');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('视频没有可读取的数据流。');
    fileHandle = fs.openSync(file, 'wx');
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error('视频超过下载体积上限，已停止下载。');
        if (!isActive()) throw new Error('扩展已关闭，已停止下载。');
        fs.writeSync(fileHandle, value);
      }
    } finally { reader.releaseLock(); }
    fs.closeSync(fileHandle); fileHandle = undefined;
    clearTimeout(timer);
    if (!size) throw new Error('视频数据为空。');
    if (!isActive()) throw new Error('扩展已关闭，未继续读取画面。');
    const count = Math.trunc(clamp(frames, 4, 1, 8));
    const info = await videoReader.probe({ kind: 'video', path: file, url: current.href }, { count });
    if (!isActive()) throw new Error('扩展已关闭，未返回画面。');
    if (info.route === 'frames' && Array.isArray(info.frames) && info.frames.length) {
      return { visualStatus: 'frames', message: '已取得抽帧画面，抽帧不能代表全部连续动作或音频。', frameTimes: info.frameTimes,
        parts: info.frames.slice(0, count).map(url => ({ type: 'image_url', image_url: { url } })) };
    }
    if (info.route === 'native' && info.nativeUrl) {
      return { visualStatus: 'native', message: '已按核心视频模式传入视频；远程播放地址可能过期或被防盗链拒绝。',
        parts: [{ type: 'video_url', video_url: { url: info.nativeUrl } }] };
    }
    return fallback('没有取得画面。请启用QQ Agent的视频抽帧技能并配置ffmpeg，或使用支持视频输入的模型。');
  } catch (error) {
    abort.abort();
    // Never expose a signed URL, a cookie or a fetch exception that embeds the request.
    const safe = String(error?.message || '');
    const secret = /https?:\/\/|SESSDATA|Cookie|access[_-]?token|upsig|deadline=/i.test(safe);
    return fallback(!secret && /^(视频|B站视频|播放地址|扩展已|QQ Agent)/.test(safe) ? safe : '视频读取未成功，已保留简介和字幕。');
  } finally {
    clearTimeout(timer);
    try { await response?.body?.cancel(); } catch { /* Reader may already be closed. */ }
    if (fileHandle !== undefined) fs.closeSync(fileHandle);
    try { fs.unlinkSync(file); } catch { /* Only our own generated file. */ }
  }
}
