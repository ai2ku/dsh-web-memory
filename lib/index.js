// dsh-web-memory · DSH Web 原生记忆 + 人格插件
//
// 从 dsh-memory-brain（QQ 桥接）剥离记忆 + 人格系统，适配 DSH 原生 Web 会话。
//
// 干的四件事：
//   1. 存 —— Web 会话每条用户消息/AI 回复写进记忆存档（chat:{userId} 跨设备共享，
//      每条带 session + device 标注）
//   2. 判读 —— 用户消息喂给人格系统（persona.onIncoming），性格/情绪/关系跟着变
//   3. 取 —— 会话开始时用最近用户消息检索记忆，注入 systemPrompt.context
//   4. 注 —— 人格 core 注入 systemPrompt.section，每条记忆带时间
//
// 挂载模式参照 dsh-fish-memory：agent.ctx.on('agent/inbox/inserted' / 'agent/turn-stopping')，
// agent.ctx.systemPrompt.context/section 注入，agent.ctx.tools.register 注册工具。
//
// 数据源：记忆/人格核心用 ./src/web-memory-core.js（从 bridge.js 剥离的纯工厂）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebMemoryCore } from '../src/web-memory-core.js';
import { createLifeLoop } from '../src/life-loop.js';

export const name = 'web-memory';
export const inject = ['systemPrompt', 'agents', 'timer', 'tools', 'webServer', 'sessions', 'llm'];

// 插件根：本插件完全自包含（copy 到 DSH 插件目录），src 在插件内。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');

