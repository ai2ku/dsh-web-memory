// memory-rag-client.js · memory-rag 索引服务（:8093）的薄客户端
//
// 为什么单独成模块：桥接只管「问一句、拿到原文片段」，超时、参数校验、字段剥离
// 和降级判断都收在这里。检索失败一律返回 null，由桥接退回本地关键词检索
// （RAG_MEMORY_PLAN §7「故障与降级」）。
//
// 安全边界：查询里带的是**当前会话的聊天原文**，所以只允许连回环地址；
// 返回给 AI 的字段也做了白名单，`file` / `line_*` / `ids` / `score` 这类内部字段
// 一律不往外带（避免绝对路径触发出站审计，见 CLAUDE.md 坑 6）。
// DECAY_PATCH：`refs` 只给桥接内部用（检索命中映射回存档行），桥接不得把它发给 AI；
// 它被定义成不可枚举属性，所以 `JSON.stringify(search())` 也不会把它带出去。
const KEY_RE = /^(group|private|persona|chat|device):[\w-]+$/;
const DEFAULT_URL = 'http://127.0.0.1:8093';
const DEFAULT_TIMEOUT_MS = 3000;
const MAX_QUERY_CHARS = 500;
const MAX_KEYWORD_CHARS = 40;
const MAX_KEYWORDS = 12;
// RAG_PATCH（P3）：自动想起 / 联想链 / 控制台查摘要的超时与上限（规格 §9.1、接口约定 C2）。
// /recall 在唤醒路径上（mode=on 时会 await），所以默认只给 400 ms：超时就当没想起来，唤醒照常。
const RECALL_DEFAULT_TIMEOUT_MS = 400;
const ASSOCIATE_TIMEOUT_MS = 1500;
const SUMMARIES_TIMEOUT_MS = 3000;
const DISTILL_RETRY_TIMEOUT_MS = 10000;
const MAX_RECALL_TEXTS = 3;
const MAX_RECALL_K = 5;
const MAX_SUMMARY_IDS = 100;
const MAX_ASSOCIATE_PEOPLE = 5;
const MAX_ASSOCIATE_EXCLUDE = 200;

// Node 的 URL.hostname 对 IPv6 会保留方括号，两种写法都认。
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function truncateChars(text, max) {
  const chars = [...String(text)];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDay(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

/** 本地时区里「今天 + offset 天」的 00:00。 */
function dayOffset(now, offset) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
}

/** 本周一（周一为一周开始）的 00:00。 */
function mondayOf(day) {
  const dow = (day.getDay() + 6) % 7; // 周一 = 0 … 周日 = 6
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - dow);
}

/**
 * 把一个日期写法解析成一个区间。
 * 绝对日期 YYYY-MM-DD 是「那一天」；相对说法（上周、上个月…）自带区间，
 * relative=true 让调用方知道「只写 from 时要不要补 to」。
 */
function parseDateRange(raw, now) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const da = Number(m[3]);
    const d = new Date(y, mo - 1, da);
    // Date 会把 2026-02-30 静默滚到 3 月，必须回读校验。
    if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) {
      throw new Error(`日期不存在：「${s}」。请用 YYYY-MM-DD（例如 2026-10-27）。`);
    }
    const v = fmtDay(d);
    return { start: v, end: v, relative: false };
  }

  const today = dayOffset(now, 0);
  switch (s) {
    case '今天':
    case '今日': {
      const v = fmtDay(today);
      return { start: v, end: v, relative: true };
    }
    case '昨天':
    case '昨日': {
      const v = fmtDay(dayOffset(now, -1));
      return { start: v, end: v, relative: true };
    }
    case '前天': {
      const v = fmtDay(dayOffset(now, -2));
      return { start: v, end: v, relative: true };
    }
    case '大前天': {
      const v = fmtDay(dayOffset(now, -3));
      return { start: v, end: v, relative: true };
    }
    // 本周 / 本月算到今天为止：查「本周聊过什么」时不该带进未来的空白日期。
    case '本周':
    case '这周':
    case '本星期':
    case '这个星期':
      return { start: fmtDay(mondayOf(today)), end: fmtDay(today), relative: true };
    case '上周':
    case '上星期':
    case '上个星期': {
      const thisMonday = mondayOf(today);
      return { start: fmtDay(dayOffset(thisMonday, -7)), end: fmtDay(dayOffset(thisMonday, -1)), relative: true };
    }
    case '本月':
    case '这个月':
      return { start: fmtDay(new Date(today.getFullYear(), today.getMonth(), 1)), end: fmtDay(today), relative: true };
    case '上个月':
    case '上月': {
      const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const last = new Date(today.getFullYear(), today.getMonth(), 0);
      return { start: fmtDay(first), end: fmtDay(last), relative: true };
    }
    default:
      throw new Error(`不认识的日期写法：「${s}」。请用 YYYY-MM-DD（例如 2026-10-27），或 今天 / 昨天 / 前天 / 上周 / 上个月。`);
  }
}

