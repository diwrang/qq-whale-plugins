import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameService } from './frames.js';

const id = 'whale-video-frames';
let apiRef, service;
export function setup(api) {
  apiRef = api;
  service = new FrameService({
    pluginRoot: path.dirname(fileURLToPath(import.meta.url)),
    getSettings: () => apiRef.config(),
    isActive: () => apiRef.isSkillActive(id) === true
  });
}
// QQ Agent requires a synchronous UI check; version detection runs in the background.
// Providers await that same detection before claiming that frames are available.
export function available() {
  return service ? service.availableStatus() : { ok: false, reason: '抽帧插件尚未初始化。' };
}
export const providers = {
  async 'video.frames.available'() {
    if (!service || apiRef.isSkillActive(id) !== true) return { ok: false, reason: '视频抽帧插件已关闭或依赖未就绪。' };
    const state = await service.ensureAvailable();
    if (apiRef.isSkillActive(id) !== true) return { ok: false, reason: '视频抽帧插件已关闭或依赖未就绪。' };
    return state;
  },
  async 'video.frames'(args = {}) {
    if (!service || apiRef.isSkillActive(id) !== true) return { frames: [], times: [], error: '视频抽帧插件已关闭或依赖未就绪。' };
    return service.extract(args);
  }
};
export function deactivate() { service?.cancelPending(); }
export function dispose() { service?.cancelPending(); }
