---
name: hermes-evolution
description: 审慎地把用户纠正、明确偏好、可复用工作流和高成本踩坑沉淀为经用户审批的 AGENTS.md、TOOLS.md、MEMORY.md 或 managed SKILL.md 更新。仅在主会话的重大轮次结束时触发，默认大多数轮次都应跳过。
---

# Hermes-Evolution

你是"提案器"，不是"自动改写器"。

目标：
- 让能力持续积累
- 保持低噪音
- 所有真正的进化都先写草稿，再等用户审批
- 没有足够证据时，输出 `NOTHING_TO_SAVE`

**硬性约束：当 child 审查完成且有提案时，必须通过 `evolution_proposal` 工具提交提案。禁止跳过工具调用直接输出纯文本审批提示。**

## 何时检查

只在以下条件同时满足时做一次轻量检查：

- 当前是主会话，不是 sub-agent，不是 cron，不是 heartbeat/system-only 轮次
- 当前轮次已经形成了完整结果，适合做复盘
- 本轮至少出现一个强信号，或两个中信号

强信号：
- 用户明确纠正你
- 用户明确说"以后都这样/不要这样"
- 用户教授了一个可复用的新 workflow
- 经过明显的失败/重试后才成功

中信号：
- 同类任务里出现了清晰的步骤模式
- 某个工具/环境坑点值得长期记住
- 同一偏好在近期被重复提到

默认跳过：
- 纯闲聊
- 单轮简单问答
- tool call 很少且没有纠正/偏好
- 一次性上下文要求
- 用户明确说"这次只是临时的"
- 已存在同签名 `pending` 草稿
- 最近 14 天内已有同签名 `rejected` 草稿，且没有新证据

## 进化强度

根据 `AGENTS.md` 中 `Self-Evolution` 段落标注的进化强度执行：

- **100%（积极）**：强信号或两个中信号均可触发
- **50%（审慎）**：仅强信号触发，中信号全部跳过，workflow 发现不单独触发
- **0%（关闭）**：不做任何进化检查，始终输出 `NOTHING_TO_SAVE`

如果 `AGENTS.md` 中没有标注强度，默认按 **100%** 执行。

## Cheap Gate

先本地判断，只有通过 gate 才允许 spawn sub-agent。

通过 gate 的最小标准：

- `correction`：用户明确指出你错了，或明确禁止某行为
- `preference`：用户明确表达稳定偏好
- `workflow`：出现可复用、非一次性的多步骤方法
- `struggle`：大约 `>=8` 次 tool call，或 `>=3` 次失败/重试后才成功

若只是"可能有点价值"，但证据不够明确，直接跳过并输出 `NOTHING_TO_SAVE`。

## 审查前准备

在 spawn child 之前，父 agent 先做四件事：

1. 提炼证据：
   - 记录 1-3 条最关键的用户原话
   - 记录工具踩坑摘要
   - 记录这条经验为什么值得复用

2. 初步判断目标文件：
   - 行为/流程规则 → `AGENTS.md`
   - 工具/环境/路径/命令坑点 → `TOOLS.md`
   - 稳定偏好/长期事实 → `MEMORY.md`
   - 可复用多步骤 workflow → managed skill 的 `SKILL.md`

3. 最小化读取：
   - 只读候选目标文件
   - 只读同签名或相近签名的草稿
   - 只读可能冲突的现有 skill
   - 不要重读整个 session transcript

4. 做一次重复检测：
   - 已存在同义规则且内容已覆盖 → 直接跳过
   - 已有 pending 草稿 → 更新该草稿，不新建
   - 最近 rejected 且无新证据 → 跳过

## Spawn 审查 Sub-Agent

使用 `sessions_spawn`，参数原则：

- `runtime: "subagent"`
- `mode: "run"`
- `cleanup: "delete"`，仅在调试 self-evolution 时保留 session
- task 中直接携带证据，不要让 child 自己去翻整段 transcript

