import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const PREFIX = 'qq-whale-frames-';
const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.trunc(Number(value)))) : fallback;
const empty = error => ({ frames: [], times: [], error });

export function localVideo(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f]|^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(?:\\\\|\/\/)/.test(value) || !path.isAbsolute(value)) {
    throw new Error('抽帧仅接受本地普通视频文件的绝对路径。');
  }
  const extension = path.extname(value).toLowerCase();
  if (!['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi'].includes(extension)) throw new Error('此文件不是支持的本地视频格式。');
  const entry = fs.lstatSync(value);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('视频输入必须是普通文件，不能是目录、链接或设备。');
  if (entry.size <= 0 || entry.size > MAX_VIDEO_BYTES) throw new Error('视频文件为空或超过200MB上限。');
  const real = fs.realpathSync(value);
  if (/^(?:\\\\|\/\/)/.test(real)) throw new Error('视频输入必须是本地文件。');
  const fd = fs.openSync(real, 'r');
  const magic = Buffer.alloc(16);
  try { fs.readSync(fd, magic, 0, magic.length, 0); } finally { fs.closeSync(fd); }
  const mp4 = magic.subarray(4, 8).toString('ascii') === 'ftyp';
  const ebml = magic.readUInt32BE(0) === 0x1a45dfa3;
  const avi = magic.subarray(0, 4).toString('ascii') === 'RIFF' && magic.subarray(8, 12).toString('ascii') === 'AVI ';
  if ((['.mp4', '.mov', '.m4v'].includes(extension) && !mp4) || (['.mkv', '.webm'].includes(extension) && !ebml) || (extension === '.avi' && !avi)) {
    throw new Error('视频文件头与格式不符，未交给抽帧程序。');
  }
  return real;
}

function executable(value, fallback) {
  const input = String(value || '').trim() || fallback;
  if (!path.isAbsolute(input) || /[\u0000-\u001f]|^(?:\\\\|\/\/)|^[a-z][a-z0-9+.-]*:\/\//i.test(input)) throw new Error('抽帧程序必须使用本地绝对路径。');
  if (process.platform === 'win32' && path.extname(input).toLowerCase() !== '.exe') throw new Error('Windows抽帧程序必须是exe文件。');
  const stat = fs.lstatSync(input);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('抽帧程序路径没有指向普通程序文件。');
  return fs.realpathSync(input);
}

/** Spawn without a shell; periodically stop when live settings or activation change. */
export function runChild(command, args, { timeoutMs = 10_000, guard = () => true, signal, stdoutLimit = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (!guard() || signal?.aborted) { reject(new Error('抽帧插件已关闭或配置已改变，已停止读取。')); return; }
    let child, finished = false, bytes = 0, stdout = [], requestedError;
    let timer, poll, forceTimer;
    const done = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearInterval(poll); clearTimeout(forceTimer); signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(value);
    };
    const stop = error => {
      if (finished || requestedError) return;
      requestedError = error;
      try { child?.kill(); } catch {}
      forceTimer = setTimeout(() => { if (!finished) { try { child?.kill('SIGKILL'); } catch {} } }, 500);
      // Resolve only after close: a terminated process must release its output files
      // before our finally block cleans the exclusively owned temporary directory.
    };
    const cancel = () => stop(new Error('抽帧插件已关闭或配置已改变，已停止读取。'));
    try { child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false }); }
    catch { done(new Error('无法启动视频抽帧程序。')); return; }
    timer = setTimeout(() => stop(new Error('视频抽帧程序运行超时，已终止。')), timeoutMs);
    poll = setInterval(() => { try { if (!guard()) cancel(); } catch { cancel(); } }, 200);
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', buffer => {
      bytes += buffer.length;
      if (bytes > stdoutLimit) stop(new Error('抽帧程序返回的数据超过上限。'));
      else stdout.push(buffer);
    });
    child.on('error', () => done(new Error('无法启动视频抽帧程序。')));
    child.on('close', code => {
      if (requestedError) done(requestedError);
      else if (!guard() || signal?.aborted) done(new Error('抽帧插件已关闭或配置已改变，已停止读取。'));
      else if (code !== 0) done(new Error('视频文件无法被抽帧程序读取。'));
      else done(null, Buffer.concat(stdout).toString('utf8'));
    });
  });
}

export function cleanOwnedTemp(directory, temporaryRoot = os.tmpdir()) {
  const resolved = path.resolve(directory);
  const root = fs.realpathSync(temporaryRoot);
  if (path.dirname(resolved) !== path.resolve(temporaryRoot) || !path.basename(resolved).startsWith(PREFIX)) return false;
  if (!fs.existsSync(resolved)) return true;
  const entry = fs.lstatSync(resolved);
  if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
  const actual = fs.realpathSync(resolved);
  if (path.dirname(actual) !== root || !path.basename(actual).startsWith(PREFIX)) return false;
  fs.rmSync(actual, { recursive: true, force: true });
  return true;
}

