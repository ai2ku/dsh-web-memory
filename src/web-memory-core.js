// web-memory-core.js · 记忆 + 人格核心的独立工厂（从 bridge.js 剥离）
//
// 目的：把「记忆系统 + 人格系统」从 QQ 桥接里拆出来，做成一个不依赖 bridge 闭包的
//       纯工厂。DSH Web 原生插件（dsh-web-memory）用它实例化记忆/人格模块，挂在
//       agent.ctx 上，直接监听 Web 会话事件。
//
// 设计：
//   - createWebMemoryCore({ root, stateDir, configFile, log, ... }) 返回
//     { ltm, rag, decay, ledgerSuggest, persona, dailyReport, ragControl, apiHub, deviceId, chatKey, personaKey }
//   - 所有模块都是现有的（long-memory / persona / memory-rag-client / ...），这里只负责
//     用正确的运行上下文实例化它们，不改它们内部逻辑。
//   - 设备标识：crossDevice.deviceId 可配置，默认 os.hostname() 清洗成 [\w-]+。
//   - 跨设备共享（做法 B）：记忆 key = chat:{userId}（可配，默认 root），
//     每条存档带 device:{deviceId} 标注来源。persona key = persona:{userId}。
//
// 依赖说明：本文件从 bridge.js 复制了 readJsonSafe / readConfigObject / atomicWriteJson /
//   renameWithRetry / atomicWriteText / readRoleState / writeRoleState 等纯工具函数，
//   不依赖 bridge 的任何闭包变量。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLongMemory } from './long-memory.js';
import { createMemoryDecay } from './memory-decay.js';
import { createMemoryRagClient, normalizeDateRange, normalizeKeywords } from './memory-rag-client.js';
import { createLedgerSuggest } from './ledger-suggest.js';
import { createPersona } from './persona.js';
import { renderCore } from './persona-state.js';
import { createDailyReport } from './daily-report.js';
import { createRagControl } from './rag-control.js';
import { createApiHub } from './api-hub.js';
import { createTokenLedger } from './token-ledger.js';
import { resolvePriceTable } from './model-prices.js';
import { readEmbeddingKind } from './api-hub.js';

// ── 纯工具函数（从 bridge.js 复制，不依赖闭包）─────────────────────────────

/** 读 JSON 文件，失败返回 fallback（或抛错）。 */
export function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

/** 读取 config.json，保证拿到可安全改写的普通对象。 */
export function readConfigObject(file) {
  const parsed = readJsonSafe(file, null, true);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
    throw new Error(`config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`);
  }
  return parsed;
}

/** 原子替换（Windows EPERM 退避）。 */
function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch {}
    }
  }
  throw lastError;
}

/** 原子写 JSON 文件。 */
export function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// ── 配置读取（从 bridge.js 的 loadConfig 语义）───────────────────────────

/** 读 config.json 顶层（不抛错，失败返回 {}）。 */
function readTopConfig(configFile) {
  try { return readJsonSafe(configFile, null) ?? {}; } catch { return {}; }
}

/** 跨端共享用户标识：config.json crossDevice.userId，默认 'root'。 */
export function crossUserId(configFile) {
  try {
    const c = readJsonSafe(configFile, null);
    const u = c?.crossDevice?.userId;
    return (typeof u === 'string' && u.trim()) ? u.trim() : 'root';
  } catch { return 'root'; }
}

/** 本机设备标识：crossDevice.deviceId 可配置；默认 hostname 清洗成 [\w-]+。 */
export function deviceId(configFile) {
  try {
    const c = readJsonSafe(configFile, null);
    const d = c?.crossDevice?.deviceId;
    if (typeof d === 'string' && d.trim()) return d.trim().replace(/[^\w-]/g, '-');
  } catch { /* 落到默认 */ }
  const h = os.hostname() || 'device';
  return h.replace(/[^\w-]/g, '-').slice(0, 48) || 'device';
}

/** 记忆 key：跨设备共享（做法 B）= chat:{userId}。 */
export function chatKey(configFile) {
  return `chat:${crossUserId(configFile)}`;
}

/** 人格 key：persona:{userId}。 */
export function personaKey(configFile) {
  return `persona:${crossUserId(configFile)}`;
}

