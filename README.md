# EMSoder Desktop

本地桌面 AI 编程助手。打开工作区，用自己的模型 API Key 或本地 Ollama 对话、改代码、跑终端、调用技能、审阅文件变更。

默认使用 **Pi sidecar** 作为 Agent runtime，同时保留 EMSoder 旧后端作为兼容与故障回退。
<img width="1362" height="745" alt="image" src="https://github.com/user-attachments/assets/fd97a900-70f0-4ab7-8af2-83762963a8d9" />

## 功能

- **多模型 BYOK**：OpenAI 兼容接口、Anthropic、Ollama、本地或第三方网关。
- **Pi Agent runtime**：独立 sidecar、工具循环、技能加载、上下文管理、自动恢复。
- **多工作区并行任务池**：
  - 不同工作区最多同时运行 **3 个** 任务；
  - 同一工作区严格 FIFO 串行；
  - 父目录与子目录也会互斥，避免交叉写文件；
  - 当前会话停止不会影响其它工作区。
- **真实子 Agent**：`spawn_subagent` 可派发最多 6 个独立子任务，结果回收给主 Agent。
- **Plan / Goal 模式**：
  - 自动：直接执行；
  - 计划：先生成计划，批准后再执行；
  - 目标：自动续跑直到任务完成。
- **文件改动审阅**：写前快照、写后捕获、diff 查看、接受、单文件撤销、全部撤销。
- **上下文窗口管理**：
  - 自定义窗口容量；
  - 底栏点击 `ctx` 可快速设置自动、32k、64k、128k、256k、512k、1M、2M；
  - 自动压缩较早上下文；
  - 支持真实 Provider usage 与本地 token 估算兜底。
- **联网工具**：
  - `web_search`：联网搜索；
  - `web_fetch`：抓取网页并提取正文；
  - `search_images` / `download_image`：图片搜索与下载。
- **Skills**：
  - 自动扫描 `~/.zcode/skills`、`~/.agents/skills`、工作区 `.emsoder/skills`；
  - `list_skills`、`load_skill`；
  - 内置 PPT、PDF、Word、Excel、图片、搜索等技能运行时。
- **Office / WPS 支持**：
  - 可读取 DOCX、DOC、WPS、XLSX、XLS、ET、CSV；
  - PPT、PDF、Word、Excel 生成通过对应 Skill 完成。
- **OAuth Provider**：
  - Authorization Code + PKCE；
  - 本地回环回调；
  - Access Token / Refresh Token 保存与自动刷新。
- **思考档位**：
  - 关闭、低、中、高、超高；
  - 映射到 Pi thinking level、动态 token 预算以及不同 Provider 请求格式。
- **桌面体验**：
  - Monaco 编辑器；
  - 文件树、Git 状态、终端、PTY；
  - `@文件路径` 引用；
  - 多会话与消息分支；
  - 桌面悬浮球；
  - 全局静音和完成提示音。

---

## 下载与运行

下载 Release 中的：

```text
EMSoder-win-unpacked.zip
```

完整解压后，双击：

```text
EMSoder.exe
```

> 不要直接在压缩包内运行程序。

首次启动后，在顶部的「服务商」或设置页中配置自己的模型服务商。

---

## 从源码启动

环境要求：

```text
Node.js 20+
Windows 10 / 11
```

安装依赖：

```bash
npm install
```

启动：

```bash
npm start
```

开发模式：

```bash
npm run dev
```

---

## 配置模型服务商

EMSoder 不提供模型额度，不托管你的 API Key。你可以使用：

- 本地 Ollama；
- OpenAI；
- Anthropic；
- DeepSeek；
- OpenRouter；
- 硅基流动；
- 兼容 OpenAI Chat Completions API 的任意网关；
- 支持 OAuth 的模型服务商。

常见本地 Ollama 配置：

```text
Base URL: http://127.0.0.1:11434/v1
API Key: ollama
模型: qwen2.5-coder:7b
```

---

## Agent Runtime

### Pi sidecar（默认）

Pi sidecar 是默认 Agent runtime，适合：

- 长任务；
- 多步骤工具调用；
- 子 Agent 并行；
- 技能工作流；
- Plan / Goal 模式；
- 自动上下文压缩；
- runtime 崩溃恢复；
- 多工作区并行任务。

