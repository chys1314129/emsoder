#!/usr/bin/env python3
"""media-search: news / images / videos split-channel search (Route A).

Backends:
  news   -> Tavily (--topic news)
  images -> Tavily (--include-images)
  videos -> YouTube (yt-dlp) + Bilibili (bili), optional

Usage:
  python query.py news   OpenAI API  --num 8 --time week
  python query.py images OpenAI logo --num 6 --with-desc
  python query.py videos OpenAI      --num 5 --source all
  python query.py all    OpenAI      --num 5
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from typing import Any

DEFAULT_NUM = 8
TVLY_CANDIDATES = [
    r"C:\Users\Admin\AppData\Local\Programs\Python\Python312\Scripts\tvly.exe",
    r"C:\Users\Admin\AppData\Local\Programs\Python\Python312\Scripts\tvly",
]
YTDLP_CANDIDATES = [
    r"C:\Users\Admin\AppData\Local\Programs\Python\Python312\Scripts\yt-dlp.exe",
    r"C:\Users\Admin\AppData\Local\Programs\Python\Python312\Scripts\yt-dlp",
]
BILI_CANDIDATES = [
    os.path.expanduser("~/.local/bin/bili"),
    r"C:\Users\Admin\.local\bin\bili",
]


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def skill_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_dotenv() -> None:
    """Load TAVILY_API_KEY etc. from skill / shared env files."""
    candidates = [
        os.path.join(skill_root(), ".env"),
        os.path.join(os.path.dirname(skill_root()), ".tavily.env"),
        os.path.join(os.path.dirname(skill_root()), "tavily-search", ".env"),
    ]
    for env_path in candidates:
        if not os.path.isfile(env_path):
            continue
        try:
            with open(env_path, "r", encoding="utf-8") as fh:
                for raw in fh:
                    line = raw.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, value = line.split("=", 1)
                    key = key.strip()
                    value = value.strip().strip('"').strip("'")
                    if key and (key not in os.environ or not os.environ.get(key)):
                        os.environ[key] = value
        except OSError as exc:
            eprint(f"[warn] failed to read {env_path}: {exc}")


def sockets_work() -> bool:
    try:
        import socket  # noqa: F401

        return hasattr(socket, "socket")
    except Exception:
        return False


def resolve_python() -> str:
    candidates = []
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA", "")
        if local:
            candidates.append(
                os.path.join(local, "Programs", "Python", "Python312", "python.exe")
            )
            candidates.append(
                os.path.join(local, "Programs", "Python", "Python311", "python.exe")
            )
    for name in ("python", "python3"):
        found = shutil.which(name)
        if found:
            candidates.append(found)
    for path in candidates:
        if path and os.path.isfile(path) and os.path.abspath(path) != os.path.abspath(
            sys.executable
        ):
            return path
    return sys.executable


def maybe_reexec() -> None:
    if sockets_work():
        return
    better = resolve_python()
    if os.path.abspath(better) == os.path.abspath(sys.executable):
        return
    try:
        probe = subprocess.run(
            [better, "-c", "import socket, json"],
            capture_output=True,
            timeout=10,
        )
        if probe.returncode != 0:
            return
    except Exception:
        return
    os.execv(better, [better, os.path.abspath(__file__), *sys.argv[1:]])


def which_cmd(name: str, extra: list[str] | None = None) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    for path in extra or []:
        if path and os.path.isfile(path):
            return path
    return None


def run_cmd(
    argv: list[str],
    timeout: int = 90,
    env: dict[str, str] | None = None,
) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=env,
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except FileNotFoundError as exc:
        return 127, "", str(exc)
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s: {' '.join(argv[:4])}"


def join_query(parts: list[str]) -> str:
    return " ".join(parts).strip()


def emit(payload: dict[str, Any]) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if not payload.get("error") else 1


def tavily_env() -> dict[str, str]:
    env = os.environ.copy()
    # Prefer system Scripts on PATH for child tools
    scripts = r"C:\Users\Admin\AppData\Local\Programs\Python\Python312\Scripts"
    path = env.get("PATH", "")
    if scripts not in path:
        env["PATH"] = scripts + os.pathsep + path
    return env


def ensure_tvly() -> str:
    tvly = which_cmd("tvly", TVLY_CANDIDATES)
    if not tvly:
        raise RuntimeError(
            "tvly not found. Install: pip install tavily-cli && tvly login --api-key tvly-..."
        )
    return tvly


def parse_json_output(raw: str) -> Any:
    text = raw.strip()
    if not text:
        raise RuntimeError("empty JSON output from backend")
    # Some tools may print logs before JSON — take last JSON object/array.
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    for opener, closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        end = text.rfind(closer)
        if start != -1 and end != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                continue
    raise RuntimeError(f"failed to parse JSON:\n{text[:500]}")


def cmd_news(args: argparse.Namespace) -> int:
    query = join_query(args.query)
    if not query:
        return emit({"error": "news requires a query", "channel": "news"})

    tvly = ensure_tvly()
    num = max(1, min(int(args.num), 20))
    argv = [
        tvly,
        "search",
        query,
        "--topic",
        "news",
        "--max-results",
        str(num),
        "--json",
    ]
    if args.time:
        argv.extend(["--time-range", args.time])
    if args.depth:
        argv.extend(["--depth", args.depth])

    code, out, err = run_cmd(argv, timeout=90, env=tavily_env())
    if code != 0:
        return emit(
            {
                "channel": "news",
                "query": query,
                "backend": "tavily",
                "error": err.strip() or out.strip() or f"tvly exit {code}",
            }
        )

    data = parse_json_output(out)
    results = []
    for item in data.get("results") or []:
        results.append(
            {
                "title": item.get("title"),
                "url": item.get("url"),
                "snippet": item.get("content"),
                "published_date": item.get("published_date"),
                "score": item.get("score"),
            }
        )

    return emit(
        {
            "channel": "news",
            "query": query,
            "backend": "tavily",
            "count": len(results),
            "results": results,
            "raw_answer": data.get("answer"),
        }
    )


def cmd_images(args: argparse.Namespace) -> int:
    query = join_query(args.query)
    if not query:
        return emit({"error": "images requires a query", "channel": "images"})

    tvly = ensure_tvly()
    num = max(1, min(int(args.num), 20))
    argv = [
        tvly,
        "search",
        query,
        "--topic",
        "general",
        "--max-results",
        str(num),
        "--include-images",
        "--json",
    ]
    if args.with_desc:
        argv.append("--include-image-descriptions")
    if args.depth:
        argv.extend(["--depth", args.depth])

    code, out, err = run_cmd(argv, timeout=90, env=tavily_env())
    if code != 0:
        return emit(
            {
                "channel": "images",
                "query": query,
                "backend": "tavily",
                "error": err.strip() or out.strip() or f"tvly exit {code}",
            }
        )

    data = parse_json_output(out)
    images: list[dict[str, Any]] = []
    raw_images = data.get("images") or []

    # Tavily may return list[str] or list[dict]
    for entry in raw_images:
        if isinstance(entry, str):
            images.append({"url": entry, "description": None})
        elif isinstance(entry, dict):
            images.append(
                {
                    "url": entry.get("url") or entry.get("src") or entry.get("image"),
                    "description": entry.get("description")
                    or entry.get("desc")
                    or entry.get("alt"),
                }
            )

    # Also harvest image-like urls from result content if images array empty
    if not images:
        for item in data.get("results") or []:
            content = item.get("content") or ""
            for m in re.findall(r"https?://[^\s\)\"']+\.(?:png|jpg|jpeg|gif|webp)", content, re.I):
                images.append({"url": m, "description": item.get("title")})

    # Dedupe by url
    seen = set()
    deduped = []
    for img in images:
        u = img.get("url")
        if not u or u in seen:
            continue
        seen.add(u)
        deduped.append(img)

    pages = []
    for item in data.get("results") or []:
        pages.append(
            {
                "title": item.get("title"),
                "url": item.get("url"),
                "snippet": item.get("content"),
                "score": item.get("score"),
            }
        )

    return emit(
        {
            "channel": "images",
            "query": query,
            "backend": "tavily",
            "count": len(deduped),
            "images": deduped[: max(num * 3, num)],
            "pages": pages,
        }
    )


def youtube_search(query: str, num: int) -> dict[str, Any]:
    ytdlp = which_cmd("yt-dlp", YTDLP_CANDIDATES)
    if not ytdlp:
        return {
            "backend": "youtube",
            "error": "yt-dlp not found. Install: pip install yt-dlp",
            "results": [],
        }

    # Prefer JSON lines via --print for flat search
    fmt = (
        "%(.{id,title,webpage_url,duration,uploader,view_count,description})j"
    )
    # yt-dlp print format with dict may vary; use simple fields then
    argv = [
        ytdlp,
        f"ytsearch{num}:{query}",
        "--flat-playlist",
        "--skip-download",
        "--print",
        "%(id)s\t%(title)s\t%(webpage_url)s\t%(duration)s\t%(uploader)s\t%(view_count)s",
    ]
    code, out, err = run_cmd(argv, timeout=120, env=tavily_env())
    if code != 0 and not out.strip():
        return {
            "backend": "youtube",
            "error": err.strip() or f"yt-dlp exit {code}",
            "results": [],
        }

    raw_results = []
    for line in out.splitlines():
        line = line.strip()
        if not line or line.startswith("WARNING") or line.startswith("ERROR"):
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        vid = parts[0]
        title = parts[1] if len(parts) > 1 else None
        url = parts[2] if len(parts) > 2 else f"https://www.youtube.com/watch?v={vid}"
        duration = parts[3] if len(parts) > 3 else None
        uploader = parts[4] if len(parts) > 4 else None
        views = parts[5] if len(parts) > 5 else None
        if duration in ("NA", "None", ""):
            duration = None
        if views in ("NA", "None", ""):
            views = None
        kind = "video"
        if url and "/channel/" in url:
            kind = "channel"
        elif url and "/playlist" in url:
            kind = "playlist"
        raw_results.append(
            {
                "platform": "youtube",
                "id": vid,
                "title": title,
                "url": url,
                "duration": duration,
                "author": uploader,
                "views": views,
                "kind": kind,
            }
        )

    # Prefer actual videos; keep channels only if nothing else
    videos = [r for r in raw_results if r.get("kind") == "video"]
    results = videos if videos else raw_results
    for r in results:
        r.pop("kind", None)

    return {
        "backend": "youtube",
        "count": len(results),
        "results": results,
        "warning": err.strip() or None,
    }


def bilibili_search(query: str, num: int) -> dict[str, Any]:
    bili = which_cmd("bili", BILI_CANDIDATES)
    if not bili:
        return {
            "backend": "bilibili",
            "error": "bili not found (optional for CN video)",
            "results": [],
        }

    argv = [
        bili,
        "search",
        query,
        "--type",
        "video",
        "-n",
        str(num),
        "--json",
    ]
    code, out, err = run_cmd(argv, timeout=60, env=tavily_env())
    if code != 0 and not out.strip():
        return {
            "backend": "bilibili",
            "error": err.strip() or f"bili exit {code}",
            "results": [],
        }

    try:
        data = parse_json_output(out)
    except RuntimeError as exc:
        return {"backend": "bilibili", "error": str(exc), "results": []}

    items = data.get("data") if isinstance(data, dict) else data
    if not isinstance(items, list):
        # some versions nest differently
        if isinstance(data, dict):
            items = data.get("results") or data.get("items") or []
        else:
            items = []

    results = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        bvid = item.get("bvid") or item.get("id")
        url = None
        if bvid:
            url = f"https://www.bilibili.com/video/{bvid}"
        results.append(
            {
                "platform": "bilibili",
                "id": bvid,
                "title": item.get("title"),
                "url": url,
                "duration": item.get("duration"),
                "author": item.get("author") or item.get("owner"),
                "views": item.get("play") or item.get("view"),
            }
        )

    return {
        "backend": "bilibili",
        "count": len(results),
        "results": results,
        "warning": err.strip() or None,
    }


def cmd_videos(args: argparse.Namespace) -> int:
    query = join_query(args.query)
    if not query:
        return emit({"error": "videos requires a query", "channel": "videos"})

    num = max(1, min(int(args.num), 20))
    source = (args.source or "all").lower()
    buckets: list[dict[str, Any]] = []
    merged: list[dict[str, Any]] = []

    if source in ("youtube", "yt", "all"):
        yt = youtube_search(query, num)
        buckets.append(yt)
        merged.extend(yt.get("results") or [])

    if source in ("bilibili", "bili", "all"):
        bl = bilibili_search(query, num)
        buckets.append(bl)
        merged.extend(bl.get("results") or [])

    errors = [b.get("error") for b in buckets if b.get("error")]
    if not merged and errors:
        return emit(
            {
                "channel": "videos",
                "query": query,
                "source": source,
                "error": "; ".join(str(e) for e in errors),
                "backends": buckets,
                "results": [],
            }
        )

    return emit(
        {
            "channel": "videos",
            "query": query,
            "source": source,
            "count": len(merged),
            "results": merged,
            "backends": [
                {
                    "backend": b.get("backend"),
                    "count": b.get("count", len(b.get("results") or [])),
                    "error": b.get("error"),
                    "warning": b.get("warning"),
                }
                for b in buckets
            ],
        }
    )


def cmd_all(args: argparse.Namespace) -> int:
    query = join_query(args.query)
    if not query:
        return emit({"error": "all requires a query", "channel": "all"})

    # Reuse namespaces lightly
    news_args = argparse.Namespace(
        query=args.query, num=args.num, time=args.time, depth=args.depth
    )
    img_args = argparse.Namespace(
        query=args.query, num=args.num, with_desc=args.with_desc, depth=args.depth
    )
    vid_args = argparse.Namespace(
        query=args.query, num=args.num, source=args.source or "all"
    )

    # Capture by calling functions that print — better refactor to return dicts.
    # Minimal change: run subprocess self for isolation? Simpler: internal helpers.

    def capture(fn, ns) -> dict[str, Any]:
        from io import StringIO
        import contextlib

        buf = StringIO()
        with contextlib.redirect_stdout(buf):
            code = fn(ns)
        try:
            payload = json.loads(buf.getvalue())
        except json.JSONDecodeError:
            payload = {"error": "failed to parse subcommand output", "raw": buf.getvalue()}
        payload["_exit"] = code
        return payload

    news = capture(cmd_news, news_args)
    images = capture(cmd_images, img_args)
    videos = capture(cmd_videos, vid_args)

    return emit(
        {
            "channel": "all",
            "query": query,
            "news": news,
            "images": images,
            "videos": videos,
        }
    )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Split-channel media search: news / images / videos"
    )
    sub = p.add_subparsers(dest="command", required=True)

    def add_query(sp: argparse.ArgumentParser) -> None:
        sp.add_argument(
            "query",
            nargs="+",
            help="Search query (shell may split words; they are joined)",
        )

    n = sub.add_parser("news", help="News search via Tavily")
    add_query(n)
    n.add_argument("--num", type=int, default=DEFAULT_NUM)
    n.add_argument(
        "--time",
        choices=["day", "week", "month", "year"],
        default=None,
        help="Relative time filter",
    )
    n.add_argument(
        "--depth",
        choices=["ultra-fast", "fast", "basic", "advanced"],
        default=None,
    )

    i = sub.add_parser("images", help="Image search via Tavily")
    add_query(i)
    i.add_argument("--num", type=int, default=DEFAULT_NUM)
    i.add_argument(
        "--with-desc",
        action="store_true",
        help="Ask Tavily for image descriptions",
    )
    i.add_argument(
        "--depth",
        choices=["ultra-fast", "fast", "basic", "advanced"],
        default=None,
    )

    v = sub.add_parser("videos", help="Video search via YouTube + Bilibili")
    add_query(v)
    v.add_argument("--num", type=int, default=5)
    v.add_argument(
        "--source",
        choices=["all", "youtube", "yt", "bilibili", "bili"],
        default="all",
        help="Video backend(s)",
    )

    a = sub.add_parser("all", help="Run news + images + videos together")
    add_query(a)
    a.add_argument("--num", type=int, default=5)
    a.add_argument(
        "--time",
        choices=["day", "week", "month", "year"],
        default="week",
    )
    a.add_argument("--with-desc", action="store_true")
    a.add_argument(
        "--source",
        choices=["all", "youtube", "yt", "bilibili", "bili"],
        default="all",
    )
    a.add_argument(
        "--depth",
        choices=["ultra-fast", "fast", "basic", "advanced"],
        default=None,
    )

    return p


def main() -> int:
    maybe_reexec()
    load_dotenv()
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "news":
            return cmd_news(args)
        if args.command == "images":
            return cmd_images(args)
        if args.command == "videos":
            return cmd_videos(args)
        if args.command == "all":
            return cmd_all(args)
        parser.error(f"unknown command: {args.command}")
        return 2
    except Exception as exc:
        eprint(f"Error: {exc}")
        return emit({"error": str(exc), "channel": getattr(args, "command", None)})


if __name__ == "__main__":
    sys.exit(main())