/** 设备能力 key：device:{deviceId}。 */
export function deviceKey(configFile) {
  return `device:${deviceId(configFile)}`;
}

// DECAY_FIX：模块级引用（createWebMemoryCore 里赋值），模块级 ltmDecayState 靠它访问 decay 实例。
let decayRef = null;

// ── 核心工厂 ─────────────────────────────────────────────────────────────

/**
 * 创建记忆 + 人格核心。
 *
 * @param {Object} opts
 * @param {string} opts.root          项目根目录（含 config.json / roles/）
 * @param {string} opts.stateDir      state 目录
 * @param {string} opts.configFile    config.json 路径（默认 root/config.json）
 * @param {(s:string)=>string} opts.redact  文本脱敏（默认原样）
 * @param {(s:string)=>void} opts.log      日志函数（默认 console.error）
 * @param {Object} opts.hooks
 * @param {(info:Object)=>void} [opts.hooks.onPromiseClosed]  约定关闭回调
 * @param {(info:Object)=>void} [opts.hooks.onWeeklyReport]   周报回调
 * @param {(info:Object)=>void} [opts.hooks.onCoreChange]     人格 core 变化回调
 * @param {()=>Object} [opts.hooks.getSessions]  当前会话表（默认 ()=>({})）
 * @param {()=>Array}  [opts.hooks.getPeopleStats] 人物统计（默认 ltm.listPeople）
 */