child 的任务提示词如下：

```
You are the self-evolution reviewer.

Your job is to decide whether the parent turn deserves ONE human-approved evolution proposal.

Rules:
- Work only from the evidence provided below and minimal file reads for dedupe.
- Never edit AGENTS.md, TOOLS.md, MEMORY.md, or any SKILL.md directly.
- You may write or update exactly one draft file under `evolution-drafts/pending/`.
- If the evidence is weak, one-off, already covered, or recently rejected, do not create a draft.
- If no proposal is justified, output exactly: NOTHING_TO_SAVE

Decision standard:
- Prefer precision over recall.
- A proposal must be specific, durable, reusable, and likely to help future turns.
- User approval is required before any real write.

Target selection:
- AGENTS.md for future behavior/process/safety rules
- TOOLS.md for tool or environment notes
- MEMORY.md for stable preferences or durable facts
- managed SKILL.md for reusable multi-step workflows

Required output:
- If skipping: `NOTHING_TO_SAVE`
- If proposing: write/update one draft file, then output exactly:
  PROPOSAL_WRITTEN
  Draft-Path: <path>
  Signature: <signature>
  Target: <target-file>
  Reason: <one sentence>

Evidence:
<parent fills this in>

Current candidate target snippets:
<parent fills this in>

Existing similar drafts or rules:
<parent fills this in>
```

## 草稿目录与文件格式

草稿目录固定为：

- `evolution-drafts/pending/`
- `evolution-drafts/approved/`
- `evolution-drafts/rejected/`

`pending` 草稿文件名使用稳定签名：

- `evolution-drafts/pending/<signature>.md`

签名规则：
- 小写
- `target + normalized rule` 组成
- 示例：
  - `agents-research-before-writing`
  - `memory-reply-briefly`
  - `tools-use-rg-for-search`
  - `skill-feishu-doc-fetch-workflow`

草稿文件格式：

```md
# Evolution Proposal: <short title>

- Proposal-ID: evo-<YYYY-MM-DD>-<signature>
- Status: pending
- Signature: <signature>
- Created-At: <YYYY-MM-DD HH:mm>
- Last-Seen-At: <YYYY-MM-DD HH:mm>
- Target-File: <AGENTS.md | TOOLS.md | MEMORY.md | ~/.openclaw-autoclaw/skills/<name>/SKILL.md>
- Trigger-Type: <correction | preference | workflow | struggle>
- Confidence: <high | medium | low>

## Why This Matters
- <why this should persist>

## Evidence
- "<exact user quote or precise summary>"
- "<exact user quote or precise summary>"
- <tool failure / retry summary if relevant>

## Duplicate Check
- Checked: <files or paths>
- Result: <none | similar existing rule | existing pending draft | recently rejected>
- Decision: <create | update-existing-draft | skip>

## Proposed Change
<the exact content to append, patch, or create>

## Apply Plan
1. <how to modify target file>
2. <where to insert or append>
3. After applying, append a one-line audit note to `memory/YYYY-MM-DD.md`

## User Approval
- Approve: `批准 evo-<YYYY-MM-DD>-<signature>`
- Reject: `拒绝 evo-<YYYY-MM-DD>-<signature>`
- Revise: `修改 evo-<YYYY-MM-DD>-<signature>: <instruction>`
```

## 目标文件选择逻辑

把内容路由到最合适的地方，不要混写。

写入 `AGENTS.md`：
- 面向未来所有类似任务的行为规则
- 安全边界
- 协作方式
- 任务执行顺序
- "以后先做 X，再做 Y" 这种全局 workflow 规则

写入 `TOOLS.md`：
- 某个工具的固定坑点
- 环境路径、命令参数、平台差异
- 外部工具如何正确使用
- "这个命令必须带某参数，否则会失败" 这种经验

写入 `MEMORY.md`：
- 用户明确表达的稳定偏好
- 长期有效的项目偏好
- 长期有效的沟通风格要求
- 明确、可持续复用的事实

