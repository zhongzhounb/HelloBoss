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
- `server/data/` 是用户唯一的配置与判定流水副本：不进 git，也没有自动备份。构建、打包、清理脚本一律不要删它；调试时也别为了「干净」去 `rm -rf data`。删掉就再也拼不回来了。
- `launcher/build.mjs` 只清理代码产物，**保留** `dist/data`、`dist/config/server.json`、`dist/resumes` 里的用户内容。要分发时先手动清掉这些个人文件，别把简历、密钥或流水打进 zip。
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

## 容易改错的地方

### 大屏的内联 JS 住在外层模板字符串里，转义会咬人

`dashboard.js` 整页由一个模板字符串吐出，所以里面那段 `<script>` 里的**任何转义都会被外层先解析一遍**：

- 想在内联脚本里写换行，必须写成 `\\n`（双反斜杠），写 `\n` 会被外层解析成真换行，
  把字符串字面量切成两行 —— 页面上表现为**整页 JS 全不执行**（按钮全没反应），
  而模板本身完全合法，`node --check src/dashboard.js` 也查不出来。
- 教训是连**注释里**都不能随手写 `\n`，同样会被切开。注释里就用文字描述。
- `test/dashboard.test.js` 里有一条 `vm.Script` 编译内联脚本的用例专门守这个，
  别删。它比人眼可靠：这个错只在浏览器里现形，服务端测试不改的话根本看不见。

同理，在模板里写 CSS/HTML 时也留意 `${` 和反引号。

### 招呼语由模型写，样式是一段要求而不是固定句子

`evaluateJob` 里：`buildGreeting` 生成；生成失败或返回空串，才退到 `buildTemplateGreeting`。
**中间没有「回落到用户写的固定句子」这一步了** —— 那条链路（`greetingSamples` /
`pickSample` / `pickFreshSample` / `NO_MATCH` / `recentSentGreetings`）已经整套删掉，
别再按旧结构去找。

大屏「打招呼样式」存的 `greetingPrompt` 是**给模型的要求**，进 system prompt，不逐字发出。
不要改成「存固定文案、原样发」：一字不变地连发几百遍正是账号被判群发的头号原因，
而固定句子跟具体岗位无关。

两个容易踩的点：

- **样式要求只能加、不能盖掉硬性约束。** `buildGreetingSystemPrompt` 里「60 字以内」
  「简历是唯一事实来源」这两条永远在，用户写「写长一点」也不该真的写 500 字。
- **写给谁看决定了写到什么粒度**，这是这段 prompt 里最容易写错的地方。读者是 HR 不是工程师：
  技术名词和中小公司名都要挡掉。早先那条「点名公司名 + 对上的技术点」的要求产出过
  「飞之辰实习做过采购寻源平台后端，用 CompletableFuture 做详情接口异步化」——
  一整句读完 HR 什么都没记住。改这条之前先想清楚读者是谁。
- **别把简历从提示词里拿掉。** 有人会提「不要给 AI 看简历，直接按 JD 说有 xxx 经验」——
  那样做，JD 里写「熟悉 Kubernetes」而简历里没有时，模型会替候选人认领。
  简历要留着**当事实来源**，只是不许当**复述内容**。
- **`stylePrompt` 只认字符串**，别写成 `String(x || '')` —— 配置被手改成数字时会把
  「123」当成样式要求塞进提示词，那种错比忽略它难查得多。
- **`buildResumeFacts` 不能按固定槽位取字段。** `.txt` 的「单位 | 时间 | 备注」把角色放在
  `position`，`.typ` 宏格式把角色放在 `mid`、时间放在 `rule`。按槽位取必然漏掉其中一种，
  而漏掉的正好是「实习岗位是什么」—— 模型看不见就写不出点名匹配的句子。
  另:各部分字数上限（`RESUME_PROMPT_LIMITS`）受 12 秒招呼语超时约束，**调大会先撞上脚本侧
  45 秒超时链**（见 server.js 顶部的超时预算注释），不要靠调大来提升质量。

### 不要再把 `toString` 伪装加回来

主脚本里原先的 `maskNative`（把包装过的 fetch/XHR/history 的 `toString` 伪造成原生）已经整套删掉，
原地留了注释说明理由。简单说：改写 `Function.prototype.toString` 本身是最经典的检测点，被识破时
性质从「疑似自动化」变成「确认在对抗风控」；而账号会不会被处置取决于节奏和文案重复度，跟这一层
化妆无关。`zhipin-devtools-unlock.user.js` 里那套同理——正常投递时不要挂着它。

### 平台的沟通提醒默认是停机信号

`isPauseDialog` 让硬限制（次数用完）和**带数字的额度预警**（`还剩 N 次沟通` / `您今天已与 N 位`）
都中断整轮，由配置项 `stopOnSoftReminder`（默认 true）控制。预警是平台动真格之前最后一次提醒，
把它当障碍物点掉继续跑，代价是账号；停下来只损失当天剩下的岗位，明天还能补。

注意 `findBossPlatformDialog` 里有两级判定：`softReminder`（宽松，含「温馨提示 + 沟通」）只用于
决定「这是个可以点掉的提示」，`quotaWarning`（必须带数字）才是停机依据。**别把停机条件放宽到
`softReminder`** —— 普通告知会被误判成预警，误伤几次用户就会把这个保护整个关掉，那才是真损失。

