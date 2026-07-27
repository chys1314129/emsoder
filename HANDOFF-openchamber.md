# EMSoder Desktop — OpenChamber 交接

> 生成：2026-07-25  
> 根目录（唯一工作区）：`D:\zcode的\EMSoder\desktop`  
> 用途：Cursor 接力失败后，在 **OpenChamber** 新会话整段粘贴下方「首条提示」；或先打开本文件再 `@` 引用。

---

## OpenChamber 操作

1. 工作目录设为：`D:\zcode的\EMSoder\desktop`（不要只开上一级 `EMSoder`）
2. 若目录绑定失败：**全程绝对路径**读写，禁止相对路径猜测
3. 新 Agent 对话 → 粘贴本文 **§首条提示（完整）**
4. 能挂文件时再附：
   - `D:\zcode的\EMSoder\desktop\HANDOFF-openchamber.md`
   - `D:\zcode的\EMSoder\desktop\HANDOFF-cursor.md`
   - `D:\zcode的\EMSoder\desktop\GAPS.md`
   - `D:\zcode的\EMSoder\desktop\AUDIT-2026-07-25.md`

---

## 首条提示（完整 · 复制到 OpenChamber）

```
你在 OpenChamber 接力 EMSoder Desktop。Cursor 已失败，不要依赖工作区切换。

【硬性路径】
唯一根目录：D:\zcode的\EMSoder\desktop
所有 Read/Edit/Write/Bash/Glob/Grep 必须用绝对路径。
示例：D:\zcode的\EMSoder\desktop\src\tools\executor.js
禁止 cd 到未知相对目录后靠猜路径改文件。

【先只读 · 再动手】
按顺序读完（用绝对路径打开）：
1. D:\zcode的\EMSoder\desktop\HANDOFF-openchamber.md
2. D:\zcode的\EMSoder\desktop\HANDOFF-cursor.md
3. D:\zcode的\EMSoder\desktop\GAPS.md
4. D:\zcode的\EMSoder\desktop\AUDIT-2026-07-25.md
读完后先用 8 行以内复述：项目是什么 / 已完成勿碰 / 你选的下一条 / 将改哪些绝对路径文件。
用户未点名时，默认做「下一优先」第 1 条。

【项目一句话】
Electron 桌面壳（仿 Qoder，天蓝色）：BYOK 多模型、Agent 工具、Quest、Monaco、真 PTY、Git、Skills。
打包优先 win-unpacked（pack.bat，npmRebuild: false）。desktop 根目录可能不是 git。

【已完成 · 禁止重做 / 禁止再实现一遍】
- apply_diff（definitions.js / executor.js；Quest snapshot 已纳入）
- Chat @ 文件引用（fs:walk-files + app.js；发送附带内容）
- @ 大文件上限（单文件 80k / 合计 200k / 最多 12；超限截断+toast）
- 技能侧栏：列表/详情/禁用/卸载
- 技能侧栏搜索 + 状态过滤 + 来源过滤 + 批量禁用/启用
- 技能安装向导 UI（skillInstall.js + IPC + 侧栏 + modalSkillInstall）
- 技能详情中文简介 + 触发关键词（skillInfo.js + skills:read；本机已装 SKILL_CN 全覆盖 ≈130）
- **预装 find-skills**（`resources/core-skills/find-skills`，来源 `core`，打包 extraResources）
- skills:read 可看已禁用技能（loadSkillContent allowDisabled）
- autoApproveSafe：读写文件+安全终端自动；仅高危险终端仍问
- autoRunTools：完全自动（含危险命令）；设置标签已区分「自动授权」
- Chat 本轮改动：写前 snapshot + 底部摘要；单文件/全部撤销 + **对比 diff**
- Chat **真虚拟列表**（`renderer/js/chat-virtual.js`，非 80 条截断）
- Agent **任务队列**（main 串行；Stop 清空队列）
- skillInfo 本机映射全覆盖 ≈130
- Chat 队列跑完后状态归零修复（`pumpChatQueue` emit `done:true` + 渲染层 `case "queue" depth=0` 时强制 `setGenerating(false)`）
- 文档：README / GAPS / HANDOFF / AUDIT 刷新 / **APP-SPLIT-PLAN.md**

【自动授权 · 勿回退】
- 输入旁「自动授权」= autoApproveSafe
- 设置「完全自动（含危险命令）」= autoRunTools
- 不安全终端不走 maybeConfirm，直接 ctx.confirm
- 禁止改回「autoApproveSafe 时写文件仍确认」
- 改授权时同时检查 Chat runner 与 Quest runner

【下一优先 · 任选 1 条做完即停并更新文档】
1) 按 APP-SPLIT-PLAN 拆 mentions.js / skills-side.js（零行为变更）
2) MCP 接入
3) walk 继续加载 / maybeConfirm 清 forceAsk
4) 统一 npm test / desktop 初始化 git（可选）

默认：若用户没指定，做 1) app 拆分 mentions

【约束】
- 不把 API Key 打进打包产物；export 默认脱敏
- 打包：npmRebuild false；中文路径构建可用 D:\emsoder-build 中转
- UI 对齐 renderer/css/theme.css 天蓝色深色，不另起皮肤
- 本机 ~/.zcode 用户 AGENTS 角色/NSFW 规则禁止写进 EMSoder 产品逻辑
- 改完：在 GAPS.md 记一笔；同步 HANDOFF-openchamber.md / HANDOFF-cursor.md「已完成/下一优先」
- 回复口语直接；改动用绝对路径列出文件

【自检】
cd /d D:\zcode的\EMSoder\desktop
node -e "require('./src/tools/skillInfo'); require('./src/tools/executor'); console.log('ok')"
npm run test:skills
npm run test:apply-diff
npm run test:skill-install

开始：只读四份交接 → 复述状态 → 实现默认第 1 条（或用户点名的那条）→ 跑自检 → 更新 GAPS/HANDOFF。
```

