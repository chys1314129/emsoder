/**
 * Built-in Chinese descriptions and trigger keywords for common skills.
 * Skill not listed here → triggers are auto-extracted from the English description.
 */

const SKILL_CN = {
  // ── zcode built-in ──
  "find-skills": {
    desc: "帮助用户发现和安装 Agent 技能。当用户问「怎么用 X」「有没有 X 技能」时触发。",
    triggers: ["找技能", "安装技能", "有什么技能", "技能市场", "npx skills"],
  },

  // ── Search ──
  "bocha-web-search": {
    desc: "博查 Web 搜索，使用 Bocha API 进行联网搜索。适用于在线查询、事实核查、时效信息。",
    triggers: ["搜索", "查一下", "网上搜", "最新消息", "事实核查"],
  },
  "bocha-web-search-a2m": {
    desc: "博查 Web 搜索（A2M 版），同上但输出格式兼容 A2M 协议。",
    triggers: ["搜索", "查一下", "A2M 搜索"],
  },
  "bocha-local": {
    desc: "博查本地搜索，针对本地/离线信息源搜索。",
    triggers: ["本地搜索", "离线搜索"],
  },
  "firecrawl-search": {
    desc: "Firecrawl 网页搜索，返回全文 Markdown 内容而非摘要。深度内容获取首选。",
    triggers: ["搜索", "搜文章", "research", "firecrawl"],
  },
  "firecrawl-scrape": {
    desc: "Firecrawl 单页抓取，提取指定 URL 的全文 Markdown。",
    triggers: ["抓取", "提取网页", "scrape", "扒内容", "这个网址"],
  },
  "firecrawl-crawl": {
    desc: "Firecrawl 站点批量爬取，从一个网站抓取多个页面。",
    triggers: ["爬取", "批量抓", "crawl", "全站抓取"],
  },
  "firecrawl-map": {
    desc: "Firecrawl 站点地图，发现网站上的所有 URL 列表。",
    triggers: ["站点地图", "发现链接", "map", "有哪些页面"],
  },
  "tavily-search": {
    desc: "Tavily Web 搜索，LLM 优化的搜索结果。支持域名过滤、时间范围、多种搜索深度。",
    triggers: ["搜索", "搜一下", "find articles", "latest", "news"],
  },
  "tavily-extract": {
    desc: "Tavily 网页内容提取，从指定 URL 提取处理后的内容。",
    triggers: ["提取", "extract", "内容提取", "这个网页"],
  },
  "tavily-crawl": {
    desc: "Tavily 站点爬取，批量抓取网站内容。",
    triggers: ["爬取", "crawl", "批量提取"],
  },
  "tavily-research": {
    desc: "Tavily 深度研究，多源综合分析带引用。适合需要全面调研的场景。",
    triggers: ["深度研究", "research", "调研", "综合分析"],
  },
  "parallel-web-search": {
    desc: "Parallel 网页搜索，快速且经济的默认搜索工具。日常查资料首选。",
    triggers: ["搜索", "查资料", "parallel", "web lookup"],
  },
  "parallel-deep-research": {
    desc: "Parallel 深度研究，详尽的多源调研。当用户明确要求「深度」或「详尽」研究时使用。",
    triggers: ["深度研究", "详尽调研", "exhaustive research"],
  },
  "deep-research": {
    desc: "通用深度研究技能，全面调查某个主题并给出有引用的报告。",
    triggers: ["深度研究", "全面调研", "deep research"],
  },
  "metaso-local": {
    desc: "秘塔本地搜索，中文搜索优化。",
    triggers: ["秘塔", "metaso", "中文搜索"],
  },
  "media-search": {
    desc: "媒体搜索，搜索图片/视频等多媒体内容。",
    triggers: ["搜图", "搜视频", "找图片", "media search"],
  },

  // ── Code / Dev ──
  "code-review": {
    desc: "双轴代码审查：标准合规 + 需求对齐。并行动态子 Agent 审查代码变更。",
    triggers: ["code review", "审查", "review", "PR review", "代码审查"],
  },
  "diagnosing-bugs": {
    desc: "Bug 诊断，系统化排查代码问题。",
    triggers: ["bug", "报错", "出问题了", "排查", "diagnose", "fix bug"],
  },
  "implement": {
    desc: "按规格说明实现功能。配合 TDD 和 code review 使用。",
    triggers: ["实现", "implement", "按规格写", "按需求做"],
  },
  "codebase-design": {
    desc: "代码库架构设计，帮助规划项目结构和模块划分。",
    triggers: ["架构设计", "项目结构", "模块划分", "design", "architecture"],
  },
  "domain-modeling": {
    desc: "领域建模，帮助定义业务域模型和实体关系。",
    triggers: ["领域建模", "domain model", "实体关系", "业务模型"],
  },
  "improve-codebase-architecture": {
    desc: "改进代码库架构，优化现有代码结构。",
    triggers: ["改进架构", "重构架构", "优化结构", "architecture improvement"],
  },
  "prototype": {
    desc: "快速原型开发，快速搭建可验证的概念代码。",
    triggers: ["原型", "prototype", "快速搭建", "POC", "概念验证"],
  },
  "research": {
    desc: "技术调研，深入研究某个技术方案或工具。",
    triggers: ["调研", "research", "技术选型", "方案对比"],
  },
  "tdd": {
    desc: "测试驱动开发，先写测试再写代码。",
    triggers: ["TDD", "测试驱动", "先写测试", "test first"],
  },
  "teach": {
    desc: "教学模式，用 Socratic 对话方式引导用户学习。",
    triggers: ["教我", "学习", "teach", "讲解", "socratic"],
  },
  "ask-matt": {
    desc: "向 Matt Pocock 提问，获取 TypeScript 最佳实践建议。",
    triggers: ["ask matt", "问 matt", "typescript 最佳实践"],
  },
  "setup-matt-pocock-skills": {
    desc: "初始化 Matt Pocock 技能套件，配置问题追踪器文档。",
    triggers: ["setup matt", "初始化技能套件", "配置追踪器"],
  },
  "wayfinder": {
    desc: "导航助手，引导用户找到正确的技能或流程。",
    triggers: ["wayfinder", "导航", "引导"],
  },
  "triage": {
    desc: "问题分类，对 Bug 或需求进行优先级排序和分类。",
    triggers: ["triage", "分类", "优先级", "排序"],
  },
  "to-spec": {
    desc: "将需求转化为规格文档，产出结构化的功能规格。",
    triggers: ["写规格", "to spec", "规格文档", "PRD"],
  },
  "to-tickets": {
    desc: "将规格拆分为可执行的开发任务工单。",
    triggers: ["拆任务", "to tickets", "工单", "任务拆分"],
  },
  "to-questionnaire": {
    desc: "生成需求澄清问卷，帮助完善模糊的需求。",
    triggers: ["问卷", "需求澄清", "questionnaire"],
  },
  "request-refactor-plan": {
    desc: "制定重构计划，分析现有代码并给出重构步骤。",
    triggers: ["重构计划", "refactor plan", "代码重构"],
  },
  "design-an-interface": {
    desc: "设计 API/组件接口，定义方法签名和类型契约。",
    triggers: ["接口设计", "API 设计", "design interface"],
  },
  "qa": {
    desc: "QA 测试技能，编写测试用例和自动化测试。",
    triggers: ["QA", "测试", "test cases", "自动化测试"],
  },

  // ── Dev platform ──
  "frontend-dev": {
    desc: "前端开发技能，React/Vue/HTML/CSS 等前端技术栈。",
    triggers: ["前端", "frontend", "React", "Vue", "CSS", "HTML"],
  },
  "fullstack-dev": {
    desc: "全栈开发技能，前后端 + 数据库一站式开发。",
    triggers: ["全栈", "fullstack", "前后端", "数据库"],
  },
  "flutter-dev": {
    desc: "Flutter 开发，Dart + Flutter 跨平台应用开发。",
    triggers: ["Flutter", "Dart", "跨平台", "移动开发"],
  },
  "android-native-dev": {
    desc: "Android 原生开发，Kotlin/Java + Android SDK。",
    triggers: ["Android", "Kotlin", "安卓", "原生开发"],
  },
  "ios-application-dev": {
    desc: "iOS 原生开发，Swift/ObjC + iOS SDK。",
    triggers: ["iOS", "Swift", "苹果开发", "iPhone"],
  },
  "react-native-dev": {
    desc: "React Native 跨平台移动开发。",
    triggers: ["React Native", "RN", "跨平台移动"],
  },
  "shader-dev": {
    desc: "Shader 开发，GLSL/HLSL 着色器编程。",
    triggers: ["shader", "着色器", "GLSL", "HLSL", "图形"],
  },

  // ── Git / Workflow ──
  "resolving-merge-conflicts": {
    desc: "解决 Git 合并冲突，辅助处理 merge/rebase 冲突。",
    triggers: ["merge conflict", "合并冲突", "冲突解决", "rebase"],
  },
  "git-guardrails-claude-code": {
    desc: "Git 安全护栏，防止不当操作破坏仓库。",
    triggers: ["git guard", "安全提交", "git 规范"],
  },
  "claude-handoff": {
    desc: "会话交接，在多轮对话间传递上下文。",
    triggers: ["交接", "handoff", "传递上下文", "继续上次"],
  },
  "handoff": {
    desc: "任务交接，将当前工作状态传递给下一个 Agent。",
    triggers: ["交接", "handoff", "转交", "传递任务"],
  },
  "grill-me": {
    desc: "无情拷问模式，对计划或设计进行压力测试和质疑。",
    triggers: ["grill", "拷问", "质疑", "压力测试", "审视方案"],
  },
  "grilling": {
    desc: "持续拷问，逐层深入分析每个决策分支。",
    triggers: ["grilling", "深入拷问", "层层追问", "决策分析"],
  },
  "grill-with-docs": {
    desc: "带文档的拷问，结合项目文档对设计进行审核。",
    triggers: ["grill with docs", "带文档审核", "规范审查"],
  },
  "batch-grill-me": {
    desc: "批量拷问，对多个方案或决策进行并行的压力测试。",
    triggers: ["批量拷问", "batch grill", "多方案审视"],
  },
  "loop-me": {
    desc: "循环执行模式，反复迭代一个任务直到满足条件。",
    triggers: ["loop", "循环", "反复执行", "迭代"],
  },
  "setup-pre-commit": {
    desc: "配置 pre-commit 钩子，在提交前自动运行检查。",
    triggers: ["pre-commit", "提交钩子", "setup pre-commit"],
  },
  "setup-ts-deep-modules": {
    desc: "配置 TypeScript 深度模块路径，优化类型检查。",
    triggers: ["ts deep modules", "模块配置", "TS 路径"],
  },
  "edit-article": {
    desc: "编辑文章，优化文档结构和表达。",
    triggers: ["编辑文章", "edit article", "润色", "改文章"],
  },
  "writing-beats": {
    desc: "写作节拍框架，帮助规划叙事结构和节奏。",
    triggers: ["写作", "writing beats", "叙事", "节奏"],
  },
  "writing-fragments": {
    desc: "写作片段生成，产出灵活的场景片段。",
    triggers: ["写作片段", "writing fragments", "场景"],
  },
  "writing-shape": {
    desc: "写作结构塑形，调整文章的整体布局。",
    triggers: ["写作结构", "writing shape", "文章布局"],
  },
  "writing-great-skills": {
    desc: "编写高质量 Agent 技能的指南和最佳实践。",
    triggers: ["写技能", "writing skills", "技能编写"],
  },
  "ubiquitous-language": {
    desc: "统一语言建模，在团队中建立一致的领域术语。",
    triggers: ["统一语言", "ubiquitous language", "DDD 术语"],
  },
  "wizard": {
    desc: "向导模式，通过分步对话引导用户完成复杂任务。",
    triggers: ["wizard", "向导", "分步引导"],
  },

  // ── Document gen ──
  "minimax-docx": {
    desc: "MiniMax 生成 Word 文档。",
    triggers: ["生成 docx", "word 文档", "minimax word"],
  },
  "minimax-pdf": {
    desc: "MiniMax 生成 PDF 文档。",
    triggers: ["生成 pdf", "pdf 文档", "minimax pdf"],
  },
  "minimax-xlsx": {
    desc: "MiniMax 生成 Excel 表格。",
    triggers: ["生成 excel", "表格", "minimax xlsx"],
  },
  "minimax-music-gen": {
    desc: "MiniMax 音乐生成。",
    triggers: ["生成音乐", "作曲", "minimax music"],
  },
  "minimax-music-playlist": {
    desc: "MiniMax 播放列表生成。",
    triggers: ["播放列表", "playlist", "歌单"],
  },
  "pptx-generator": {
    desc: "PPT 生成器，生成 PowerPoint 演示文稿。",
    triggers: ["生成 ppt", "幻灯片", "powerpoint", "演示文稿"],
  },
  "gif-sticker-maker": {
    desc: "GIF 贴纸制作，生成动态贴纸。",
    triggers: ["gif", "贴纸", "表情包", "动图"],
  },

  // ── Misc ──
  "buddy-sings": {
    desc: "Buddy 唱歌模式，AI 以歌词形式回复。",
    triggers: ["唱歌", "sing", "buddy", "歌词"],
  },
  "hermes-evolution": {
    desc: "Hermes 进化，知识图谱和推理链演化。",
    triggers: ["hermes", "进化", "推理", "知识图谱"],
  },
  "agent-reach": {
    desc: "Agent Reach，让 Agent 调用其他 Agent 完成任务。",
    triggers: ["agent reach", "调用 agent", "子 agent"],
  },
  "vision-analysis": {
    desc: "视觉分析，对图片进行理解和描述。",
    triggers: ["分析图片", "看图", "vision", "图片理解"],
  },
  "feishu-wiki-extract": {
    desc: "飞书知识库内容提取。",
    triggers: ["飞书", "feishu", "知识库", "wiki"],
  },
  "vxpublic-fetch": {
    desc: "微信公众号文章抓取。",
    triggers: ["公众号", "微信文章", "wxpublic"],
  },
  // "公众号抓取wxpublic-fetch-1.0.6" → alias added below after wxpublic-fetch

  // ── Firecrawl 扩展 ──
  "firecrawl": {
    desc: "Firecrawl 总入口：搜索、抓取、交互网页。日常联网查资料、扒页面、爬文档都可用。",
    triggers: ["firecrawl", "搜网页", "抓取网页", "查一下", "扒内容"],
  },
  "firecrawl-agent": {
    desc: "Firecrawl 智能抽取：自动导航复杂站点，按 schema 返回结构化 JSON（定价、商品列表等）。",
    triggers: ["结构化抽取", "extract as JSON", "拉商品列表", "定价档位", "结构化数据"],
  },
  "firecrawl-build-interact": {
    desc: "把 Firecrawl /interact 接到产品代码：点击、填表、分页、登录后抓取等动态流程。",
    triggers: ["接入 interact", "动态页面", "填表抓取", "点击后抓取"],
  },
  "firecrawl-build-onboarding": {
    desc: "Firecrawl 凭证与 SDK 接入引导：配置 API Key、.env、首次集成。",
    triggers: ["Firecrawl 配置", "FIRECRAWL_API_KEY", "接入 Firecrawl", "onboarding"],
  },
  "firecrawl-build-scrape": {
    desc: "把 Firecrawl /scrape 接到产品：单页 Markdown/HTML/截图/元数据抽取。",
    triggers: ["接入 scrape", "单页抽取", "页面 markdown"],
  },
  "firecrawl-build-search": {
    desc: "把 Firecrawl /search 接到产品：先搜索再可选补全文。",
    triggers: ["接入 search", "搜索再抽取", "discovery search"],
  },
  "firecrawl-company-directories": {
    desc: "从企业目录站抽公司列表（YC、Crunchbase、Product Hunt 等）导出 JSON/CSV。",
    triggers: ["公司目录", "创业公司列表", "Crunchbase", "YC 名单"],
  },
  "firecrawl-competitive-intel": {
    desc: "竞品情报：监控定价、功能、changelog、产品变更并结构化告警。",
    triggers: ["竞品监控", "竞品定价", "competitive intel", "产品变更跟踪"],
  },
  "firecrawl-dashboard-reporting": {
    desc: "从分析看板/内部 Web 工具拉指标，做跨平台汇总与日期范围报表。",
    triggers: ["看板报表", "dashboard metrics", "拉指标", "分析汇总"],
  },
  "firecrawl-deep-research": {
    desc: "Firecrawl 深度研究报告：执行摘要、多角度发现、反方观点、开放问题与完整引用。",
    triggers: ["深度报告", "正式调研报告", "cited analytical report", "firecrawl research"],
  },
  "firecrawl-demo-walkthrough": {
    desc: "用浏览器走产品主流程，产出注册/引导/定价/文档等 UX 走查纪要。",
    triggers: ["产品走查", "UX walkthrough", "demo 流程", "首跑体验"],
  },
  "firecrawl-download": {
    desc: "整站下载为本地 Markdown/截图等多格式，适合离线文档镜像。",
    triggers: ["下载整站", "离线文档", "save site locally", "offline copy"],
  },
  "firecrawl-interact": {
    desc: "控制实时浏览器会话：点击、填表、分页、无限滚动、登录后抓取。",
    triggers: ["浏览器交互", "点按钮", "填表", "登录后抓", "分页抓取"],
  },
  "firecrawl-knowledge-base": {
    desc: "用网页内容建知识库：RAG 分块、微调语料、文档镜像、主题语料。",
    triggers: ["建知识库", "RAG 语料", "文档镜像", "knowledge base"],
  },
  "firecrawl-knowledge-ingest": {
    desc: "摄入公开或登录后的文档门户/帮助中心（JS 重、分页、需登录）。",
    triggers: ["摄入文档站", "帮助中心", "login-gated docs", "知识库导入"],
  },
  "firecrawl-lead-gen": {
    desc: "从潜客库/目录生成线索列表，按角色、行业、技术栈等导出 CRM 可用数据。",
    triggers: ["线索生成", "lead gen", "潜客列表", "CRM 导出"],
  },
  "firecrawl-lead-research": {
    desc: "会前线索情报：公司/人物近况、痛点、谈资，用于销售或合作拜访。",
    triggers: ["会前调研", "lead research", "客户情报", "谈资准备"],
  },
  "firecrawl-local": {
    desc: "本机 Firecrawl 配置与路由：何时用 Firecrawl / Tavily / media-search / Exa。",
    triggers: ["Firecrawl 本机", "firecrawl local", "路由选型", "API 已配"],
  },
  "firecrawl-market-research": {
    desc: "市场/财报/行业指标抽取：公开公司数据、同业对比、结构化市场报告。",
    triggers: ["市场调研", "财报", "行业趋势", "market research"],
  },
  "firecrawl-monitor": {
    desc: "监控网页变更（定价/文档/招聘/博客），Webhook 或邮件通知；AI 过滤噪声。",
    triggers: ["监控网页", "变更告警", "watch page", "notify when changes"],
  },
  "firecrawl-parse": {
    desc: "本地文件解析：PDF/DOCX/XLSX/HTML 等转干净 Markdown 落盘。",
    triggers: ["解析 PDF", "读本地文档", "convert document", "extract text from file"],
  },
  "firecrawl-qa": {
    desc: "对线上站点做探索性 QA：表单、导航、响应式、性能观察与缺陷报告。",
    triggers: ["网站 QA", "上线前检查", "form testing", "exploratory QA"],
  },
  "firecrawl-research-index": {
    desc: "用语义检索找能回答问题的论文集合，含扩展与正文核验。",
    triggers: ["找论文", "literature index", "paper retrieval", "检索文献"],
  },
  "firecrawl-research-papers": {
    desc: "论文/白皮书/技术报告检索与综合：文献综述、研究全景、带出处摘要。",
    triggers: ["文献综述", "论文综述", "research papers", "学术来源"],
  },
  "firecrawl-seo-audit": {
    desc: "网站 SEO 审计：元数据、标题、站点结构、关键词与竞品 SERP 建议。",
    triggers: ["SEO 审计", "seo audit", "关键词机会", "站点结构"],
  },
  "firecrawl-shop": {
    desc: "全网比价与购物推荐：评测、预算、偏好，可结合已登录会话。",
    triggers: ["比价", "购物推荐", "选购", "product compare"],
  },
  "firecrawl-website-design-clone": {
    desc: "从任意网站抽设计系统到 DESIGN.md（色/字/间距/组件），供复刻 UI。",
    triggers: ["克隆设计", "设计系统", "DESIGN.md", "仿站 UI"],
  },
  "firecrawl-workflows": {
    desc: "结果导向的 Firecrawl 工作流：调研报告、SEO、QA、线索、知识库等交付物。",
    triggers: ["firecrawl 工作流", "交付物调研", "SEO 报告流程"],
  },

  // ── Tavily / Parallel / Exa 扩展 ──
  "tavily-cli": {
    desc: "Tavily CLI 总入口：搜索、提取、爬取、地图、深度研究。",
    triggers: ["tavily", "tavily cli", "联网搜索", "提取网页"],
  },
  "tavily-map": {
    desc: "Tavily 站点 URL 发现：只列链接不抽正文，比 crawl 更快。",
    triggers: ["map the site", "站点有哪些页", "list all pages", "site structure"],
  },
  "tavily-dynamic-search": {
    desc: "上下文隔离的程序化搜索：过滤结果并只抽关键信息，默认联网调研技能。",
    triggers: ["动态搜索", "look up", "search and filter", "curated search"],
  },
  "tavily-best-practices": {
    desc: "Tavily 生产集成最佳实践：Agent/RAG 里搜索、抽取、爬取、研究的写法参考。",
    triggers: ["Tavily 最佳实践", "tavily integration", "生产接入 Tavily"],
  },
  "parallel-cli-setup": {
    desc: "安装与维护 Parallel CLI：安装、鉴权、余额、skills 安装。",
    triggers: ["Parallel CLI", "parallel setup", "安装 parallel"],
  },
  "parallel-data-enrichment": {
    desc: "批量数据 enrichment：给公司/人物/产品列表补 CEO、融资、联系方式等字段。",
    triggers: ["数据 enrichment", "补全 CSV", "enrich leads", "批量补字段"],
  },
  "parallel-findall": {
    desc: "按自然语言发现实体列表（公司/人/产品），返回结构化名单而非网页。",
    triggers: ["find all", "列出所有", "findall", "实体名单"],
  },
  "parallel-monitor": {
    desc: "按周期持续监控网页变化并告警；可列出/更新/停止已有 monitor。",
    triggers: ["持续监控", "track changes", "alert me when", "monitor web"],
  },
  "parallel-web-extract": {
    desc: "Parallel URL 内容提取：网页/PDF/重 JS 站，token 友好。",
    triggers: ["提取 URL", "web extract", "读这个链接", "抽正文"],
  },
  // "EXA搜索" → alias added below after exa-search
  "migrate-to-parallel": {
    desc: "把 Exa/Tavily/Perplexity/Firecrawl 集成完整迁到 Parallel 产品，保留行为。",
    triggers: ["迁到 Parallel", "migrate parallel", "替换 firecrawl", "换搜索供应商"],
  },

  // ── 工程 / 工作流 ──
  "planning-with-files": {
    desc: "文件化持久规划：task_plan/findings/progress 落盘，跨会话与 /clear 后可恢复。",
    triggers: ["文件规划", "task_plan", "多步计划", "planning with files"],
  },
  "scaffold-exercises": {
    desc: "搭建练习目录结构：章节、题目、解答、讲解，并通过 lint。",
    triggers: ["搭练习", "scaffold exercises", "课程章节", "练习桩"],
  },
  "migrate-to-shoehorn": {
    desc: "测试里把 `as` 断言迁到 @total-typescript/shoehorn，支持部分测试数据。",
    triggers: ["shoehorn", "migrate as", "测试断言", "type assertion"],
  },
  "obsidian-vault": {
    desc: "在 Obsidian 库中搜索、创建、管理笔记（wikilink 与索引笔记）。",
    triggers: ["Obsidian", "笔记库", "wikilink", "整理笔记"],
  },
  "status": {
    desc: "按 run ID 查询进行中的研究任务状态。",
    triggers: ["任务状态", "run status", "研究进度", "status by id"],
  },
  "result": {
    desc: "按 run ID 取回已完成的研究任务结果。",
    triggers: ["取研究结果", "result by id", "完成结果", "run result"],
  },
  // "minimax-multimodal-toolkit" → alias added below after mmx-cli

  // ── 中文角色 / 核查（带英文 id 的权威条目在下方；这里只保留无英文 id 的独立技能）──
  "luoxiang-trinity": {
    desc: "三合一罗翔视角：法理、表达与 Agentic 工作流，看法理边界与社会热点。",
    triggers: ["罗翔", "罗翔视角", "罗翔怎么看", "罗翔模式", "从罗翔视角"],
  },

  // ── 本机用户自定义技能（中文目录名）──
  "cite-hallucination-check": {
    desc: "引用幻觉核查：逐条验证报告/文档中的引用是否真实存在，判定「真实可溯/有小错/编造/无法核实/存疑」五类，输出红旗清单。",
    triggers: [
      "核查引用", "引用幻觉", "来源靠不靠谱", "出处核实",
      "有没有编造的引用", "fact check", "citation verification",
      "核实来源", "验证引用", "查引用真假",
    ],
  },
  "darwin-skill": {
    desc: "达尔文 3.0：自主技能优化器，基于 GEP 基因/胶囊/事件自进化模型，从执行轨迹中提取基因并打包策略，带完整审计日志。",
    triggers: [
      "达尔文", "技能进化", "自优化", "gene evolution",
      "skill optimizer", "进化技能", "自我迭代",
    ],
  },
  "dingyuanying-perspective": {
    desc: "丁元英视角：《遥远的救世主》虚构人物的思维操作系统，用于剖析文化属性与商业逻辑。",
    triggers: [
      "丁元英", "遥远的救世主", "文化属性", "强势文化",
      "弱势文化", "丁元英视角", "豆豆",
    ],
  },
  "exa-search": {
    desc: "Exa 联网搜索：用 Exa MCP 进行网页搜索、按域名/日期/分类过滤、抓取页面全文 Markdown。适合时效性信息和深度 research。",
    triggers: [
      "exa 搜索", "联网搜", "网页搜索", "搜最新", "research",
      "domain search", "web retrieval",
    ],
  },
  "feynman-perspective": {
    desc: "费曼视角：用理查德·费曼的思维框架分析问题——检测「货物崇拜」、区分命名与真正理解、用演示替代空洞论证。",
    triggers: [
      "费曼", "费曼视角", "feynman", "费曼学习法",
      "cargo cult", "命名不等于理解", "用简单的话真的理解了吗",
    ],
  },
  "handctoken": {
    desc: "Headroom + Caveman 整合省流：双层 token 优化，输出极简（~75% 节省）并控制上下文余量。",
    triggers: [
      "省 token", "token 省流", "caveman", "headroom",
      "极简输出", "压缩回答", "节省上下文",
    ],
  },
  "mmx-cli": {
    desc: "MiniMax 多模态 CLI（mmx）：通过终端生成文字、图片、视频、语音、音乐，调用 MiniMax AI 平台，支持联网搜索与资源管理。",
    triggers: [
      "mmx", "minimax", "生成图片", "生成视频", "生成语音",
      "生成音乐", "文生图", "MiniMax", "多模态生成",
    ],
  },
  "news-fact-check": {
    desc: "新闻事实核查：验证消息真假、辨别谣言、鉴别信息可信度，输出核查结论。",
    triggers: [
      "核实新闻", "验证新闻", "新闻真假", "是不是谣言",
      "辟谣", "假新闻", "fact check", "这条新闻靠谱吗",
      "信息核查", "真的假的", "debunk",
    ],
  },
  "nopua-zh": {
    desc: "反 PUA（中文版）：用智慧与信任而非威胁驱动 AI，任务卡住/反复失败/甩锅时激活，恢复内在动力。",
    triggers: [
      "NoPUA", "以道驭术", "别 PUA 我", "换个思路",
      "为什么老是失败", "try harder", "figure it out",
    ],
  },
  "wxpublic-fetch": {
    desc: "微信公众号抓取：按公众号名称和日期范围抓取文章，保存为本地 Markdown 文件。",
    triggers: [
      "抓取公众号", "获取公众号文章", "下载微信文章",
      "爬公众号", "保存公众号内容", "公众号抓取",
    ],
  },
};

