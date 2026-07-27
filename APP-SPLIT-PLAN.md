# app.js 拆分方案

> 日期：2026-07-25  
> 路径：`D:\zcode的\EMSoder\desktop`  
> 状态：**方案文档**（本轮未做行为级拆分，仅落地 `chat-virtual.js`）

## 现状

| 文件 | 规模 | 职责 |
|------|------|------|
| `renderer/js/app.js` | ~3700+ 行 | 全局 state、流式 UI、@ 引用、技能侧栏、Chat、设置、绑定、Agent 事件 |
| 已拆 | — | `dom-util.js` / `panels.js` / `quest.js` / `editor-host.js` / `chat-virtual.js` |

无 bundler：继续用 `<script>` + `window.Emsoder*` 全局，风格对齐 `EmsoderQuest`。

## 目标结构

```
renderer/js/
  dom-util.js          # 已有
  chat-virtual.js      # 已有：窗口虚拟列表
  mentions.js          # 待拆：@ 与附件
  skills-side.js       # 待拆：技能侧栏 + 安装模态
  chat-messages.js     # 待拆：addMsg / renderHistory / stream folds / 本轮改动
  settings-ui.js       # 待拆：服务商 / 模型 / 设置表单
  app.js               # 编排：state、sendMessage、onAgentEvent、init
```

`index.html` 建议顺序：

```html
<script src="js/dom-util.js"></script>
<script src="js/resize-columns.js"></script>
<script src="js/monaco-setup.js"></script>
<script src="js/lsp-host.js"></script>
<script src="js/editor-host.js"></script>
<script src="js/panels.js"></script>
<script src="js/quest.js"></script>
<script src="js/chat-virtual.js"></script>
<script src="js/mentions.js"></script>
<script src="js/skills-side.js"></script>
<script src="js/chat-messages.js"></script>
<script src="js/settings-ui.js"></script>
<script src="js/app.js"></script>
```

## 模块边界

### 1. `mentions.js` → `window.EmsoderMentions`（优先拆，依赖少）

约 `app.js` 395–650：

- `loadMentionCache` / `showMentionPopup` / `resolveAtMentions`
- `buildAttachmentPayload` / `renderAttachments` / `addAttachmentsFromPicker`

注入：`state`、`$`、`toast`、`emsoder`、`inputEl`、`workspace`。

### 2. `skills-side.js` → `window.EmsoderSkillsSide`

约 1193–1835：

- `renderSkillsSide` / `showSkillDetail` / 过滤 / 批量 / 安装向导 UI

注入：`state`、`emsoder`、`openModal`、`toast`。

### 3. `chat-messages.js` → `window.EmsoderChat`

- stream folds、`addMsg`、`renderHistory`（内部用 `EmsoderChatVirtual`）
- `renderChatChanges` / `showFileChangeDiff`
- `sendMessage` 可留在 `app.js`（编排层）或一并迁入

注入：`state`、`messagesEl`、`openFile`、`setGenerating`、分支切换。

### 4. `settings-ui.js` → `window.EmsoderSettingsUi`

- `showProviders` / `showModels` / `fillSettingsForm` / 导入导出配置

最后拆：模态与 `state.config` 耦合多。

## 拆分步骤（安全顺序）

1. **mentions.js** — 行为零变更，只搬函数 + 挂全局  
2. **skills-side.js** — 同上  
3. **chat-messages.js** — 带虚拟列表与本轮改动；跑一轮手测 Chat  
4. **settings-ui.js**  
5. 每步后：`npm start` 点一遍发送 / 技能侧栏 / 设置；可选补 smoke

## 约束

- 不改 IPC / 授权语义  
- 不引入 bundler / React  
- 共享 state 用同一对象引用，禁止深拷贝拆分  
- 全局命名统一 `Emsoder*`  
- 拆完更新 `GAPS.md` 与本文件状态为「已落地」

## 本轮已完成相关项（勿与拆分混淆）

- Chat 窗口虚拟列表：`chat-virtual.js`  
- Agent 主进程串行队列  
- 本轮改动「对比」diff 模态  
- AUDIT 文档刷新  

真正的 `app.js` 大拆仍按上表分步做。
