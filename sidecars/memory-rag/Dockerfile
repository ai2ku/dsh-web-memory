# memory-rag 容器：跨终端共享记忆索引服务
# 构建：docker build -t memory-rag:latest .
# 数据卷：挂载 /data（state 目录，记忆持久化）

FROM docker.1panel.live/library/python:3.12-slim

# 系统依赖（chromadb/uvicorn 需要）；Debian 用清华源加速（国内）
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list 2>/dev/null || true
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖（利用缓存）；国内用清华 pip 源加速
COPY pyproject.toml ./
COPY memory_rag/ ./memory_rag/
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple -e .

# 数据卷（state 目录）
VOLUME /data
ENV MEMORY_RAG_STATE_DIR=/data

# 默认监听 0.0.0.0（容器内），端口 8093
EXPOSE 8093

# 启动（host 由 MEMORY_RAG_HOST 控制，默认 0.0.0.0）
CMD ["python", "-m", "memory_rag.app"]