## exe 模式下是两个进程，别把「停服务」做成进程内开关

`HelloBoss.exe` 的引导层有三种身份（见 `server/launcher/bootstrap.cjs`）：父进程只负责派生一个
隐藏的控制进程并退出；控制进程（`server/src/supervisor.js`）常驻，提供大屏、配置、记录与导出；
判定服务是它的子进程，**默认不启动**，由大屏右上角的「启动服务 / 停止服务」拉起和杀掉。

- 判定服务监听**临时端口**，端口号通过 stdout 的 `HELLOBOSS_WORKER_PORT=<port>` 握手回控制进程。
  别改成固定端口：那会和别的实例 / 别的软件撞车。
- 判定服务没启动时，控制进程对 `/evaluate` 回 503 并说明原因，**不要**在控制进程里直接判定 ——
  那样「停止服务」就只是改了个布尔值，并没有真的停掉。
- 保存配置后，控制进程要调用后台服务的 `/api/cache/clear`。只清自己进程里的缓存不够：
  判定缓存长在后台服务里。
- 判定服务的 stdin 管道是孤儿保护：控制进程死掉（尤其是 Windows 上被强杀）时管道断开，
  子进程跟着退出。别把它改成 `ignore`。
- 大屏的 `/api/watch` 只表示「有人看着控制台」，**不代表判定服务在运行**。按钮状态跟着
  `/api/records` 里的 `service` 字段走，不要再用 SSE 连接去推断。
- 局域网开关会先写 `config/server.json`、延迟 200ms 再重绑监听。先发响应再 close 是故意的：
  `closeAllConnections()` 会把当前这条请求一起收掉，同步重绑的话页面收不到「已开启」。
- 再双击一次 exe 不会复用旧控制进程：引导层先 `POST /api/shutdown` 请旧实例退出
  （判定服务一起停掉），等端口释放后再起新实例。`/api/shutdown` 必须响应的 `finish`
  事件之后才关服务，否则调用方只会看到连接被重置。旧版本没有这个接口时退回「只开网页」。

## 关键文件

- `zhipin-auto-greeting.user.js`：主脚本，负责岗位筛选、自动沟通、记录存储、导出和控制面板。
- `zhipin-devtools-unlock.user.js`：本地调试辅助脚本，降低页面反调试逻辑对 DevTools 的干扰。
- `server/src/server.js`：HTTP 路由、鉴权、判定编排、判定服务的启停与局域网开关接口。
  `evaluateJob` 的 fail-closed 闸门在这里。投递数量与时段都由脚本侧控制，服务端不做节流
  —— 别把每日上限或允许时段加回来。
- `server/src/supervisor.js`：exe 模式下的常驻控制进程（大屏 + 服务启停 + 局域网重绑）。
- `server/src/workerController.js`：判定子进程的启动、停止、状态与 `/evaluate` 转发。
- `server/src/evaluator.js`：`callChatApi`（判定、招呼语、大屏的「测试连通」**共用这一处**调用）、
  判定与招呼语 prompt、`buildResumeFacts`（简历 → 提示词事实清单）、
  `buildGreetingSystemPrompt`（把用户的打招呼样式拼进去）。
  上游格式由 `detectApiFormat` 按端点路径自动识别 ——
  `/chat/completions` 结尾走 OpenAI 格式，否则走 Anthropic Messages；加第三种格式只需在
  这文件里多一对「拼请求 / 解析响应」，发请求与兜底那部分不用动。
- `server/src/settings.js`：配置存取与校验、密钥脱敏。
- `server/src/dashboard.js`：大屏页面，也是**唯一的配置入口**。里面的示例规则与示例招呼语
  必须保持脱敏 —— 那是给陌生人看的模板，不能混进任何真实公司名、地名或个人经历。
- `server/src/{ledger,resumeParser,typst,variantSelector}.js`：流水存储、简历解析（`.txt` / `.typ`）与版本选择。
- `server/src/idleExit.js`：大屏页面关掉后让控制进程自己退出。
- `server/launcher/`：`bootstrap.cjs`（三种身份）与 `build.mjs`（打包成 `HelloBoss.exe`）。
  构建直接跑 `node launcher/build.mjs`，不再有任何 `.cmd` / `.vbs` 脚本。
- 根目录 `README.md`：面向用户；`AGENTS.md`：面向 AI 维护者（本文件）。

## 代码规范

- 数据结构：在代码阅读性、空间、时间三者之间平衡，对于复杂需求，使用符合要求的数据结构。
- 逻辑耦合：依赖抽象而非具体实现，在适合解耦合的地方进行拆分，但不要过度抽象和解耦。
- 代码冗余：不要过度将多个功能同时存入一个函数之中，拆分功能板块、函数原子化。
- 代码注释：当新增了一些核心功能和工具函数的时候，需要补充代码注释，说明用途和意义。

## 输出偏好

每次搞定任务后，回复结果的时候，都要以“好厚米”开头，剩下没啥了，避免浪费你太多token，ai兄弟。
