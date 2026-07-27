# EMSoder Desktop

独立 Electron 桌面壳，布局贴近锤子系统的拟物风格（v2.0.0）。

- 免费 · 无账号 · 无 Credits  
- 自定义第三方模型（OpenAI 兼容 / Anthropic / Ollama / 自建网关）  
- **Quest 优先界面**（对齐 Qoder Quest 操作习惯：左任务板 / 中执行流 / 右计划+Changes）  
- 顶栏可一键 **Quest ↔ IDE** 切换  
- **Monaco** 语法高亮 + 行内补全 + **TS/JS 简易 LSP**  
- **Node 调试器** · **真 PTY 终端** · Agent 输出镜像  
- 底部：终端 / Git / 调试 / 问题 / 规则  
- 免费多模型 BYOK（Quest 与 Chat 共用）  
- **Skills 侧栏**（查看 / 禁用 / 卸载）· **@ 引用文件** · **apply_diff** · **自动授权**  

## 快速启动

```bash
cd "D:/zcode的/EMSoder/desktop"
# 国内网络建议设置 Electron 镜像
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
npm run fix-electron
npm start
```

或双击 `start.bat`（会自动处理镜像与二进制）。

开发模式（自动开 DevTools）：

```bash
npm run dev
```

## 打包 / 分享给朋友

**推荐（免安装、功能完整）：**

```bat
pack.bat
```

产物在 `desktop/dist/`（`pack.bat` **默认只打文件夹版**）：

- **`win-unpacked\`** + **`EMSoder-win-unpacked.zip`** — 推荐分享：解压后双击 `EMSoder.exe`，启动快
- 单文件 portable：`npm run pack:portable`（传文件方便，启动更慢）

说明见 **`分享给朋友.md`**。

也可手动：

```bash
npm run dist
```

## 界面结构（默认 IDE）

```
┌ titlebar（Quest|IDE 切换 · 工作区 · 服务商/模型）
├ rail | 会话 | 资源管理器 | 搜索 | Quest | Git | 技能 | 记忆 | 设置
├ 侧栏 | 会话列表 / 文件树 / 搜索结果 / Quest 任务板…
├ center | Chat（Agent / Ask）
└ 底部面板 | 终端 · Git · 调试 · 问题
```

顶栏切到 **Quest** 后进入 Quest 工作台：任务板 + 执行流 + 右侧计划/Changes。

主色：`#38bdf8 / #0ea5e9` 天空蓝系深色背景，白天模式自适应浅色皮肤。

## 配置第三方模型（IDE + Quest 共用）

Chat、行内补全、Inline Edit、**Quest 任务** 全部走同一套 BYOK 服务商配置。

1. 顶栏 **服务商** → **添加服务商**  
   - 可用预设：Ollama / LM Studio / DeepSeek / SiliconFlow / OpenRouter / Moonshot / 通义兼容 / Anthropic / vLLM / 自定义网关  
2. 填 **Base URL** + **API Key** + **模型列表** → 保存 → **测试**  
3. 顶栏 **模型** 或 Chat 顶栏 chip 切换全局默认模型  
4. **Quest**：左侧新建任务时可选「模型」下拉（绑定到该任务的 `providerId` + `model`）  
5. 也可直接编辑用户配置：`%APPDATA%/emsoder-desktop/emsoder-config.json`（以本机实际 userData 为准）

### 本地免费示例（Ollama）

