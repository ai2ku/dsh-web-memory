"""memory-rag HTTP 服务（只监听 127.0.0.1）。

    .venv/bin/python -m memory_rag.app

接口：GET /health、POST /index/run、POST /search、POST /forget、POST /rebuild。
/forget 消费桥接写的遗忘请求；/rebuild 在后台全量重建（口径不一致时也能跑，这正是它的用途）。
RAG_PATCH（P3）：另有 /recall（唤醒时自动想起）、/associate（联想链）、/summaries（按编号取摘要）、
/distill/retry（手动重试提炼失败的块）；前三个与 /search 一样按 key 隔离、先处理遗忘请求。
SUGGEST_PATCH：/notes（本会话的账本建议候选，同样按 key 隔离、先处理遗忘请求）与
/notes/backfill（把老摘要排进回补队列，真正回补在提炼循环里跑）。
"""

from __future__ import annotations

import json
import os
import threading
import time
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .archive import valid_key
from .indexer import IndexBusy
from .l2 import L2
from .recall import associate as run_associate, recall as run_recall, summaries as run_summaries
from .service import RebuildRunning, Service, request_at

svc = Service()
app = FastAPI(title="memory-rag", docs_url=None, redoc_url=None, openapi_url=None)


# ── M5：API token 认证（局域网直连 + token）。未配置 token 时不鉴权（本地开发兼容）。
# 配置后：除 /health（探活）外，所有请求须带 X-API-Token 或 Authorization: Bearer <token>。
API_TOKEN = os.environ.get("MEMORY_RAG_API_TOKEN", "").strip()


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if API_TOKEN:
        path = request.url.path
        if path != "/health":
            supplied = request.headers.get("x-api-token") or ""
            if not supplied:
                auth = request.headers.get("authorization") or ""
                if auth.startswith("Bearer "):
                    supplied = auth[7:].strip()
            # 常量时间比较，防时序攻击
            import hmac
            if not hmac.compare_digest(supplied, API_TOKEN):
                return JSONResponse({"detail": "invalid token"}, status_code=401)
    return await call_next(request)


class SearchReq(BaseModel):
    key: str = ""
    query: str = ""
    keywords: list[str] = Field(default_factory=list)
    date_from: str | None = Field(default=None, alias="from")
    date_to: str | None = Field(default=None, alias="to")
    speaker: str = ""
    k: int | None = None
    expand: int | None = None


class ForgetReq(BaseModel):
    key: str = ""


# RAG_PATCH（P3）：联想三接口 + 提炼重试（接口约定 C2）
class RecallReq(BaseModel):
    key: str = ""
    texts: list[str] = Field(default_factory=list)
    k: int | None = 2
    now: int | None = None


class AssociateReq(BaseModel):
    key: str = ""
    text: str = ""
    t: int | None = None
    people: list[str] = Field(default_factory=list)
    exclude: list[str] = Field(default_factory=list)
    min_age_days: float | None = None
    k: int | None = 3
    now: int | None = None


class SummariesReq(BaseModel):
    key: str = ""
    ids: list[str] = Field(default_factory=list)


# MEMORY_MAP_PATCH → BRAIN_PATCH：记忆星图升级为实时脑图。GraphReq 新增 keys（多会话，缺省 =
# 全部会话）与 limit（快照容量）；旧字段 key/entity_limit/summary_limit 保留，向后兼容单会话旧调用。
class GraphReq(BaseModel):
    key: str = ""
    entity_limit: int = 300
    summary_limit: int = 300
    # BRAIN_PATCH：实时脑图快照（接口约定 §5.1）。keys 为 None/缺省 = 全部会话。
    keys: list[str] | None = None
    limit: int | None = 2000


# BRAIN_PATCH：单个话题块的原文（点开某个话题块时才取，快照里不含原文）。
class ChunkReq(BaseModel):
    key: str = ""
    chunk_id: str = ""


# SUGGEST_PATCH：账本建议的读接口与回补（接口约定 §1）。`hours` 故意用 Any 接，
# 好把「不是整数 / 超范围」统一回 400，而不是 pydantic 默认的 422。
class NotesReq(BaseModel):
    key: str = ""
    since_ms: int | None = 0
    limit: int | None = 100


class NotesBackfillReq(BaseModel):
    hours: Any = 72
    dry_run: bool = False


