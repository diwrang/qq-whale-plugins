import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { watchVideo } from '../skills/whale-social/watch.js';

const metadata = () => ({ playbackUrl: 'https://cn-test.bilivideo.com/video.mp4?secret=test', page: { durationSeconds: 60 }, playback: { sizeBytes: 4 } });
test('画面通过多模态部分返回，临时文件下载后交给核心并清理', async () => {
  let cached;
  const result = await watchVideo({ metadata: metadata(), fetch: async (url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Referer, 'https://www.bilibili.com/');
    return new Response(new Uint8Array([1, 2, 3, 4]));
  }, videoReader: { async probe(media, options) {
    cached = media.path; assert.equal(options.count, 4);
    assert.deepEqual([...fs.readFileSync(cached)], [1, 2, 3, 4]);
    return { route: 'frames', frames: ['data:image/jpeg;base64,frame'], frameTimes: [10] };
  } } });
  assert.equal(result.visualStatus, 'frames');
  assert.equal(result.parts[0].type, 'image_url');
  assert.equal(fs.existsSync(cached), false);
  assert.doesNotMatch(JSON.stringify(result), /secret=test/);
});
test('阻止不可信播放地址、重定向到内网、超大与超长视频', async () => {
  let calls = 0;
  const common = { videoReader: { probe() { throw new Error('不应调用'); } }, fetch: async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/' } }); } };
  const redirected = await watchVideo({ ...common, metadata: metadata() });
  assert.equal(redirected.visualStatus, 'unavailable'); assert.equal(calls, 1);
  calls = 0;
  const external = await watchVideo({ ...common, metadata: { ...metadata(), playbackUrl: 'https://bilivideo.com.evil.test/video' } });
  assert.equal(external.visualStatus, 'unavailable'); assert.equal(calls, 0);
  const long = await watchVideo({ ...common, metadata: { ...metadata(), page: { durationSeconds: 3601 } } });
  assert.match(long.message, /时长/); assert.equal(calls, 0);
  const large = await watchVideo({ ...common, metadata: { ...metadata(), playback: { sizeBytes: 100 * 1024 * 1024 } } });
  assert.match(large.message, /体积/); assert.equal(calls, 0);
});
test('体积护栏同时检查头和流；核心无画面时诚实降级', async () => {
  const common = { metadata: metadata(), videoReader: { async probe() { return { route: 'meta' }; } } };
  const tooLarge = await watchVideo({ ...common, fetch: async () => new Response('tiny', { headers: { 'Content-Length': String(300 * 1024 * 1024) } }) });
  assert.match(tooLarge.message, /体积/);
  const streamed = await watchVideo({ ...common, settings: { maxVideoMegabytes: 8 }, fetch: async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)) });
  assert.match(streamed.message, /体积/);
  const meta = await watchVideo({ ...common, fetch: async () => new Response('data') });
  assert.equal(meta.visualStatus, 'unavailable'); assert.match(meta.message, /没有取得画面/);
});
test('核心原生视频部分不混入文字；网络错误里的密钥地址不会泄漏', async () => {
  const native = await watchVideo({ metadata: metadata(), fetch: async () => new Response('data'), videoReader: { async probe() { return { route: 'native', nativeUrl: 'data:video/mp4;base64,abc' }; } } });
  assert.equal(native.parts[0].type, 'video_url');
  const error = await watchVideo({ metadata: metadata(), fetch: async () => { throw new Error('fetch failed https://signed.bilivideo.com/?SESSDATA=secret'); }, videoReader: { probe() {} } });
  assert.doesNotMatch(JSON.stringify(error), /SESSDATA|secret|signed/);
  const prefixed = await watchVideo({ metadata: metadata(), fetch: async () => new Response('data'), videoReader: { probe() { throw new Error('视频读取失败 https://signed.bilivideo.com/?upsig=private-signature'); } } });
  assert.doesNotMatch(JSON.stringify(prefixed), /private-signature|signed|upsig/);
});
