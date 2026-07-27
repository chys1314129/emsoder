#!/usr/bin/env python3
"""Exa MCP client for the exa-search skill.

Usage:
  python query.py list_tools
  python query.py call_tool <tool_name> '<json_args>'
  python query.py search '<query>' [--num 5]
  python query.py fetch <url> [url2 ...] [--max-chars 3000]
  python query.py advanced '<query>' [--num 5] [--domain d] [--category c] ...

Environment:
  EXA_API_KEY   optional; improves rate limits / reliability
  EXA_MCP_URL   override MCP endpoint (default https://mcp.exa.ai/mcp)
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from typing import Any

# urllib is imported lazily after maybe_reexec(), because some embedded
# Python builds ship a broken _socket and fail on `import urllib.request`.

DEFAULT_MCP_URL = "https://mcp.exa.ai/mcp"
DEFAULT_TIMEOUT = 60

# Optional tools must be requested via the tools= query param on the MCP URL.
OPTIONAL_TOOLS = {
    "web_search_advanced_exa",
    "get_code_context_exa",
    "crawling_exa",
    "company_research_exa",
    "linkedin_search_exa",
    "deep_researcher_start",
    "deep_researcher_check",
}


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def skill_root() -> str:
    # .../EXA搜索/scripts/query.py -> .../EXA搜索
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_dotenv() -> None:
    """Load KEY=VALUE pairs from skill .env if process env is missing them."""
    env_path = os.path.join(skill_root(), ".env")
    if not os.path.isfile(env_path):
        return
    try:
        with open(env_path, "r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if not key:
                    continue
                # Do not override an already-exported environment variable.
                if key not in os.environ or not os.environ.get(key):
                    os.environ[key] = value
    except OSError as exc:
        eprint(f"[warn] failed to read {env_path}: {exc}")


def resolve_python() -> str:
    """Prefer a system Python with working sockets over broken embedded ones."""
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
        candidates.append(r"C:\Python312\python.exe")
        candidates.append(r"C:\Python311\python.exe")
    # Also try PATH python outside this process
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


def sockets_work() -> bool:
    try:
        import socket  # noqa: F401

        return hasattr(socket, "socket")
    except Exception:
        return False


def maybe_reexec() -> None:
    """If current interpreter lacks sockets, re-exec with a better Python."""
    if sockets_work():
        return
    better = resolve_python()
    if os.path.abspath(better) == os.path.abspath(sys.executable):
        return
    try:
        probe = subprocess.run(
            [better, "-c", "import socket, urllib.request"],
            capture_output=True,
            timeout=10,
        )
        if probe.returncode != 0:
            return
    except Exception:
        return
    os.execv(better, [better, os.path.abspath(__file__), *sys.argv[1:]])


def urlencode(query: dict[str, str]) -> str:
    from urllib.parse import urlencode as _urlencode

    return _urlencode(query)


def base_url() -> str:
    return os.environ.get("EXA_MCP_URL", DEFAULT_MCP_URL).rstrip("/")


def mcp_url_for_tool(tool_name: str | None = None) -> str:
    url = base_url()
    if tool_name and tool_name in OPTIONAL_TOOLS:
        sep = "&" if "?" in url else "?"
        return f"{url}{sep}{urlencode({'tools': tool_name})}"
    return url


def build_headers() -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    api_key = os.environ.get("EXA_API_KEY")
    if api_key:
        headers["x-api-key"] = api_key
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def parse_mcp_response(raw: str) -> Any:
    """Parse JSON-RPC response; supports plain JSON and SSE event streams."""
    raw = raw.strip()
    if not raw:
        raise RuntimeError("Empty response from Exa MCP")

    # SSE: event: message\ndata: {...}\n\n
    if "data:" in raw and (raw.startswith("event:") or "\ndata:" in raw):
        payloads = []
        for line in raw.splitlines():
            if line.startswith("data:"):
                payloads.append(line[5:].strip())
        if not payloads:
            raise RuntimeError(f"SSE response had no data lines:\n{raw[:500]}")
        # Prefer last non-empty data payload
        text = next((p for p in reversed(payloads) if p), payloads[-1])
        return json.loads(text)

    return json.loads(raw)


def http_post_urllib(url: str, body: dict[str, Any], timeout: int) -> Any:
    import urllib.error
    import urllib.request

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers=build_headers(), method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {err_body[:2000]}") from exc
    return parse_mcp_response(raw)


def http_post_curl(url: str, body: dict[str, Any], timeout: int) -> Any:
    curl = shutil.which("curl")
    if not curl:
        raise RuntimeError("Neither working urllib nor curl is available")

    cmd = [
        curl,
        "-sS",
        "-m",
        str(timeout),
        "-X",
        "POST",
        url,
        "-H",
        "Content-Type: application/json",
        "-H",
        "Accept: application/json, text/event-stream",
    ]
    api_key = os.environ.get("EXA_API_KEY")
    if api_key:
        cmd.extend(["-H", f"x-api-key: {api_key}"])
        cmd.extend(["-H", f"Authorization: Bearer {api_key}"])
    cmd.extend(["-d", json.dumps(body, ensure_ascii=False)])

    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        raise RuntimeError(
            f"curl failed ({proc.returncode}): {proc.stderr.strip() or proc.stdout[:500]}"
        )
    return parse_mcp_response(proc.stdout)


def rpc(method: str, params: dict[str, Any] | None = None, tool_name: str | None = None) -> Any:
    body: dict[str, Any] = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params or {},
    }
    url = mcp_url_for_tool(tool_name)
    timeout = int(os.environ.get("EXA_TIMEOUT", DEFAULT_TIMEOUT))

    if sockets_work():
        try:
            return http_post_urllib(url, body, timeout)
        except Exception as exc:
            eprint(f"[warn] urllib failed ({exc}); falling back to curl")
    return http_post_curl(url, body, timeout)


def unwrap_result(payload: Any) -> Any:
    if not isinstance(payload, dict):
        return payload
    if "error" in payload:
        err = payload["error"]
        raise RuntimeError(json.dumps(err, ensure_ascii=False, indent=2))
    return payload.get("result", payload)


def cmd_list_tools(_args: argparse.Namespace) -> int:
    # Default tools + try to surface advanced when useful
    result = unwrap_result(rpc("tools/list"))
    tools = result.get("tools", []) if isinstance(result, dict) else []

    # Also probe advanced endpoint so the skill can report optional tools.
    try:
        adv = unwrap_result(
            rpc("tools/list", tool_name="web_search_advanced_exa")
        )
        adv_tools = adv.get("tools", []) if isinstance(adv, dict) else []
        names = {t.get("name") for t in tools if isinstance(t, dict)}
        for t in adv_tools:
            if isinstance(t, dict) and t.get("name") not in names:
                tools.append(t)
                names.add(t.get("name"))
    except Exception as exc:
        eprint(f"[info] optional tools probe skipped: {exc}")

    print(json.dumps({"tools": tools}, ensure_ascii=False, indent=2))
    return 0


def _join_query(parts: list[str]) -> str:
    """Join split query tokens (Git Bash -> Windows Python often breaks quotes)."""
    return " ".join(parts).strip()


def _parse_json_object(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if not text:
        return {}
    # Tolerate outer single quotes left by shells: '{"a":1}'
    if (text.startswith("'") and text.endswith("'")) or (
        text.startswith('"') and text.endswith('"') and text.count('"') == 2
    ):
        text = text[1:-1]
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        # Last resort: if shell stripped quotes around keys, fail clearly
        raise
    if not isinstance(value, dict):
        raise ValueError("Tool arguments must be a JSON object")
    return value


def cmd_call_tool(args: argparse.Namespace) -> int:
    tool = args.tool_name
    if args.args_file:
        if args.args_file == "-":
            raw_args = sys.stdin.read()
        else:
            with open(args.args_file, "r", encoding="utf-8") as fh:
                raw_args = fh.read()
    elif args.arguments:
        raw_args = _join_query(args.arguments)
    else:
        # Allow: python query.py call_tool web_search_exa < args.json
        if not sys.stdin.isatty():
            raw_args = sys.stdin.read()
        else:
            raw_args = "{}"
    try:
        arguments = _parse_json_object(raw_args)
    except (json.JSONDecodeError, ValueError) as exc:
        eprint(f"Invalid JSON arguments: {exc}")
        eprint(
            "Tip (Windows/Git Bash): use --args-file path.json "
            "or: echo '{...}' | python query.py call_tool TOOL --args-file -"
        )
        return 2

    result = unwrap_result(
        rpc(
            "tools/call",
            {"name": tool, "arguments": arguments},
            tool_name=tool,
        )
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    query = _join_query(args.query)
    if not query:
        eprint("search requires a non-empty query")
        return 2
    arguments: dict[str, Any] = {"query": query}
    if args.num is not None:
        arguments["numResults"] = args.num
    result = unwrap_result(
        rpc(
            "tools/call",
            {"name": "web_search_exa", "arguments": arguments},
            tool_name="web_search_exa",
        )
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_fetch(args: argparse.Namespace) -> int:
    arguments: dict[str, Any] = {"urls": args.urls}
    if args.max_chars is not None:
        arguments["maxCharacters"] = args.max_chars
    result = unwrap_result(
        rpc(
            "tools/call",
            {"name": "web_fetch_exa", "arguments": arguments},
            tool_name="web_fetch_exa",
        )
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_advanced(args: argparse.Namespace) -> int:
    query = _join_query(args.query)
    if not query:
        eprint("advanced requires a non-empty query")
        return 2
    arguments: dict[str, Any] = {"query": query}
    if args.num is not None:
        arguments["numResults"] = args.num
    if args.type:
        arguments["type"] = args.type
    if args.category:
        arguments["category"] = args.category
    if args.domain:
        arguments["includeDomains"] = args.domain
    if args.exclude_domain:
        arguments["excludeDomains"] = args.exclude_domain
    if args.start_published:
        arguments["startPublishedDate"] = args.start_published
    if args.end_published:
        arguments["endPublishedDate"] = args.end_published
    if args.highlights:
        arguments["enableHighlights"] = True
    if args.summary:
        arguments["enableSummary"] = True

    result = unwrap_result(
        rpc(
            "tools/call",
            {"name": "web_search_advanced_exa", "arguments": arguments},
            tool_name="web_search_advanced_exa",
        )
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Exa MCP query helper")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("list_tools", help="List tools exposed by Exa MCP")

    c = sub.add_parser("call_tool", help="Call a tool by name with JSON args")
    c.add_argument("tool_name")
    c.add_argument(
        "arguments",
        nargs="*",
        default=[],
        help='JSON object args, e.g. {"query":"x","numResults":5}',
    )
    c.add_argument(
        "--args-file",
        default=None,
        help="Read JSON arguments from a file (avoids shell quoting issues)",
    )

    s = sub.add_parser("search", help="Shortcut for web_search_exa")
    s.add_argument("query", nargs="+", help="Search query (words may be split by shell)")
    s.add_argument("--num", type=int, default=5)

    f = sub.add_parser("fetch", help="Shortcut for web_fetch_exa")
    f.add_argument("urls", nargs="+")
    f.add_argument("--max-chars", type=int, default=None)

    a = sub.add_parser("advanced", help="Shortcut for web_search_advanced_exa")
    a.add_argument("query", nargs="+", help="Search query (words may be split by shell)")
    a.add_argument("--num", type=int, default=5)
    a.add_argument("--type", choices=["auto", "fast", "instant"], default=None)
    a.add_argument("--category", default=None)
    a.add_argument("--domain", action="append", default=None)
    a.add_argument("--exclude-domain", action="append", default=None)
    a.add_argument("--start-published", default=None)
    a.add_argument("--end-published", default=None)
    a.add_argument("--highlights", action="store_true")
    a.add_argument("--summary", action="store_true")

    return p


def main() -> int:
    maybe_reexec()
    load_dotenv()
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "list_tools":
            return cmd_list_tools(args)
        if args.command == "call_tool":
            return cmd_call_tool(args)
        if args.command == "search":
            return cmd_search(args)
        if args.command == "fetch":
            return cmd_fetch(args)
        if args.command == "advanced":
            return cmd_advanced(args)
        parser.error(f"Unknown command: {args.command}")
        return 2
    except Exception as exc:
        eprint(f"Error: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