class IndexTextReq(BaseModel):
    """CROSS_DEVICE_PATCH：直接索引文本到指定 key（不走 archive）。
    persona:root（人格快照）等稳定特征用——不是聊天消息，不写 archive。"""
    key: str = ""
    text: str = ""
    t: int | None = None
    replace: bool = True  # 同名（同 key+文本）覆盖，避免重复


def _ready():
    if svc.mismatch:
        raise HTTPException(503, f"{svc.mismatch}（运行 python -m memory_rag.cli rebuild）")


def _recall_ready(key: str) -> None:
    """RAG_PATCH（P3）：联想三接口共用的前置检查（顺序与 /search 一致）。

    key 非法 400 → 口径不一致 / L2 不可用 503 → 该会话有遗忘请求就先处理（拿不到索引锁则 503）。
    遗忘请求必须在查 L2 之前处理掉，否则可能把已删会话的摘要返回给桥接。
    """
    if not valid_key(key):
        raise HTTPException(400, "key 必填，格式 group:<群号> 或 private:<QQ号>")
    _ready()
    if svc.l2 is None:
        raise HTTPException(503, f"{svc.mismatch or '向量库不可用'}")
    try:
        svc.process_forget_requests(only_key=key, blocking=False)
    except IndexBusy:
        raise HTTPException(503, "该会话有待处理的遗忘请求，稍后再试") from None


def _brain_ready(keys):
    """BRAIN_PATCH：/graph、/chunk 的前置检查，返回读 L2 用的对象。keys 为 None = 全部会话。

    不调 _ready()：脑图只读 SQLite，不需要 embedding，口径不一致时也要能画出来（约定 §5.1、任务书第 8 条）。
    但遗忘请求必须先消费掉，否则会把已删的东西画出来：
    - 正常时照 /search 的做法非阻塞地处理，拿不到索引锁 → 503（只读模式在 process_forget_requests 里同样抛 IndexBusy）；
    - 口径不一致时 indexer 不在、消费不了 → 只要涉及的会话有待处理请求就 503，宁可画不出也不返回已删内容。
    """
    if svc.indexer is None:
        if any(keys is None or k in keys for _, k, _ in svc.forget_requests()):
            raise HTTPException(503, "有待处理的遗忘请求，稍后再试")
        # 口径不一致时 svc.l2 是 None；L2 只是包一层同库同锁的连接，现造一个就能读
        return svc.l2 or L2(svc.db)
    try:
        if keys is None:
            svc.process_forget_requests(blocking=False)
        else:
            for k in keys:
                svc.process_forget_requests(only_key=k, blocking=False)
    except IndexBusy:
        raise HTTPException(503, "有待处理的遗忘请求，稍后再试") from None
    return svc.l2 or L2(svc.db)


def _clamp(value, lo: int, hi: int, default: int) -> int:
    if value is None:
        return default
    return max(lo, min(hi, int(value)))


def _index_once(indexer) -> None:
    # 遗忘后立刻把该会话重建回来；拿不到锁就算了，60 秒的定时循环会补上
    try:
        indexer.run()
    except Exception as e:  # 后台线程的异常记进上一轮结果，/health 看得见
        indexer.last = {"at": int(time.time() * 1000), "chunks": 0, "error": repr(e)}


@app.get("/health")
def health():
    return svc.health()


@app.post("/index/run")
def index_run():
    _ready()
    return svc.indexer.run()