写入 managed `SKILL.md`：
- 可以独立复用的多步骤 workflow
- 有明确触发场景、步骤、输入输出、坑点
- 已经超出一条规则，接近"操作手册"

不要把这些作为主要进化目标：
- `memory/YYYY-MM-DD.md`
  - 它只用于审计日志和当天记录
  - 不作为 self-evolution 的主目标文件
  - 只在审批通过/拒绝后记录结果

## 写入执行逻辑

永远不要在没有用户批准的情况下改目标文件。

如果 child 输出 `NOTHING_TO_SAVE`：
- 父 agent 不创建草稿
- 正常回复用户
- 不额外打扰

如果 child 输出 `PROPOSAL_WRITTEN`：

**⚠ 必须调用 `evolution_proposal` 工具。禁止直接输出纯文本审批提示。**

步骤（严格按顺序执行，不可跳步）：
1. 先完成当前对用户的正常答复
2. **必须**调用 `evolution_proposal` 工具，传入结构化 JSON（见下方格式）
3. 等待工具返回，读取结果中的 `deliveryMode`
4. 如果 `deliveryMode == "card"`：**立即停止**，不要输出任何审批相关文本，桌面端会自动渲染交互卡片
5. 如果 `deliveryMode == "text"`：补一段简短纯文本审批提示（见下方固定格式）

**错误示例（严格禁止）：**
- ❌ 没有调用 `evolution_proposal` 工具，直接输出"请审批这条进化提案：evo-xxx"
- ❌ 把草稿内容复述一遍然后问用户"批准还是拒绝"
- ❌ 看到 child 返回 PROPOSAL_WRITTEN 后在文本中提及进化内容但不调工具
- ❌ 假设 deliveryMode 是 text，跳过工具调用直接输出审批文案

**正确做法：**
- ✅ 先调用 `evolution_proposal` 工具 → 拿到 deliveryMode → 再决定是否输出文本

- 输入格式如下：

```json
{
  "proposalId": "evo-2026-04-14-memory-reply-briefly",
  "signature": "memory-reply-briefly",
  "description": "简短描述这条进化提案的意图",
  "tabs": [
    {
      "kind": "memory",
      "label": "长期记忆",
      "targetFile": "MEMORY.md",
      "content": "这里放该文件的完整新内容（不是 diff，是整个文件）"
    }
  ],
  "draftPath": "evolution-drafts/pending/memory-reply-briefly.md"
}
```

- `tabs` 数组：每个 tab 对应一个要修改的目标文件。**每个 tab 必须包含 `targetFile` 字段**，指定 workspace 内的目标文件名。
- `targetFile`：**必填**。workspace 内的文件名，例如 `"MEMORY.md"`、`"AGENTS.md"`、`"TOOLS.md"`、`"USER.md"`、`"SOUL.md"` 等。用户审批后，桌面端会直接将 `content` 写入 `<workspace>/<targetFile>`。
  - 常见映射：`MEMORY.md`（长期记忆）、`AGENTS.md`（行为规范）、`TOOLS.md`（工具调用）、`USER.md`（用户画像）
  - 也支持任何自定义 `.md` 文件，如 `SOUL.md`、`CONTEXT.md` 等
- `kind`：UI 展示用的分类标签。取值为 `memory`、`behavior`、`skill`、`tool`。如果目标文件不在这四类中（如 `USER.md`），使用最接近的 `kind`（如 `behavior`）即可，`targetFile` 会覆盖 `kind` 的默认映射。
- `content`：**该文件的完整新内容**。审批通过后会直接覆盖目标文件，所以必须是完整内容，不是 diff 或追加片段。
- 一个 proposal 可以涉及多个目标文件 — 此时 `tabs` 数组包含多个元素，每个元素对应一个目标文件的变更草稿。只包含实际有变更的模块，不要为没有变更的模块添加空 tab。
- **不同目标文件必须使用不同的 tab**，不要把多个文件的内容混在一个 tab 里。
- `description`：一句话说明为什么需要这条进化
- `draftPath`：child 写入的草稿文件路径
- 如果没有提案，不要调用此工具，也不提 self-evolution

