---
name: metaso-local
description: |
  Local Metaso (秘塔AI搜索) setup. Use when the user wants 中文深度问答、无广告直达结论、带引用的综合回答, or says 秘塔/metaso. Requires METASO_API_KEY and metaso-sdk. This is an answer engine, not a SERP split API — for news/images/videos use media-search; for structured Chinese links use Bocha.
---

# Metaso (local)

## Auth
- User env: `METASO_API_KEY`
- `C:\Users\Admin\.zcode\skills\.metaso.env`
- SDK: `pip install metaso-sdk` (installed)

## CLI helper
```bash
export PATH="/c/Users/Admin/AppData/Local/Programs/Python/Python312/Scripts:$PATH"
set -a; source /c/Users/Admin/.zcode/skills/.metaso.env; set +a
PY="/c/Users/Admin/AppData/Local/Programs/Python/Python312/python.exe"
"$PY" /c/Users/Admin/.zcode/skills/metaso-local/scripts/query.py ask OpenAI 是什么
```

## When to use
- Chinese research Q&A with synthesized answer + references
- Follow-up with sessionId when continuing a thread
- Do **not** use as Brave-style news/images/videos backend