---

## 短提示（已熟悉时）

```
OpenChamber 接力 EMSoder。根目录绝对路径：D:\zcode的\EMSoder\desktop
先读：HANDOFF-openchamber.md、HANDOFF-cursor.md、GAPS.md、AUDIT-2026-07-25.md（均用绝对路径）
禁止重做：apply_diff / @ / 技能侧栏搜索批量安装 / autoApprove 写放行 / Chat 本轮撤销 / test-apply-diff / test-skill-install / allowDisabled
请实现：按 APP-SPLIT-PLAN 拆 mentions.js（零行为变更）
做完更新 GAPS + 两份 HANDOFF，并跑相关自检
全程绝对路径。
```

把最后「请实现：…」换成 MCP / walk 分页 / 清 forceAsk 即可换任务。

---

## 关键绝对路径

| 用途 | 路径 |
|------|------|
| 本交接 | `D:\zcode的\EMSoder\desktop\HANDOFF-openchamber.md` |
| Cursor 旧交接 | `D:\zcode的\EMSoder\desktop\HANDOFF-cursor.md` |
| 功能表 | `D:\zcode的\EMSoder\desktop\GAPS.md` |
| 审计 | `D:\zcode的\EMSoder\desktop\AUDIT-2026-07-25.md` |
| 技能中文 | `D:\zcode的\EMSoder\desktop\src\tools\skillInfo.js` |
| 技能发现 | `D:\zcode的\EMSoder\desktop\src\tools\skills.js` |
| 安装向导 | `D:\zcode的\EMSoder\desktop\src\tools\skillInstall.js`（若存在） |
| 工具执行 | `D:\zcode的\EMSoder\desktop\src\tools\executor.js` |
| UI 主逻辑 | `D:\zcode的\EMSoder\desktop\renderer\js\app.js` |
| 主进程 IPC | `D:\zcode的\EMSoder\desktop\src\main\main.js` |

---

## 自检

```bat
cd /d D:\zcode的\EMSoder\desktop
node -e "require('./src/tools/skillInfo'); require('./src/tools/executor'); console.log('ok')"
npm run test:skills
npm run test:apply-diff
npm run test:skill-install
```
