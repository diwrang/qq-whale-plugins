import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FrameService, localVideo, runChild, cleanOwnedTemp } from '../plugins/whale-video-frames/frames.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(root, 'plugins', 'whale-video-frames');
const ffmpeg = path.join(pluginRoot, 'bin', 'ffmpeg.exe');
const ffprobe = path.join(pluginRoot, 'bin', 'ffprobe.exe');
const binariesReady = fs.existsSync(ffmpeg) && fs.existsSync(ffprobe);
const tempList = () => fs.readdirSync(os.tmpdir()).filter(x => x.startsWith('qq-whale-frames-')).sort();

test('只接受真实普通本地视频，不把URL、目录、设备或伪装文本交给程序', () => {
  for (const input of ['https://upos.bilivideo.com/video.mp4', 'file:///C:/video.mp4', 'pipe:0', '\\\\.\\NUL', '\\\\server\\share\\video.mp4', 'relative.mp4', os.tmpdir()]) assert.throws(() => localVideo(input));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-input-test-'));
  const fake = path.join(fixture, 'fake.mp4'); fs.writeFileSync(fake, '#EXTM3U\nhttps://invalid.test/example');
  assert.throws(() => localVideo(fake), /文件头/);
  const big = path.join(fixture, 'oversize.mp4'); fs.writeFileSync(big, '0000ftypisom'); fs.truncateSync(big, 200 * 1024 * 1024 + 1);
  assert.throws(() => localVideo(big), /200MB/);
  // Fixture files are individually removed; no recursive user-directory operation.
  fs.unlinkSync(fake); fs.unlinkSync(big); fs.rmdirSync(fixture);
});

test('临时文件清理只允许直接位于系统临时目录的自有目录', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-not-owned-'));
  fs.writeFileSync(path.join(other, 'keep.txt'), 'keep');
  assert.equal(cleanOwnedTemp(other), false); assert.equal(fs.existsSync(path.join(other, 'keep.txt')), true);
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-whale-frames-'));
  fs.writeFileSync(path.join(owned, 'frame.jpg'), 'temporary');
  assert.equal(cleanOwnedTemp(owned), true); assert.equal(fs.existsSync(owned), false);
  assert.equal(cleanOwnedTemp(os.tmpdir()), false);
  fs.unlinkSync(path.join(other, 'keep.txt')); fs.rmdirSync(other);
});

test('进程超时和实时停用会终止子进程；大量stdout受上限限制', async () => {
  await assert.rejects(runChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), /超时/);
  let active = true;
  const task = runChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 3000, guard: () => active });
  setTimeout(() => { active = false; }, 80);
  await assert.rejects(task, /已关闭/);
  await assert.rejects(runChild(process.execPath, ['-e', 'process.stdout.write("a".repeat(200000));setInterval(()=>{},1000)'], { stdoutLimit: 1000, timeoutMs: 3000 }), /超过上限/);
});

test('缺少ffmpeg与停用状态都不会声称已经取得画面', async () => {
  const missing = new FrameService({ pluginRoot: path.join(root, 'missing-programs') });
  assert.equal(missing.availableStatus().ok, false); assert.equal((await missing.ensureAvailable()).ok, false);
  const off = new FrameService({ pluginRoot, isActive: () => false });
  assert.deepEqual((await off.extract({ filePath: 'https://invalid.test/video.mp4' })).frames, []);
  assert.match((await off.extract()).error, /已关闭/);
});