1. 安装并启动 [Ollama](https://ollama.com)  
2. `ollama pull qwen2.5-coder:7b`  
3. 应用默认已带 Ollama provider：`http://127.0.0.1:11434/v1`  
4. Quest 新建任务时选 `qwen2.5-coder:7b · Ollama`

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| Ctrl+Shift+P | **命令面板**（模型 / Quest / 终端 / 导入导出…） |
| Ctrl+O | 打开文件夹 |
| Ctrl+S | 保存文件 |
| Ctrl+= / Ctrl+- | 增大 / 减小编辑器字号 |
| Ctrl+Shift+L | 切换 AI 侧栏 |
| Ctrl+` | 打开真 PTY 终端（可交互） |
| Ctrl+J | 切换底部面板 |
| Ctrl+Shift+M | 问题面板（TS/JS 诊断） |
| Ctrl+Shift+D | 调试面板 |
| Ctrl+Shift+Q | Quest 任务板 |
| F9 | 切换断点 |
| F12 | 跳转定义（TS/JS） |
| Alt+F12 | Peek 定义 |
| Shift+F12 | 查找引用 |
| Ctrl+I | Inline Edit |
| Ctrl+Shift+K | 选区加入对话 |
| Ctrl+N | 新对话 |
| Esc | 停止生成 |

### Chat 交互

- **右键消息**：复制全文 / 复制选中  
- **用户消息「编辑」**：修改后发送会 **新建分支**，旧回答仍保留  
- **分支切换**：有多条兄弟回复时，消息旁显示 `‹ 1/2 ›`，可切换  
- **工具 / 思考过程**：默认 **折叠**（点标题展开）；设置里可改为全部展开  
- **自识别授权运行**：设置开启后，安全终端命令自动执行；写文件 / 危险命令仍确认  
- **输入框右键**：粘贴 / 复制 / 全选  
- **终端右键**：复制选中 / 粘贴 / 清屏  

### 状态栏：上下文与缓存

| 项 | 含义 |
|----|------|
| `ctx 已用/容量 (占用%)` | 当前上下文窗口占用。优先用接口返回的 `usage`；没有则本地估算 |
| `cache 平均命中%` | 近若干次请求的平均缓存命中率。支持 API 的 `cached_tokens` / Anthropic `cache_read`；否则用本地前缀复用估算 |

可选配置（`emsoder-config.json`）：

```json
{
  "contextWindow": 128000,
  "modelContextWindows": {
    "my-custom-model": 64000
  }
}
```

## 配置备份

设置 → **导出配置**（API Key 脱敏）/ **导入配置**。  
异常退出时未保存文件会写入草稿；下次启动可选择恢复。

## 与扩展版关系

- `../` 根目录是 **VS Code 扩展**版 EMSoder  
- `desktop/` 是 **独立桌面应用**，不依赖 VS Code / Qoder 安装  

两者都免费、都支持自定义第三方模型；桌面版自带编辑器壳与天蓝色 Qoder 风 UI。

## License

MIT

## 文档生成（Agent）

Agent 模式可调用工具 `create_document` 生成：

| format | 文件 |
|--------|------|
| `docx` | Word（.docx） |
| `pdf` | PDF（Windows 下优先用黑体等系统字体以支持中文） |
| `pptx` | PowerPoint（.pptx；也可用 ppt 别名） |

示例（对 Agent 说即可）：

- 生成一份 Word 报告到 `exports/报告.docx`
- 做 5 页项目介绍 PPT
- 导出 PDF 总结

默认会确认后写入工作区。输入框旁开 **「自动授权」**（`autoApproveSafe`）后：读写文件、安全终端命令自动执行；仅高危险命令仍询问。设置里 **「完全自动（含危险命令）」**（`autoRunTools`）更激进，连危险终端也可自动。

Agent 工具还包括：`read_file` / `write_file` / `edit_file` / **`apply_diff`**（同文件多处精确替换）/ `search_text` / `run_terminal` / `create_document` 等。

Chat 输入框支持 **`@路径`** 引用工作区文件（弹列表筛选，发送时附带内容；单文件约 80k / 合计约 200k / 最多 12 个，超限截断）。Agent 写盘后底部有 **「本轮改动」**，可单文件或全部撤销（对齐 Quest snapshot）。

## Skills（兼容 zcode / agents）

桌面端会扫描 **SKILL.md 技能包**，注入 Agent / Quest 系统提示，并提供工具：

| 工具 | 作用 |
|------|------|
| `list_skills` | 列出已发现技能（可按关键词过滤） |
| `load_skill` | 读取某技能的 `SKILL.md` 或包内相对文件，再按说明执行 |

**UI：** 左侧活动栏 ⭐ **技能管理** — 搜索 / 状态与来源过滤 / 批量禁用启用、按来源分组、查看详情（中文简介 + 触发关键词 + SKILL.md）、禁用/启用、卸载（仅用户安装源）。设置页仍可刷新列表与开关全局 Skills。

扫描优先级（存在才用）：

1. 本机 `%USERPROFILE%\.zcode\skills` / `.agents\skills`
2. 配置 `skillsDirs[]`、工作区 `.emsoder/skills` 等
3. **核心预装** `resources/core-skills`（仓库内，含 **find-skills**，干净环境也有）
4. **同步捆绑** `resources/bundled-skills`（`npm run sync-skills` 从本机同步，gitignore）
5. 可选插件缓存 `~\.zcode\cli\plugins\cache`

### 打包时带上技能 + CLI 运行时（给朋友）

```bat
npm run sync-all
pack.bat
```

`pack.bat` 会自动：

1. **sync-skills** → `resources/bundled-skills`（SKILL.md 包，跳过 `.env`；并确认 core-skills）
2. **sync-runtime** → `resources/skill-runtime`（Node CLI：`firecrawl` / `mmx` 等 + PATH 注入）
3. 打进 portable（`extraResources` 含 **core-skills** + bundled-skills + skill-runtime）

| 会打包 | 不会打包 |
|--------|----------|
| **core-skills**（find-skills 等预装） | API Key |
| 技能说明 / 工作流（sync 的 bundled） | 你的本机全局配置 |
| **便携 Node**（`skill-runtime/node`） | — |
| firecrawl / mmx CLI + PATH | — |
| 可选 **便携 Python**（`EMSODER_BUNDLE_PYTHON=1`） | — |

安装版与便携版资源相同（都走 `extraResources`），**不必为了 Node/Python 改打安装版**。

```bat
:: 默认：技能 + Node + firecrawl/mmx
npm run sync-all

:: 额外打入 Python（本机有 joyclaw python-win 或 EMSODER_PYTHON_SRC）
set EMSODER_BUNDLE_PYTHON=1
npm run sync-runtime
pack.bat
```

朋友仍需：模型 Key；云服务 Key（`FIRECRAWL_API_KEY` 等）。

自检：`npm run test:skills` · 应用内终端执行 `emsoder-skill-doctor`
