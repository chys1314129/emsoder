---
name: firecrawl-local
description: |
  Local Firecrawl setup + routing guide for this machine. Use when choosing between Firecrawl, Tavily, media-search, or Exa; when running firecrawl CLI; or when the user mentions Firecrawl scrape/crawl/map/search/agent. Requires FIRECRAWL_API_KEY (already configured). Prefer Firecrawl for hard pages, whole-site crawl/map, and clean markdown extraction; prefer media-search for news/images/videos split channels; prefer Exa for semantic/tech web search; prefer Tavily for quick LLM search/extract/research without crawl.
---

# Firecrawl (local)

This machine has **Firecrawl API key + CLI + skills** installed.

## Auth

Key is stored (do not print full key):

- User env: `FIRECRAWL_API_KEY`
- `C:\Users\Admin\.zcode\skills\.firecrawl.env`
- `C:\Users\Admin\.firecrawl\.env`
- this skill: `.env`

```bash
export PATH="/c/Users/Admin/AppData/Local/Programs/Python/Python312/Scripts:$PATH"
# load if needed:
set -a; source /c/Users/Admin/.zcode/skills/.firecrawl.env; set +a

npx -y firecrawl-cli@latest --status
```

## Everyday CLI

```bash
FC="npx -y firecrawl-cli@latest"

$FC search "query" --limit 5
$FC scrape "https://example.com"
$FC map "https://example.com"
$FC crawl "https://example.com/docs"
$FC agent "Extract pricing tiers from https://example.com/pricing"
```

Installed agent skills (examples): `firecrawl-search`, `firecrawl-scrape`, `firecrawl-crawl`, `firecrawl-map`, `firecrawl-interact`, `firecrawl-agent`, plus workflows (`firecrawl-deep-research`, `firecrawl-market-research`, …).

## When to use what (this machine)

| User need | Use | Why |
|-----------|-----|-----|
| 新闻 / 图片 / 视频 **分接口** | **media-search** | Tavily news+images; YouTube/B站 videos |
| 快速网页搜 + 摘要/抽取/深研 | **Tavily** (`tvly` / tavily-* skills) | 已登录、LLM 友好、research 一条龙 |
| 语义/技术文档搜索 | **Exa** (`exa-search`) | 技术向、MCP 已通 |
| 难渲染页、整站 docs、map/crawl | **Firecrawl** | 抓取/站点能力最强 |
| 产品里写爬虫集成代码 | firecrawl-build-* skills | 教你怎么嵌 API，不是现场搜 |
| 中文问答边搜边总结 | Kimi `$web_search`（若以后接） | 对话式，不是 SERP |

### 推荐升级路径

```text
search (Tavily 或 Firecrawl 或 Exa)
  → 单页不够干净 → Firecrawl scrape / interact
  → 不知有哪些页 → Firecrawl map
  → 要整站/文档站 → Firecrawl crawl
  → 要新闻/图/视频分栏 → media-search（不要硬用 Firecrawl）
```

### 省额度

Firecrawl 本机额度大约 **1000 credits/周期**（以 `firecrawl --status` 为准）。

- 能用 Tavily/Exa 搞定的简单搜索，先别上 Firecrawl  
- crawl 最吃额度；先 `map` 再针对性 `scrape`  
- 新闻/图/视频走 media-search，不走 Firecrawl  

## Do not

- 不要用 Firecrawl 替代 media-search 的视频通道  
- 不要把 API key 写进 SKILL.md 或对话回显全文  
- Eve / PromptScript 不支持全局 skill 安装（可忽略那些失败）