@app.post("/index/text")
def index_text(req: IndexTextReq):
    """CROSS_DEVICE_PATCH：直接索引文本到指定 key（不走 archive）。

    persona:root（人格快照）等稳定特征用——不是聊天消息，不写 archive。
    文本作为单个 chunk 存进向量库 + FTS，key 过滤，替换同 key 的旧块。
    """
    if not valid_key(req.key):
        raise HTTPException(400, "key 必填，格式 group/private/persona/chat/device:<id>")
    _ready()
    text = str(req.text or "").strip()
    if not text:
        raise HTTPException(400, "text 不能为空")
    indexer = svc.indexer
    if indexer is None:
        raise HTTPException(503, f"{svc.mismatch or '向量库不可用'}")
    text = text[:20000]
    now_ms = req.t if req.t else int(time.time() * 1000)
    # 确定性 ID：同 key+text 覆盖（upsert），persona 快照更新时不会积累旧块
    chunk_id = hashlib.sha1(f"{req.key}|{text}".encode("utf-8")).hexdigest()
    day = datetime.fromtimestamp(now_ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%d")
    meta = {
        "key": req.key, "t_start": now_ms, "t_end": now_ms, "day": day,
        "speakers": "", "speaker_names": "", "title": "persona",
        "cut_reason": "direct", "file_start": "", "line_start": 0,
        "file_end": "", "line_end": 0, "n_msgs": 1, "distilled": "pending",
    }
    try:
        vec = svc.embedder.embed_docs([text])[0]
    except Exception as e:
        raise HTTPException(503, f"embedding 不可用：{e}") from None
    try:
        with indexer.lock:
            # 删旧块（同 key）再写入，保证 persona:root 只有最新快照
            indexer.db.delete_key(req.key)
            indexer.vstore.delete_key(req.key)
            indexer.vstore.upsert([chunk_id], [vec], [meta], [text])
            indexer.db.upsert([{"chunk_id": chunk_id, "text": text, **meta}], int(time.time() * 1000))
    except Exception as e:
        raise HTTPException(500, f"写入失败：{e}") from None
    return {"ok": True, "key": req.key, "chunk_id": chunk_id, "chunks": 1}


@app.post("/forget")
def forget(req: ForgetReq):
    """RAG_PATCH（P2）：忘掉一个会话的向量记忆（桥接删完存档后调用）。"""
    if not valid_key(req.key):
        raise HTTPException(400, "key 必填，格式 group:<群号> 或 private:<QQ号>")
    if svc.indexer is None:
        raise HTTPException(503, f"{svc.mismatch or '向量库不可用'}")
    # 先记下请求文件与它的 at：处理完只有 at 没变才删（期间桥接可能又写了新请求）
    pending = {k: (p, at) for p, k, at in svc.forget_requests()}.get(req.key)
    try:
        out = svc.forget(req.key)
    except IndexBusy:
        raise HTTPException(409, "索引正忙，稍后重试") from None
    if pending is not None:
        path, at = pending
        if request_at(path) == at:
            try:
                path.unlink()
            except OSError:
                pass
    indexer = svc.indexer
    threading.Thread(target=_index_once, args=(indexer,), daemon=True).start()
    return out


@app.post("/rebuild", status_code=202)
def rebuild():
    """RAG_PATCH（P2）：后台全量重建。故意不调 _ready()：口径不一致时正需要它来修。"""
    try:
        job = svc.start_rebuild()
    except RebuildRunning:
        raise HTTPException(409, "已有重建任务在进行") from None
    return {"ok": True, "job": job}


@app.post("/search")
def search(req: SearchReq):
    # key 必填：会话隔离的第二道闸（第一道在桥接，key 由会话令牌校验得出）
    if not valid_key(req.key):
        raise HTTPException(400, "key 必填，格式 group:<群号> 或 private:<QQ号>")
    _ready()
    # RAG_PATCH（P2）：这个会话有待处理的遗忘请求时先清掉，免得把已删内容返回给桥接。
    # 拿不到索引锁就 503，桥接降级为关键词检索——宁可查不到，也不能返回已删除的内容。
    try:
        svc.process_forget_requests(only_key=req.key, blocking=False)
    except IndexBusy:
        raise HTTPException(503, "该会话有待处理的遗忘请求，稍后再试") from None
    try:
        return svc.searcher.search(req.key, req.query, req.keywords[:12], req.date_from, req.date_to,
                                   req.speaker, req.k, req.expand)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


# ---------------------------------------------------------------- 联想三接口（RAG_PATCH（P3））


@app.post("/recall")
def recall(req: RecallReq):
    """唤醒时自动想起：桥接把最近 1～3 条来信交过来，回候选摘要与要注入的编号（接口约定 C2）。"""
    _recall_ready(req.key)
    texts = [str(t or "")[:500] for t in (req.texts or [])[-3:]]  # 只看最近的来信，过长截断
    return run_recall(svc, req.key, texts, k=_clamp(req.k, 1, 5, 2), now_ms=req.now)


@app.post("/associate")
def associate(req: AssociateReq):
    """联想链：按文字 / 指定的人 / 某个时刻的块找本会话里另一件相关的旧事。"""
    _recall_ready(req.key)
    people = [str(p).strip() for p in (req.people or []) if str(p).strip().isdigit()][:5]
    return run_associate(svc, req.key, text=str(req.text or "")[:500], t=req.t, people=people,
                         exclude=[str(x) for x in (req.exclude or [])][:200],
                         min_age_days=req.min_age_days, k=_clamp(req.k, 1, 5, 3), now_ms=req.now)


@app.post("/summaries")
def summaries(req: SummariesReq):
    """控制台按编号取摘要文字：不属于该 key 或已删除的 id 不返回（桥接显示「已删除」）。"""
    _recall_ready(req.key)
    return run_summaries(svc, req.key, [str(i) for i in (req.ids or [])][:100])


@app.post("/graph")
def graph(req: GraphReq):
    """记忆星图 / 实时脑图（接口约定 §5.1）。**绝不含块原文**：块原文点开时走 /chunk 单独取。

    两种调用方式：
    - 旧星图（单会话）：带 key → 走 _recall_ready（要 embedding），返回 entities/relations/summaries；
    - 实时脑图（多会话）：带 keys（None = 全部会话）→ 走 _brain_ready（只读 SQLite，口径不一致也画得出），
      额外返回 chunks（话题块元数据）、summary_entities、notes、truncated。
    """
    if req.keys is not None or (not req.key and (req.limit or 0)):
        # BRAIN_PATCH：多会话快照模式（keys 显式给了，或没给 key 但要 limit 的新版调用）
        keys = None
        if req.keys:
            keys = []
            for k in req.keys:
                if not valid_key(k):
                    raise HTTPException(400, "keys 里每一项都必须是合法会话 key")
                if k not in keys:
                    keys.append(k)
        limit = _clamp(req.limit, 1, 2000, 2000)
        l2 = _brain_ready(keys)
        chunks, chunks_cut = svc.db.graph_chunks(keys, limit)
        g = l2.graph(keys, limit)
        return {"ok": True, "chunks": chunks, "summaries": g["summaries"], "entities": g["entities"],
                "summary_entities": g["summary_entities"], "relations": g["relations"], "notes": g["notes"],
                "truncated": {"chunks": chunks_cut, **g["truncated"]}}
    # 旧星图（单会话）
    _recall_ready(req.key)
    if svc.l2 is None:
        raise HTTPException(503, "向量库不可用")
    g = svc.l2.list_graph(req.key, entity_limit=req.entity_limit, summary_limit=req.summary_limit)
    return {"key": req.key, "entities": g["entities"], "relations": g["relations"], "summaries": g["summaries"]}


@app.post("/chunk")
def chunk(req: ChunkReq):
    """BRAIN_PATCH：单个话题块的原文。不存在与 key 不匹配回同一个 404，不让人试出「块在，但属于别的会话」。"""
    if not valid_key(req.key):
        raise HTTPException(400, "key 必填，格式 chat:<id> / group:<群号> / private:<QQ号> 等")
    _brain_ready([req.key])
    row = svc.db.chunk_text(req.key, str(req.chunk_id or ""))
    if row is None:
        raise HTTPException(404, "话题块不存在")
    return {"ok": True, **row}


@app.post("/notes")
def notes(req: NotesReq):
    """SUGGEST_PATCH：本会话的账本建议候选（接口约定 §1）。

    与 /recall 同一套前置检查：key 非法 400、口径不一致 503、该会话有遗忘请求就先处理掉——
    否则可能把已删会话的候选返回给桥接。
    """
    _recall_ready(req.key)
    since = max(0, int(req.since_ms or 0))
    limit = _clamp(req.limit, 1, 200, 100)
    return {"key": req.key, "items": svc.l2.notes(req.key, since, limit)}


@app.post("/notes/clear")
def notes_clear(req: NotesReq):
    """DEBUG_PATCH：清空本会话的候选（ledger_notes），保留摘要。调试清假候选用。"""
    n = svc.l2.clear_notes(req.key)
    return {"key": req.key, "cleared": n}


@app.post("/notes/backfill")
def notes_backfill(req: NotesBackfillReq):
    """SUGGEST_PATCH：把最近 hours 小时内、还没抽过候选的摘要标成 queued（真的回补在提炼循环里）。"""
    hours = req.hours if req.hours is not None else 72
    if isinstance(hours, bool) or not isinstance(hours, int) or not (1 <= hours <= 168):
        raise HTTPException(400, "hours 必须是 1～168 的整数")
    if svc.l2 is None:
        raise HTTPException(503, f"{svc.mismatch or '向量库不可用'}")
    now = int(time.time() * 1000)
    queued = svc.l2.queue_notes_backfill(hours, now, dry_run=bool(req.dry_run))
    return {"queued": queued, "dry_run": bool(req.dry_run)}


@app.post("/distill/retry")
def distill_retry():
    """手动重试提炼失败的块（控制台用）。不按会话查东西，所以不需要 key。"""
    if svc.distiller is None:
        raise HTTPException(503, f"{svc.mismatch or '向量库不可用'}")
    return {"ok": True, "retried": svc.distiller.retry_failed()}


# ---------------------------------------------------------------- M3：设备能力（跨端适配）


class DeviceRegisterReq(BaseModel):
    """设备能力上报。key 必须是 device:{deviceId}。capability 是结构化描述。"""
    key: str = ""
    capability: dict[str, Any] = Field(default_factory=dict)


class DeviceGetReq(BaseModel):
    key: str = ""


def _devices_dir() -> Path:
    return svc.cfg["paths"].devices


def _device_file(device_id: str) -> Path:
    # device_id 只允许 [\w-]+（KEY_RE 的 device 段），避免路径穿越
    import re as _re
    if not _re.fullmatch(r"[\w-]+", device_id or ""):
        raise HTTPException(400, "deviceId 不合法（只允许字母数字下划线连字符）")
    return _devices_dir() / f"{device_id}.json"


def _read_device(device_id: str) -> dict | None:
    f = _device_file(device_id)
    if not f.exists():
        return None
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_device(device_id: str, data: dict) -> None:
    d = _devices_dir()
    d.mkdir(parents=True, exist_ok=True)
    os.chmod(d, 0o700)
    f = _device_file(device_id)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(f)


@app.post("/device/register")
def device_register(req: DeviceRegisterReq):
    """注册/更新一台设备的能力（OS、shell、工具、路径等）。幂等：同 key 覆盖。"""
    if not valid_key(req.key) or not req.key.startswith("device:"):
        raise HTTPException(400, "key 必填，格式 device:<deviceId>")
    device_id = req.key.split(":", 1)[1]
    data = _read_device(device_id) or {}
    data["deviceId"] = device_id
    data["capability"] = req.capability
    data["updatedAt"] = int(time.time() * 1000)
    data["ts"] = int(time.time() * 1000)  # 兼容 search 的 t 字段口径
    _write_device(device_id, data)
    return {"ok": True, "key": req.key, "deviceId": device_id}


@app.post("/device/get")
def device_get(req: DeviceGetReq):
    """读取一台设备的能力。找不到返回 ok:true、found:false（不 404，方便桥接轮询）。"""
    if not valid_key(req.key) or not req.key.startswith("device:"):
        raise HTTPException(400, "key 必填，格式 device:<deviceId>")
    device_id = req.key.split(":", 1)[1]
    data = _read_device(device_id)
    if data is None:
        return {"ok": True, "key": req.key, "deviceId": device_id, "found": False, "capability": None}
    return {"ok": True, "key": req.key, "deviceId": device_id, "found": True, **data}


@app.get("/device/list")
def device_list():
    """列出所有已注册设备（用于跨端发现）。"""
    d = _devices_dir()
    if not d.exists():
        return {"ok": True, "devices": []}
    out = []
    for f in sorted(d.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            out.append({"deviceId": f.stem, "capability": data.get("capability", {}),
                        "updatedAt": data.get("updatedAt")})
        except Exception:
            continue
    return {"ok": True, "devices": out}


# ── 通用文件存储（插件 dsh-web-memory 的持久化后端）──────────────────────
# 插件把 state 下文件读写（people.json、archive、persona、memory-decay）都走这里。
# 容器作为纯存储层：只读写 state 下的相对路径文件，不做业务逻辑。

def _file_root() -> Path:
    """state 目录（svc.cfg['paths'].state）。"""
    return svc.cfg["paths"].state


def _safe_rel(path: str) -> Path:
    """只允许 state 下的相对路径，防目录穿越。"""
    if not path or not isinstance(path, str) or not path.strip():
        raise HTTPException(400, "path 必填")
    p = Path(path.strip())
    if p.is_absolute():
        raise HTTPException(400, "path 必须是相对路径")
    parts = p.parts
    if any(part in ("..", ".") for part in parts):
        raise HTTPException(400, "path 非法")
    return p


class FileReadReq(BaseModel):
    path: str = ""


class FileWriteReq(BaseModel):
    path: str = ""
    content: str = ""


class FileDeleteReq(BaseModel):
    path: str = ""


class FileListReq(BaseModel):
    path: str = ""


@app.post("/file/read")
def file_read(req: FileReadReq):
    """读 state 下相对路径的文件内容。不存在返回 ok:true, found:false。"""
    try:
        rel = _safe_rel(req.path)
    except HTTPException:
        raise
    f = _file_root() / rel
    if not f.exists() or not f.is_file():
        return {"ok": True, "found": False}
    try:
        return {"ok": True, "found": True, "content": f.read_text(encoding="utf-8")}
    except Exception as e:
        raise HTTPException(500, f"读失败：{e}") from None


@app.post("/file/write")
def file_write(req: FileWriteReq):
    """写 state 下相对路径（原子替换，600）。"""
    try:
        rel = _safe_rel(req.path)
    except HTTPException:
        raise
    f = _file_root() / rel
    f.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(f.parent, 0o700)
    tmp = f.with_suffix(f.suffix + ".tmp")
    try:
        tmp.write_text(req.content, encoding="utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(f)
    except Exception as e:
        raise HTTPException(500, f"写失败：{e}") from None
    return {"ok": True}


@app.post("/file/append")
def file_append(req: FileWriteReq):
    """追加到 state 下相对路径（archive JSONL 用）。"""
    try:
        rel = _safe_rel(req.path)
    except HTTPException:
        raise
    f = _file_root() / rel
    f.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(f.parent, 0o700)
    try:
        with open(f, "a", encoding="utf-8") as fh:
            fh.write(req.content)
    except Exception as e:
        raise HTTPException(500, f"追加失败：{e}") from None
    return {"ok": True}


@app.post("/file/delete")
def file_delete(req: FileDeleteReq):
    """删除 state 下相对路径（文件或目录）。"""
    try:
        rel = _safe_rel(req.path)
    except HTTPException:
        raise
    f = _file_root() / rel
    if not f.exists():
        return {"ok": True, "found": False}
    try:
        if f.is_dir():
            import shutil
            shutil.rmtree(f)
        else:
            f.unlink()
    except Exception as e:
        raise HTTPException(500, f"删除失败：{e}") from None
    return {"ok": True}


@app.post("/file/list")
def file_list(req: FileListReq):
    """列出 state 下相对路径的目录项。"""
    try:
        rel = _safe_rel(req.path)
    except HTTPException:
        raise
    d = _file_root() / rel
    if not d.exists() or not d.is_dir():
        return {"ok": True, "found": False, "entries": []}
    entries = []
    for child in sorted(d.iterdir()):
        entries.append({"name": child.name, "is_dir": child.is_dir(),
                        "size": child.stat().st_size if child.is_file() else 0})
    return {"ok": True, "found": True, "entries": entries}


def _loop(interval: float):
    while True:
        try:
            if svc.indexer:
                # RAG_PATCH（P2）：先消费遗忘请求，再增量索引——否则可能先把墓碑前的旧内容又索引一遍
                svc.process_forget_requests()
                svc.indexer.run()
                # RAG_PATCH（P3）：索引完提炼一轮（对账 → 补向量 → 挑块调模型）。
                # 提炼的异常不能拖垮定时循环，记进 distiller 自己的 last_error（只写类别）。
                if svc.distiller:
                    try:
                        svc.distiller.run_once()
                    except Exception as e:
                        svc.distiller.last_error = f"run: {type(e).__name__}"
        except Exception as e:  # 定时任务不能因为一次异常就停掉
            if svc.indexer:
                svc.indexer.last = {"at": int(time.time() * 1000), "chunks": 0, "error": repr(e)}
        time.sleep(interval)


def main():
    import uvicorn

    srv = svc.cfg.get("server") or {}
    threading.Thread(target=_loop, args=(float(srv.get("index_interval_s", 60)),), daemon=True).start()
    # MEMORY_RAG_HOST 环境变量优先（容器内监听 0.0.0.0，远程连接）
    host = os.environ.get("MEMORY_RAG_HOST") or srv.get("host", "127.0.0.1")
    # 自定义日志：抑制 uvicorn.error 的 WARNING（如外部探测打到端口导致的
    # 「Invalid HTTP request received」噪音），只保留 ERROR；access 日志照旧。
    # 注意：uvicorn.run 的 log_level 会覆盖 log_config 里的 level，所以这里不传 log_level，
    # 让 log_config 全权控制（uvicorn.error=ERROR，uvicorn.access 保持默认）。
    import copy
    log_cfg = None
    try:
        log_cfg = copy.deepcopy(getattr(uvicorn.config, 'LOGGING_CONFIG', None))
        if log_cfg:
            log_cfg["loggers"]["uvicorn.error"]["level"] = "ERROR"
            log_cfg["loggers"]["uvicorn"]["level"] = "ERROR"
    except Exception:
        log_cfg = None
    uvicorn.run(app, host=str(host), port=int(srv.get("port", 8093)), log_config=log_cfg)


if __name__ == "__main__":
    main()
