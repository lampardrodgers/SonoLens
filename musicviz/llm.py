"""LLM layer: provider adapters (Claude / OpenAI / Gemini / DeepSeek / Kimi / Grok), key storage,
song-context builder, narration prompt + streaming parser.

Keys live in ~/.config/sonolens/llm.json (chmod 600) or the usual env vars; they are never sent to the browser.
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Iterator

import numpy as np

CONF = Path(os.environ.get("SONOLENS_CONFIG", Path.home() / ".config" / "sonolens" / "llm.json"))

# kind: "anthropic" uses the official Anthropic SDK; "openai" uses the OpenAI SDK against each vendor's
# OpenAI-compatible endpoint. Default model ids for non-Claude vendors change often – the UI can fetch
# the live list from each provider (/models) and the user can type any id.
PROVIDERS: dict[str, dict] = {
    "claude": {"name": "Claude", "vendor": "Anthropic", "kind": "anthropic", "base_url": "",
               "model": "claude-opus-5-5", "env": "ANTHROPIC_API_KEY",
               "suggest": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"],
               "console": "https://console.anthropic.com/settings/keys"},
    "openai": {"name": "OpenAI", "vendor": "OpenAI", "kind": "openai", "base_url": "https://api.openai.com/v1",
               "model": "gpt-5", "env": "OPENAI_API_KEY", "suggest": ["gpt-5", "gpt-5-mini"],
               "console": "https://platform.openai.com/api-keys"},
    "gemini": {"name": "Gemini", "vendor": "Google", "kind": "openai",
               "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
               "model": "gemini-2.5-pro", "env": "GEMINI_API_KEY", "suggest": ["gemini-2.5-pro", "gemini-2.5-flash"],
               "console": "https://aistudio.google.com/apikey"},
    "deepseek": {"name": "DeepSeek", "vendor": "深度求索", "kind": "openai", "base_url": "https://api.deepseek.com",
                 "model": "deepseek-chat", "env": "DEEPSEEK_API_KEY", "suggest": ["deepseek-chat", "deepseek-reasoner"],
                 "console": "https://platform.deepseek.com/api_keys"},
    "kimi": {"name": "Kimi", "vendor": "月之暗面 Moonshot", "kind": "openai", "base_url": "https://api.moonshot.cn/v1",
             "model": "kimi-k2-turbo-preview", "env": "MOONSHOT_API_KEY", "suggest": ["kimi-k2-turbo-preview", "kimi-latest"],
             "console": "https://platform.moonshot.cn/console/api-keys"},
    "grok": {"name": "Grok", "vendor": "xAI", "kind": "openai", "base_url": "https://api.x.ai/v1",
             "model": "grok-4", "env": "XAI_API_KEY", "suggest": ["grok-4", "grok-4-fast"],
             "console": "https://console.x.ai"},
}
# Claude models that take server-side refusal fallbacks + effort.
_CLAUDE_FALLBACK = ("claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5")
_CLAUDE_EFFORT = _CLAUDE_FALLBACK + ("claude-haiku-5-5", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7")


class LLMError(RuntimeError):
    pass


# ------------------------------------------------------------------------------------------ config
def load_conf() -> dict:
    try:
        c = json.loads(CONF.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        c = {}
    c.setdefault("active", "claude")
    c.setdefault("providers", {})
    return c


def save_conf(c: dict) -> None:
    CONF.parent.mkdir(parents=True, exist_ok=True)
    tmp = CONF.with_suffix(".tmp")
    tmp.write_text(json.dumps(c, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(CONF)


def _settings(pid: str, conf: dict | None = None) -> dict:
    if pid not in PROVIDERS:
        raise LLMError(f"未知的模型服务：{pid}")
    conf = conf or load_conf()
    p, u = PROVIDERS[pid], conf["providers"].get(pid, {})
    key = (u.get("api_key") or os.environ.get(p["env"]) or "").strip()
    return {"id": pid, **p, "api_key": key, "model": (u.get("model") or p["model"]).strip(),
            "base_url": (u.get("base_url") or p["base_url"]).strip(), "key_source": "saved" if u.get("api_key") else ("env" if key else "")}


def public_conf() -> dict:
    conf = load_conf()
    out = []
    for pid in PROVIDERS:
        s = _settings(pid, conf)
        k = s["api_key"]
        out.append({k2: s[k2] for k2 in ("id", "name", "vendor", "model", "base_url", "suggest", "console", "env", "key_source")}
                   | {"has_key": bool(k), "key_hint": (k[:4] + "…" + k[-4:]) if len(k) > 12 else ("已设置" if k else "")})
    return {"active": conf["active"], "providers": out, "path": str(CONF)}


def update_conf(body: dict) -> dict:
    conf = load_conf()
    if body.get("active") in PROVIDERS:
        conf["active"] = body["active"]
    for pid, v in (body.get("providers") or {}).items():
        if pid not in PROVIDERS or not isinstance(v, dict):
            continue
        cur = conf["providers"].setdefault(pid, {})
        for f in ("model", "base_url"):
            if f in v:
                cur[f] = str(v[f] or "").strip()
        if v.get("clear_key"):
            cur.pop("api_key", None)
        elif v.get("api_key"):
            cur["api_key"] = str(v["api_key"]).strip()
    save_conf(conf)
    return public_conf()


# ------------------------------------------------------------------------------------------ clients
def _client(s: dict):
    if s["kind"] == "anthropic":
        import anthropic
        kw = {"api_key": s["api_key"]} if s["api_key"] else {}   # no key → SDK resolves env / `ant auth login` profile
        if s["base_url"]:
            kw["base_url"] = s["base_url"]
        return anthropic.Anthropic(timeout=600.0, **kw)
    if not s["api_key"]:
        raise LLMError(f"{s['name']} 还没有设置 API Key（在「AI 设置」里填写，或设置环境变量 {s['env']}）")
    import openai
    return openai.OpenAI(api_key=s["api_key"], base_url=s["base_url"] or None, timeout=600.0)


def _friendly(e: Exception, s: dict) -> LLMError:
    name = type(e).__name__
    msg = getattr(e, "message", None) or str(e)
    if "resolve authentication" in msg:
        return LLMError(f"{s['name']} 还没有设置 API Key（在「AI 设置」里填写，或设置环境变量 {s['env']}）")
    if "Authentication" in name or "401" in msg:
        return LLMError(f"{s['name']}：API Key 无效或没有权限（{name}）")
    if "NotFound" in name or "404" in msg:
        return LLMError(f"{s['name']}：找不到模型 “{s['model']}”，请在设置里换一个模型 ID")
    if "RateLimit" in name or "429" in msg:
        return LLMError(f"{s['name']}：请求太频繁或额度不足（429），稍后再试")
    if "Connection" in name or "Timeout" in name:
        return LLMError(f"{s['name']}：连接失败，请检查网络 / 代理 / Base URL（{name}）")
    return LLMError(f"{s['name']}：{name}: {msg[:300]}")


def stream_text(pid: str | None, system: str, messages: list[dict], max_tokens: int = 16000,
                model: str | None = None) -> Iterator[str]:
    """Yield text deltas from the chosen provider. Raises LLMError with a readable message."""
    conf = load_conf()
    s = _settings(pid or conf["active"], conf)
    if model:
        s["model"] = model.strip()
    try:
        cli = _client(s)
        if s["kind"] == "anthropic":
            import anthropic
            m = s["model"]
            kw = dict(model=m, max_tokens=max_tokens, system=system, messages=messages)
            if m.startswith(_CLAUDE_EFFORT):
                kw["output_config"] = {"effort": "medium"}
            if m in _CLAUDE_FALLBACK:  # re-run on a fallback model if a safety classifier declines
                ctx = cli.beta.messages.stream(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kw)
            else:
                ctx = cli.messages.stream(**kw)
            with ctx as st:
                for t in st.text_stream:
                    yield t
                final = st.get_final_message()
            if final.stop_reason == "refusal":
                raise LLMError("Claude 拒绝了这次请求（refusal），可以换个风格或模型再试")
            if final.stop_reason == "max_tokens":
                yield "\n"
        else:
            msgs = [{"role": "system", "content": system}] + messages
            resp = cli.chat.completions.create(model=s["model"], messages=msgs, stream=True)
            for ch in resp:
                if not ch.choices:
                    continue
                d = ch.choices[0].delta
                if d and getattr(d, "content", None):
                    yield d.content
    except LLMError:
        raise
    except Exception as e:  # noqa: BLE001 – vendor SDK errors are mapped to a readable message
        raise _friendly(e, s) from e


def list_models(pid: str) -> list[str]:
    s = _settings(pid)
    try:
        cli = _client(s)
        ids = [m.id for m in cli.models.list()]
    except LLMError:
        raise
    except Exception as e:  # noqa: BLE001
        raise _friendly(e, s) from e
    ids = [i.removeprefix("models/") for i in ids]
    if s["kind"] == "openai":  # keep chat-capable families
        bad = ("embed", "tts", "whisper", "dall-e", "image", "audio", "moderation", "transcribe", "realtime", "search", "vision-preview", "aqa")
        ids = [i for i in ids if not any(b in i.lower() for b in bad)]
    return sorted(set(ids), key=lambda x: (x not in s["suggest"], x))


def ping(pid: str, model: str | None = None) -> dict:
    t0 = time.time()
    out = "".join(stream_text(pid, "Reply with exactly: OK", [{"role": "user", "content": "ping"}], max_tokens=2000, model=model))
    return {"ok": True, "reply": out.strip()[:80], "ms": int((time.time() - t0) * 1000)}


# ------------------------------------------------------------------------------------------ context
NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
STEM_CN = {"vocals": "人声", "drums": "鼓", "bass": "贝斯", "guitar": "吉他", "piano": "钢琴", "other": "其他乐器"}


def _mmss(t: float) -> str:
    t = max(0, float(t))
    return f"{int(t // 60)}:{int(t % 60):02d}"


def _series(d: dict | None):
    if not d or "v" not in d:
        return None
    v = np.asarray(d["v"], float)
    return d.get("t0", 0.0), d.get("dt", 0.1), v


def _at(sr, t):
    t0, dt, v = sr
    i = int(round((t - t0) / dt))
    return float(v[min(max(i, 0), len(v) - 1)])


def extract_events(A: dict) -> list[dict]:
    """Time-stamped musical events the narration should react to (≈ one every 5–8 s at most)."""
    ev: list[dict] = []
    dur = A["meta"]["duration"]
    chs = A.get("story", {}).get("chapters", [])
    for c in chs:
        ev.append({"t": c["start"], "kind": "chapter", "w": 3,
                   "what": f"第 {c['roman']} 章「{c.get('name', '')}」开始：{c.get('subtitle', '')}"})
    # stems entering / leaving (energy in dB per frame)
    for it in A.get("stems", {}).get("items", []):
        sr = _series(it.get("energy"))
        if not sr:
            continue
        t0, dt, v = sr
        thr = max(np.percentile(v, 90) - 24, -50)
        on = v > thr
        k = max(1, int(round(2.0 / dt)))
        # smooth: state must hold ≥2 s
        state, emitted, last = bool(on[0]), bool(on[0]), 0.0
        for i in range(1, len(on) - k):
            if on[i] != state and np.all(on[i:i + k] == on[i]):
                state = bool(on[i])
                t = t0 + i * dt
                if state != emitted and t - last > 6 and 2 < t < dur - 3:
                    emitted = state
                    nm = STEM_CN.get(it["name"], it["name"])
                    ev.append({"t": round(t, 1), "kind": "stem_in" if state else "stem_out", "w": 2,
                               "what": f"{nm}{'进入' if state else '退出'}"})
                    last = t
    # loudness jumps and the loudest moment
    st = _series(A.get("loudness", {}).get("short_term"))
    if st:
        t0, dt, v = st
        v = np.where(np.isfinite(v), v, -70)
        k = max(1, int(round(2.0 / dt)))
        last = -99.0
        for i in range(k, len(v)):
            d = v[i] - v[i - k]
            t = t0 + i * dt
            if abs(d) >= 6 and t - last > 6:
                ev.append({"t": round(t - 1, 1), "kind": "surge" if d > 0 else "drop", "w": 2,
                           "what": f"响度{'骤升' if d > 0 else '骤降'} {abs(d):.0f} dB（{v[i - k]:.0f} → {v[i]:.0f} LUFS）"})
                last = t
        i = int(np.argmax(v))
        ev.append({"t": round(t0 + i * dt, 1), "kind": "peak", "w": 2, "what": f"全曲最响处，短时响度 {v[i]:.1f} LUFS"})
    # key changes
    for ks in A.get("harmony", {}).get("key_segments", [])[1:]:
        ev.append({"t": ks["start"], "kind": "key", "w": 1, "what": f"调性转向 {ks.get('name_cn', ks.get('name'))}"})
    # first borrowed chord per chapter
    seen = set()
    for c in A.get("harmony", {}).get("chords", []):
        if c.get("function") == "X" and c["label"] not in seen:
            seen.add(c["label"])
            ev.append({"t": c["start"], "kind": "borrowed", "w": 1, "what": f"出现调外和弦 {c['label']}"})
    # thin out: keep high-weight events, min spacing 5 s, cap 36
    ev.sort(key=lambda e: (-e["w"], e["t"]))
    keep: list[dict] = []
    for e in ev:
        if all(abs(e["t"] - k2["t"]) >= (0.5 if e["kind"] == "chapter" or k2["kind"] == "chapter" else 5) for k2 in keep):
            keep.append(e)
        if len(keep) >= 36:
            break
    keep.sort(key=lambda e: e["t"])
    for e in keep:
        e.pop("w", None)
    return keep


def song_context(A: dict) -> str:
    m, R, H, L = A["meta"], A.get("rhythm", {}), A.get("harmony", {}), A.get("loudness", {})
    G = A.get("story", {}).get("global", {})
    lines = [f"# 曲目：{m.get('title') or m.get('file_name')}" + (f" — {m['artist']}" if m.get("artist") else ""),
             f"时长 {_mmss(m['duration'])}；{R.get('bpm')} BPM，{R.get('time_signature')}，{R.get('n_bars')} 小节；"
             f"摇摆比 {R.get('swing_ratio')}，速度波动 ±{R.get('tempo_stability_bpm_std')} BPM",
             f"调性 {H.get('key', {}).get('name_cn', '?')}（{H.get('key', {}).get('name', '')}），检测到 {H.get('modulations', 0)} 次可能的转调；"
             f"音域 {G.get('range', '')}",
             f"响度：综合 {L.get('integrated_lufs')} LUFS，LRA {L.get('lra')} LU，真峰值 {L.get('true_peak_dbtp')} dBTP，PLR {L.get('plr_db')} dB",
             "## 自动摘要"] + [f"- {s}" for s in A.get("summary", [])]
    lines.append("## 听感指标 (0–1)")
    lines.append("，".join(f"{d['label']} {d['value']}" for d in A.get("descriptors", [])))
    stems = A.get("stems", {}).get("items", [])
    if stems:
        lines.append("## 分轨能量占比")
        lines.append("，".join(f"{STEM_CN.get(s['name'], s['name'])} {s.get('energy_share', 0):.0f}%" for s in stems))
    cs = H.get("chord_stats", {})
    if cs.get("progressions"):
        lines.append("## 常见和弦进行")
        for p in cs["progressions"][:4]:
            ch = p.get("chords", p) if isinstance(p, dict) else p
            lines.append(f"- {' → '.join(ch) if isinstance(ch, list) else ch}" + (f"（{p['count']} 次）" if isinstance(p, dict) and p.get("count") else ""))
    lines.append("## 章节（由响度/频谱/结构自动划分）")
    for c in A.get("story", {}).get("chapters", []):
        mm = c.get("m", {})
        st = mm.get("stems") or {}
        top = "、".join(f"{STEM_CN.get(k, k)}{v:.0f}%" for k, v in sorted(st.items(), key=lambda x: -x[1])[:3] if v > 3)
        seq = " ".join((mm.get("chord_seq") or [])[:10])
        lines.append(
            f"- {c['roman']} {c.get('name', '')}（{c.get('subtitle', '')}）{_mmss(c['start'])}–{_mmss(c['end'])}："
            f"平均 {mm.get('lufs')} LUFS（{mm.get('lufs_start')}→{mm.get('lufs_end')}），频谱质心 {mm.get('centroid')} Hz，"
            f"低频(<150Hz)占比 {mm.get('low150')}%，音域 {NOTE[int(mm['range_lo']) % 12] + str(int(mm['range_lo']) // 12 - 1) if mm.get('range_lo') else '?'}"
            f"–{NOTE[int(mm['range_hi']) % 12] + str(int(mm['range_hi']) // 12 - 1) if mm.get('range_hi') else '?'}；"
            f"主要声部 {top or '—'}；和弦 {seq or '—'}" + (f"；调外和弦 {' '.join(mm['borrowed'])}" if mm.get("borrowed") else ""))
    return "\n".join(lines)


STYLES = {
    "pro": "专业乐评人：用准确的乐理与制作术语（和声功能、配器、动态、混音），但每个术语都落到听感上。",
    "easy": "通俗讲解：面向没学过乐理的听众，少用术语，多用比喻和画面感，让人一听就懂。",
    "poetic": "诗意叙述：像电影旁白一样有画面和情绪，但每一句都必须建立在给出的数据上，不编造。",
}

NARRATE_SYS = """你是「声镜 SonoLens」的音乐解说员。你会拿到一首歌的完整信号分析数据（全部由音频算法得出），
任务是为它写一份中文解析，并为可视化影院模式写逐时刻的实时解说字幕。

