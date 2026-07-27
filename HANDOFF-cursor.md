# EMSoder Desktop — Cursor 交接

> 生成时间：2026-07-25  
> 项目路径：`D:\zcode的\EMSoder\desktop`  
> 用途：在 Cursor 里打开本仓库后，把本文贴给 Agent，或 `@HANDOFF-cursor.md` 引用。

---

## 1. 一分钟上手

```bash
# 在 Cursor 里
File → Open Folder → D:\zcode的\EMSoder\desktop

# 或终端
cd "D:\zcode的\EMSoder\desktop"
npm start
```

**给 Cursor Agent 的首条提示（复制即可）：**

```
请阅读 HANDOFF-cursor.md、GAPS.md、AUDIT-2026-07-25.md，继续 EMSoder Desktop。
当前工作区：D:\zcode的\EMSoder\desktop
不要重复已完成功能；先确认状态再改代码。Cursor 工作区切换若失败，一律用绝对路径。
```

---

## 2. 项目是什么

Electron 桌面壳（仿 Qoder / 天蓝色皮肤）：

- BYOK 多模型（OpenAI 兼容 / Anthropic / Ollama）
- Agent 工具：读写文件、搜索、终端、文档生成、Skills
- Quest 任务板、Monaco 编辑器、真 PTY 终端、Git
- 打包：优先 `win-unpacked`（`pack.bat`，`npmRebuild: false`）

**不是 git 仓库**（至少 desktop 根目录当时不是）。改完注意备份。

---

## 3. 最近已完成（勿重做）

| 能力 | 关键文件 |
|------|----------|
| zcode Skills 发现/注入/`list_skills`/`load_skill` | `src/tools/skills.js` |
| 打包捆绑 skills + skill-runtime | `scripts/sync-*.js`，`resources/` |
| Chat 工具/思考默认折叠 | `renderer/js/app.js`，`collapseProcess` |
| 输入旁「自动授权」 | `autoApproveSafe`；**已修**：开后读写文件也自动，仅危险终端仍问 |
| Agent 长任务续跑 | `agentMaxRounds` 32 + `agentAutoContinue` 2 |
| 真 PTY / fix-pty | `src/main/terminal.js`，`scripts/fix-pty.js` |
| **apply_diff** 多块补丁 | `definitions.js` / `executor.js` |
| **@ 文件引用** | 输入 `@` 弹列表；`fs:walk-files`；发送时读入上下文 |
| **侧栏技能管理** | 活动栏 ⭐ → 搜索+状态+**来源**过滤/列表/查看/禁用/卸载；**批量**；**安装向导**（`skillInstall.js` + 模态框） |
| 技能详情 **中文简介 + 触发关键词** | `src/tools/skillInfo.js`（≈130 条本机全覆盖）+ `skills:read` |
| **预装 find-skills** | `resources/core-skills/find-skills` · source=`core` · 打包进 extraResources |
| **@ 大文件上限** | `resolveAtMentions`：单文件 80k / 合计 200k / 最多 12 个，超限截断并 toast |
| **设置文案** | `stAutoTools` 标签为「完全自动（含危险命令）」，与输入旁「自动授权」区分 |
| **Chat 本轮改动** | 写前 snapshot + 底部摘要；单文件 / 全部撤销 + **对比** |
| **Chat 虚拟列表** | `renderer/js/chat-virtual.js` 窗口虚拟滚动 |
| **Agent 任务队列** | main 串行队列；Stop 清空 |

---

## 4. 自动授权（刚修过，重要）

**旧 bug：** `maybeConfirm` 在 `forceAsk=true` 时不认 `autoApproveSafe`，写文件仍次次弹窗。

**现行为：**

| 开关 | 效果 |
|------|------|
| `autoApproveSafe` 开 | 读/写/edit/apply_diff/文档 + 安全终端（git/npm/ls…）自动；**不安全命令仍问** |
| `autoRunTools` 开 | 连危险终端也自动 |

核心：`src/tools/executor.js` 的 `maybeConfirm` / `runTerminal`；`documents.js` 的 `maybeConfirmWrite`。

