#!/usr/bin/env python3
"""Minimal Bocha web-search helper.

Usage:
  python query.py search OpenAI --num 5 --freshness oneWeek
  python query.py search 阿里巴巴 ESG --summary
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from typing import Any

ENDPOINTS = [
    "https://api.bocha.cn/v1/web-search",
    "https://api.bochaai.com/v1/web-search",
]


def eprint(*a: object) -> None:
    print(*a, file=sys.stderr)


def skill_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_dotenv() -> None:
    candidates = [
        os.path.join(skill_root(), ".env"),
        os.path.join(os.path.dirname(skill_root()), ".bocha.env"),
        os.path.join(os.path.dirname(skill_root()), "bocha-web-search", ".env"),
    ]
    for path in candidates:
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as fh:
                for raw in fh:
                    line = raw.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip().strip('"').strip("'")
                    if k and not os.environ.get(k):
                        os.environ[k] = v
        except OSError:
            pass


def sockets_work() -> bool:
    try:
        import socket  # noqa: F401

        return True
    except Exception:
        return False


def maybe_reexec() -> None:
    if sockets_work():
        return
    local = os.environ.get("LOCALAPPDATA", "")
    better = os.path.join(local, "Programs", "Python", "Python312", "python.exe")
    if os.path.isfile(better) and os.path.abspath(better) != os.path.abspath(sys.executable):
        os.execv(better, [better, os.path.abspath(__file__), *sys.argv[1:]])


def http_post(url: str, headers: dict[str, str], body: dict[str, Any], timeout: int = 45) -> dict[str, Any]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    if sockets_work():
        import urllib.error
        import urllib.request

        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8", errors="replace"))
        except urllib.error.HTTPError as exc:
            err = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {err[:1000]}") from exc

    curl = shutil.which("curl")
    if not curl:
        raise RuntimeError("no urllib sockets and no curl")
    cmd = [curl, "-sS", "-m", str(timeout), "-X", "POST", url]
    for k, v in headers.items():
        cmd.extend(["-H", f"{k}: {v}"])
    cmd.extend(["-d", json.dumps(body, ensure_ascii=False)])
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr or proc.stdout[:500])
    return json.loads(proc.stdout)


def search(query: str, count: int, freshness: str, summary: bool) -> dict[str, Any]:
    key = os.environ.get("BOCHA_API_KEY") or os.environ.get("BOCHA_KEY")
    if not key:
        raise RuntimeError("BOCHA_API_KEY not set")
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    body = {
        "query": query,
        "freshness": freshness,
        "count": max(1, min(count, 50)),
        "summary": summary,
    }
    last_err: Exception | None = None
    for url in ENDPOINTS:
        try:
            data = http_post(url, headers, body)
            data["_endpoint"] = url
            return data
        except Exception as exc:
            last_err = exc
            eprint(f"[warn] {url} failed: {exc}")
    raise RuntimeError(str(last_err) if last_err else "all endpoints failed")


def normalize(data: dict[str, Any]) -> dict[str, Any]:
    payload = data.get("data") if isinstance(data.get("data"), dict) else data
    web = (payload.get("webPages") or {}).get("value") or []
    images = (payload.get("images") or {}).get("value") or payload.get("images") or []
    results = []
    for item in web:
        if not isinstance(item, dict):
            continue
        results.append(
            {
                "title": item.get("name") or item.get("title"),
                "url": item.get("url"),
                "snippet": item.get("snippet") or item.get("summary"),
                "summary": item.get("summary"),
                "site": item.get("siteName"),
                "date": item.get("datePublished") or item.get("dateLastCrawled"),
            }
        )
    img_out = []
    if isinstance(images, list):
        for img in images:
            if isinstance(img, str):
                img_out.append({"url": img})
            elif isinstance(img, dict):
                img_out.append(
                    {
                        "url": img.get("contentUrl") or img.get("url") or img.get("thumbnailUrl"),
                        "name": img.get("name") or img.get("hostPageDisplayUrl"),
                    }
                )
    return {
        "backend": "bocha",
        "query": (payload.get("queryContext") or {}).get("originalQuery"),
        "endpoint": data.get("_endpoint"),
        "code": data.get("code"),
        "count": len(results),
        "results": results,
        "images": img_out,
    }


def main() -> int:
    maybe_reexec()
    load_dotenv()
    p = argparse.ArgumentParser(description="Bocha web search")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search")
    s.add_argument("query", nargs="+")
    s.add_argument("--num", type=int, default=8)
    s.add_argument(
        "--freshness",
        default="noLimit",
        choices=["noLimit", "oneDay", "oneWeek", "oneMonth", "oneYear"],
    )
    s.add_argument("--summary", action="store_true", default=True)
    s.add_argument("--no-summary", action="store_true")
    s.add_argument("--raw", action="store_true")
    args = p.parse_args()
    try:
        q = " ".join(args.query).strip()
        summary = False if args.no_summary else True
        raw = search(q, args.num, args.freshness, summary)
        out = raw if args.raw else normalize(raw)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        eprint(f"Error: {exc}")
        print(json.dumps({"error": str(exc), "backend": "bocha"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