// ── 别名：中文目录名 → 英文 id 权威条目（同一对象引用，避免维护两份）──
// skills.js 以 s.id 查；main.js skills:read 也用 id；但目录名 key 仍保留供旧代码兼容。
const _aliases = {
  "公众号抓取wxpublic-fetch-1.0.6": "wxpublic-fetch",
  "EXA搜索":                         "exa-search",
  "minimax-multimodal-toolkit":      "mmx-cli",
  "丁元英":                           "dingyuanying-perspective",
  "费曼":                             "feynman-perspective",
  "新闻核实":                         "news-fact-check",
  "引用幻觉核查2.0ima":               "cite-hallucination-check",
  "达尔文3.0ima":                     "darwin-skill",
  "NoPUA — 以道驭术":                 "nopua-zh",
  "Headroom和Caveman技能整合为一 token省流": "handctoken",
};
for (const [alias, canonical] of Object.entries(_aliases)) {
  if (SKILL_CN[canonical]) SKILL_CN[alias] = SKILL_CN[canonical];
}

/**
 * Try to extract trigger keywords from an English skill description.
 * Looks for common patterns like:
 *   "when the user asks to X, Y, Z"
 *   "search for", "find me", "look up"
 *   quoted phrases like "search for"
 */
function extractTriggers(description) {
  const text = String(description || "");
  const triggers = new Set();

  // Commands in backticks
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const t = m[1].trim();
    if (t.length >= 2 && t.length <= 30) triggers.add(t);
  }

  // Quoted trigger phrases in double quotes
  for (const m of text.matchAll(/"([^"]{2,40})"/g)) {
    const t = m[1].trim().toLowerCase();
    if (t.length >= 2 && !/^[a-z]+$/.test(t)) triggers.add(t);
  }

  // Common trigger patterns in descriptions
  const patterns = [
    /(?:use|trigger|invoke)\s+(?:this\s+)?(?:skill\s+)?(?:when|if|for)\s+(?:the\s+)?(?:user\s+)?(?:asks?\s+(?:to|for|about)|says?\s+|mentions?\s+|wants?\s+(?:to\s+)?)/i,
    /(?:whenever|when)\s+(?:the\s+)?user\s+(?:asks?\s+(?:to|for|about)|says?\s+|wants?\s+(?:to\s+)?)/i,
  ];

  // Extract "verb phrases" after trigger patterns
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      const after = text.slice(m.index + m[0].length);
      // take up to ~80 chars and split on commas/or
      const snippet = after.slice(0, 80).replace(/[."!]\s*$/, "");
      const parts = snippet.split(/\s*(?:,|、|，|or)\s*/);
      for (const p of parts) {
        const cleaned = p.trim().replace(/^["']|["']$/g, "");
        if (cleaned.length >= 2 && cleaned.length <= 30) {
          triggers.add(cleaned);
        }
      }
    }
  }

  return [...triggers].slice(0, 12);
}

module.exports = { SKILL_CN, extractTriggers };
