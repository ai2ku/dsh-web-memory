// persona-store.js · 人格与情绪的文件存储（PERSONA_PATCH）
//
// 布局（docs/design/PERSONA_MIND_PLAN.md §5.7，实施细化见 PERSONA_IMPL_PLAN.md）：
//   state/persona/config.json            设置 + 判读密钥（600；控制台只回显提示，不回显原文）
//   state/persona/live.json              给 DSH 插件读的快照（按 DSH 会话 ID 索引）
//   state/persona/usage.json             判读用量（按天 × 每次运行；PERSONA_PATCH §6-1）
//   state/persona/<角色>/core.json        大五与自我信念
//   state/persona/<角色>/people.json      每个 用户标识的关系、偏移、信念
//   state/persona/<角色>/emotion.json     core / scenes / labels / history
//   state/persona/<角色>/meta.json        夜间结算、主动表达计数等杂项
//   state/persona/<角色>/evidence.jsonl   养成证据（不存原文）
//   state/persona/<角色>/appraisals/<会话>/<YYYY-MM>.jsonl  判读日志（不存原文）
//   state/persona/<角色>/history/YYYY-MM-DD.json            每晚快照
//   state/persona/<角色>/reports/YYYY-Www.md                周报
// 目录 700、文件 600，写入一律原子替换。
import fs from 'node:fs';
import path from 'node:path';

export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  return dir;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
}