/**
 * 把 from/to 规整成 YYYY-MM-DD。
 * - 只写 from（相对说法）→ 补上该区间的结束，例如 from=上周 → 上周一 ~ 上周日；
 * - 只写 to（相对说法）→ 补上该区间的开始；
 * - 绝对日期只写一端时另一端保持空（表示不限）。
 * 不认识的写法抛错，让调用方回 400，AI 能看到原因并改正。
 */
export function normalizeDateRange({ from, to } = {}, now = new Date()) {
  const a = parseDateRange(from, now);
  const b = parseDateRange(to, now);
  let start = a ? a.start : '';
  let end = b ? b.end : '';
  if (a && !b && a.relative) end = a.end;
  if (b && !a && b.relative) start = b.start;
  if (start && end && start > end) [start, end] = [end, start];
  return { from: start, to: end };
}

/**
 * 关键词归一：数组或字符串（按空白/逗号/顿号/分号切）→ 去空、去重、每个截 40 字、最多 12 个。
 * 顺序保留最先出现的写法（AI 给的顺序通常就是重要程度）。
 */
export function normalizeKeywords(input) {
  let parts = [];
  if (Array.isArray(input)) parts = input;
  else if (typeof input === 'string') parts = input.split(/[\s,，、;；]+/u);
  const out = [];
  for (const part of parts) {
    if (typeof part !== 'string' && typeof part !== 'number') continue;
    const word = truncateChars(String(part).trim(), MAX_KEYWORD_CHARS);
    if (!word || out.includes(word)) continue;
    out.push(word);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

/**
 * 只允许回环地址。聊天原文会随查询发过去，指向外部等同于把私聊内容外发。
 */
function assertLoopback(urlText, allowRemote = false) {
  let parsed;
  try {
    parsed = new URL(urlText);
  } catch {
    throw new Error(`memory-rag 地址不合法：${urlText}（应形如 http://127.0.0.1:8093）`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`memory-rag 地址只能是 http(s)：${urlText}`);
  }
  // M4：allowRemote（局域网直连，受 M5 token 保护）时放行非回环地址；
  // 否则仍只允许回环（本地开发 / 本机 sidecar）。
  if (!LOOPBACK_HOSTS.has(parsed.hostname) && !allowRemote) {
    throw new Error(`memory-rag 只允许回环地址（127.0.0.1 / localhost / ::1），拒绝：${parsed.hostname}`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export function createMemoryRagClient({ url = DEFAULT_URL, timeoutMs = DEFAULT_TIMEOUT_MS, recallTimeoutMs = RECALL_DEFAULT_TIMEOUT_MS, token = '', allowRemote = false, isEnabled = () => true, log = () => {} } = {}) {
  // APIHUB_PATCH：控制台的总开关关掉后，桥接不该再向 memory-rag 发任何请求（服务已经停了，
  // 发了也只是等超时）。这里统一在每个方法入口拦一次，各处调用点本来就把「不可用」当正常情况。
  // 不传 isEnabled 时恒为 true：老调用方（测试 / 脚本）行为逐字不变。
  const enabled = () => {
    try { return isEnabled() !== false; } catch { return false; }
  };
  // 关着时写操作返回与服务不可用一致的形态，桥接现有的 409 / queued 映射不用改。
  const offResult = () => ({ ok: false, status: 503, data: { off: true, error: 'RAG 已关闭' } });
  // M5：API token（局域网直连时校验）。配置后每个请求带 X-API-Token。
  const apiToken = String(token ?? '').trim();
  const baseUrl = assertLoopback(String(url || DEFAULT_URL).trim(), allowRemote);
  const timeout = clampInt(timeoutMs, 100, 60000, DEFAULT_TIMEOUT_MS);
  // RAG_PATCH（P3）：/recall 走的是唤醒路径，超时单独一个（夹到 100～5000）：
  // 配成 0 会变成永远「不可达」，配成 30 秒则会把一次唤醒拖住半分钟。
  const recallTimeout = clampInt(recallTimeoutMs, 100, 5000, RECALL_DEFAULT_TIMEOUT_MS);
  // 503（向量库口径不一致）每 10 分钟只提示一次，免得每次检索都刷日志。
  let lastMismatchLogAt = 0;

  async function request(pathname, init, timeoutMs = timeout) {
    try {
      const headers = { ...(init?.headers || {}) };
      if (apiToken) headers['X-API-Token'] = apiToken;
      return await fetch(`${baseUrl}${pathname}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      // 连接被拒 / 超时 / DNS：都当服务不可用，交给调用方降级。
      return null;
    }
  }

  /**
   * RAG_PATCH（P2）：索引管理接口共用的返回形态。
   * 网络失败给 null（桥接回 503「不可达」）；有响应时一律 { ok, status, data }，
   * 让桥接能把 409（索引正忙）/ 503（口径不一致）原样透传给控制台。
   * data 解析失败为 null（例如 502 返回的 HTML 错误页）。
   */
  async function callJson(pathname, init, timeoutMs = timeout) {
    const response = await request(pathname, init, timeoutMs);
    if (!response) return null;
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    return { ok: response.ok, status: response.status, data };
  }

  /**
   * POST /search。任何失败（网络、超时、4xx/5xx、坏 JSON、结构不对、key 不一致）都返回 null。
   * 返回结构只保留 { semantic, hint?, items: [{ day, title, sources, text }] }。
   */
  async function search(params = {}) {
    if (!enabled()) return null;
    const key = String(params.key ?? '').trim();
    if (!KEY_RE.test(key)) {
      log(`[rag] 拒绝检索：会话 key 不合法`);
      return null;
    }

    const payload = { key, k: clampInt(params.k, 1, 8, 5) };
    const query = truncateChars(String(params.query ?? '').trim(), MAX_QUERY_CHARS);
    if (query) payload.query = query;
    const keywords = normalizeKeywords(params.keywords);
    if (keywords.length) payload.keywords = keywords;
    const from = String(params.from ?? '').trim();
    if (from) payload.from = from;
    const to = String(params.to ?? '').trim();
    if (to) payload.to = to;
    const speaker = String(params.speaker ?? '').trim();
    if (speaker) payload.speaker = speaker;
    if (params.expand !== undefined && params.expand !== null && params.expand !== '') {
      payload.expand = clampInt(params.expand, 0, 5, 0);
    }
    // BRAIN_PATCH：检索演示（/probe）要 ranked / routes；缺省 False，主路径逐字节不变
    if (params.debug === true) payload.debug = true;

    const response = await request('/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response) return null;
    if (!response.ok) {
      if (response.status === 503 && Date.now() - lastMismatchLogAt > 10 * 60 * 1000) {
        lastMismatchLogAt = Date.now();
        log('[rag] memory-rag 报 503：向量库口径与配置不一致，需要运行 cli rebuild（检索暂时降级为关键词）');
      }
      return null;
    }

    let data;
    try {
      data = await response.json();
    } catch {
      return null;
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return null;

    // 纵深防御：服务端必须回同一个会话。跑偏了就整份丢掉，绝不把别会话的原文交给 AI。
    if (String(data.key ?? '') !== key) {
      log(`[rag] 拒绝返回：响应 key 与请求不一致`);
      return null;
    }

    const picked = data.items
      .filter((it) => it && typeof it === 'object' && typeof it.text === 'string' && it.text);
    const items = picked.map((it) => ({
      day: typeof it.day === 'string' ? it.day : '',
      title: typeof it.title === 'string' ? it.title : '',
      sources: Array.isArray(it.sources) ? it.sources.filter((s) => typeof s === 'string') : [],
      text: it.text
    }));
    // DECAY_PATCH：refs 与 items 平行（同长度、同顺序），供桥接把命中映射回存档行。
    // 单条不合法（没有文件名 / 行号不是正整数）时这一项为 null，不影响其它条目。
    const refs = picked.map((it) => {
      const file = typeof it.file === 'string' && it.file ? it.file : '';
      const fileEnd = typeof it.file_end === 'string' && it.file_end ? it.file_end : file;
      const lineStart = Number(it.line_start);
      const lineEnd = Number(it.line_end);
      if (!file || !fileEnd) return null;
      if (!Number.isInteger(lineStart) || lineStart < 1 || !Number.isInteger(lineEnd) || lineEnd < 1) return null;
      return { file, lineStart, fileEnd, lineEnd };
    });
    const semantic = typeof data.semantic === 'string' && data.semantic ? data.semantic : 'ok';
    const hint = typeof data.hint === 'string' && data.hint.trim() ? data.hint.trim() : undefined;
    const result = { semantic, ...(hint ? { hint } : {}), items };
    // BRAIN_PATCH：检索演示要 ranked（名次）/ routes（五路各自命中数）。只 debug 时带。
    if (params.debug === true) {
      result.ranked = Array.isArray(data.ranked) ? data.ranked : [];
      result.routes = data.routes && typeof data.routes === 'object' ? data.routes : {};
    }
    // 不可枚举：序列化时（日志 / 误发 / JSON.stringify）不会把存档文件名带出去。
    Object.defineProperty(result, 'refs', { value: refs, enumerable: false, writable: false, configurable: false });
    return result;
  }

  /** GET /health：成功返回解析后的对象，失败返回 null。 */
  async function health() {
    if (!enabled()) return null;
    const response = await request('/health', { method: 'GET' });
    if (!response || !response.ok) return null;
    try {
      const data = await response.json();
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  // ── RAG_PATCH（P2）：索引管理 ────────────────────────────────────────────
  // 增量索引要等 embedding 跑完，给足 60 秒；重建只是入队（202），10 秒足够；
  // 遗忘要等索引锁，30 秒。超时由 request 的 signal 控制，不会拖住桥接太久。
  const INDEX_TIMEOUT_MS = 60000;
  const REBUILD_TIMEOUT_MS = 10000;
  const FORGET_TIMEOUT_MS = 30000;

  /** POST /index/run：增量索引。口径不一致时服务端回 503。 */
  function indexRun() {
    if (!enabled()) return offResult();
    return callJson('/index/run', { method: 'POST' }, INDEX_TIMEOUT_MS);
  }

  /** POST /rebuild：全量重建（后台任务，202）。 */
  function rebuild() {
    if (!enabled()) return offResult();
    return callJson('/rebuild', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    }, REBUILD_TIMEOUT_MS);
  }

  /** POST /forget：删掉某个会话的全部块与向量。key 不合法直接返回 null，不发请求。 */
  async function forget(key) {
    if (!enabled()) return offResult();
    const k = String(key ?? '').trim();
    if (!KEY_RE.test(k)) {
      log('[rag] 拒绝遗忘：会话 key 不合法');
      return null;
    }
    return callJson('/forget', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: k })
    }, FORGET_TIMEOUT_MS);
  }

  // ── RAG_PATCH（P3）：自动想起 / 联想链 / 摘要文字（docs/design/ASSOCIATION_SPEC.md §9.1）──
  //
  // 这一组和 search 同一套纪律：只允许回环地址；任何失败都返回 null（桥接自行降级）；
  // 响应里的 key 必须与请求一致；返回字段做白名单，日志/异常里不出现任何原文。

  /** 数字字段：数字保留，null / undefined / 空串是 null，其余类型（字符串等）算不合法（返回 undefined）。 */
  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  /**
   * /recall 的候选：字段类型不对的**这一条**丢掉，不影响其它候选。
   * 只保留桥接要用的字段（title / summary 给「开」的提示词，其余给影子日志与控制台）。
   */
  function normalizeRecallCandidate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.summary_id !== 'string' || !raw.summary_id) return null;
    if (typeof raw.chunk_id !== 'string') return null;
    if (typeof raw.day !== 'string') return null;
    if (typeof raw.t_end !== 'number' || !Number.isFinite(raw.t_end)) return null;
    if (typeof raw.title !== 'string') return null;
    if (typeof raw.summary !== 'string') return null;
    const cosine = numberOrNull(raw.cosine);
    const bm25Rank = numberOrNull(raw.bm25_rank);
    const graph = numberOrNull(raw.graph);
    if (cosine === undefined || bm25Rank === undefined || graph === undefined) return null;
    if (!Array.isArray(raw.signals) || raw.signals.some((s) => typeof s !== 'string')) return null;
    if (typeof raw.pass !== 'boolean') return null;
    return {
      summary_id: raw.summary_id,
      chunk_id: raw.chunk_id,
      day: raw.day,
      t_end: raw.t_end,
      title: raw.title,
      summary: raw.summary,
      cosine,
      bm25_rank: bm25Rank,
      graph,
      signals: [...raw.signals],
      pass: raw.pass
    };
  }

  /** /associate 的候选：summary / score / day 缺一不可（生活回路要用它们拼文案）。 */
  function normalizeAssociateItem(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.summary_id !== 'string' || !raw.summary_id) return null;
    if (typeof raw.day !== 'string') return null;
    if (typeof raw.t_end !== 'number' || !Number.isFinite(raw.t_end)) return null;
    if (typeof raw.title !== 'string') return null;
    if (typeof raw.summary !== 'string') return null;
    if (typeof raw.score !== 'number' || !Number.isFinite(raw.score)) return null;
    if (!Array.isArray(raw.via) || raw.via.some((v) => typeof v !== 'string')) return null;
    return {
      summary_id: raw.summary_id,
      day: raw.day,
      t_end: raw.t_end,
      title: raw.title,
      summary: raw.summary,
      score: raw.score,
      via: [...raw.via]
    };
  }

  /**
   * SUGGEST_PATCH：/notes 的条目（docs/design/worker-kit/suggest/contract.md §1）。
   * 只留契约里写死的字段：原文要给提示词用，summary_id / 权重这类内部字段不带出去。
   * 类型不对的**这一条**丢掉，不影响其它候选。
   */
  function normalizeLedgerNote(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.note_id !== 'string' || !raw.note_id) return null;
    const tEnd = numberOrNull(raw.t_end);
    const importance = numberOrNull(raw.importance);
    const createdAt = numberOrNull(raw.created_at);
    if (tEnd === undefined || importance === undefined || createdAt === undefined) return null;
    return {
      note_id: raw.note_id,
      summary_id: typeof raw.summary_id === 'string' ? raw.summary_id : '',
      day: typeof raw.day === 'string' ? raw.day : '',
      t_end: tEnd,
      who: typeof raw.who === 'string' ? raw.who : '',
      who_name: typeof raw.who_name === 'string' ? raw.who_name : '',
      cat: typeof raw.cat === 'string' ? raw.cat : '',
      text: typeof raw.text === 'string' ? raw.text : '',
      due: typeof raw.due === 'string' && raw.due ? raw.due : null,
      importance,
      created_at: createdAt,
      source: raw.source === 'backfill' ? 'backfill' : (raw.source === 'distill' ? 'distill' : '')
    };
  }

  /** /summaries 的条目：控制台只显示日期、标题、摘要，别的字段不带出去。 */
  function normalizeSummaryRow(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.summary_id !== 'string' || !raw.summary_id) return null;
    if (typeof raw.day !== 'string') return null;
    if (typeof raw.title !== 'string') return null;
    if (typeof raw.summary !== 'string') return null;
    return { summary_id: raw.summary_id, day: raw.day, title: raw.title, summary: raw.summary };
  }

  /** 失败一律 null；成功时校验 key 一致性，再按 parseData 取字段（不合法就 null）。 */
  async function postJson(pathname, payload, timeoutMs, parseData, skipKeyCheck = false) {
    const response = await request(pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }, timeoutMs);
    if (!response || !response.ok) return null;
    let data;
    try { data = await response.json(); } catch { return null; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    // BRAIN_PATCH：多会话 /graph（keys）与 /chunk 不回 key，跳过检查；其余带 key 接口逐字节不变
    if (!skipKeyCheck && payload.key !== undefined && String(data.key ?? '') !== payload.key) {
      log(`[rag] 拒绝返回：${pathname} 响应 key 与请求不一致`);
      return null;
    }
    return parseData(data);
  }

  /**
   * POST /recall：唤醒时自动想起。texts 只留字符串、最后 3 条、每条截 500 字；k 夹到 1～5。
   * 失败（网络 / 超时 / 非 2xx / 坏 JSON / key 不一致 / candidates 不是数组）一律 null。
   */
  async function recall(params = {}) {
    if (!enabled()) return null;
    const key = String(params.key ?? '').trim();
    if (!KEY_RE.test(key)) {
      log('[rag] 拒绝自动想起：会话 key 不合法');
      return null;
    }
    const texts = (Array.isArray(params.texts) ? params.texts : [])
      .filter((t) => typeof t === 'string')
      .map((t) => truncateChars(t, MAX_QUERY_CHARS).trim())
      .filter(Boolean)
      .slice(-MAX_RECALL_TEXTS);
    return postJson('/recall', { key, texts, k: clampInt(params.k, 1, MAX_RECALL_K, 2) }, recallTimeout, (data) => {
      if (!Array.isArray(data.candidates)) return null;
      const tau = data.tau === null || data.tau === undefined ? null : Number(data.tau);
      return {
        skipped: typeof data.skipped === 'string' && data.skipped ? data.skipped : null,
        tau: Number.isFinite(tau) ? tau : null,
        // inject 的顺序就是提示词里的顺序；不是字符串的编号丢掉。
        inject: Array.isArray(data.inject) ? data.inject.filter((id) => typeof id === 'string' && id) : [],
        candidates: data.candidates.map(normalizeRecallCandidate).filter(Boolean)
      };
    });
  }

  /**
   * POST /associate：联想链。除 key 外都可省（C2）；minAgeDays 打包成 snake_case 的 min_age_days。
   * people 只留纯数字 用户标识（至多 5 个），exclude 至多 200 个。
   */
  async function associate(params = {}) {
    if (!enabled()) return null;
    const key = String(params.key ?? '').trim();
    if (!KEY_RE.test(key)) {
      log('[rag] 拒绝联想：会话 key 不合法');
      return null;
    }
    const payload = { key, k: clampInt(params.k, 1, MAX_RECALL_K, 3) };
    const text = truncateChars(String(params.text ?? '').trim(), MAX_QUERY_CHARS);
    if (text) payload.text = text;
    const t = Number(params.t);
    if (Number.isFinite(t) && t > 0) payload.t = Math.round(t);
    const people = (Array.isArray(params.people) ? params.people : [])
      .map((p) => String(p ?? '').trim())
      .filter((p) => /^\d+$/.test(p))
      .slice(0, MAX_ASSOCIATE_PEOPLE);
    if (people.length) payload.people = people;
    const exclude = (Array.isArray(params.exclude) ? params.exclude : [])
      .filter((id) => typeof id === 'string' && id)
      .slice(0, MAX_ASSOCIATE_EXCLUDE);
    if (exclude.length) payload.exclude = exclude;
    const minAgeDays = Number(params.minAgeDays);
    if (Number.isFinite(minAgeDays) && minAgeDays >= 0) payload.min_age_days = minAgeDays;

    return postJson('/associate', payload, ASSOCIATE_TIMEOUT_MS, (data) => {
      if (!Array.isArray(data.items)) return null;
      return { items: data.items.map(normalizeAssociateItem).filter(Boolean) };
    });
  }

  /** POST /summaries：控制台按编号取摘要文字（ids 至多 100，没有 id 就不发请求）。 */
  async function summaries(params = {}) {
    if (!enabled()) return null;
    const key = String(params.key ?? '').trim();
    if (!KEY_RE.test(key)) {
      log('[rag] 拒绝查摘要：会话 key 不合法');
      return null;
    }
    const ids = (Array.isArray(params.ids) ? params.ids : [])
      .filter((id) => typeof id === 'string' && id)
      .slice(0, MAX_SUMMARY_IDS);
    if (!ids.length) return { items: [] };
    return postJson('/summaries', { key, ids }, SUMMARIES_TIMEOUT_MS, (data) => {
      if (!Array.isArray(data.items)) return null;
      return { items: data.items.map(normalizeSummaryRow).filter(Boolean) };
    });
  }

  /**
   * MEMORY_MAP_PATCH：POST /graph —— 记忆星图数据（实体/关系/摘要）。
   * 和 summaries 同一套纪律：key 不合法不发请求；失败返回 null；
   * 返回 { entities, relations, summaries }。
   * BRAIN_PATCH：传 keys（数组，可为 null=全部）走实时脑图新模式，返回
   * { chunks, summaries, entities, summary_entities, relations, notes, truncated }。
   */
  async function graph(params = {}) {
    if (!enabled()) return null;
    // BRAIN_PATCH：实时脑图多会话快照（keys 显式传了）
    if (params.keys !== undefined) {
      const keys = params.keys == null ? null : (Array.isArray(params.keys) ? params.keys.map(String).filter((k) => KEY_RE.test(k)) : null);
      const limit = clampInt(params.limit, 1, 2000, 2000);
      return postJson('/graph', { keys, limit }, SUMMARIES_TIMEOUT_MS, (data) => {
        if (!data || data.ok === false) return null;
        return {
          chunks: Array.isArray(data.chunks) ? data.chunks.map((c) => ({
            chunk_id: String(c.chunk_id ?? ''), key: String(c.key ?? ''), day: String(c.day ?? ''),
            t_start: Number(c.t_start ?? 0), t_end: Number(c.t_end ?? 0), title: String(c.title ?? ''),
            n_msgs: Number(c.n_msgs ?? 0),
            speakers: Array.isArray(c.speaker_names) ? c.speaker_names.map(String) : [],
          })).filter((c) => c.chunk_id && c.key) : [],
          summaries: Array.isArray(data.summaries) ? data.summaries.map((s) => ({
            summary_id: String(s.summary_id ?? ''), chunk_id: String(s.chunk_id ?? ''), key: String(s.key ?? ''),
            day: String(s.day ?? ''), t_start: Number(s.t_start ?? 0), t_end: Number(s.t_end ?? 0),
            title: String(s.title ?? ''), summary: String(s.summary ?? ''),
            importance: Number(s.importance ?? 0), valence: Number(s.valence ?? 0),
          })).filter((s) => s.summary_id) : [],
          entities: Array.isArray(data.entities) ? data.entities.map((e) => ({
            entity_id: String(e.entity_id ?? ''), type: String(e.type ?? 'thing'), name: String(e.name ?? ''),
            qq: e.qq == null ? null : String(e.qq), n: Number(e.n ?? 0),
          })).filter((e) => e.entity_id && e.name) : [],
          summary_entities: Array.isArray(data.summary_entities) ? data.summary_entities.map((se) => ({
            summary_id: String(se.summary_id ?? ''), entity_id: String(se.entity_id ?? ''), key: String(se.key ?? ''),
          })).filter((se) => se.summary_id && se.entity_id) : [],
          relations: Array.isArray(data.relations) ? data.relations.map((r) => ({
            summary_id: String(r.summary_id ?? ''), key: String(r.key ?? ''), src_id: String(r.src_id ?? ''),
            dst_id: String(r.dst_id ?? ''), relation: String(r.relation ?? ''),
          })).filter((r) => r.summary_id && r.src_id && r.dst_id) : [],
          notes: Array.isArray(data.notes) ? data.notes.map((n) => ({
            note_id: String(n.note_id ?? ''), summary_id: String(n.summary_id ?? ''), key: String(n.key ?? ''),
            cat: String(n.cat ?? ''), text: String(n.text ?? ''), due: n.due ?? null, created_at: Number(n.created_at ?? 0),
          })).filter((n) => n.note_id) : [],
          truncated: data.truncated ?? {},
        };
      });
    }
    // 旧星图（单会话）
    const key = String(params.key ?? '').trim();
    if (!KEY_RE.test(key)) {
      log('[rag] 拒绝查星图：会话 key 不合法');
      return null;
    }
    const entityLimit = clampInt(params.entityLimit, 1, 1000, 300);
    const summaryLimit = clampInt(params.summaryLimit, 1, 1000, 300);
    return postJson('/graph', { key, entity_limit: entityLimit, summary_limit: summaryLimit }, SUMMARIES_TIMEOUT_MS, (data) => {
      if (!Array.isArray(data.entities) || !Array.isArray(data.relations) || !Array.isArray(data.summaries)) return null;
      return {
        entities: data.entities.map((e) => ({
          id: String(e.id ?? ''),
          type: String(e.type ?? 'thing'),
          name: String(e.name ?? ''),
          qq: e.qq == null ? null : String(e.qq),
          count: Number(e.count ?? 0),
        })).filter((e) => e.id && e.name),
        relations: data.relations.map((r) => ({
          src: String(r.src ?? ''),
          dst: String(r.dst ?? ''),
          relation: String(r.relation ?? ''),
          count: Number(r.count ?? 0),
        })).filter((r) => r.src && r.dst),
        summaries: data.summaries.map((s) => ({
          summaryId: String(s.summary_id ?? ''),
          day: String(s.day ?? ''),
          title: String(s.title ?? ''),
          summary: String(s.summary ?? ''),
          importance: Number(s.importance ?? 0),
          valence: Number(s.valence ?? 0),
          tStart: Number(s.t_start ?? 0),
        })).filter((s) => s.summaryId),
      };
    });
  }

  /**
   * BRAIN_PATCH：POST /chunk —— 单个话题块的原文（控制台点开某话题块时才取）。
   * 快照里不含原文；这里按需取。key 不合法 / 不存在 / 失败一律 null。
   */
  async function chunk({ key = '', chunkId = '' } = {}) {
    if (!enabled()) return null;
    const k = String(key ?? '').trim();
    const cid = String(chunkId ?? '').trim();
    if (!KEY_RE.test(k) || !cid) {
      log('[rag] 拒绝取块原文：key 或 chunk_id 不合法');
      return null;
    }
    return postJson('/chunk', { key: k, chunk_id: cid }, SUMMARIES_TIMEOUT_MS, (data) => {
      if (!data || data.ok === false || !data.chunk_id) return null;
      return {
        chunk_id: String(data.chunk_id ?? ''), key: String(data.key ?? ''), day: String(data.day ?? ''),
        title: String(data.title ?? ''), t_start: Number(data.t_start ?? 0), t_end: Number(data.t_end ?? 0),
        n_msgs: Number(data.n_msgs ?? 0), text: String(data.text ?? ''),
      };
    });
  }

  /**
   * SUGGEST_PATCH：POST /notes —— 账本建议的候选（契约 §1，按会话 key 与 since_ms 过滤）。
   * 和别的读接口同一套纪律：key 不合法不发请求；失败（网络 / 超时 / 非 2xx / 坏 JSON /
   * key 不一致）一律 null；返回 { items }，字段白名单见 normalizeLedgerNote。
   * timeoutMs 由调用方单独给（它不走唤醒路径，但也不能把控制台拖住）。
   */
  async function notes(params = {}, { timeoutMs } = {}) {
    if (!enabled()) return null;
    const key = String(params.key ?? '').trim();
    if (!KEY_RE.test(key)) {
      log('[rag] 拒绝查账本候选：会话 key 不合法');
      return null;
    }
    const sinceMs = clampInt(params.sinceMs, 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = clampInt(params.limit, 1, 200, 100);
    const t = clampInt(timeoutMs, 50, 10000, timeout);
    return postJson('/notes', { key, since_ms: sinceMs, limit }, t, (data) => {
      if (!Array.isArray(data.items)) return null;
      return { items: data.items.map(normalizeLedgerNote).filter(Boolean) };
    });
  }

  /** POST /distill/retry：控制台「重试失败的」。返回 { ok, status, data } 或 null（不可达）。 */
  function distillRetry() {
    if (!enabled()) return offResult();
    return callJson('/distill/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    }, DISTILL_RETRY_TIMEOUT_MS);
  }

  /** POST /device/register：上报本机能力（OS/shell/tools/paths）。key 须 device:{deviceId}。 */
  function registerDevice(key, capability) {
    if (!enabled()) return offResult();
    if (!KEY_RE.test(String(key ?? ''))) {
      log(`[rag] 拒绝设备注册：key 不合法`);
      return null;
    }
    return callJson('/device/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: String(key), capability: capability ?? {} })
    }, timeout);
  }

  /** POST /device/get：读一台设备的能力。返回 { ok, status, data } 或 null。 */
  function getDevice(key) {
    if (!enabled()) return offResult();
    if (!KEY_RE.test(String(key ?? ''))) {
      log(`[rag] 拒绝设备读取：key 不合法`);
      return null;
    }
    return callJson('/device/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: String(key) })
    }, timeout);
  }

  /** GET /device/list：列出所有已注册设备。 */
  function listDevices() {
    if (!enabled()) return offResult();
    return callJson('/device/list', { method: 'GET' }, timeout);
  }

  /**
   * CROSS_DEVICE_PATCH：直接索引文本到指定 key（不走 archive）。
   * persona:root（人格快照）等稳定特征用；同 key 的旧块会被替换（不积累）。
   */
  async function indexText(params = {}) {
    if (!enabled()) return null;
    const key = String(params.key ?? '').trim();
    if (!KEY_RE.test(key)) {
      log('[rag] 拒绝索引文本：会话 key 不合法');
      return null;
    }
    const text = String(params.text ?? '').trim();
    if (!text) return null;
    const payload = { key, text: truncateChars(text, 20000) };
    const t = Number(params.t);
    if (Number.isFinite(t) && t > 0) payload.t = Math.round(t);
    return postJson('/index/text', payload, timeout, (data) => ({
      chunkId: data.chunk_id ?? null,
      chunks: Number(data.chunks ?? 0)
    }));
  }

  // ── 通用文件存储（持久化后端）：ltm/persona 的 state 文件读写走这里 ──
  // path 是相对 state 的路径（如 'long-memory/people.json'、'long-memory/archive/chat:root/2026-11.jsonl'）。
  // 返回 { ok, found, content }（read）/ { ok }（write/append/delete）/ { ok, entries }（list）。
  // 网络失败返回 null（调用方降级）。
  async function fileRead(path) {
    if (!enabled()) return null;
    if (!path || typeof path !== 'string') return null;
    return callJson('/file/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
  }
  async function fileWrite(path, content) {
    if (!enabled()) return null;
    if (!path || typeof path !== 'string' || typeof content !== 'string') return null;
    return callJson('/file/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content }) });
  }
  async function fileAppend(path, content) {
    if (!enabled()) return null;
    if (!path || typeof path !== 'string' || typeof content !== 'string') return null;
    return callJson('/file/append', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content }) });
  }
  async function fileDelete(path) {
    if (!enabled()) return null;
    if (!path || typeof path !== 'string') return null;
    return callJson('/file/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
  }
  async function fileList(path) {
    if (!enabled()) return null;
    if (!path || typeof path !== 'string') return null;
    return callJson('/file/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
  }

  return {
    search, health, indexRun, rebuild, forget, recall, associate, summaries, graph, notes, distillRetry,
    registerDevice, getDevice, listDevices, indexText,
    fileRead, fileWrite, fileAppend, fileDelete, fileList,
    // APIHUB_PATCH：给桥接算 history-search 的 semantic / 判断总开关用。
    enabled
  };
}
