---
name: exa-search
description: Search the web, read webpages as markdown, and run filtered web retrieval with Exa MCP. Use this skill whenever the user asks for current web information, web research, domain/date/category-filtered search, company or people lookup via search filters, or extracting clean page content from one or more URLs.
---

# Exa Search

Use this skill for Exa MCP web retrieval.

## When to Use
- Current web search
- Web research that needs clean LLM-ready results
- Domain, date, and category filtered search
- Company or people lookup through search filters
- Read full page content from known URLs as markdown

## Preferred Tools
- `web_search_exa`: default search tool
- `web_fetch_exa`: fetch one or more URLs as markdown
- `web_search_advanced_exa`: use only when filters or advanced options are needed (auto-enabled via MCP `tools=` param)

## Paths
```text
Skill root : C:\Users\Admin\.zcode\skills\EXA搜索
Python CLI : C:\Users\Admin\.zcode\skills\EXA搜索\scripts\query.py
Bash wrap  : C:\Users\Admin\.zcode\skills\EXA搜索\scripts\query.sh
```

```bash
SKILL_ROOT="/c/Users/Admin/.zcode/skills/EXA搜索"
Q="$SKILL_ROOT/scripts/query.sh"   # preferred on Git Bash
# or: Q="python3 $SKILL_ROOT/scripts/query.py"  # auto-reexec / curl fallback
```

`query.py` will:
1. Re-exec onto a system Python with working sockets when the embedded interpreter is broken
2. Fall back to `curl` if urllib fails
3. Parse SSE (`event: message` / `data: {...}`) MCP responses
4. Request optional tools via `?tools=<name>` automatically

## Workflow
1. Run `list_tools` to confirm exposed tools.
2. Default path: `search` → if needed `fetch` on best URLs.
3. Use `advanced` only for domain/date/category/highlight filters.
4. Prefer shortcuts (`search` / `fetch` / `advanced`) over raw `call_tool` on Windows shells.

## Commands (verified on this machine)

```bash
SKILL_ROOT="/c/Users/Admin/.zcode/skills/EXA搜索"
Q="$SKILL_ROOT/scripts/query.sh"

# List tools (default + advanced probe)
"$Q" list_tools

# Search (words may be unquoted; shell splitting is joined)
"$Q" search Exa MCP documentation --num 5

# Fetch full page markdown
"$Q" fetch https://exa.ai/docs/reference/exa-mcp --max-chars 4000

# Advanced search with domain filter
"$Q" advanced Exa MCP documentation --domain exa.ai --num 5 --highlights

# Raw tool call — prefer args file (avoids Git Bash quote mangling)
cat > /tmp/exa-args.json <<'EOF'
{"query":"latest changes in Exa MCP docs","numResults":5}
EOF
"$Q" call_tool web_search_exa --args-file /tmp/exa-args.json

# Or pipe JSON on stdin
printf '%s' '{"urls":["https://exa.ai/docs/reference/exa-mcp"],"maxCharacters":3000}' \
  | "$Q" call_tool web_fetch_exa --args-file -
```

## Notes
- Base MCP URL: `https://mcp.exa.ai/mcp` (override with `EXA_MCP_URL`)
- Default tools: `web_search_exa`, `web_fetch_exa`
- Optional: `web_search_advanced_exa` (and others) via `?tools=`
- Do not assume optional tools are always present; check `list_tools`
- Free tier works without a key; set `EXA_API_KEY` for higher limits

## Environment Variables
| Var | Required | Meaning |
|-----|----------|---------|
| `EXA_API_KEY` | no | Higher limits / reliability |
| `EXA_MCP_URL` | no | MCP endpoint override |
| `EXA_TIMEOUT` | no | Seconds (default 60) |
| `EXA_PYTHON` | no | Force Python path for `query.sh` |

If rate-limited without a key, ask the user to set `EXA_API_KEY` in the environment.
