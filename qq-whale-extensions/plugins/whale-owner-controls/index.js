import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { CommandBridge } from './bridge.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const profile = /^\d+$/.test(String(process.env.QQ_AGENT_PROFILE ?? '')) ? `-${process.env.QQ_AGENT_PROFILE}` : '';
const dataDir = process.env.QQ_AGENT_DATA_DIR || path.join(appRoot, `data${profile}`);
const config = () => {
  const file = path.join(dataDir, 'config.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
};
let cfg = () => ({}), apiRef, bridge, Socket = globalThis.WebSocket;
try { Socket = createRequire(import.meta.url)('ws'); } catch { /* Node 22+ 原生 WebSocket 兜底 */ }

export function setup(api) { apiRef = api; cfg = api.config; }
export function available() {
  if (!Socket) return { ok: false, reason: '缺少 QQ Agent 自带的 ws 依赖；请修复应用依赖' };
  try {
    const owner = String(config().skills?.['whale-relations']?.ownerQQ ?? '').trim();
    if (!/^[1-9]\d{0,14}$/.test(owner)) return { ok: false, reason: '创建者 QQ 号无效，请在隐藏关系插件设置中修正' };
    return { ok: true };
  } catch { return { ok: false, reason: 'QQ Agent 配置不可读，未连接创建者接口' }; }
}
export function activate() {
  if (!available().ok || bridge) return;
  bridge = new CommandBridge({ Socket, config, enabled: () => apiRef.isSkillActive('whale-owner-controls'), options: cfg, warn: apiRef.warn });
  bridge.start();
}
export function deactivate() { bridge?.stop(); bridge = null; }
export function dispose() { deactivate(); }

export const hooks = {
  'before-llm-messages': ({ messages }) => {
    if (!available().ok) return;
    // 公共接口只能加工提示词，不能从入站存档阶段拦截命令。
    for (const m of messages || []) {
      if (m.role !== 'user' || typeof m.content !== 'string') continue;
      let handled = false;
      m.content = m.content.split('\n').map(line => {
        const match = /^(\[[^\]\r\n]+\]\s*(?:#-?\d+\s+)?[^\r\n]*?\(QQ:[1-9]\d{0,14}\)[：:])\s*\/ds(?:\s|$)/.exec(line);
        if (!match) return line;
        handled = true;
        return `${match[1]}[创建者控制接口处理的命令]`;
      }).join('\n');
      if (handled) m.content += '\n\n【控制接口】/ds 命令已交给确定性接口处理；不要重复回答、复执行或猜测结果。仅处理同轮其它普通聊天；只有控制命令时安静结束。';
    }
  }
};