export class FrameService {
  constructor({ pluginRoot, getSettings = () => ({}), isActive = () => true } = {}) {
    this.pluginRoot = path.resolve(pluginRoot);
    this.getSettings = getSettings; this.isActive = isActive;
    this.pending = new Set(); this.probeCache = null; this.probing = null; this.lastFailureAt = 0;
  }
  options() {
    const cfg = this.getSettings() || {};
    return {
      ffmpeg: executable(cfg.ffmpegPath, path.join(this.pluginRoot, 'bin', 'ffmpeg.exe')),
      ffprobe: executable(cfg.ffprobePath, path.join(this.pluginRoot, 'bin', 'ffprobe.exe')),
      count: bounded(cfg.frameCount, 4, 1, 8), width: bounded(cfg.frameWidth, 640, 160, 1280),
      jpegBytes: bounded(cfg.jpegLimitKilobytes, 1024, 64, 2048) * 1024
    };
  }
  signature(options = this.options()) { return JSON.stringify(options); }
  availableStatus() {
    let options;
    try { options = this.options(); } catch { return { ok: false, reason: '未找到本地ffmpeg/ffprobe。请放入插件bin文件夹，或在插件设置中填写程序路径。' }; }
    const signature = this.signature(options);
    if (this.probeCache?.signature === signature) {
      if (this.probeCache.state.ok || Date.now() - this.lastFailureAt < 60_000) return this.probeCache.state;
    }
    this.ensureAvailable().catch(() => {});
    return { ok: true, reason: '正在检查视频抽帧程序。' };
  }
  async ensureAvailable() {
    let options;
    try { options = this.options(); } catch { return { ok: false, reason: '未找到本地ffmpeg/ffprobe。请放入插件bin文件夹，或填写程序路径。' }; }
    const signature = this.signature(options);
    if (this.probeCache?.signature === signature && (this.probeCache.state.ok || Date.now() - this.lastFailureAt < 60_000)) return this.probeCache.state;
    if (this.probing?.signature === signature) return this.probing.promise;
    const promise = (async () => {
      let state;
      try {
        const guard = () => { try { return this.signature() === signature; } catch { return false; } };
        const results = await Promise.all([runChild(options.ffmpeg, ['-version'], { timeoutMs: 5000, guard, stdoutLimit: 200_000 }), runChild(options.ffprobe, ['-version'], { timeoutMs: 5000, guard, stdoutLimit: 200_000 })]);
        state = /^ffmpeg version /i.test(results[0]) && /^ffprobe version /i.test(results[1]) ? { ok: true } : { ok: false, reason: '指定的程序没有返回有效ffmpeg/ffprobe版本。' };
      } catch { state = { ok: false, reason: 'ffmpeg/ffprobe检查失败，请确认程序可运行且路径正确。' }; }
      this.probeCache = { signature, state }; if (!state.ok) this.lastFailureAt = Date.now();
      if (this.probing?.signature === signature) this.probing = null;
      return state;
    })();
    this.probing = { signature, promise };
    return promise;
  }
  cancelPending() { for (const abort of this.pending) abort.abort(); }
  async extract({ filePath, count } = {}) {
    if (!this.isActive()) return empty('视频抽帧插件已关闭。');
    if (this.pending.size >= 2) return empty('当前视频抽帧任务已满，请稍后再读。');
    let temporaryDirectory;
    const abort = new AbortController(); this.pending.add(abort);
    try {
      const input = localVideo(filePath);
      const state = await this.ensureAvailable();
      if (!state.ok) return empty(state.reason);
      const options = this.options(), signature = this.signature(options);
      const guard = () => { try { return this.isActive() && this.signature() === signature; } catch { return false; } };
      if (!guard() || abort.signal.aborted) return empty('抽帧插件已关闭或配置已改变，已停止读取。');
      const metadata = await runChild(options.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration:stream=codec_type,duration', '-of', 'json', input], { timeoutMs: 10_000, guard, signal: abort.signal });
      let parsed;
      try { parsed = JSON.parse(metadata); } catch { throw new Error('未能读取视频时长，未抽取画面。'); }
      const stream = Array.isArray(parsed.streams) ? parsed.streams.find(x => x.codec_type === 'video') : null;
      const duration = Number(parsed.format?.duration || stream?.duration);
      if (!stream || !Number.isFinite(duration) || duration <= 0 || duration > 24 * 60 * 60) throw new Error('没有有效的视频流或时长，未抽取画面。');
      // The upstream caller's duration hint is not trusted; ffprobe selects the times.
      const number = count === undefined ? options.count : bounded(count, options.count, 1, 8);
      const times = Array.from({ length: number }, (_, i) => Number((duration * (i + 1) / (number + 1)).toFixed(4)));
      temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
      const frames = [];
      for (let i = 0; i < times.length; i++) {
        if (!guard() || abort.signal.aborted) throw new Error('抽帧插件已关闭或配置已改变，已停止读取。');
        const output = path.join(temporaryDirectory, `frame-${i}.jpg`);
        await runChild(options.ffmpeg, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-ss', String(times[i]), '-i', input, '-frames:v', '1', '-an', '-sn', '-dn', '-vf', `scale='min(${options.width},iw)':'min(${options.width},ih)':force_original_aspect_ratio=decrease`, '-q:v', '4', '-fs', String(options.jpegBytes), '-update', '1', output], { timeoutMs: 12_000, guard, signal: abort.signal, stdoutLimit: 16_000 });
        const stat = fs.lstatSync(output);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 4 || stat.size > options.jpegBytes) throw new Error('抽取的JPEG画面为空或超过体积限制。');
        const bytes = fs.readFileSync(output);
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error('抽取的画面没有形成完整JPEG。');
        frames.push(`data:image/jpeg;base64,${bytes.toString('base64')}`);
      }
      if (!guard() || abort.signal.aborted) throw new Error('抽帧插件已关闭或配置已改变，已停止读取。');
      return { frames, times, durationSec: duration, note: `已抽取${frames.length}张画面，仅代表这些时间点，不包含连续动作或声音。` };
    } catch (error) {
      const message = String(error?.message || '');
      return empty(/^(抽帧|视频|此文件|没有有效|未能读取|当前)/.test(message) ? message : '视频抽帧未成功，请检查本地文件和程序。');
    } finally {
      this.pending.delete(abort);
      if (temporaryDirectory) { try { cleanOwnedTemp(temporaryDirectory); } catch {} }
    }
  }
}