export function createWebMemoryCore(opts = {}) {
  const root = opts.root ?? process.cwd();
  const stateDir = opts.stateDir ?? path.join(root, 'state');
  const configFile = opts.configFile ?? path.join(root, 'config.json');
  const log = opts.log ?? ((s) => console.error(s));
  const redact = opts.redact ?? ((s) => s);
  const hooks = opts.hooks ?? {};

  // 运行上下文：deviceId / userId / keys（每次现读，支持配置热重载）
  const ctx = {
    root, stateDir, configFile, log, redact,
    deviceId: () => deviceId(configFile),
    userId: () => crossUserId(configFile),
    chatKey: () => chatKey(configFile),
    personaKey: () => personaKey(configFile),
    deviceKey: () => deviceKey(configFile),
    readTop: () => readTopConfig(configFile),
  };

  // ── 记忆代谢（遗忘曲线）──
  let decay = null;
  try {
    const decayFileCfg = readJsonSafe(configFile, null)?.decay ?? {};
    decay = createMemoryDecay({
      statePath: path.join(stateDir, 'memory-decay.json'),
      options: decayFileCfg,
      log,
      // 记忆全存容器：memory-decay.json 走容器存储（惰性绑定 rag）
      fileClient: {
        fileRead: (...a) => (rag ? rag.fileRead(...a) : null),
        fileWrite: (...a) => (rag ? rag.fileWrite(...a) : null),
        fileAppend: (...a) => (rag ? rag.fileAppend(...a) : null),
        fileDelete: (...a) => (rag ? rag.fileDelete(...a) : null),
        fileList: (...a) => (rag ? rag.fileList(...a) : null),
      },
      relPath: 'memory-decay.json',
    });
  } catch (error) {
    log(`⚠️ 遗忘模块未启用：${error?.message ?? error}`);
  }
  decayRef = decay; // DECAY_FIX：模块级引用，让模块级 ltmDecayState 能访问到

  // ── 长期记忆（存档 + 人物账本）──
  // 记忆全存容器：fileClient 惰性绑定 rag（容器存储），ltm 的持久化走容器。
  // rag 在下方创建（let rag），闭包在调用时能拿到已赋值的 rag。
  const ltm = createLongMemory({
    stateDir: path.join(stateDir, 'long-memory'),
    redact,
    log,
    onPromiseClosed: (info) => {
      try { hooks.onPromiseClosed?.(info); } catch {}
    },
    decayOf: decay
      ? (item, uid) => {
        try {
          const st = ltmDecayState(item, uid, crossUserId(configFile));
          return st ? { R: st.R, frozen: st.frozen } : null;
        } catch { return null; }
      }
      : null,
    fileClient: {
      fileRead: (...a) => (rag ? rag.fileRead(...a) : null),
      fileWrite: (...a) => (rag ? rag.fileWrite(...a) : null),
      fileAppend: (...a) => (rag ? rag.fileAppend(...a) : null),
      fileDelete: (...a) => (rag ? rag.fileDelete(...a) : null),
      fileList: (...a) => (rag ? rag.fileList(...a) : null),
    },
  });

  // ── memory-rag 客户端（跨设备后端）──
  const ragFileCfg = readJsonSafe(configFile, null)?.memoryRag ?? {};
  let ragControl = null;
  let rag = null;
  try {
    rag = createMemoryRagClient({
      url: ragFileCfg.url,
      timeoutMs: ragFileCfg.timeoutMs,
      recallTimeoutMs: ragFileCfg.recall?.timeoutMs,
      token: ragFileCfg.token,
      allowRemote: ragFileCfg.allowRemote === true,
      isEnabled: () => (ragControl ? ragControl.enabled() === true : false),
      log
    });
  } catch (error) {
    log(`⚠️ memory-rag 客户端未启用：${error?.message ?? error}`);
    rag = null;
  }

  // 记忆全存容器：异步预载 people + archive + decay 到内存缓存（等 ragControl 就绪后，见下方）

  // ── RAG 总开关 ──
  try {
    const embeddingKindOf = readEmbeddingKind({ root, stateDir });
    ragControl = createRagControl({
      root,
      stateDir,
      runDir: process.env.QQB_RUN_DIR || path.join(os.homedir(), '.ai-companion-run'),
      readEnabled: () => ragFileCfg.enabled === true,
      writeEnabled: (value) => {
        const file = readConfigObject(configFile);
        file.memoryRag = { ...(file.memoryRag && typeof file.memoryRag === 'object' ? file.memoryRag : {}), enabled: value === true };
        atomicWriteJson(configFile, file);
      },
      rag,
      embeddingKind: embeddingKindOf,
      log,
      now: Date.now
    });
  } catch (error) {
    log(`⚠️ RAG 总开关未启用：${error?.message ?? error}`);
    ragControl = null;
  }

  // 记忆全存容器：ragControl 就绪后异步预载 people + archive + decay（此时 enabled() 才生效）
  try { ltm.loadFromRemote().catch(() => {}); } catch {}
  try { decay?.loadFromRemote?.().catch(() => {}); } catch {}

  // ── 账本建议 ──
  let ledgerSuggest = null;
  try {
    const suggestFileCfg = readJsonSafe(configFile, null)?.memoryRag?.suggest ?? {};
    ledgerSuggest = createLedgerSuggest({
      rag, ltm,
      statePath: path.join(stateDir, 'long-memory', 'suggest-state.json'),
      config: suggestFileCfg,
      log,
      // 记忆全存容器：suggest-state.json 走容器存储（惰性绑定 rag）
      fileClient: {
        fileRead: (...a) => (rag ? rag.fileRead(...a) : null),
        fileWrite: (...a) => (rag ? rag.fileWrite(...a) : null),
        fileAppend: (...a) => (rag ? rag.fileAppend(...a) : null),
        fileDelete: (...a) => (rag ? rag.fileDelete(...a) : null),
        fileList: (...a) => (rag ? rag.fileList(...a) : null),
      },
      relPath: 'long-memory/suggest-state.json',
    });
    ledgerSuggest.loadFromRemote?.().catch(() => {});
  } catch (error) {
    log(`⚠️ 账本建议模块未启用：${error?.message ?? error}`);
    ledgerSuggest = null;
  }

  // ── 人格系统 ──
  let persona = null;
  try {
    persona = createPersona({
      stateDir: path.join(stateDir, 'persona'),
      roleName: () => readRoleState(root).role || 'default',
      roleCard: (name) => {
        try { return fs.readFileSync(path.join(root, 'roles', `${path.basename(String(name))}.md`), 'utf8'); } catch { return ''; }
      },
      sessions: hooks.getSessions ?? (() => ({})),
      ownerQQ: () => crossUserId(configFile),  // 主人 = 单用户 userId（默认 root），不再读旧 ownerQQ（QQ 已去除）
      peopleStats: hooks.getPeopleStats ?? (() => ltm.listPeople()),
      redact,
      log,
      onWeeklyReport: (report) => { try { hooks.onWeeklyReport?.(report); } catch {} },
      onCoreChange: ({ role, core }) => {
        try {
          if (!rag || !core) return;
          const text = `【人格快照】${role}\n${renderCore(core)}`;
          rag.indexText({ key: ctx.personaKey(), text }).catch(() => {});
        } catch (e) { log(`[persona] 同步 persona:${ctx.userId()} 失败：${e?.message ?? e}`); }
      },
      // 记忆全存容器：persona 数据（config/live/usage/history/reports）走容器存储
      fileClient: {
        fileRead: (...a) => (rag ? rag.fileRead(...a) : null),
        fileWrite: (...a) => (rag ? rag.fileWrite(...a) : null),
        fileAppend: (...a) => (rag ? rag.fileAppend(...a) : null),
        fileDelete: (...a) => (rag ? rag.fileDelete(...a) : null),
        fileList: (...a) => (rag ? rag.fileList(...a) : null),
      }
    });
    persona.start();
  } catch (error) {
    log(`⚠️ 人格与情绪模块未启用：${error?.message ?? error}`);
    persona = null;
  }

  // ── 每日报表 ──
  let dailyReport = null;
  try {
    dailyReport = createDailyReport({
      stateDir,
      getLive: () => ({ ltmTotals: ltmTotals(ltm) }),
      log
    });
  } catch (error) {
    log(`⚠️ 每日报表模块未启用：${error?.message ?? error}`);
    dailyReport = null;
  }

  // ── API 管理（密钥/向量模型测试）──
  let apiHub = null;
  try {
    apiHub = createApiHub({
      root, stateDir,
      getPersonaConsole: () => (persona ? persona.console : null),
      ragControl, rag,
      readConfigObject: (f) => readConfigObject(f),
      atomicWriteJson: (f, obj) => atomicWriteJson(f, obj),
      log,
      now: Date.now,
    });
  } catch (error) {
    log(`⚠️ API 管理模块未启用：${error?.message ?? error}`);
    apiHub = null;
  }

  // 返回核心实例
  return {
    ctx, ltm, rag, ragControl, decay, ledgerSuggest, persona, dailyReport, apiHub,
    root, stateDir,
    deviceId: ctx.deviceId,
    userId: ctx.userId,
    chatKey: ctx.chatKey,
    personaKey: ctx.personaKey,
    deviceKey: ctx.deviceKey,
    normalizeDateRange, normalizeKeywords,
    renderCore,
  };
}