**重要（再次强调）**：
- 有提案时**必须先调用 `evolution_proposal` 工具**，这是唯一正确的提案提交方式
- 调用工具后，查看返回结果中的 `deliveryMode`
- 只有当 `deliveryMode == "text"` 时，才补纯文本审批提示
- 如果 `deliveryMode == "card"`，不要重复草稿内容，不要输出审批命令，不要再说"请回复批准/拒绝"
- 纯文本里不要重复整份草稿，只保留 `proposalId`、一句话说明和审批指令
- 当 `deliveryMode == "text"` 时，推荐使用如下固定格式：

```text
请审批这条进化提案：<proposalId>
说明：<description>
回复以下任一命令即可：
- 批准 <proposalId>
- 拒绝 <proposalId>
- 修改 <proposalId>: <你的修改意见>
```

- 工具结果里的 `followUp` 指令优先级高于默认文案；严格照做
- `card` 模式下，用户应该只看到交互卡片
- `text` 模式下，用户应该直接看到这段文本并按命令回复

## 用户审批后的处理

无论用户是在桌面端点击卡片按钮，还是在 IM 渠道发送文本命令，你都会收到一条纯文本消息：
- `批准 evo-<YYYY-MM-DD>-<signature>`
- `拒绝 evo-<YYYY-MM-DD>-<signature>`
- `修改 evo-<YYYY-MM-DD>-<signature>: <instruction>`

**所有渠道的处理方式完全一致，不做区分。** 收到审批消息后，按以下流程执行：

### 批准

1. 找到匹配的 `pending` 草稿（通过 proposalId 或 signature 匹配）
2. 按草稿里的 `Apply Plan` 把修改正式应用到目标文件（AGENTS.md / TOOLS.md / MEMORY.md / SKILL.md）
3. 将草稿移入 `evolution-drafts/approved/`
4. 在 `memory/YYYY-MM-DD.md` 追加一条审计记录
5. 明确回复用户"已生效"

### 拒绝

1. 将草稿移入 `evolution-drafts/rejected/`
2. 在 `memory/YYYY-MM-DD.md` 追加一条审计记录
3. 明确回复用户"不会应用"

### 修改

1. 原地更新 `pending` 草稿
2. 保持同一 `signature`
3. 不直接落目标文件
4. 重新调用 `evolution_proposal` 工具展示更新后的提案
5. 再次读取 `deliveryMode`，只有 `deliveryMode == "text"` 时才再次发送纯文本审批提示

## 重复检测逻辑

每次准备写 draft 前，都执行：

1. 搜索以下位置是否已有同义规则：
   - `AGENTS.md`
   - `TOOLS.md`
   - `MEMORY.md`
   - `~/.openclaw-autoclaw/skills/*/SKILL.md`
   - `evolution-drafts/pending/`
   - `evolution-drafts/approved/`
   - `evolution-drafts/rejected/`

2. 归一化后判断：
   - 同一目标
   - 同一核心规则
   - 同一用户偏好或同一 workflow

3. 决策：
   - 已覆盖 → skip
   - pending 同签名 → update existing draft
   - approved 同签名但本次证据更强 → update target only after new approval
   - rejected 同签名且无新证据 → skip

"新证据"只认：
- 新的明确用户表述
- 新的明显失败案例
- 新的重复出现

不要因为语序不同就重复提案。

## 质量标准

只有同时满足这些条件才值得提案：

- 具体
- 可执行
- 长期有效
- 非一次性
- 对未来有帮助
- 用户大概率会批准

如果拿不准，宁可跳过。
默认答案应该是：`NOTHING_TO_SAVE`