test('真实短视频抽帧、JPEG格式、均匀时间点、配置更改、QQ Agent核心整合', { skip: !binariesReady && '需要插件bin下的ffmpeg.exe、ffprobe.exe' }, async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-frame-test-'));
  const video = path.join(fixture, 'test.mp4');
  const generated = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=192x108:rate=8', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(generated.status, 0, generated.stderr);
  const before = tempList();
  let active = true, cfg = {};
  const service = new FrameService({ pluginRoot, getSettings: () => cfg, isActive: () => active });
  await t.test('真实默认4张与最多8张，返回完整JPEG并清理输出', async () => {
    assert.equal((await service.ensureAvailable()).ok, true);
    const frames = await service.extract({ filePath: video });
    assert.equal(frames.frames.length, 4, frames.error);
    assert.deepEqual(frames.times, [0.4, 0.8, 1.2, 1.6]);
    assert.equal(frames.durationSec, 2); assert.match(frames.note, /不包含/);
    for (const frame of frames.frames) {
      const jpeg = Buffer.from(frame.replace('data:image/jpeg;base64,', ''), 'base64');
      assert.equal(jpeg.readUInt16BE(0), 0xffd8); assert.equal(jpeg.readUInt16BE(jpeg.length - 2), 0xffd9); assert.ok(jpeg.length <= 1024 * 1024);
    }
    assert.equal((await service.extract({ filePath: video, count: 99 })).frames.length, 8);
    assert.deepEqual(tempList(), before);
  });
  await t.test('实时停用和配置改变会撤回画面', async () => {
    const task = service.extract({ filePath: video, count: 8 });
    active = false;
    const cancelled = await task;
    assert.equal(cancelled.frames.length, 0); assert.match(cancelled.error, /已关闭/);
    active = true;
    const changing = service.extract({ filePath: video, count: 8 });
    setTimeout(() => { cfg = { frameWidth: 320 }; }, 1);
    const changed = await changing;
    assert.equal(changed.frames.length, 0); assert.match(changed.error, /配置已改变/);
    cfg = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, frameWidth: 320, frameCount: 2 };
    assert.equal((await service.extract({ filePath: video })).frames.length, 2);
    cfg = { ffmpegPath: 'https://invalid.test/program.exe' };
    assert.equal(service.availableStatus().ok, false);
    assert.equal((await service.extract({ filePath: video })).frames.length, 0);
    assert.deepEqual(tempList(), before);
  });
  const upstream = process.env.QQ_WHALE_UPSTREAM;
  await t.test('真正加载器挂能力，VideoReader自动返回画面；禁用后退为元信息', { skip: !upstream && '需要QQ_WHALE_UPSTREAM' }, async () => {
    process.env.QQ_AGENT_DATA_DIR = path.join(fixture, 'data');
    const source = relative => pathToFileURL(path.join(upstream, relative)).href;
    const { loadPlugins, unloadSkill } = await import(source('src/plugin-loader.js'));
    const { skillManager } = await import(source('src/skills/manager.js'));
    const { setSkillEnabled } = await import(source('src/skills/config.js'));
    const { updateConfig } = await import(source('src/config.js'));
    const { VideoReader } = await import(source('src/video-reader.js'));
    updateConfig({ api: { videoMode: 'auto', videoModel: '' } });
    fs.mkdirSync(path.join(fixture, 'empty-skills'));
    const logs = [];
    const loaded = await loadPlugins({ roots: { plugins: path.join(root, 'plugins'), skills: path.join(fixture, 'empty-skills') }, log: line => logs.push(line) });
    assert.equal(loaded.failed.length, 0, logs.join('\n')); assert.equal(loaded.loaded.length, 1);
    assert.equal(logs.some(line => line.includes('⚠️')), false, logs.join('\n'));
    const reader = new VideoReader({});
    assert.equal(await reader.framesAvailable(), true);
    assert.equal(skillManager.status('whale-video-frames').active, true);
    const result = await reader.probe({ kind: 'video', path: video }, { count: 3 });
    assert.equal(result.route, 'frames', result.routeReason); assert.equal(result.frames.length, 3);
    setSkillEnabled('whale-video-frames', false); skillManager.deactivate('whale-video-frames');
    assert.equal(await reader.framesAvailable(), false);
    const stopped = await reader.probe({ kind: 'video', path: video }, { count: 3 });
    assert.equal(stopped.route, 'meta'); assert.equal(stopped.frames, undefined);
    setSkillEnabled('whale-video-frames', true);
    unloadSkill('whale-video-frames');
    assert.deepEqual(tempList(), before);
  });
  fs.unlinkSync(video);
  // The fixture also contains QQ Agent's generated config. Preserve it for diagnosis.
});