const keyDir = (key) => String(key ?? '').replace(':', '_').replace(/[^\w-]/g, '_');
const safeRole = (role) => String(role || 'default').replace(/[\\/:*?"<>|\s.]+/g, '_') || 'default';

export function createPersonaStore({ rootDir, fileClient = null, relBase = '' }) {
  // 记忆全存容器：fileClient 时数据走容器，不需要本地目录（避免重建空的 state/persona）。
  if (!fileClient) ensureDir(rootDir);
  const CONFIG = path.join(rootDir, 'config.json');
  // PERSONA_PATCH（§6-1）：全局一份，不分角色——判读器和密钥都是全局的。
  const USAGE = path.join(rootDir, 'usage.json');
  const LIVE = path.join(rootDir, 'live.json');
  const roleDir = (role) => (fileClient ? path.join(rootDir, safeRole(role)) : ensureDir(path.join(rootDir, safeRole(role))));
  const file = (role, name) => path.join(roleDir(role), name);

  // ── 记忆全存容器：fileClient 提供容器存储，本地 fs 降级 ──
  // relOf：state 相对路径（如 persona/config.json）。fileClient 时写/读容器。
  const relOf = (f) => {
    const rel = path.relative(rootDir, f).split(path.sep).join('/');
    return relBase ? `${relBase}/${rel}` : rel;
  };
  const fileCache = new Map(); // rel → content（内存缓存，同步读；写后同步更新）
  const storeRead = (f, fallback) => {
    if (fileClient) {
      const rel = relOf(f);
      if (fileCache.has(rel)) {
        try { return JSON.parse(fileCache.get(rel).replace(/^\uFEFF/, '')); } catch { return fallback; }
      }
      return fallback;
    }
    return readJson(f, fallback);
  };
  const storeWrite = (f, data) => {
    if (fileClient) {
      fileCache.set(relOf(f), data);
      Promise.resolve(fileClient.fileWrite(relOf(f), data)).catch(() => {});
    } else {
      writeFileAtomic(f, data);
    }
  };
  const storeAppend = (f, row) => {
    const line = JSON.stringify(row) + '\n';
    if (fileClient) {
      const rel = relOf(f);
      fileCache.set(rel, (fileCache.get(rel) ?? '') + line);
      Promise.resolve(fileClient.fileAppend(rel, line)).catch(() => {});
    } else {
      appendJsonl(f, row);
    }
  };
  // 从容器预载核心文件到内存缓存（异步；未加载完成时同步读降级 fallback）。
  let loaded = false;
  const loadFromRemote = async () => {
    if (!fileClient) return;
    try {
      const want = [CONFIG, USAGE, LIVE];
      for (const f of want) {
        const rel = relOf(f);
        const r = await fileClient.fileRead(rel);
        if (r && r.data && r.data.found) fileCache.set(rel, r.data.content);
      }
      // 角色状态分片（core/people/emotion/meta）——枚举 persona 下的角色目录
      const pr = await fileClient.fileList(relBase || 'persona');
      if (pr && pr.data && pr.data.found) {
        for (const ent of (pr.data.entries || [])) {
          if (!ent.is_dir) continue;
          const role = safeRole(ent.name);
          for (const part of ['core', 'people', 'emotion', 'meta']) {
            const rf = file(role, `${part}.json`);
            const rel = relOf(rf);
            const r = await fileClient.fileRead(rel);
            if (r && r.data && r.data.found) fileCache.set(rel, r.data.content);
          }
        }
      }
    } catch { /* 预载失败不阻塞 */ } finally { loaded = true; }
  };

  return {
    rootDir,
    isLoaded: () => loaded,
    readConfig: () => storeRead(CONFIG, {}),
    writeConfig: (c) => storeWrite(CONFIG, JSON.stringify(c, null, 2) + '\n'),

    /** 读一个角色的全部状态；core 为 null 表示出厂值还没确认（未初始化）。 */
    load(role) {
      return {
        core: storeRead(file(role, 'core.json'), null),
        people: storeRead(file(role, 'people.json'), {}),
        emotion: storeRead(file(role, 'emotion.json'), null),
        meta: storeRead(file(role, 'meta.json'), {})
      };
    },
    save(role, part, value) {
      if (!['core', 'people', 'emotion', 'meta'].includes(part)) throw new Error(`未知的状态分片：${part}`);
      storeWrite(file(role, `${part}.json`), JSON.stringify(value, null, part === 'emotion' ? 0 : 2) + '\n');
    },

    appendEvidence: (role, row) => storeAppend(file(role, 'evidence.jsonl'), row),
    readEvidence(role, sinceMs = 0) {
      let text = '';
      if (fileClient) {
        // 记忆全存容器：从内存缓存读（appendEvidence 已更新缓存）；未加载返回空
        const rel = relOf(file(role, 'evidence.jsonl'));
        text = fileCache.get(rel) ?? '';
      } else {
        try { text = fs.readFileSync(file(role, 'evidence.jsonl'), 'utf8'); } catch { return []; }
      }
      const out = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        try { const r = JSON.parse(line); if (Number(r.at) >= sinceMs) out.push(r); } catch {}
      }
      return out;
    },

    appendAppraisal(role, key, row) {
      const d = new Date(row.at ?? Date.now());
      const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      storeAppend(path.join(roleDir(role), 'appraisals', keyDir(key), `${month}.jsonl`), row);
    },

    // LIFE_LOOP_PATCH（规格 §7.2）：生活回路要按 msgId 取判读显著度，决定哪句话值得「忽然想起」。
    // 判读日志按月分文件：从 sinceMs 所在月开始读到最新的月份文件（不按「现在」截断，避免时钟偏差漏读）；
    // sinceMs 为 0 时读全部。坏行跳过，不炸整本。
    readAppraisals(role, key, { sinceMs = 0 } = {}) {
      const dir = path.join(roleDir(role), 'appraisals', keyDir(key));
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort(); } catch { return []; }
      const since = Number(sinceMs) || 0;
      const sinceMonth = since > 0 ? `${new Date(since).getFullYear()}-${String(new Date(since).getMonth() + 1).padStart(2, '0')}` : '';
      const out = [];
      for (const n of names) {
        if (sinceMonth && n.slice(0, 7) < sinceMonth) continue;
        let text = '';
        try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
          if (!line) continue;
          try {
            const r = JSON.parse(line);
            if (Number(r.at) >= since) out.push(r);
          } catch { /* 坏行跳过 */ }
        }
      }
      return out;
    },

    // PERSONA_PATCH（§6-1）：判读用量。按「天 × 每次运行」分开存，读的时候手算总和；
    // 同一天的几次运行（桥接重启）因此不会互相覆盖。坏数据一律退回空表，不让用量把控制台带崩。
    readUsage() {
      const u = storeRead(USAGE, null);
      const plain = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
      if (!plain(u) || !plain(u.days)) return { version: 1, days: {} };
      return u;
    },
    writeUsage: (obj) => storeWrite(USAGE, JSON.stringify(obj) + '\n'),

    // PERSONA_PATCH（§6-1）：按天统计判读日志（所有会话目录一起算），给控制台对照「日志里到底判读了几次」。
    // 只统计 at >= sinceMs 的行；日期用本地日历（算法同 persona-state.js 的 dayOf，这里内联，store 不多依赖一层）。
    appraisalDayCounts(role, sinceMs = 0) {
      const base = path.join(roleDir(role), 'appraisals');
      const since = Number(sinceMs) || 0;
      // 判读日志按月分文件：sinceMs > 0 时只读它所在月份及以后的文件（写法同 readAppraisals）。
      // 否则每次控制台刷新都要把每个会话目录下所有月份读一遍，一年后会读十几个文件。
      const sinceMonth = since > 0 ? `${new Date(since).getFullYear()}-${String(new Date(since).getMonth() + 1).padStart(2, '0')}` : '';
      let dirs = [];
      try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return {}; }
      const dayKey = (ms) => {
        const d = new Date(ms);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      const out = {};
      for (const dir of dirs) {
        let names = [];
        try { names = fs.readdirSync(path.join(base, dir)).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)); } catch { continue; }
        for (const name of names) {
          if (sinceMonth && name.slice(0, 7) < sinceMonth) continue;
          let text = '';
          try { text = fs.readFileSync(path.join(base, dir, name), 'utf8'); } catch { continue; }
          for (const line of text.split('\n')) {
            if (!line) continue;
            let r = null;
            try { r = JSON.parse(line); } catch { continue; } // 坏行跳过
            const at = Number(r?.at);
            if (!Number.isFinite(at) || at < since) continue;
            const c = (out[dayKey(at)] ??= { model: 0, rules: 0 });
            if (r.source === 'model') c.model += 1; else c.rules += 1;
          }
        }
      }
      return out;
    },

    writeSnapshot: (role, day, obj) => storeWrite(path.join(roleDir(role), 'history', `${day}.json`), JSON.stringify(obj, null, 2) + '\n'),
    readSnapshot: (role, day) => storeRead(path.join(roleDir(role), 'history', `${String(day).replace(/[^\d-]/g, '')}.json`), null),
    listSnapshots(role) {
      try { return fs.readdirSync(path.join(roleDir(role), 'history')).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).map((n) => n.slice(0, 10)).sort(); } catch { return []; }
    },

    writeReport: (role, name, md) => {
      const f = path.join(roleDir(role), 'reports', `${name}.md`);
      if (fileClient) { fileCache.set(relOf(f), md); Promise.resolve(fileClient.fileWrite(relOf(f), md)).catch(() => {}); }
      else writeFileAtomic(f, md);
    },
    readReport(role, name) {
      const f = path.join(roleDir(role), 'reports', `${String(name).replace(/[^\w-]/g, '')}.md`);
      if (fileClient) {
        const rel = relOf(f);
        if (fileCache.has(rel)) return fileCache.get(rel);
        return '';
      }
      try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
    },
    listReports(role) {
      try { return fs.readdirSync(path.join(roleDir(role), 'reports')).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)).sort(); } catch { return []; }
    },

    liveFile: LIVE,
    writeLive: (obj) => storeWrite(LIVE, JSON.stringify(obj) + '\n'),
    loadFromRemote
  };
}
