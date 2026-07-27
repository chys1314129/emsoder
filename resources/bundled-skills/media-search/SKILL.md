---
name: media-search
description: |
  Split-channel media search without Brave API key. Use this skill when the user wants news, images, or videos as separate channels — e.g. "搜新闻", "找图片", "搜视频", "news search", "image search", "video search", or Brave-like multi-modal web results. Routes: news/images via Tavily (tvly); videos via YouTube (yt-dlp) and Bilibili (bili). Prefer this over generic web search when the user explicitly wants news, images, or videos.
---

# Media Search (Route A)

Brave-like **news / images / videos** split interfaces using tools you already have.

| Channel | Backend | Needs |
|---------|---------|--------|
| `news` | Tavily `tvly search --topic news` | `tvly` + Tavily key (already configured) |
| `images` | Tavily `tvly search --include-images` | same |
| `videos` | YouTube `yt-dlp` + Bilibili `bili` | yt-dlp (installed); bili optional for CN |

## Paths

```text
Skill root : C:\Users\Admin\.zcode\skills\media-search
Python CLI : C:\Users\Admin\.zcode\skills\media-search\scripts\query.py
Bash wrap  : C:\Users\Admin\.zcode\skills\media-search\scripts\query.sh
```

```bash
Q="/c/Users/Admin/.zcode/skills/media-search/scripts/query.sh"
export PATH="/c/Users/Admin/AppData/Local/Programs/Python/Python312/Scripts:$HOME/.local/bin:$PATH"
```

## Commands

```bash
# News (default time filter optional)
"$Q" news OpenAI API  --num 8 --time week

# Images
"$Q" images OpenAI logo --num 6 --with-desc

# Videos (YouTube + Bilibili)
"$Q" videos OpenAI --num 5 --source all
"$Q" videos OpenAI --num 5 --source youtube
"$Q" videos 人工智能 --num 5 --source bilibili

# All three channels
"$Q" all OpenAI --num 5 --time week
```

All subcommands print **JSON** to stdout.

## Output shape (examples)

**news**

```json
{
  "channel": "news",
  "backend": "tavily",
  "results": [
    {"title": "...", "url": "...", "snippet": "...", "published_date": "...", "score": 0.6}
  ]
}
```

**images**

```json
{
  "channel": "images",
  "images": [{"url": "https://...", "description": null}],
  "pages": [{"title": "...", "url": "..."}]
}
```

**videos**

```json
{
  "channel": "videos",
  "results": [
    {"platform": "youtube", "id": "...", "title": "...", "url": "...", "duration": "...", "author": "...", "views": "..."},
    {"platform": "bilibili", "id": "BVxx", "title": "...", "url": "https://www.bilibili.com/video/BVxx", ...}
  ]
}
```

## Workflow for agents

1. User wants **news** → `news` only (add `--time day|week|month|year` when fresh).
2. User wants **images / 找图** → `images` (add `--with-desc` if captions help).
3. User wants **videos / 视频** → `videos --source all` (CN topics: try `bilibili` or `all`).
4. User wants full multi-modal scan → `all`.
5. For deep page text after a news hit, use Tavily extract / Exa fetch / Jina — not this skill.

## Dependencies

```bash
pip install tavily-cli yt-dlp
tvly login --api-key tvly-YOUR_KEY   # already done on this machine
# optional CN video:
# bili CLI on PATH (~/.local/bin/bili)
```

## Environment

| Var | Required | Meaning |
|-----|----------|---------|
| `TAVILY_API_KEY` | recommended | Loaded from `../.tavily.env` or `tvly` config if set |
| `MEDIA_SEARCH_PYTHON` | no | Force Python path for `query.sh` |

## Notes

- This is **not** Brave Search API; it approximates the three-channel UX.
- Video quality depends on yt-dlp / bili availability and network.
- Do not put API keys in this SKILL.md.
