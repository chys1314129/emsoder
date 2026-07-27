---
name: feishu-wiki-extract
description: |
  Extract full body and embedded Excel/tables from Feishu/Lark public wiki pages when attachments are not downloadable (Login Required). Use when the user gives a my.feishu.cn/wiki or feishu.cn/wiki URL, asks to 抓取/导出飞书文档/wiki正文, 内嵌xlsx, 音乐流派大全类表格, or says 附件没权限下载/只要完整内容. Follow the global runbook; deliver under D:\zcode2的\<task>\.
allowed-tools:
  - Bash(firecrawl *)
  - Bash(npx firecrawl *)
  - Bash(curl *)
  - Bash(python *)
  - Bash(python3 *)
---

# feishu-wiki-extract

从**公开**飞书 Wiki 抓取完整正文与内嵌 Excel（含附件无下载权限时的预览还原）。

## 权威流程（必读）

全局 runbook（步骤 A–F、校验、降级、铁律）：

`D:\zcode2的\docs\runbooks\feishu-wiki-excel-extract.md`

索引：`D:\zcode2的\docs\runbooks\README.md`

## 何时使用

- URL 含 `my.feishu.cn/wiki` / `feishu.cn/wiki` / Lark 公开 doc  
- 用户要：正文完整导出、内嵌 xlsx/表格、附件 Login Required 仍要内容  
- 不要用本 skill 做未授权入侵；仅公开页或用户已授权分享链  

## 快速流程

```text
1. scrape URL → markdown/html（--wait-for 5000+）
2. curl 探 file token 下载 → 401 则放弃直下
3. 清洗正文骨架（去壳、统一 ##）
4. 每个内嵌 xlsx：
   - 小表：markdown 表直接抽
   - 大表：interact 点目录 + 滚预览 + 多轮合并
   - 可选：预览前 N 行对齐的公开镜像补骨架
5. 导出到 D:\zcode2的\<任务名>\
   00-正文完整版.md / 01..xlsx / README.md
6. 校验行数、去重、完整度说明
```

## 命令骨架

```bash
WORKSPACE="D:/zcode2的"
TASK="feishu-<简称>"
BASE="${WORKSPACE}/${TASK}"
FC="${WORKSPACE}/.firecrawl"
mkdir -p "$BASE" "$FC"

firecrawl scrape "<URL>" --wait-for 6000 --format markdown,links,html \
  -o "$FC/${TASK}-page.json"

firecrawl interact --scrape-id "<ID>" --timeout 200 \
  --prompt "打开目标章节；聚焦 excel 预览；多次 PageDown；导出全部行列" \
  -o "$FC/${TASK}-sheet.txt"

firecrawl interact stop --scrape-id "<ID>"
```

## 铁律

1. 先 scrape，再 interact，最后才镜像  
2. 下载 401 不耗在 API  
3. 虚拟滚动多轮合并  
4. 镜像必须与预览开头对齐  
5. 交付在 `D:\zcode2的\<任务名>\`，写清完整度  
6. 还原表 ≠ 原文件二进制  

## 参考实例

`D:\zcode2的\feishu-AI音乐提示词大礼包\`  
含 `export_all_excels.py`、`export_full_body.py`、正文与三表交付。

## 相关 skill

- `firecrawl-scrape` / `firecrawl-interact`：底层抓取与交互  
- 下载检疫：外链二进制走 `D:\Quarantine` 规则，不覆盖本 skill 的「预览还原表」
