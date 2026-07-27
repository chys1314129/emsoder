---
name: bocha-local
description: |
  Local Bocha (博查) setup on this machine. Use for Chinese-first structured web search via Bocha Web Search API when the user wants 中文网页搜索、时效新闻、事实核查、带引用的来源列表. Requires BOCHA_API_KEY (configured). Prefer bocha-web-search official skill instructions; this skill documents local auth and CLI helper.
---

# Bocha (local)

## Auth
- User env: `BOCHA_API_KEY`
- `C:\Users\Admin\.zcode\skills\.bocha.env`
- Official skills: `bocha-web-search`, `bocha-web-search-a2m` (a2m is paid marketplace flow; prefer `bocha-web-search` with API key)

## CLI helper
```bash
export PATH="/c/Users/Admin/AppData/Local/Programs/Python/Python312/Scripts:$PATH"
set -a; source /c/Users/Admin/.zcode/skills/.bocha.env; set +a
PY="/c/Users/Admin/AppData/Local/Programs/Python/Python312/python.exe"
"$PY" /c/Users/Admin/.zcode/skills/bocha-local/scripts/query.py search OpenAI --num 5 --freshness oneWeek
```

## Official skill API (from bocha-web-search)
```http
POST https://api.bocha.cn/v1/web-search
Authorization: Bearer <BOCHA_API_KEY>
```
Body: `query`, optional `freshness` (`noLimit|oneDay|oneWeek|oneMonth|oneYear`), `summary` (default true), `count` (1-50).

Also works: `https://api.bochaai.com/v1/web-search`

## When to use
- Chinese SERP / news / fact check with source links
- Not for whole-site crawl (use Firecrawl) or video platforms (use media-search)
