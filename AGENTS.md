# boss-auto-greeting

两个互相独立的求职自动化工具，同仓库两个子目录。都是零依赖的单文件油猴（Tampermonkey）脚本。

- `boss-greeting/` —— BOSS 直聘自动打招呼 + 本地判定服务与大屏。
- `autofill/` —— 通用网申自动填写。

两者各自注入、各存各的数据、各跑各的流程，代码上**零交叉引用**。改一个不要顺手改另一个。

## 技术栈

### 油猴脚本（两边都是）

- 原生 JavaScript（ES6+）Tampermonkey / 油猴 Userscript。
- 无构建流程、无包管理器、无前端框架；`.user.js` 文件需要能直接安装运行。
- 运行在浏览器页面环境，主要目标是 Chrome / Edge + Tampermonkey。
- 主要使用浏览器原生 API：DOM、事件模拟、History API、MutationObserver、fetch / XMLHttpRequest、IndexedDB、localStorage。
- Excel 导出按需从 CDN 懒加载 SheetJS `xlsx@0.20.3`。
- 主脚本依赖 `document-start` 阶段提前注入（拦截接口、保存原生方法引用），不要随意调整 userscript header。

### 本地服务（仅 boss-greeting/server）

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
- 简历目录 `server/resumes/` 除 `example.typ` 外一律不进版本管理 —— 简历是个人信息。

## 两个必须守住的约束

### 1. fail-closed：没配就不投

`server/src/server.js` 的 `evaluateJob` 里，**规则、密钥、简历三者任一缺失都表现为「不投」**，
绝不拿一套内置默认规则顶上。理由：招呼语发出去收不回来，而漏投的岗位还能再投；
且本仓库是开源的，别人照着默认状态跑，一个「没配就开投」的默认值会让人按别人的标准投递。

改动判定链路时，这个性质必须存活，相关回归用例不能删。

### 2. 密钥不出网、不被误清

服务端（`server/src/settings.js`）：

- `get()` 返回**原始**密钥（判定要用），脱敏只在 HTTP 边界做（`redactSettings`）。
- 响应体里 `aiKey` 恒为空串，末四位单独放 `aiKeyHint`。**不要把末四位放进 `aiKey`** ——
  大屏的密钥框不回填，用户只改规则时会把该字段原样提交，截断串会覆盖真密钥。
- 空 `aiKey` 是「本次未修改」的哨兵，`validatePatch` 跳过不写；清空走 `clearAiKey`。
- `decideByPrompt` 解析 AI 配置必须用 `options.ai === undefined` 判断，**不能写 `ai.key || LEGACY_KEY`** ——
  那会让用户显式清空的密钥重新拿到旧默认值并发给远端。

脚本端（`autofill`）不做这套：密钥存 GM 存储、用户在自己浏览器里填，明文是该形态的常态。

## 关键文件

### boss-greeting/

- `zhipin-auto-greeting.user.js`：主脚本，负责岗位筛选、自动沟通、记录存储、导出和控制面板。
- `zhipin-devtools-unlock.user.js`：本地调试辅助脚本，降低页面反调试逻辑对 DevTools 的干扰。
- `server/src/server.js`：HTTP 路由、鉴权、判定编排（`evaluateJob` 的 fail-closed 闸门在这里）。
- `server/src/evaluator.js`：`callMessagesApi`（判定与招呼语**共用这一处**调用）、判定与招呼语 prompt。
- `server/src/settings.js`：配置存取与校验、密钥脱敏。
- `server/src/dashboard.js`：大屏页面，也是**唯一的配置入口**。
- `server/src/{ledger,resumeParser,typst,variantSelector}.js`：流水存储、简历解析与版本选择。

### autofill/

- `autofill.user.js`：通用网申自动填写脚本。按字段语义匹配用户信息表；本地词典优先、
  AI 只兜底判断字段归属且**只回键名不返回值**（防编造），自动翻页但永不代提交。信息表与设置存 GM 存储。
- `test/autofill.test.js`：114 个用例。DOM 层的 `collectRaw` 无法离线测，其余尽量拆成纯函数覆盖。

### 根目录

- `README.md`：面向用户的索引与快速开始。
- `AGENTS.md`：面向 AI 维护者的项目上下文和约束。

## 代码规范

- 数据结构：在代码阅读性、空间、时间三者之间平衡，对于复杂需求，使用符合要求的数据结构。
- 逻辑耦合：依赖抽象而非具体实现，在适合解耦合的地方进行拆分，但不要过度抽象和解耦。
- 代码冗余：不要过度将多个功能同时存入一个函数之中，拆分功能板块、函数原子化。
- 代码注释：当新增了一些核心功能和工具函数的时候，需要补充代码注释，说明用途和意义。

## 输出偏好

每次搞定任务后，回复结果的时候，都要以“好厚米”开头，剩下没啥了，避免浪费你太多token，ai兄弟。