// ── 内部辅助 ─────────────────────────────────────────────────────────────

/** 账本现状（daily-report 用口径）：总/冻结/已过时。 */
function ltmTotals(ltm) {
  try {
    let total = 0, faded = 0, outdated = 0;
    for (const p of ltm.listPeople()) {
      const active = (ltm.personView(p.userId)?.items ?? []).filter((x) => !x.archivedAt);
      total += active.length;
      faded += active.filter((x) => !x.outdatedAt && ltmDecayState(x, p.userId, p.userId)?.frozen).length;
      outdated += active.filter((x) => x.outdatedAt).length;
    }
    return { total, faded, outdated };
  } catch { return null; }
}

/** 从 ltmDecayState 读记忆代谢状态（bridge.js 原本的实现，简化版）。 */
function ltmDecayState(item, uid, ownerQQ) {
  try {
    // DECAY_FIX：原项目直接调 decay.state() 实时算 R/frozen，不是读 item._decay（那字段从没被赋值，导致遗忘一直不生效）。
    const d = decayRef;
    if (!d || !item || item.id == null) return null;
    const meta = d.ltmMeta(item, { ownerQQ: ownerQQ != null ? ownerQQ : null, userId: String(uid ?? ''), intimacy: undefined });
    const st = d.state('ltm:' + item.id, meta);
    return st && typeof st === 'object' ? st : null;
  } catch { return null; }
}

/** 读角色状态（current-role.json）。 */
function readRoleState(root) {
  const file = path.join(root, 'state', 'current-role.json');
  return readJsonSafe(file, { role: null, mode: 'active' });
}