---

## 5. 技能侧栏（刚做完）

- UI：活动栏 `data-view="skills"` → `renderSkillsSide()` / `showSkillDetail()`
- IPC：`skills:list` / `skills:set-disabled` / `skills:read` / `skills:uninstall`
- Preload：`listSkills` / `setSkillDisabled` / `readSkill` / `uninstallSkill`
- 中文映射：`src/tools/skillInfo.js`（约 130 个 `SKILL_CN` 本机已装全覆盖 + `extractTriggers` 回退）
- 卸载仅允许 `zcode` / `agents` / `workspace`；bundled/plugin 只能禁用

详情页展示：英文描述 → 中文简介框 → 触发关键词标签 → 路径 → SKILL.md 原文。

---

## 6. 关键路径速查

```
desktop/
  GAPS.md                 # 功能对照（权威进度表）
  HANDOFF-cursor.md       # 本文件
  AUDIT-2026-07-25.md     # 代码 vs 文档 vs 测试缺口（绝对路径审计）
  package.json
  pack.bat
  src/
    main/main.js          # IPC 总入口
    main/agentBridge.js
    main/terminal.js
    preload/preload.js
    agent/runner.js / questRunner.js / session.js
    tools/
      definitions.js      # 工具 schema（含 apply_diff）
      executor.js         # 执行 + 授权
      skills.js / skillInfo.js / skillRuntime.js
      documents.js / paths.js / search.js
    core/config.js
  renderer/
    index.html
    css/theme.css
    js/app.js             # 侧栏、@、Chat、技能 UI 主逻辑
    js/quest.js / panels.js / editor-host.js
  scripts/
    test-skills.js / test-apply-diff.js / fix-pty.js / sync-*.js
```

技能磁盘位置（不在本仓库）：

- `~/.zcode/skills`
- `~/.agents/skills`
- 工作区 `.emsoder/skills`
- 打包：`resources/bundled-skills`（gitignore，`npm run sync-skills` 生成）

---

## 7. 建议的后续（用户尚未点名做）

虚拟列表 / 队列 / 本轮 diff / skillInfo / 安装向导 均已落地，勿重做。按优先级任选：

1. **按 APP-SPLIT-PLAN 拆 app.js**（mentions → skills-side → chat）
2. **MCP**
3. **walk 继续加载 / forceAsk 清理**
4. **i18n / 自动更新 / 安装包体积**
5. **测试**：`test:apply-diff` + `test:skills` + `test:skill-install` 已有

P2 对照见 `GAPS.md`；完整缺口表见 `AUDIT-2026-07-25.md`。

---

## 8. 约束与习惯

- 配置里 **不要** 把 API Key 打进分享包；export 默认脱敏
- 打包：`npmRebuild: false`；中文路径构建曾踩坑，可用 `D:\emsoder-build` 中转
- 改工具授权时同时考虑 Chat runner 与 Quest runner
- UI 风格：天蓝色深色主题，侧栏与 composer 已有既有 class，新 UI 对齐 `theme.css`
- 用户偏好口语、直接；改完在 GAPS 记一笔

---

## 9. 自检命令

```bash
cd "D:\zcode的\EMSoder\desktop"
node -e "require('./src/tools/skillInfo'); require('./src/tools/executor'); console.log('ok')"
npm run test:skills
npm run test:apply-diff
# 完整跑：npm start
```

---

## 10. 会话外补充

- 曾执行：`npx skills add mattpocock/skills --skill=grill-me -y -g`（实际装了很多相关技能到 `~/.agents/skills`）
- 本机 AGENTS.md 有用户级偏好（角色/NSFW 等）；**写产品代码时以本仓库 GAPS/README 为准**，不要把那些角色规则写进 EMSoder 产品逻辑

---

**Cursor 最小继续指令：**

> 打开 `D:\zcode的\EMSoder\desktop`，读 `HANDOFF-cursor.md`，然后实现：\_\_\_\_（填你要做的下一条）。
