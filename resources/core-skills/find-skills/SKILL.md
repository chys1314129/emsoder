---
name: find-skills
description: Helps users discover and install agent skills when they ask questions like "how do I do X", "find a skill for X", "is there a skill that can...", or express interest in extending capabilities. This skill should be used when the user is looking for functionality that might exist as an installable skill.
---

# Find Skills（EMSoder 预装）

本技能为 **EMSoder 核心预装**，用于在开放 Agent Skills 生态中发现与安装技能。

## When to Use

- 用户问「怎么做 X / 有没有 X 技能 / 帮我找技能」
- 用户想扩展能力、装模板、装工作流
- 用户提到希望有设计 / 测试 / 部署等领域帮助

## EMSoder 优先路径

1. **应用内安装向导**（推荐）  
   侧栏 ⭐ 技能 →「安装技能」→ 预设仓库或自定义 `owner/repo` / `owner/repo@skill`  
   对应 IPC 包装 `npx skills add`，装完刷新列表即可。

2. **终端 Skills CLI**（与向导等价）

```bash
npx skills find [query]
npx skills add <owner/repo@skill> -g -y
npx skills check
npx skills update
```

浏览目录：https://skills.sh/

## 搜索步骤

1. 弄清领域（React / 测试 / 设计…）与具体任务  
2. 运行 `npx skills find [query]`（或引导用户打开安装向导）  
3. 展示技能名、用途、安装命令、skills.sh 链接  
4. 用户确认后安装：`npx skills add <pkg> -g -y`，或走 EMSoder 安装向导

## 示例

| 用户说法 | 建议查询 |
|---------|----------|
| React 怎么更快 | `npx skills find react performance` |
| 帮我做 PR review | `npx skills find pr review` |
| 写 changelog | `npx skills find changelog` |

## 常见分类关键词

| Category | Example Queries |
| -------- | --------------- |
| Web Development | react, nextjs, typescript, css, tailwind |
| Testing | testing, jest, playwright, e2e |
| DevOps | deploy, docker, kubernetes, ci-cd |
| Documentation | docs, readme, changelog, api-docs |
| Code Quality | review, lint, refactor, best-practices |
| Design | ui, ux, design-system, accessibility |
| Productivity | workflow, automation, git |

## 搜不到时

1. 说明生态里暂无匹配技能  
2. 用通用能力直接帮用户做  
3. 可选：`npx skills init my-skill` 自建技能  

## 注意

- 安装需要本机可访问 npm / GitHub（或用户配置的镜像）  
- API Key **不要**写进技能包；密钥放用户本机环境变量或 EMSoder 设置  
- 用户已安装的同名技能优先于本预装包（扫描优先级：本机用户目录 > 工作区 > **core** > 同步 bundled）
