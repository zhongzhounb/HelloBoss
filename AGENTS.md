# HelloBoss

在 BOSS 直聘按用户自己写的规则筛选岗位、自动打招呼，判定过程显示在一块本机大屏上。
一个零依赖的单文件油猴脚本 + 一个零依赖的本地 Node 服务。

目录名与文件名沿用旧的项目名（`boss-auto-greeting`、`zhipin-auto-greeting` 等），
不动它们是为了不让文档链接与启动脚本失效；对外的项目名统一叫 **HelloBoss**。

## 技术栈

### 油猴脚本（`boss-greeting/*.user.js`）

- 原生 JavaScript（ES6+）Tampermonkey / 油猴 Userscript。
- 无构建流程、无包管理器、无前端框架；`.user.js` 文件需要能直接安装运行。
- 运行在浏览器页面环境，主要目标是 Chrome / Edge + Tampermonkey。
- 主要使用浏览器原生 API：DOM、事件模拟、History API、MutationObserver、fetch / XMLHttpRequest、IndexedDB、localStorage。
- Excel 导出按需从 CDN 懒加载 SheetJS `xlsx@0.20.3`。
- 主脚本依赖 `document-start` 阶段提前注入（拦截接口、保存原生方法引用），不要随意调整 userscript header。

### 本地服务（`boss-greeting/server/`）

- Node 22+，ESM，**零第三方依赖**，只用内置模块。
- 测试用内置的 `node --test`，离线可跑，不引 jsdom。
- 大屏是单个 `renderDashboardHtml()` 吐出的模板字符串，原生 DOM + 内联样式，无构建、无框架、无外部资源引用。

## 维护约定

- 优先保持单文件脚本结构，不要引入构建工具、框架或复杂依赖。
- 修改页面逻辑时，要考虑 BOSS 直聘是 SPA，列表页和聊天页可能通过 history 跳转而不是整页刷新。
- 岗位记录存储在 IndexedDB；配置、运行状态和调试事件存储在 localStorage。
- 网络请求优先使用页面 fetch；当页面策略或跨域限制影响请求时，使用 `GM_xmlhttpRequest` 兜底。
- UI 使用原生 DOM 和内联样式实现，不要改成 Vue / React / jQuery。
- 服务侧的运行期数据（`data/`）与局域网令牌（`config/server.json`）都在 gitignore 里，**不要提交**。
- 简历目录 `server/resumes/` 除 `example.txt` 外一律不进版本管理 —— 简历是个人信息。

## 两个必须守住的约束

### 1. fail-closed：没配就不投

`server/src/server.js` 的 `evaluateJob` 里，**规则、密钥、简历三者任一缺失都表现为「不投」**，
绝不拿一套内置默认规则顶上。理由：招呼语发出去收不回来，而漏投的岗位还能再投；
且本仓库是开源的，别人照着默认状态跑，一个「没配就开投」的默认值会让人按别人的标准投递。

「有简历」的判定要注意 **`resumes/example.txt` 不算简历**（`resumeParser.js` 里按**文件基名**
`example` 跳过，不看扩展名）：它是给 clone 下来的人看格式的模板，内容固定是「张三/示例大学」。
若把它当简历加载，没配任何东西的人会拿这份占位身份通过闸门、把招呼语发出去 ——
这正是 fail-closed 要挡的。用户自己的简历必须换个文件名放进来。
（简历格式有两种：推荐的 `.txt` 极简格式，和兼容保留的 `.typ` 宏格式。跳过示例这条性质
对两种扩展名都必须成立。）

改动判定链路时，这个性质必须存活，相关回归用例不能删。

### 2. 密钥不出网、不被误清

服务端（`server/src/settings.js`）：

- `get()` 返回**原始**密钥（判定要用），脱敏只在 HTTP 边界做（`redactSettings`）。
- 响应体里 `aiKey` 恒为空串，末四位单独放 `aiKeyHint`。**不要把末四位放进 `aiKey`** ——
  大屏的密钥框不回填，用户只改规则时会把该字段原样提交，截断串会覆盖真密钥。
- 空 `aiKey` 是「本次未修改」的哨兵，`validatePatch` 跳过不写；清空走 `clearAiKey`。
- `decideByPrompt` 解析 AI 配置必须用 `options.ai === undefined` 判断，**不能写 `ai.key || LEGACY_KEY`** ——
  那会让用户显式清空的密钥重新拿到旧默认值并发给远端。

## 关键文件

- `zhipin-auto-greeting.user.js`：主脚本，负责岗位筛选、自动沟通、记录存储、导出和控制面板。
- `zhipin-devtools-unlock.user.js`：本地调试辅助脚本，降低页面反调试逻辑对 DevTools 的干扰。
- `server/src/server.js`：HTTP 路由、鉴权、判定编排（`evaluateJob` 的 fail-closed 闸门在这里）。
- `server/src/evaluator.js`：`callMessagesApi`（判定、招呼语、大屏的「测试连通」**共用这一处**调用）、
  判定与招呼语 prompt。
- `server/src/settings.js`：配置存取与校验、密钥脱敏。
- `server/src/dashboard.js`：大屏页面，也是**唯一的配置入口**。里面的示例规则与示例招呼语
  必须保持脱敏 —— 那是给陌生人看的模板，不能混进任何真实公司名、地名或个人经历。
- `server/src/{ledger,resumeParser,typst,variantSelector}.js`：流水存储、简历解析（`.txt` / `.typ`）与版本选择。
- `server/src/idleExit.js`：大屏页面关掉后让服务自己退出。
- `server/launcher/`：把服务打包成 `HelloBoss.exe` 的引导层与构建脚本。
- 根目录 `README.md`：面向用户；`AGENTS.md`：面向 AI 维护者（本文件）。

## 代码规范

- 数据结构：在代码阅读性、空间、时间三者之间平衡，对于复杂需求，使用符合要求的数据结构。
- 逻辑耦合：依赖抽象而非具体实现，在适合解耦合的地方进行拆分，但不要过度抽象和解耦。
- 代码冗余：不要过度将多个功能同时存入一个函数之中，拆分功能板块、函数原子化。
- 代码注释：当新增了一些核心功能和工具函数的时候，需要补充代码注释，说明用途和意义。

## 输出偏好

每次搞定任务后，回复结果的时候，都要以“好厚米”开头，剩下没啥了，避免浪费你太多token，ai兄弟。