Pi sidecar 以独立进程运行，Agent runtime 崩溃时不会直接拖垮桌面界面。发生意外退出时，EMSoder 会基于会话历史自动重建 sidecar 并尝试续跑。

### EMSoder 旧后端（回退）

旧后端保留用于：

- Pi sidecar 被安全软件阻止启动；
- 某个模型服务商与 Pi 流式协议兼容异常；
- 排查 Pi runtime 回归；
- 需要使用更短、更直接的单进程执行链路。

旧后端同样保留工具调用、文件改动审阅、技能、终端和基础 Agent 能力。

---

## 多工作区并行任务池

EMSoder 现在支持多个独立会话在不同工作区同时执行。

```text
工作区 A / 会话 1  ─┐
工作区 B / 会话 2  ─┼─ 最多 3 个任务同时运行
工作区 C / 会话 3  ─┘
```

同一工作区会自动串行：

```text
D:\project-a / 会话 1
        ↓
D:\project-a / 会话 2
        ↓
D:\project-a / 会话 3
```

父子目录也被视为同一冲突域：

```text
D:\project-a
D:\project-a\packages\web
```

这两个目录不会同时执行可能写文件的任务。

任务在发送时会冻结：

```text
sessionId
workspaceRoot
taskId
```

因此即使你之后切换会话、切换工作区，后台任务也不会写到错误目录或错误会话。

点击当前会话的「停止」只会：

- 中止当前会话正在执行的任务；
- 移除当前会话排队中的任务；
- 拒绝当前任务等待中的权限确认；

不会影响其它工作区的任务。

---

## 子 Agent

Pi 模式提供真实 `spawn_subagent` 工具。

示例任务结构：

```json
{
  "tasks": [
    {
      "task": "检查项目结构与关键入口文件"
    },
    {
      "task": "搜索并分析当前测试覆盖情况"
    }
  ],
  "maxRounds": 8
}
```

特点：

- 最多 6 个子任务并行；
- 每个子 Agent 有独立上下文；
- 每个子 Agent 有独立轮数上限；
- 子 Agent 的结果自动返回给主 Agent；
- 主 Agent 综合结果后继续执行；
- 子 Agent 对文件的真实修改会进入父会话的“本轮改动”审阅。

女娲 Skill 的「双Agent精炼」会使用这一机制真实派发：

```text
Agent A：结构优化评审
Agent B：激活条件与问题路由评审
```

不会只在正文中模拟两份评审结果。

---

## Plan / Goal 模式

在设置中选择 Pi 运行模式。

### 自动

```text
自动
```

直接执行任务。

### 计划

```text
计划（先审批）
```

先生成可执行计划，不改文件、不跑终端。你点击「批准并执行」后，Agent 才开始调用工具。

### 目标

```text
目标（自动跑完）
```

Agent 会在模型提前收口、但任务尚未真正完成时自动续跑，直到：

- 任务完成；
- 用户点击停止；
- 达到设置的自动续跑限制。

---

## 文件改动审阅

Agent 写文件时，EMSoder 会记录完整事务：

```text
写前快照
→ 工具执行
→ 写后捕获
→ 本轮改动审阅
→ 接受或撤销
```

支持的写入工具包括：

```text
write_file
edit_file
apply_diff
```

你可以：

- 查看单文件 diff；
- 接受本轮全部改动；
- 撤销单个文件；
- 撤销本轮全部改动。

撤销包含文件陈旧保护：如果文件在 Agent 写入后又被其它任务或用户修改，EMSoder 不会盲目覆盖最新内容。

---

## 上下文窗口与 Token 统计

底栏显示：

```text
ctx 已用token / 窗口容量 (占用比例)
```

点击底栏 `ctx` 可直接设置上下文窗口容量：

```text
自动
32k
64k
128k
256k
512k
1M
2M
```

也可以输入任意非负整数。

```text
0 = 按模型自动判断
```

统计规则：

- Provider 返回 usage 时，显示真实 API token 用量；
- Provider 不返回 usage 时，显示本地估算 token 用量；
- 自定义窗口容量会影响占用比例与自动压缩时机。

Pi runtime 会根据上下文占用自动压缩较早对话，保留：

