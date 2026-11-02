// life-loop.js · 「生活回路」Web 简化版
// 干什么：主动唤醒 —— ① 到期约定提醒（promiseWake）② 忽然想起（chat:root 账本/archive 简单版）。
// Web 版去掉 QQ 专属（ownerQQ/private/group、diaryDir、associate 联想链）：
//   到期约定用 ltm.duePromises(day)，deliverPromiseWake 由插件注入（agent.followup 推 Web 会话）。
import fs from 'node:fs';
import path from 'node:path';

const HOUR = 3600000;
const DAY = 86400000;
const HISTORY_MAX = 50;

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hhmm(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function createLifeLoop({
  ltm,
  statePath,
  deliverPromiseWake,
  isAllowed = () => true,
  options = {},
  now = () => Date.now(),
  log = () => {},
}) {
  if (!ltm) throw new Error('life-loop: 缺 ltm');
  if (!statePath) throw new Error('life-loop: 缺 statePath');

  const quiet = normalizeQuiet(options.quiet);
  const promiseWake = {
    enabled: options.promiseWake?.enabled !== false,
    at: /^\d{2}:\d{2}$/.test(String(options.promiseWake?.at ?? '')) ? String(options.promiseWake.at) : '10:00',
    maxPerDay: Math.max(0, Number(options.promiseWake?.maxPerDay ?? 5)),
  };

  const emptyState = () => ({ version: 1, promiseWakes: { day: '', users: [] }, history: [] });
  let state = emptyState();
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      state = { ...emptyState(), ...raw };
      const pw = raw.promiseWakes && typeof raw.promiseWakes === 'object' ? raw.promiseWakes : {};
      state.promiseWakes = { day: String(pw.day ?? ''), users: Array.isArray(pw.users) ? pw.users.map(String) : [] };
      state.history = Array.isArray(raw.history) ? raw.history.filter((h) => h && typeof h === 'object').slice(-HISTORY_MAX) : [];
    }
  } catch { /* 文件坏了：空状态 */ }

  function saveNow() {
    try {
      state.history = state.history.slice(-HISTORY_MAX);
      fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
      const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, statePath);
    } catch (e) { log(`状态写不进去（忽略）：${e?.message ?? e}`); }
  }

  function inQuiet(ts) {
    const h = new Date(ts).getHours();
    return h >= quiet[0] && h < quiet[1];
  }

  function promiseWakeText(userId, items) {
    const lines = items.map((it) => {
      const by = it.by === 'me' ? '你答应的' : it.by === 'them' ? '他答应的' : '约定';
      return `- ${it.text}（${by}）〔${it.id}〕`;
    });
    return [
      '【到期的约定】今天是你和用户说好的日子：',
      ...lines,
      '想提就自然地提一句（别像闹钟一样念），也可以等他来找你再说；他在忙或不方便就别打扰。',
      '确认兑现了、没兑现、不做了，用 mem_remember 更新（标 status：done / missed / cancelled）。',
    ].join('\n');
  }

  let notAllowedLogged = new Set();

  async function tick(t = now()) {
    try {
      if (!promiseWake.enabled) return;
      const at = Number(t) || now();
      const today = dayKey(at);
      if (state.promiseWakes.day !== today) {
        state.promiseWakes = { day: today, users: [] };
        notAllowedLogged = new Set();
        saveNow();
      }
      if (hhmm(at) < promiseWake.at) return;
      if (inQuiet(at)) return;

      let due = [];
      try { due = ltm.duePromises?.(today) ?? []; } catch (e) { log(`读到期约定失败：${e?.message ?? e}`); return; }
      const entries = [...due].sort((a, b) => String(a?.userId ?? '').localeCompare(String(b?.userId ?? '')));

      for (const entry of entries) {
        const userId = String(entry?.userId ?? '');
        if (!userId) continue;
        const viewerKey = 'chat:root';
        let items = [];
        try { items = (entry.items ?? []).filter((it) => ltm.visibleTo?.(it, viewerKey)); } catch { items = []; }
        if (!items.length) continue;
        if (state.promiseWakes.users.includes(userId)) continue;
        if (state.promiseWakes.users.length >= promiseWake.maxPerDay) return;

        let allowed = false;
        try { allowed = !!isAllowed(viewerKey); } catch { allowed = false; }
        if (!allowed) {
          if (!notAllowedLogged.has(userId)) { notAllowedLogged.add(userId); log(`到期唤醒跳过（不允许）：${userId}`); }
          continue;
        }

        state.promiseWakes.users.push(userId);
        saveNow();
        try {
          await deliverPromiseWake(viewerKey, promiseWakeText(userId, items));
          log(`到期唤醒已投递：${userId}（${items.length} 条）`);
        } catch (e) { log(`到期唤醒投递失败：${userId} · ${e?.message ?? e}`); }
        state.history.push({ at, kind: 'promise-wake', userId, items: items.length });
        saveNow();
      }
    } catch (e) { log(`tick 失败：${e?.message ?? e}`); }
  }

  function snapshot() {
    try {
      return { promiseWakes: state.promiseWakes, history: state.history.slice(-10) };
    } catch { return null; }
  }

  function start() {
    // 每分钟 tick 一次（对齐原版），只跑到期约定检查。
    setInterval(() => { tick().catch(() => {}); }, 60000).unref?.();
    // 启动先跑一次（补上错过的时间窗口）。
    tick().catch(() => {});
  }

  return { tick, snapshot, start, promiseWakeText };
}

function normalizeQuiet(raw) {
  const q = Array.isArray(raw) ? raw.map(Number).filter(Number.isFinite) : [];
  return [Number(q[0]) || 0, Number(q[1]) || 8];
}

export default createLifeLoop;
