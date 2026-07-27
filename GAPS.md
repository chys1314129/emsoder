# EMSoder Desktop — 功能对照与完善记录

## 相对 Qoder：已对齐（桌面壳 v1.9 · 含 Quest + P0/P1 + Skills 侧栏 / apply_diff / @）

| Qoder 能力 | EMSoder Desktop |
|-----------|-----------------|
| 活动栏 + 资源管理器 + 编辑器 + AI 侧栏 | 有（天蓝色皮肤） |
| Agent 读写文件 / 搜索 / 终端工具 | 有（工作区沙箱） |
| BYOK 多模型（OpenAI 兼容 / Anthropic / Ollama / 第三方网关） | 有 · 无 Credits · IDE Chat + Quest 共用 · 任务可绑独立模型 |
| Inline Edit | 有（Ctrl+I） |
| 选区入聊 / 解释选区 | 有（Ctrl+Shift+K） |
| 行内补全（NES 简化） | 有 · **竞态取消**（只保留最新请求） |
| 项目规则 AGENTS.md / .emsoder/rules | 有（注入系统提示） |
| 底部终端 | **真 PTY**（xterm.js + ConPTY/PowerShell，可交互） |
| Git 状态 / stage / commit / AI message | 有 |
| Commit Message 生成 | 有 |
| 搜索工作区 | 有 · **分页加载** |
| 单实例 / 脏退出保护 / 路径沙箱 | 有 · **草稿崩溃恢复** |
| Monaco 语法高亮编辑器 | 有 · **字号快捷键** Ctrl+= / Ctrl+- |
| TS/JS 诊断 / 跳转定义 / 引用 | **简易 LSP** |
| Node 调试 | **简易 Inspector CDP** |
| Quest 任务板 | 计划 → Agent/Experts → Changes · 创建时选第三方模型 |
| 命令面板 | **Ctrl+Shift+P** |
| 配置备份 | **导出（脱敏）/ 导入** |
| zcode / agents Skills | **侧栏技能管理**：搜索/状态过滤/**来源过滤**（含 **预装 core**）、**批量禁用/启用**、**安装向导**（`npx skills add` 包装 + 预设）、按来源分组、查看详情（**中文简介 + 触发关键词** + SKILL.md）、禁用/启用/卸载 · **预装 find-skills**（`resources/core-skills`）· 注入提示 · `list_skills` / `load_skill` |
| Chat 过程折叠 | 工具 / 思考默认折叠，突出最终回答 · `collapseProcess` |
| 自识别授权 | `autoApproveSafe`：文件读写+安全命令自动，仅高危险命令仍询问 · `autoRunTools` 额外覆盖危险命令 |
| Agent 长任务 | 默认 32 轮工具循环 + 最多 2 次自动续跑 · `agentMaxRounds` / `agentAutoContinue` |
| apply_diff 多块补丁 | 同文件多处修改一次 apply_diff（hunks[] 或 SEARCH/REPLACE 标记），比多次 edit_file / write_file 更稳 |
| @ 文件引用 | 输入 `@` 弹出工作区文件列表，选中后附带内容；**大文件截断**（单文件 80k / 合计 200k / 最多 12 个）防撑爆上下文 |
| Chat 本轮改动 / 撤销 | 对齐 Quest snapshot：写前 before、写后 after；Chat 底部「本轮改动」列表 + 单文件撤销 / 全部撤销 + **对比 diff** |
| Agent 任务队列 | Chat 主进程串行队列：忙时再发送入队；Stop 中止当前并清空队列 |

## v1.7 稳定性 / 流畅度

| 项 | 说明 |
|----|------|
| 会话 / Quest 落盘 | 防抖 + 原子写，退出 flush |
| 历史裁剪 | 会话 200 / Quest 120；落盘 40 / 80 |
| Agent 上下文 | 历史 24 轮；工具输出截断 |
| OpenAI 兼容 | 超时 120s、429/5xx 重试、流式 abort cancel |
| Chat / Quest 流式 UI | rAF 节流 |

## v1.8 P0 + P1（本次）

| 项 | 说明 |
|----|------|
| Anthropic 超时/重试 | 与 OpenAI 对齐（`httpUtil.js`） |
| 错误可操作 | 401/超时/额度等分类 → 提示 + 跳转服务商/模型 |
| 补全竞态 | main 取消旧请求 + editor `completeSeq` 丢弃过期结果 |
| 配置导出/导入 | 设置页按钮；导出默认脱敏 Key |
| 脏文件草稿恢复 | 编辑防抖写入 `emsoder-drafts.json`，启动可恢复 |
| 命令面板 | Ctrl+Shift+P：开文件/模型/Quest/终端/导入导出… |
| 字号缩放 | Ctrl+= / Ctrl+-，写入配置 |
| 搜索分页 | 先渲染 40 条，「加载更多」 |
| Chat 历史渲染上限 | **真虚拟列表**：`chat-virtual.js` 窗口虚拟滚动，全量数据可滚；流式消息挂 live 区 |

## 仍可后续补全（P2）

| 能力 | 说明 |
|------|------|
| 多根工作区 | 目前单文件夹 |
| Git merge / blame 图形 | 仅常用 status/diff/commit |
| 完整 tsserver / pyright | 现为 Monaco 内置 + 简易索引 |
| 多语言调试 DAP | 现仅 Node Inspector |
| 扩展市场 | 无 |
| Computer Use / RepoWiki | 无 |
| 云端 Quest 沙箱 | 本地简化版 |
| Chat 真虚拟列表 | **已有**：`renderer/js/chat-virtual.js` 像素窗口虚拟滚动 |
| 任务队列 | **已有**：Chat Agent 主进程串行队列（Quest 仍可并行） |
| MCP | 无 |
| 技能安装向导 | **已有**：`skillInstall.js` + 侧栏模态；底层仍包装 `npx skills add` |
| `skillInfo.js` 中文映射 | **本机已装全覆盖**（约 130 条 `SKILL_CN`；未装新技能仍靠 `extractTriggers` 回退） |
| app.js 拆分 | 方案见 `APP-SPLIT-PLAN.md`；已抽出 `chat-virtual.js`，大拆未做 |

## 代码结构（防屎山）

| 模块 | 职责 |
|------|------|
| `src/main/agentBridge.js` | Chat / 分支重发共用的 Agent 事件桥（避免 main 双份 run 逻辑） |
| `src/core/contextStats.js` | 上下文窗口 + 缓存命中统计 |
| `src/providers/httpUtil.js` | 超时/重试/错误分类 |
| `src/tools/skills.js` | zcode 技能发现（元数据扫描 + 30s 缓存）/ load；**coreSkillRoots**（预装）+ bundled |
| `src/tools/skillInfo.js` | 技能中文简介 + 触发关键词（`SKILL_CN` ≈130 / `extractTriggers` 回退） |
| `src/tools/executor.js` | 工具执行（read_file/write_file/edit_file/apply_diff/terminal/search/create_document/skills） |
| `renderer/js/dom-util.js` | toast / modal / escapeHtml / 右键菜单 / copy 等 DOM 工具 |
| `renderer/js/chat-virtual.js` | Chat 消息窗口虚拟列表（spacer + 可视窗口 + live 流式区） |
| `renderer/js/app.js` | UI 编排（@ 文件引用、输入/附件/发送、折叠、自动授权、inline edit、队列指示、本轮 diff 等） |
| `src/main/main.js` | IPC（agent 队列 send/stop、file-change-diff、skills、fs、workspace、git、term 等） |
| `APP-SPLIT-PLAN.md` | app.js 拆分方案（mentions / skills-side / chat-messages / settings-ui） |
| `scripts/test-*.js` | 可重复测试；一次性 patch 脚本已删除 |

## 关键相关文件

- `src/providers/httpUtil.js` — 超时/重试/错误分类
- `src/providers/openai.js` / `anthropic.js` — 统一 HTTP 策略
- `src/main/main.js` + `agentBridge.js` — IPC 与 Agent 运行
- `src/core/contextStats.js` — ctx/cache 指标
- `src/preload/preload.js` — export/import/drafts/context API
- `src/tools/skills.js` — Skills 扫描与 load
- `renderer/js/dom-util.js` / `app.js` / `panels.js` / `quest.js`
- `renderer/index.html` / `css/theme.css`

## 启动

```bash
cd desktop
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
npm run fix-electron
npm start
```
