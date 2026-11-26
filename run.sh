#!/usr/bin/env bash
# MusicViz 一键启动：首次运行自动建虚拟环境并安装依赖，然后启动网页服务。
# 用法:  ./run.sh                 启动网站 (http://localhost:8765)
#        ./run.sh analyze a.mp3   命令行分析音频
set -euo pipefail
cd "$(dirname "$0")"
PY=${PYTHON:-python3.11}
if [ ! -x .venv/bin/python ]; then
  command -v "$PY" >/dev/null || PY=python3
  echo "› 创建虚拟环境 (.venv) ..."
  "$PY" -m venv .venv
  .venv/bin/python -m pip install -U pip
  .venv/bin/python -m pip install -r requirements.txt
fi
command -v ffmpeg >/dev/null || { echo "需要 ffmpeg：brew install ffmpeg"; exit 1; }
if [ "${1:-}" = "analyze" ]; then
  shift; exec .venv/bin/python -m musicviz analyze "$@"
fi
PORT=${PORT:-8765}
echo "› 打开 http://localhost:$PORT"
exec .venv/bin/python -m musicviz serve --port "$PORT"
