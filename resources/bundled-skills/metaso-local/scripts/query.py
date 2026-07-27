#!/usr/bin/env python3
"""Minimal Metaso AI search helper.

Usage:
  python query.py ask OpenAI 是什么
  python query.py ask 同花顺 --raw
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any


def eprint(*a: object) -> None:
    print(*a, file=sys.stderr)


def skill_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_dotenv() -> None:
    candidates = [
        os.path.join(skill_root(), ".env"),
        os.path.join(os.path.dirname(skill_root()), ".metaso.env"),
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


def maybe_reexec() -> None:
    try:
        import socket  # noqa: F401
    except Exception:
        local = os.environ.get("LOCALAPPDATA", "")
        better = os.path.join(local, "Programs", "Python", "Python312", "python.exe")
        if os.path.isfile(better) and os.path.abspath(better) != os.path.abspath(sys.executable):
            os.execv(better, [better, os.path.abspath(__file__), *sys.argv[1:]])


def ask(question: str, session_id: str | None = None) -> dict[str, Any]:
    if not os.environ.get("METASO_API_KEY"):
        raise RuntimeError("METASO_API_KEY not set")
    try:
        from metaso_sdk import Query, search
    except ImportError as exc:
        raise RuntimeError("metaso-sdk not installed. pip install metaso-sdk") from exc

    q = Query(question=question)
    if session_id:
        # SDK may accept sessionId on Query
        try:
            q = Query(question=question, sessionId=session_id)
        except TypeError:
            pass
    result = search(q)
    if hasattr(result, "model_dump"):
        data = result.model_dump()
    elif isinstance(result, dict):
        data = result
    else:
        data = {"raw": repr(result)}
    return data


def normalize(data: dict[str, Any]) -> dict[str, Any]:
    refs = data.get("references") or data.get("refs") or []
    ref_out = []
    if isinstance(refs, list):
        for r in refs:
            if isinstance(r, dict):
                ref_out.append(
                    {
                        "title": r.get("title") or r.get("name"),
                        "url": r.get("url") or r.get("link"),
                        "snippet": r.get("snippet") or r.get("summary"),
                    }
                )
            else:
                ref_out.append({"value": str(r)})
    return {
        "backend": "metaso",
        "text": data.get("text") or data.get("answer") or data.get("content"),
        "sessionId": data.get("sessionId"),
        "resultId": data.get("resultId"),
        "balance": data.get("balance"),
        "references": ref_out,
    }


def main() -> int:
    maybe_reexec()
    load_dotenv()
    p = argparse.ArgumentParser(description="Metaso AI search")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("ask", help="Ask Metaso a research question")
    a.add_argument("question", nargs="+")
    a.add_argument("--session", default=None)
    a.add_argument("--raw", action="store_true")
    args = p.parse_args()
    try:
        q = " ".join(args.question).strip()
        raw = ask(q, args.session)
        out = raw if args.raw else normalize(raw)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        eprint(f"Error: {exc}")
        print(json.dumps({"error": str(exc), "backend": "metaso"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