- 最初用户目标；
- 最近对话；
- 关键决策；
- 文件改动信息；
- 未完成事项。

---

## 联网工具

EMSoder 内置无需额外 API Key 的联网能力。

### `web_search`

搜索网页信息，优先 DuckDuckGo，失败自动尝试 Bing。

适用于：

```text
查最新资料
查技术文档
查 API 用法
查版本信息
事实核验
```

### `web_fetch`

读取网页正文并转为可读文本。

```text
先 web_search 找链接
→ 再 web_fetch 阅读详细内容
```

### 图片工具

```text
search_images
download_image
```

适用于 PPT、PDF、汇报、演示稿等需要图片素材的任务。

---

## Skills

EMSoder 支持 zcode / agents 兼容的 `SKILL.md` 技能包。

扫描目录包括：

```text
~/.zcode/skills
~/.agents/skills
<workspace>/.emsoder/skills
```

Agent 工具：

```text
list_skills
load_skill
```

当任务与已安装 Skill 匹配时，Agent 会先读取 `SKILL.md`，再按技能工作流执行。

常见能力包括：

```text
PPT 生成
PDF 生成
Word / Excel 生成
WPS 文件读取
联网研究
图片搜索
音频与多媒体
前端开发
全栈开发
代码审查
安全测试
数据分析
```

---

## PPT、PDF、Word、Excel

需要生成文档时，直接告诉 Agent 目标和格式。

示例：

```text
用 ppt-master 做一份精美的新能源汽车行业分析 PPT，10 页，要有图片和数据图表。
```

```text
生成一份年度项目总结 PDF，包含封面、目录、数据表和结论。
```

```text
读取工作区里的 .wps、.doc、.et、.xls 文件，整理成 Markdown。
```

预装核心 Skill：

```text
ppt-master
minimax-docx
minimax-pdf
minimax-xlsx
minimax-multimodal-toolkit
minimax-music-gen
minimax-music-playlist
find-skills
```

---

## OAuth Provider

服务商编辑页支持 OAuth 登录。

配置：

```text
authorizeUrl
tokenUrl
clientId
scopes（可选）
```

点击「OAuth 登录」后：

```text
系统浏览器授权
→ 本地回环回调
→ Authorization Code + PKCE
→ 保存 Access Token / Refresh Token
→ 过期自动刷新
```

OAuth Bearer Token 会优先于 API Key 用于请求模型服务商。

---

## 思考档位

设置中可选：

```text
关闭
低
中
高
超高
```

Pi runtime 会将档位映射到：

```text
Pi thinkingLevel
动态 thinking token 预算
OpenAI reasoning_effort
OpenAI thinking_token_budget
Anthropic thinking.budget_tokens
```

选择「关闭思考」时，不会发送 reasoning 或 thinking 参数。

---

## 快捷操作

```text
Enter              发送
Shift + Enter      换行
@文件路径          引用工作区文件
F9                 编辑器断点
Esc                关闭权限菜单 / 停止当前任务
```

---

## 打包

生成 Windows 解压即用版本：

```bash
pack.bat
```

或：

```bash
npm run build:pi-sidecar
npm run pack
```

分享推荐使用：

```text
dist/EMSoder-win-unpacked.zip
```

完整解压后运行：

```text
dist/win-unpacked/EMSoder.exe
```

---

## 测试

运行全部测试：

```bash
npm test
```

覆盖内容包括：

```text
Pi sidecar 启动与打包路径
技能加载
上下文压缩
Token usage 与本地估算
文件变更事务与撤销
双 Agent 精炼
Pi 子 Agent
Plan 模式
Goal 模式
Pi runtime 崩溃恢复
多 Pi 会话并行
工作区任务池
父子目录互斥
会话与工作区固定归属
Provider
MCP
文档读取
图片配置
内存
```

当前测试套件：

```text
20 suites
```

---

## 注意事项

- EMSoder 不托管模型额度，请使用自己的 API Key 或本地模型。
- 不要上传包含个人 API Key、OAuth Token、`emsoder-config.json` 的文件。
- 不同工作区可以并行，但同一工作区会自动串行，避免文件冲突。
- 如果 Pi sidecar 无法启动或某个 Provider 出现兼容问题，可在设置中切换到 `EMSoder 旧后端（回退）`。