// 数据目录 / 配置：从插件内 config.json 读（指向项目 state/，与 memory-rag 容器共享）。
// 若缺省，回退到 DSH_HOME 下的插件数据目录（此时 memory-rag 向量索引不会同步，需自行确认）。
function loadPluginConfig() {
  try {
    const p = path.join(PLUGIN_ROOT, 'config.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return {};
}
const PLUGIN_CFG = loadPluginConfig();
const PROJECT_ROOT = PLUGIN_CFG.projectRoot || PLUGIN_CFG.stateDir || path.join(os.homedir(), '.dsh-web-memory');
const DATA_ROOT = PLUGIN_CFG.stateDir || path.join(os.homedir(), '.dsh-web-memory', 'state');
const CONFIG_FILE = PLUGIN_CFG.configFile || path.join(PROJECT_ROOT, 'config.json');
// 主人称呼（config.json ownerName，默认「用户」）：DSH message 不带作者名，存档 name 用它
const OWNER_NAME = (typeof PLUGIN_CFG.ownerName === 'string' && PLUGIN_CFG.ownerName.trim()) ? PLUGIN_CFG.ownerName.trim() : '用户';

function diag(msg) {
  try { console.error(`[web-memory] ${msg}`); } catch {}
  // 诊断：同时写文件（DSH 可能吞 console.error）
  try {
    const f = path.join(process.env.DSH_HOME || os.homedir(), 'dsh-web-memory-err.log');
    fs.appendFileSync(f, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// 启动错误写文件：DSH 可能吞掉 console.error（stderr 转 socket），
// 插件激活失败时把确切报错写到 DSH_HOME，便于诊断。
function diagErr(msg) {
  diag(msg);
  try {
    const f = path.join(process.env.DSH_HOME || os.homedir(), 'dsh-web-memory-err.log');
    fs.appendFileSync(f, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// DSH webServer 的 handler 只传 (req, res)，不解析 body。POST 路由需要手动读。
// 读 req 流并 JSON.parse；读不到或非 JSON 返回 {}。
async function readBody(req) {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ── 消息文本提取（参照 dsh-fish-memory）───────────────────────────────────
function textOfMessage(p) {
  if (!p) return '';
  if (typeof p === 'string') return p.slice(0, 2000);
  if (typeof p.text === 'string') return p.text.slice(0, 2000);
  if (typeof p.content === 'string') return p.content.slice(0, 2000);
  if (Array.isArray(p.content)) {
    const parts = [];
    for (const b of p.content) {
      if (typeof b === 'string') parts.push(b);
      else if (b && typeof b.text === 'string') parts.push(b.text);
    }
    if (parts.length) return parts.join(' ').slice(0, 2000);
  }
  return '';
}

// 机器来源（宿主/插件塞的上下文，不是人话）—— 参照 dsh-fish-memory 的黑名单
const 机器来源 = new Set([
  'runtime-context', 'time-context', 'skill-catalog', 'model-selection',
  'compact-checkpoint', 'repeat-tool-reminder', 'user-approval',
  'system-prompt', 'working-directory', 'ptc-mode', 'tool-registry',
  'agent-instructions', 'subagent-settled', 'team-message', 'agent-message',
  'speak-up', 'her-words', 'bili-duty-scan', 'fishbuddy-watch',
  'schedule',
]);

function 是机器话(event) {
  try {
    const src = event?.data?.source;
    const kind = src && typeof src.kind === 'string' ? src.kind : '';
    if (kind && 机器来源.has(kind)) return true;
  } catch {}
  return false;
}

function lastUserText(session) {
  try {
    if (!session || typeof session.snapshotEvents !== 'function') return '';
    const ev = session.snapshotEvents() || [];
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i];
      if (e?.type !== 'user/message') continue;
      if (是机器话(e)) continue;
      const p = e.payload !== undefined ? e.payload : e.data;
      const txt = textOfMessage(p).replace(/\s+/g, ' ').trim();
      if (txt) return txt.slice(0, 500);
    }
  } catch {}
  return '';
}

// ── 工具：remember（AI 自己记，参照 fish-memory）─────────────────────────
// 类别映射：tags 里的约定/喜好等关键词推断 ltm 类别，缺省 fact（告诉过你的事）。
function mapCat(tags, explicit) {
  const c = String(explicit ?? '').trim();
  if (c) return c;
  const t = (Array.isArray(tags) ? tags : []).join(' ').toLowerCase();
  if (t.includes('约定') || t.includes('答应') || t.includes('承诺') || t.includes('待办')) return 'pending';
  if (t.includes('喜好') || t.includes('习惯') || t.includes('性格') || t.includes('喜欢') || t.includes('讨厌')) return 'trait';
  if (t.includes('经历') || t.includes('一起') || t.includes('事件')) return 'event';
  return 'fact';
}

function makeRememberTool(ctx, core, sid) {
  return {
    name: 'mem_remember',
    description: '把一件事记进长期记忆（dsh-memory-brain 跨设备共享，每轮都可能想起来）。' +
      '一句话说清：人称——你是「我」，用户是「爸爸」，别人直接写名字。' +
      '可带 replaces=旧编号 表示「这条是在更新一件旧事」（旧的会标过时），tags 帮助以后想起来，core=true 标最重要的。' +
      '例：mem_remember("他说周六中午一起去吃火锅", {tags:["约定"], replaces:"旧编号"})',
    parameters: {
      text: { type: 'string', required: true, description: '要记住的事，一句话说清。' },
      tags: { type: 'array', items: { type: 'string' }, description: '关键词，如 ["约定"]。' },
      cat: { type: 'string', description: '类别：trait/fact/event/pending/note（缺省按 tags 推断）。' },
      replaces: { type: 'string', description: '可选：更新旧事的编号（旧条目标过时）。' },
      core: { type: 'boolean', description: '可选：true 表示这是最重要的事（每人最多 8 条）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const text = value && typeof value === 'object' ? (value.message ?? '') : String(value ?? '');
        return [{ type: 'text', text }];
      },
    },
    async execute(args) {
      try {
        const text = String(args?.text ?? args?.[0] ?? '').trim();
        if (!text) return { ok: false, message: '没给要记的话（参数 text）。' };
        const tags = Array.isArray(args?.tags) ? args.tags.filter(Boolean) : [];
        const cat = mapCat(tags, args?.cat);
        const replaces = String(args?.replaces ?? args?.取代 ?? '').trim();
        const coreFlag = args?.core === true;
        const r = core.ltm.remember({
          userId: String(core.userId()),
          name: OWNER_NAME,
          cat,
          text,
          sourceKey: core.chatKey(),
          scope: 'public',
          ...(replaces ? { replaces } : {}),
          ...(coreFlag ? { core: true } : {}),
        });
        const n = r?.item?.id ?? r?.id ?? '?';
        diag(`remember(sid=${String(sid).slice(0, 12)}…): ${text.slice(0, 40)} [cat:${cat}${replaces ? ' replaces:' + replaces : ''}]`);
        // 账本建议判采用：刚记下的条目是不是本进程给她看过的某条候选（规格 §4.6）
        try { core.ledgerSuggest?.onRemember?.(core.chatKey(), String(core.userId()), n); } catch {}
        let extra = '';
        if (r?.replaced) extra = '（旧条目已标过时）';
        else if (r?.duplicate) extra = '（已记过，刷新时间）';
        return { ok: true, message: `记住了：${text}${extra}` };
      } catch (e) {
        return { ok: false, message: `记失败：${e?.message ?? e}` };
      }
    },
  };
}

// ── 插件入口 ──────────────────────────────────────────────────────────────
export function apply(ctx) {
  try {
    return applyInner(ctx);
  } catch (error) {
    diagErr(`插件激活失败（${error?.message ?? error}）\n${error?.stack ?? ''}`);
    throw error; // 让 DSH 知道激活失败
  }
}

function applyInner(ctx) {
  const stateDir = DATA_ROOT;
  const configFile = CONFIG_FILE;

  // 记忆 + 人格核心
  let core;
  try {
    core = createWebMemoryCore({
      root: PROJECT_ROOT,
      stateDir,
      configFile,
      log: diag,
      redact: (s) => s,
    });
    diag(`核心就绪：device=${core.deviceId()} chat=${core.chatKey()} persona=${core.personaKey()}`);
  } catch (error) {
    diagErr(`核心初始化失败：${error?.message ?? error}`);
    return;
  }

  const mounted = new Map(); // sid -> { agent, offs: [] }

  function mountFor(agent, sid) {
    const offs = [];
    const chatKey = core.chatKey();
    const device = core.deviceId();
    // 记忆召回缓存：异步预取 rag 检索结果，systemPrompt.context 同步读（rag.search 是 async，context text 要同步）
    let recallCache = '';
    let lastUserQuery = ''; // inbox/inserted 记录的最新用户消息（比 lastUserText(session) 更早触发，避免首轮时序漏）
    // 账本建议候选（suggest）：唤醒时预取 plan → 存 block，systemPrompt.context 注入一次（"值得长期记住"）
    let suggestBlock = '';

    // 0. 主动唤醒（life-loop）：到期约定提醒 + 忽然想起。deliverPromiseWake 用 agent.followup 推 Web 会话。
    let lifeLoop = null;
    try {
      const statePath = path.join(core.root, 'state', 'life-loop.json');
      lifeLoop = createLifeLoop({
        ltm: core.ltm,
        statePath,
        deliverPromiseWake: async (key, text) => {
          try {
            // 主动唤醒提醒：用 followup 注入 inbox 并唤醒 agent（role='user' 让 agent 处理），
            // 但 source.kind='schedule'（定时任务注入，producer-owned，非 'user'）让 UI 显示为系统提醒而非用户气泡。
            // DSH 校验：source.kind 必须非空字符串且 !== 'plugin'（dsh-session-format-v3-to-v4:126）。
            const input = { role: 'user', content: [{ type: 'text', text }], source: { kind: 'schedule' }, id: `life-loop-${Date.now()}` };
            await agent.followup(input);
            return { ok: true };
          } catch (e) { return { ok: false, error: e?.message ?? e }; }
        },
        isAllowed: () => true,
        options: { promiseWake: { enabled: true, at: '10:00', maxPerDay: 3 } },
        log: (m) => diag(`[life-loop] ${m}`),
      });
      if (ctx?.timer && typeof ctx.timer.setInterval === 'function') {
        diag(`life-loop 定时器：ctx.timer（顶层 ctx 可用）`);
        ctx.timer.setInterval(() => { lifeLoop.tick().catch((e) => diag(`life-loop tick 失败: ${e?.message ?? e}`)); }, 60000);
      } else {
        diag(`life-loop 定时器：全局 setInterval（ctx.timer 不可用，${!!ctx?.timer}）`);
        setInterval(() => { lifeLoop.tick().catch((e) => diag(`life-loop tick 失败: ${e?.message ?? e}`)); }, 60000).unref?.();
      }
      // 启动立即 tick 一次（补上错过的时间窗口，也便于验证）
      lifeLoop.tick().then(() => diag('life-loop 首次 tick 完成')).catch((e) => diag(`life-loop 首次 tick 失败: ${e?.message ?? e}`));
      diag('life-loop 已启动（主动唤醒）');
    } catch (e) { diag(`life-loop 启动失败: ${e?.message ?? e}`); }

    // 1. 用户消息 → 写存档 + 判读人格
    try {
      offs.push(agent.ctx.on('agent/inbox/inserted', (payload) => {
        const msg = payload?.message ?? payload;
        if (是机器话({ data: msg })) return;
        const txt = textOfMessage(msg);
        if (!txt) return;
        lastUserQuery = txt;
        try {
          core.ltm.archive(chatKey, {
            dir: 'in', userId: core.userId(), name: OWNER_NAME,
            text: txt, msgId: msg?.id ?? null, device, session: sid,
          });
          // 人物账本：touch 更新「认识这个人」的消息计数（items 由提炼/l2 蒸馏生成）
          try { core.ltm.touch(core.userId(), OWNER_NAME); } catch {}
          diag(`存档 in (${sid.slice(0, 12)}…): ${txt.slice(0, 30)}`);
        } catch (e) { diag(`存档 in 失败: ${e?.message ?? e}`); }
        // 账本建议候选（suggest）：唤醒时预取 plan（async）→ 存 block，供 context 注入一次
        try {
          const ls = core.ledgerSuggest;
          if (ls && typeof ls.plan === 'function') {
            ls.plan(chatKey).then((r) => {
              if (r && typeof r.block === 'string' && r.block) {
                suggestBlock = r.block;
                if (Array.isArray(r.ids) && r.ids.length) ls.markShown?.(chatKey, r.ids);
              }
            }).catch((e) => diag(`suggest plan 失败: ${e?.message ?? e}`));
          }
        } catch (e) { diag(`suggest 预取失败: ${e?.message ?? e}`); }
        // 异步预取记忆召回（账本 matchItems + archive ltm.search + rag 向量）→ 存缓存供 context 注入
        try {
          const parts = [];
          // 1. 账本长期记忆（暗号/约定/喜好等，people.json 的 items）——matchItems 整词匹配，中文句子需 2-gram 才能命中
          try {
            const q = String(txt);
            const words = new Set();
            // 拆分词（按分隔符）
            for (const s of q.split(/[\s,，。.!！?？、;；:：'""''()（）\[\]【】<>《》\/|]+/).filter((s) => s.length >= 2)) words.add(s);
            // 2-gram（连续 2 字子串，中文句子无分隔符时用）
            const chars = [...q];
            for (let i = 0; i + 2 <= chars.length; i += 1) words.add(chars.slice(i, i + 2).join(''));
            const ledger = core.ltm.matchItems(String(core.userId()), chatKey, q) ?? [];
            const seen = new Set(ledger.map((it) => it.id));
            for (const w of [...words].slice(0, 8)) {
              for (const it of core.ltm.matchItems(String(core.userId()), chatKey, w) ?? []) {
                if (!seen.has(it.id)) { seen.add(it.id); ledger.push(it); }
              }
            }
            for (const it of ledger.slice(0, 6)) {
              parts.push(`- [${it.cat}] ${String(it.text ?? '').slice(0, 200)}`);
            }
          } catch (e) { /* 账本检索失败不阻塞 */ }
          // 2. archive 全文检索（会话消息记录，含历史暗号/约定对话）——同步
          try {
            const s = core.ltm.search(chatKey, { query: txt, limit: 6 });
            for (const line of (s.lines ?? []).slice(0, 4)) {
              parts.push(`- ${String(line).slice(0, 200)}`);
            }
          } catch (e) { /* archive 检索失败不阻塞 */ }
          // 3. 跨设备 rag 向量检索（历史对话，语义相似）
          if (core.rag) {
            core.rag.search({ key: chatKey, query: txt, k: 4 }).then((r) => {
              const items = r?.items ?? [];
              for (const it of items.slice(0, 4)) {
                parts.push(`- ${it.day ? `(${it.day}) ` : ''}${String(it.text).slice(0, 200)}`);
              }
              recallCache = parts.length ? '【记忆】相关的事：\n' + parts.join('\n') : '';
            }).catch(() => { recallCache = parts.length ? '【记忆】相关的事：\n' + parts.join('\n') : ''; });
          } else {
            recallCache = parts.length ? '【记忆】相关的事：\n' + parts.join('\n') : '';
          }
        } catch (e) { /* 检索失败不阻塞 */ }
        // 判读人格（Web 会话也判读）
        if (core.persona && core.userId()) {
          core.persona.onIncoming({
            key: chatKey, kind: 'private', userId: String(core.userId()),
            name: OWNER_NAME, text: txt, msgId: msg?.id ?? null,
            directed: true, context: [],
          }).catch((e) => diag(`判读失败: ${e?.message ?? e}`));
        }
      }));
    } catch (e) { diag(`挂 inbox 失败: ${e?.message ?? e}`); }

    // 2. AI 回复 → 写存档（dir=out）
    try {
      offs.push(agent.ctx.on('agent/turn-stopping', () => {
        try {
          const ev = (agent.session?.snapshotEvents?.() ?? []) || [];
          let 回复 = '';
          for (let i = ev.length - 1; i >= 0; i--) {
            const e = ev[i];
            if (e?.type === 'assistant/message') {
              回复 = textOfMessage(e.data?.message);
              break;
            }
          }
          if (!回复) return;
          try {
            core.ltm.archive(chatKey, {
              dir: 'out', userId: core.userId(), name: 'web',
              text: 回复, msgId: null, device, session: sid,
            });
            diag(`存档 out (${sid.slice(0, 12)}…): ${回复.slice(0, 30)}`);
          } catch (e) { diag(`存档 out 失败: ${e?.message ?? e}`); }
        } catch (e) { diag(`turn-stopping 失败: ${e?.message ?? e}`); }
      }));
    } catch (e) { diag(`挂 turn-stopping 失败: ${e?.message ?? e}`); }

    // 3. 记忆召回注入（systemPrompt.context，每轮变的内容）——自动想起候选 + archive 检索
    try {
      offs.push(agent.ctx.systemPrompt.context({
        name: 'web-memory',
        order: 900,
        interpolate: false,
        text: () => {
          const query = lastUserQuery || lastUserText(agent.session);
          const blocks = [];
          // 1. 进行中的话题（archive 最近对话，不按 query）——原版 formatMemoryV2 的【进行中的话题】，Web 用最近对话推断
          try {
            const rows = core.ltm.archiveRows(chatKey, { limit: 20 })
              // WEB_SESSION_PATCH：只取当前会话，避免把别的会话的话题混进来（记忆共享但话题按会话）
              .filter((r) => !r.session || r.session === sid)
              .slice(-3);
            const topics = rows.map((r) => ({ dir: r.dir, text: String(r.text ?? '').replace(/\s+/g, ' ').slice(0, 100) }))
              .filter((r) => r.text && !/\[SCHEDULE|巡检|REMINDER|本轮无待下单|^\[/i.test(r.text))
              .map((r) => `- ${r.dir === 'in' ? '你说' : '我'}：${r.text}`);
            if (topics.length) blocks.push('【进行中的话题】\n' + topics.join('\n'));
          } catch (e) { /* 话题失败不阻塞 */ }
          // 2. archive 检索（按 query 的相关对话）——同步，保证首轮注入
          if (query) {
            try {
              const s = core.ltm.search(chatKey, { query, limit: 6 });
              const lines = (s.lines ?? []).slice(0, 4).map((line) => `- ${String(line).slice(0, 200)}`);
              if (lines.length) blocks.push('【记忆】相关的事：\n' + lines.join('\n'));
            } catch (e) { /* archive 检索失败不阻塞 */ }
          }
          // 3. 自动想起候选（rag.recall，跨设备语义）——用缓存（recallCache），异步预取
          if (recallCache) blocks.push(recallCache);
          // 4. 账本建议候选（suggest）——唤醒时预取的"值得长期记住"，注入一次后清空
          if (suggestBlock) {
            blocks.push(suggestBlock);
            suggestBlock = '';
          }
          const out = blocks.join('\n\n');
          if (!out) return '';
          return out;
        },
      }));
    } catch (e) { diag(`挂 memory context 失败: ${e?.message ?? e}`); }

    // 3b. 账本长期记忆注入（systemPrompt.section，常驻）——按原版 renderFor（核心/约定/性格/事实）
    try {
      offs.push(agent.ctx.systemPrompt.section({
        name: 'long-memory',
        order: 10100,
        interpolate: false,
        text: () => {
          try {
            const users = core.ltm.personView(String(core.userId()), chatKey) ? [String(core.userId())] : [];
            const rendered = core.ltm.renderFor(users, chatKey, { maxChars: 1600 });
            if (!rendered) { diag(`long-memory section: 空（账本无条目）`); return ''; }
            diag(`long-memory section: 注入 len=${rendered.length}`);
            return `【长期记忆 —— 你一直记得的事】\n${rendered}`;
          } catch (e) { diag(`long-memory section 失败: ${e?.message ?? e}`); return ''; }
        },
      }));
    } catch (e) { diag(`挂 long-memory section 失败: ${e?.message ?? e}`); }

    // 4. 人格注入（systemPrompt.section，常驻）
    try {
      offs.push(agent.ctx.systemPrompt.section({
        name: 'persona',
        order: 10150,
        interpolate: false,
        text: () => {
          try {
            const st = core.persona?.console?.status?.();
            const rendered = st?.rendered;
            const coreText = rendered && typeof rendered.core === 'string' ? rendered.core : '';
            diag(`persona section text: persona=${!!core.persona} rendered=${!!rendered} coreLen=${coreText.length}`);
            return coreText ? `【人格】\n${coreText}` : '';
          } catch (e) { diag(`persona section text 异常: ${e?.message ?? e}`); return ''; }
        },
      }));
    } catch (e) { diag(`挂 persona section 失败: ${e?.message ?? e}`); }

    // 5. remember 工具
    try {
      const at = agent.ctx.tools;
      if (at && typeof at.register === 'function') {
        offs.push(at.register(makeRememberTool(ctx, core, sid)));
      }
    } catch (e) { diag(`挂 remember 工具失败: ${e?.message ?? e}`); }

    return offs;
  }

  function 卸掉挂载(entry) {
    for (const off of entry.offs || []) {
      try { if (typeof off === 'function') off(); else off?.off?.(); } catch {}
    }
    entry.offs = [];
  }

  // 扫 agents，每个挂载；agent 实例换了就重挂
  function tick() {
    try {
      const list = ctx.agents?.list?.() ?? [];
      for (const agent of list) {
        const sid = String(agent?.session?.id ?? '');
        if (!sid) continue;
        const 已挂 = mounted.get(sid);
        if (已挂 && 已挂.agent === agent) continue;
        if (已挂) { 卸掉挂载(已挂); mounted.delete(sid); }
        diag(`挂载 ${sid.slice(0, 12)}…`);
        try {
          const offs = mountFor(agent, sid);
          mounted.set(sid, { agent, offs });
        } catch (e) { diag(`挂载失败 ${sid.slice(0, 12)}…: ${e?.message ?? e}`); }
      }
    } catch (e) { diag(`tick 失败: ${e?.message ?? e}`); }
  }

  // 启动 + 定时扫
  tick();
  try {
    ctx.effect(() => ctx.interval(tick, 1000));
  } catch (e) { diag(`定时器不可用: ${e?.message ?? e}`); }

  // 清理
  ctx.effect(() => () => {
    for (const v of mounted.values()) 卸掉挂载(v);
    mounted.clear();
  });

  // ── 控制台设置页路由（最小：健康检查）──
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-web-memory/health',
      handler: async (req, res) => {
        try {
          const ragHealth = core.rag ? await core.rag.health() : null;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            device: core.deviceId(),
            chatKey: core.chatKey(),
            personaKey: core.personaKey(),
            memoryCount: (() => { try { return core.ltm.archiveRows(core.chatKey(), { limit: 100000 }).length; } catch { return 0; } })(),
            persona: (() => {
              try {
                const st = core.persona?.console?.status?.();
                const rendered = st?.rendered;
                const coreText = rendered && typeof rendered.core === 'string' ? rendered.core : '';
                // 性格概览：traitView 是 [{name, value, group}] 数组 → 只取大五（big5）转 {key: value} 便于前端直接展示
                const traits = (st?.traitView || []).filter((t) => t && t.group === 'big5').reduce((o, t) => {
                  if (t && t.name != null && t.value != null) o[t.name] = t.value;
                  return o;
                }, {});
                return { initialized: !!st?.initialized, inject: !!st?.inject, coreLen: coreText.length, role: st?.role ?? null, traits };
              } catch (e) { return { error: String(e?.message ?? e) }; }
            })(),
            // 容器 memory-rag 完整状态（向量索引页用）：store / lag / last_index / job / distill / mismatch
            rag: ragHealth,
            // 记忆服务连接状态：ragHealth 为 null 表示不可达/未启用
            ragOk: !!ragHealth,
            ragChecked: true,
          }));
        } catch (e) {
          try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); } catch {}
        }
      },
    }));
  } catch (e) { diag(`webServer 挂载失败: ${e?.message ?? e}`); }

  // ── 重建索引（设置页按钮）──
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-web-memory/rebuild',
      handler: async (req, res) => {
        try {
          // POST：触发容器全量重建（后台任务，202）；GET：查当前 job 进度
          if (req.method === 'POST') {
            if (!core.rag) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'memory-rag 未启用' })); return; }
            const r = await core.rag.rebuild();
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, job: r?.job ?? null }));
            return;
          }
          if (req.method === 'GET') {
            const health = core.rag ? await core.rag.health() : null;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, job: health?.job ?? null, lastIndex: health?.last_index ?? null }));
            return;
          }
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
        } catch (e) {
          try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); } catch {}
        }
      },
    }));
  } catch (e) { diag(`rebuild API 挂载失败: ${e?.message ?? e}`); }

  // ── 立即索引（增量，设置页按钮）──
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-web-memory/index',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'method not allowed' })); return; }
          if (!core.rag) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'memory-rag 未启用' })); return; }
          const r = await core.rag.indexRun();
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: r ?? null }));
        } catch (e) {
          try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); } catch {}
        }
      },
    }));
  } catch (e) { diag(`index API 挂载失败: ${e?.message ?? e}`); }

  // ── 配置读写（设置页）──
  try {
    // 读配置：脱敏 token（只显示前 4 后 4），返回可编辑结构
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-web-memory/config',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const cfg = loadPluginConfig();
            const token = String(cfg?.memoryRag?.token ?? '');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              config: {
                ownerName: typeof cfg?.ownerName === 'string' && cfg.ownerName.trim() ? cfg.ownerName.trim() : '用户',
                enabled: cfg?.enabled ?? true,
                crossDevice: {
                  userId: cfg?.crossDevice?.userId ?? 'root',
                  deviceId: cfg?.crossDevice?.deviceId ?? '',
                },
                role: {
                  maxInjectChars: cfg?.role?.maxInjectChars ?? 6000,
                },
                memoryRag: {
                  enabled: !!cfg?.memoryRag?.enabled,
                  url: cfg?.memoryRag?.url ?? 'http://127.0.0.1:8093',
                  timeoutMs: cfg?.memoryRag?.timeoutMs ?? 3000,
                  tokenHint: token ? `${token.slice(0, 4)}…${token.slice(-4)}` : '',
                  hasToken: !!token,
                  allowRemote: !!cfg?.memoryRag?.allowRemote,
                  recall: {
                    mode: cfg?.memoryRag?.recall?.mode ?? 'shadow',
                    timeoutMs: cfg?.memoryRag?.recall?.timeoutMs ?? 400,
                  },
                  suggest: {
                    mode: cfg?.memoryRag?.suggest?.mode ?? 'on',
                    perWake: cfg?.memoryRag?.suggest?.perWake ?? 3,
                    maxShows: cfg?.memoryRag?.suggest?.maxShows ?? 2,
                    ttlHours: cfg?.memoryRag?.suggest?.ttlHours ?? 72,
                    timeoutMs: cfg?.memoryRag?.suggest?.timeoutMs ?? 300,
                  },
                },
                decay: {
                  freezeBelow: cfg?.decay?.freezeBelow ?? 0.5,
                  reviewCooldownMs: cfg?.decay?.reviewCooldownMs ?? 3600000,
                },
                lifeLoop: {
                  enabled: !!cfg?.lifeLoop?.enabled,
                  recallPerDay: cfg?.lifeLoop?.recallPerDay ?? 2,
                  cooldownDays: cfg?.lifeLoop?.cooldownDays ?? 7,
                  promiseWake: {
                    enabled: !!cfg?.lifeLoop?.promiseWake?.enabled,
                    at: cfg?.lifeLoop?.promiseWake?.at ?? '10:00',
                    maxPerDay: cfg?.lifeLoop?.promiseWake?.maxPerDay ?? 5,
                  },
                  quiet: cfg?.lifeLoop?.quiet ?? [3, 8],
                  associate: {
                    enabled: !!cfg?.lifeLoop?.associate?.enabled,
                    cooldownDays: cfg?.lifeLoop?.associate?.cooldownDays ?? 7,
                    minAgeDays: cfg?.lifeLoop?.associate?.minAgeDays ?? 2,
                    timeoutMs: cfg?.lifeLoop?.associate?.timeoutMs ?? 1500,
                  },
                },
              },
            }));
            return;
          }
          if (req.method === 'POST') {
            const body = await readBody(req);
            const patch = body?.config ?? {};
            const cfg = loadPluginConfig();
            // 主人称呼（存档 name / 账本 name）：保存后需重启（OWNER_NAME 启动时读）
            if (typeof patch.ownerName === 'string' && patch.ownerName.trim()) cfg.ownerName = patch.ownerName.trim();
            // 只合并可编辑字段，token 为空时保留原值
            if (typeof patch.memoryRag === 'object' && patch.memoryRag) {
              cfg.memoryRag = cfg.memoryRag ?? {};
              if (typeof patch.memoryRag.enabled === 'boolean') cfg.memoryRag.enabled = patch.memoryRag.enabled;
              if (typeof patch.memoryRag.url === 'string' && patch.memoryRag.url.trim()) cfg.memoryRag.url = patch.memoryRag.url.trim();
              if (typeof patch.memoryRag.timeoutMs === 'number') cfg.memoryRag.timeoutMs = patch.memoryRag.timeoutMs;
              if (typeof patch.memoryRag.allowRemote === 'boolean') cfg.memoryRag.allowRemote = patch.memoryRag.allowRemote;
              if (typeof patch.memoryRag.token === 'string' && patch.memoryRag.token.trim()) cfg.memoryRag.token = patch.memoryRag.token.trim();
              if (typeof patch.memoryRag.recall === 'object' && patch.memoryRag.recall) {
                cfg.memoryRag.recall = cfg.memoryRag.recall ?? {};
                if (typeof patch.memoryRag.recall.mode === 'string') cfg.memoryRag.recall.mode = patch.memoryRag.recall.mode;
                if (typeof patch.memoryRag.recall.timeoutMs === 'number') cfg.memoryRag.recall.timeoutMs = patch.memoryRag.recall.timeoutMs;
              }
              if (typeof patch.memoryRag.suggest === 'object' && patch.memoryRag.suggest) {
                cfg.memoryRag.suggest = cfg.memoryRag.suggest ?? {};
                if (typeof patch.memoryRag.suggest.mode === 'string') cfg.memoryRag.suggest.mode = patch.memoryRag.suggest.mode;
                if (typeof patch.memoryRag.suggest.perWake === 'number') cfg.memoryRag.suggest.perWake = patch.memoryRag.suggest.perWake;
                if (typeof patch.memoryRag.suggest.maxShows === 'number') cfg.memoryRag.suggest.maxShows = patch.memoryRag.suggest.maxShows;
                if (typeof patch.memoryRag.suggest.ttlHours === 'number') cfg.memoryRag.suggest.ttlHours = patch.memoryRag.suggest.ttlHours;
                if (typeof patch.memoryRag.suggest.timeoutMs === 'number') cfg.memoryRag.suggest.timeoutMs = patch.memoryRag.suggest.timeoutMs;
              }
            }
            if (typeof patch.crossDevice === 'object' && patch.crossDevice) {
              cfg.crossDevice = cfg.crossDevice ?? {};
              if (typeof patch.crossDevice.userId === 'string' && patch.crossDevice.userId.trim()) cfg.crossDevice.userId = patch.crossDevice.userId.trim();
              if (typeof patch.crossDevice.deviceId === 'string') cfg.crossDevice.deviceId = patch.crossDevice.deviceId.trim();
            }
            if (typeof patch.role === 'object' && patch.role) {
              cfg.role = cfg.role ?? {};
              if (typeof patch.role.maxInjectChars === 'number') cfg.role.maxInjectChars = patch.role.maxInjectChars;
            }
            if (typeof patch.decay === 'object' && patch.decay) {
              cfg.decay = cfg.decay ?? {};
              if (typeof patch.decay.freezeBelow === 'number') cfg.decay.freezeBelow = patch.decay.freezeBelow;
              if (typeof patch.decay.reviewCooldownMs === 'number') cfg.decay.reviewCooldownMs = patch.decay.reviewCooldownMs;
            }
            if (typeof patch.lifeLoop === 'object' && patch.lifeLoop) {
              cfg.lifeLoop = cfg.lifeLoop ?? {};
              if (typeof patch.lifeLoop.enabled === 'boolean') cfg.lifeLoop.enabled = patch.lifeLoop.enabled;
              if (typeof patch.lifeLoop.recallPerDay === 'number') cfg.lifeLoop.recallPerDay = patch.lifeLoop.recallPerDay;
              if (typeof patch.lifeLoop.cooldownDays === 'number') cfg.lifeLoop.cooldownDays = patch.lifeLoop.cooldownDays;
              if (typeof patch.lifeLoop.promiseWake === 'object' && patch.lifeLoop.promiseWake) {
                cfg.lifeLoop.promiseWake = cfg.lifeLoop.promiseWake ?? {};
                if (typeof patch.lifeLoop.promiseWake.enabled === 'boolean') cfg.lifeLoop.promiseWake.enabled = patch.lifeLoop.promiseWake.enabled;
                if (typeof patch.lifeLoop.promiseWake.at === 'string' && patch.lifeLoop.promiseWake.at.trim()) cfg.lifeLoop.promiseWake.at = patch.lifeLoop.promiseWake.at.trim();
                if (typeof patch.lifeLoop.promiseWake.maxPerDay === 'number') cfg.lifeLoop.promiseWake.maxPerDay = patch.lifeLoop.promiseWake.maxPerDay;
              }
              if (Array.isArray(patch.lifeLoop.quiet)) cfg.lifeLoop.quiet = patch.lifeLoop.quiet.filter((n) => typeof n === 'number').slice(0, 2);
              if (typeof patch.lifeLoop.associate === 'object' && patch.lifeLoop.associate) {
                cfg.lifeLoop.associate = cfg.lifeLoop.associate ?? {};
                if (typeof patch.lifeLoop.associate.enabled === 'boolean') cfg.lifeLoop.associate.enabled = patch.lifeLoop.associate.enabled;
                if (typeof patch.lifeLoop.associate.cooldownDays === 'number') cfg.lifeLoop.associate.cooldownDays = patch.lifeLoop.associate.cooldownDays;
                if (typeof patch.lifeLoop.associate.minAgeDays === 'number') cfg.lifeLoop.associate.minAgeDays = patch.lifeLoop.associate.minAgeDays;
                if (typeof patch.lifeLoop.associate.timeoutMs === 'number') cfg.lifeLoop.associate.timeoutMs = patch.lifeLoop.associate.timeoutMs;
              }
            }
            try {
              fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch (e) {
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
            }
            return;
          }
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
        } catch (e) {
          try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); } catch {}
        }
      },
    }));
  } catch (e) { diag(`config API 挂载失败: ${e?.message ?? e}`); }

  // ── 人格提炼（设置页按钮）：propose 从角色卡提炼出厂值，confirm 写入 core ──
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-web-memory/persona/roles',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') { res.writeHead(405, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'method not allowed' })); return; }
          const dir = path.join(PROJECT_ROOT, 'roles');
          let roles = [];
          try { roles = fs.readdirSync(dir).filter((n) => n.endsWith('.md') && !n.startsWith('README')).map((n) => n.slice(0, -3)); } catch {}
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, roles }));
        } catch (e) {
          try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); } catch {}
        }
      },
    }));
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-web-memory/persona/propose',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'method not allowed' })); return; }
          if (!core.persona) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '人格系统未启用' })); return; }
          const body = await readBody(req);
          const f = await core.persona.console.proposeFactory(body?.role);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, factory: f }));
        } catch (e) {
          try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); } catch {}
        }
      },
    }));
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-web-memory/persona/confirm',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'method not allowed' })); return; }
          if (!core.persona) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '人格系统未启用' })); return; }
          const body = await readBody(req);
          const factory = body?.factory;
          if (!factory || typeof factory !== 'object') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '缺少 factory 参数' })); return; }
          const core0 = core.persona.console.confirmFactory(factory, body?.role);
          const rendered = core.persona.console.status()?.rendered;
          const coreText = rendered && typeof rendered.core === 'string' ? rendered.core : '';
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, coreLen: coreText.length, core: core0 }));
        } catch (e) {
          try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); } catch {}
        }
      },
    }));
  } catch (e) { diag(`persona 提炼 API 挂载失败: ${e?.message ?? e}`); }

  // ── 记忆库 / 人格详情（设置页 tab）──
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-web-memory/memory',
      handler: async (req, res) => {
        try {
          res.writeHead(200, { 'content-type': 'application/json' });
          const people = (() => { try { return (core.ltm.listPeople() ?? []).map((p) => ({ userId: p.userId, name: p.name, items: p.items, messages: p.messages, lastSeenAt: p.lastSeenAt })); } catch { return []; } })();
          const personaText = (() => {
            try {
              const st = core.persona?.console?.status?.();
              const rendered = st?.rendered;
              return rendered && typeof rendered.core === 'string' ? rendered.core : '';
            } catch { return ''; }
          })();
          const archiveLimit = (() => {
            try {
              const q = new URL(req.url ?? '/', 'http://x').searchParams.get('limit');
              const n = Number(q);
              return Number.isFinite(n) && n > 0 ? Math.min(500, Math.floor(n)) : 30;
            } catch { return 30; }
          })();
          const archive = (() => { try { return core.ltm.archiveRows(core.chatKey(), { limit: archiveLimit }); } catch { return []; } })();
          res.end(JSON.stringify({ ok: true, people, personaText, archiveCount: archive.length, archive }));
        } catch (e) {
          try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); } catch {}
        }
      },
    }));
  } catch (e) { diag(`memory API 挂载失败: ${e?.message ?? e}`); }

  // ── 记忆星图（实体 / 关系 / 摘要）──
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-web-memory/graph',
      handler: async (req, res) => {
        try {
          const q = new URL(req.url ?? '/', 'http://x').searchParams;
          const key = String(q.get('key') ?? '') || core.chatKey();
          const entityLimit = Math.max(1, Math.min(1000, Number(q.get('entity_limit') || 300) || 300));
          const summaryLimit = Math.max(1, Math.min(1000, Number(q.get('summary_limit') || 300) || 300));
          if (!core.rag) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'memory-rag 未启用' })); return; }
          const g = await core.rag.graph({ key, entityLimit, summaryLimit });
          if (!g) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '容器 /graph 无返回' })); return; }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, key, entities: g.entities, relations: g.relations, summaries: g.summaries }));
        } catch (e) {
          try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); } catch {}
        }
      },
    }));
  } catch (e) { diag(`graph API 挂载失败: ${e?.message ?? e}`); }

  // ── 记忆星图 HTML（独立页，iframe 加载）──
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-web-memory/map',
      handler: (req, res) => {
        try {
          const file = path.join(PLUGIN_ROOT, 'static', 'memory-brain-map.html');
          if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('星图 HTML 不存在'); return; }
          const html = fs.readFileSync(file, 'utf8');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(html);
        } catch (e) {
          try { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('星图读取失败: ' + String(e?.message ?? e)); } catch {}
        }
      },
    }));
  } catch (e) { diag(`map API 挂载失败: ${e?.message ?? e}`); }
}