规则：
- 只依据给出的数据，不要编造歌手、歌词、年代、流派背景等数据里没有的事实；可以基于数据做合理的听感推断。
- 引用具体数字和时间点（如 1:23、-11 LUFS、120 BPM、Am→F）让解说有据可查。
- 严格按下面的标记格式输出，标记独占一行，不要输出任何其他标记或代码块：

@TITLE
一句话的标题（≤20 字）
@SUMMARY
全曲解析，Markdown，400–700 字：整体气质 → 结构与情绪走向 → 和声与旋律 → 节奏与律动 → 配器与制作/混音 → 值得反复听的瞬间（带时间点）。
@CHAPTER <罗马数字>
该章节 2–3 句解说（≤90 字），每个章节都要写，顺序与数据一致。
@MOMENT <m:ss>
一句实时解说字幕（≤36 字），用现在时，像现场解说一样说出“此刻发生了什么、为什么值得注意”。
（为「关键事件」列表里的每个事件写一条，时间点取事件时间，可略微合并相邻事件；额外可再补 3–6 条你认为重要的时刻。按时间顺序输出。）
@END"""


def narrate_messages(A: dict, style: str = "pro") -> tuple[str, list[dict]]:
    ev = extract_events(A)
    evs = "\n".join(f"- {_mmss(e['t'])}  {e['what']}" for e in ev)
    user = (f"{song_context(A)}\n\n## 关键事件（时间 · 事件）\n{evs}\n\n"
            f"解说风格：{STYLES.get(style, STYLES['pro'])}\n请开始输出。")
    return NARRATE_SYS, [{"role": "user", "content": user}]


_TAG = re.compile(r"^@(TITLE|SUMMARY|CHAPTER|MOMENT|END)\b\s*(.*)$")


def _t(s: str) -> float | None:
    m = re.match(r"\s*(\d+):(\d{1,2})(?:\.(\d+))?", s)
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2)) + (float("0." + m.group(3)) if m.group(3) else 0)


def parse_narration(text: str) -> dict:
    out = {"title": "", "summary": "", "chapters": {}, "moments": []}
    cur, arg, buf = None, "", []

    def flush():
        body = "\n".join(buf).strip()
        if cur == "TITLE":
            out["title"] = body.splitlines()[0].strip("#* ") if body else arg
        elif cur == "SUMMARY":
            out["summary"] = body
        elif cur == "CHAPTER" and arg:
            out["chapters"][arg.strip().strip("：:")] = body
        elif cur == "MOMENT":
            t = _t(arg)
            if t is not None and body:
                out["moments"].append({"t": t, "text": body.replace("\n", " ")})

    for ln in text.splitlines():
        m = _TAG.match(ln.strip())
        if m:
            flush()
            cur, arg, buf = m.group(1), m.group(2), []
            if cur == "TITLE" and arg:
                buf = [arg]
            if cur == "END":
                cur = None
        elif cur:
            buf.append(ln)
    flush()
    out["moments"].sort(key=lambda x: x["t"])
    return out


def chat_system(A: dict, narration: dict | None) -> str:
    s = ("你是「声镜 SonoLens」的音乐分析助手。下面是一首歌的完整信号分析数据（由音频算法得出）。"
         "用中文回答用户关于这首歌的问题：依据数据、引用时间点和数字，不编造数据里没有的事实；"
         "如果问题超出数据范围，诚实说明并给出基于听感的推测。回答简洁，必要时用 Markdown 列表。\n\n" + song_context(A))
    if narration and narration.get("summary"):
        s += "\n\n## 之前生成的全曲解析（供参考）\n" + narration["summary"][:3000]
    return s
