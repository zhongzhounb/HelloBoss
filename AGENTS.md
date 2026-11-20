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
- 服务侧的运行期数据（`data/`）在 gitignore 里，**不要提交** —— 里面同时存着用户的知识库（简历全文）与密钥。
- `data/` 是用户唯一的配置与判定流水副本：不进 git，也没有自动备份。构建、打包、清理脚本一律不要删它；调试时也别为了「干净」去 `rm -rf data` 或 `%LOCALAPPDATA%\HelloBoss\data`。删掉就再也拼不回来了。
- `launcher/build.mjs` 只清理代码产物，**保留** `dist/data`（以及旧版本留下的 `dist/resumes`）里的用户内容。要分发时先手动清掉这些个人文件，别把知识库、密钥或流水打进去。
- exe 里的 `runtime/` 目录是可再生的代码副本，删掉没关系；`data/` 是用户数据，两者别混为一谈。

## 两个必须守住的约束

### 1. fail-closed：没配就不投

`server/src/server.js` 的 `evaluateJob` 里，**规则、密钥、知识库三者任一缺失都表现为「不投」**，
绝不拿一套内置默认规则顶上。理由：招呼语发出去收不回来，而漏投的岗位还能再投；
且本仓库是开源的，别人照着默认状态跑，一个「没配就开投」的默认值会让人按别人的标准投递。

「有知识库」的判定就是 `settings.knowledge.trim()` 非空 —— 知识库取代了原来的 `resumes/`
目录扫描，用户在大屏「打招呼样式」下面直接粘简历全文。**仓库不带任何默认知识库**：
空着就是没有候选人资料，一个岗位都不放行。这条性质（`meta.noKnowledge` + 不调 LLM +
不进缓存）由 `test/server.test.js` 的「知识库为空时一个岗位都不投」守着，不能删。

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

### 首次使用教学在大屏里，且只在大屏里

新人真正的卡点是「不知道该去哪填、装没装上」—— 而「脚本要装进浏览器」这件事，
大屏自己看不见。所以首屏问一句「要开启使用教学吗」，选「开启教学」就逐步骤
把位置指出来（`TOUR_STEPS`，`dashboard.js`）。

几条要保持的性质：

- **只在「看起来还没配过」时主动问。** 判据是 `loadSettings()` 返回的
  `decisionPrompt` / `knowledge` / `hasAiKey` 三者任一为空。已经配好的人
  （升级上来的老用户）不该每次打开都被拦一下；配置读不出来（返回 `null`）时也
  不弹 —— 那种情况下大屏自己就在报错，再叠一层只会挡住错误信息。
- **看完要记住。** `localStorage` 的 `helloboss.tour.seen`；localStorage 被禁用时
  退回内存标记，至少同一次会话里不再重复问。顶栏「使用教学」永远能重新打开。
- **每一步的 `target` 必须是页面上真实存在的 id。** 写错不会报错，只会让那一步
  悄悄变成「居中卡片、什么都不指」，用户看到的是「说要点这里，但没说哪里」。
  `test/dashboard.test.js` 里有一条专门从 `TOUR_STEPS` 抠出 target 去比对页面 id。
- **引导层用 `pointer-events: none` + `box-shadow` 压暗**，被指到的控件仍然能点、
  能打字 —— 用户是边看边操作，不是先看完再自己找。整页不引入任何外部资源。
- 教程文案只讲「现在该做什么」，不复述文档。教程的价值在**定位**，不在信息量；
  但「问候语来源保持 AI 判定」这句必须在最后一步里 —— 换成别的模式就不看规则了。

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
  「知识库是唯一事实来源」这两条永远在，用户写「写长一点」也不该真的写 500 字。
- **写给谁看决定了写到什么粒度**，这是这段 prompt 里最容易写错的地方。读者是 HR 不是工程师：
  技术名词和中小公司名都要挡掉。早先那条「点名公司名 + 对上的技术点」的要求产出过
  「飞之辰实习做过采购寻源平台后端，用 CompletableFuture 做详情接口异步化」——
  一整句读完 HR 什么都没记住。改这条之前先想清楚读者是谁。
- **别把知识库从提示词里拿掉。** 有人会提「不要给 AI 看简历，直接按 JD 说有 xxx 经验」——
  那样做，JD 里写「熟悉 Kubernetes」而知识库里没有时，模型会替候选人认领。
  知识库要留着**当事实来源**，只是不许当**复述内容**。
- **`stylePrompt` 只认字符串**，别写成 `String(x || '')` —— 配置被手改成数字时会把
  「123」当成样式要求塞进提示词，那种错比忽略它难查得多。
- **`buildKnowledgeFacts` 只认字符串、只做截断。** 知识库是一段自由文本，不再解析
  `.txt` / `.typ`，也不按槽位猜「哪段是实习」。配置被手改成数字时别把「123」当成资料
  塞进提示词（`normalizeSettings` 保证正常路径是字符串，这里是防手改）。
  另:字数上限（`KNOWLEDGE_PROMPT_CHARS`）受 12 秒招呼语超时约束，**调大会先撞上脚本侧
  45 秒超时链**（见 server.js 顶部的超时预算注释），不要靠调大来提升质量。

### 主脚本里不许有「兜底话术」，默认模式是 AI 判定

服务侧那条「不退到固定句子」的规矩，在**主脚本**里有对应的三条，改脚本前先看这里：

1. `DEFAULT_CONFIG.greetingMode` 是 `'aiGate'`，不是 `'fastReply'`。
   全新安装的用户如果默认落在「常用语」，而他没配过常用语（BOSS 那边一条都没建，
   或者接口取不到），脚本会一路退到兜底话术；更糟的是 **fail-closed 闸门长在 aiGate
   分支上**，默认走常用语时它根本不生效 —— 大屏上规则、密钥、知识库都没配，这边照样往外发。
   `normalizeConfig` 只在 localStorage 里**没有**这一项时才用默认值，所以老用户不受影响。
2. `APP.defaultGreetingText` 这个常量**已被有意删除**，别再引入等价物。
   它以前被三处当兜底（取不到常用语、跨页状态丢了、自定义文本为空），是三条群发通道：
   那句话对每个岗位都一样，而「连发几百遍同一句话」正是账号被判群发的头号原因。
   现在这三处一律抛错停下并说明原因。
3. `customText` 默认是空串，配合 `validateConfig` 里的「自定义文本不能为空」在点「开始」
   那一刻就拦住 —— 预填一句默认文案等于让用户什么都没写就群发。

`validateConfig` 里另有「常用语模式下一条常用语都没有」的前置校验。**别把它删掉**：
这是「开始」这一刻唯一能拦住 fastReply 群发的地方。

`server/test/userscript.test.js` 守着上面这几条。它是源码级断言（主脚本是 document-start
就执行的大 IIFE，没有导出，而仓库约定零依赖、不引 jsdom），断言前会先去掉注释 ——
注释里解释这段历史是允许的，代码里再出现就不行。**别删这个文件**，也别把断言放宽成
「能匹配上就行」：它抓的正是这几行被顺手加回来的情况。

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

## exe 是一个自解包的单文件，引导层不能拆

`HelloBoss.exe` 里装着全部东西：引导层（`server/launcher/bootstrap.cjs`）+ `src/` 全部源码
+ `package.json` + 油猴脚本。启动时引导层把它们解包到
`%LOCALAPPDATA%\HelloBoss\runtime\<内容指纹>\`，再 `import()` 磁盘上那份副本。
用户只需要那一个 exe 文件，不需要带文件夹。

**两条不能破的结构约束：**

- **引导层必须是单文件**。SEA 只把 `main` 那一个脚本嵌进 exe，`require('./x.cjs')` 在 exe 里
  会报 `ERR_UNKNOWN_BUILTIN_MODULE`。所以解包、目录解析、常量全部内联在 `bootstrap.cjs` 里，
  别为了「拆干净」把其中任何一段挪到新文件 —— 那会让 exe 启动即崩。它导出的纯函数仍能被
  `test/launcher.test.js` 直接 `require`（`require.main === module` 在 SEA 里成立，
  只有作为入口时才真的启动服务，所以 require 它没有副作用）。
- **资源清单靠目录扫描生成**（`launcher/assets.mjs` 的 `collectAssets`），不要手写文件名。
  手写的那份迟早漏掉新加的文件，而漏掉的表现是「exe 起不来」，不是构建报错。

引导层里有三种身份（靠环境变量区分）：父进程只负责派生一个隐藏的控制进程并退出；
控制进程（`server/src/supervisor.js`）常驻，提供大屏、配置、记录与导出；
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
- 再双击一次 exe 不会复用旧控制进程：引导层先 `POST /api/shutdown` 请旧实例退出
  （判定服务一起停掉），等端口释放后再起新实例。`/api/shutdown` 必须响应的 `finish`
  事件之后才关服务，否则调用方只会看到连接被重置。旧版本没有这个接口时退回「只开网页」。
- 解包目录名用**内容指纹**，别改成固定目录：两个不同版本的 exe 同时跑时，固定目录会让
  后启动的那个覆盖掉前一个正在 `import()` 的源码。`.extracted` 标记最后写，解包到一半
  被强杀时下次会重来，而不是照着半份源码启动。

## 用户数据在 %LOCALAPPDATA%，别搬回 exe 旁边

`data/` 的位置看模式（`resolveDataDir`，`server.js` 与 `bootstrap.cjs` 共用一套规则）：

1. `HELLOBOSS_DATA_DIR` 设了就用它；
2. 开发模式（`npm start` / `node launcher/bootstrap.cjs`）→ `<server>/data`；
3. exe 模式 → `%LOCALAPPDATA%\HelloBoss\data`。

**exe 模式别改回「挨着 exe 的 data/」。** 以前 exe 挨着 `src/`，用户挪走其中任何一个都起不来，
反而提醒了他们这是一体的；单文件之后那个提醒没有了，用户很容易把 exe 单独拖到桌面或另一个盘，
而数据留在原地 —— 那是**静默**丢失（规则、知识库、全部流水），而 `data/` 没有自动备份。

第一次在 exe 旁边发现旧版的 `data/`（含 `settings.json` 或 `jobs.jsonl`）时，引导层会搬过去：
优先同盘 `rename`，跨盘失败退回复制并**保留**原目录。**新位置已有数据时绝不覆盖**；
判断「有没有用户数据」只看那两三个文件名，不看目录是否非空（日志也在同一个目录里）。

## 关键文件

- `zhipin-auto-greeting.user.js`：主脚本，负责岗位筛选、自动沟通、记录存储、导出和控制面板。
  它也被打进 exe，由 `GET /install.user.js` 发给浏览器（见下）。
- `zhipin-devtools-unlock.user.js`：本地调试辅助脚本，降低页面反调试逻辑对 DevTools 的干扰。
- `server/src/server.js`：HTTP 路由、判定编排、判定服务的启停接口。
  `evaluateJob` 的 fail-closed 闸门在这里。投递数量与时段都由脚本侧控制，服务端不做节流
  —— 别把每日上限或允许时段加回来。
- `server/src/supervisor.js`：exe 模式下的常驻控制进程（大屏 + 服务启停）。
- `server/src/workerController.js`：判定子进程的启动、停止、状态与 `/evaluate` 转发。
- `server/src/evaluator.js`：`callChatApi`（判定、招呼语、大屏的「测试连通」**共用这一处**调用）、
  判定与招呼语 prompt、`buildKnowledgeFacts`（知识库 → 提示词事实片段）、
  `buildGreetingSystemPrompt`（把用户的打招呼样式拼进去）。
  上游格式由 `detectApiFormat` 按端点路径自动识别 ——
  `/chat/completions` 结尾走 OpenAI 格式，否则走 Anthropic Messages；加第三种格式只需在
  这文件里多一对「拼请求 / 解析响应」，发请求与兜底那部分不用动。
- `server/src/settings.js`：配置存取与校验、密钥脱敏。
- `server/src/dashboard.js`：大屏页面，也是**唯一的配置入口**。整页分「① 设置 / ② 投递记录」两页，
  两页是同一份文档里互斥显示的两个视图，共用一条轮询和一条 `/api/watch` 连接 ——
  别拆成两条路由，否则游标、服务灯、孤儿保护信号都要各维护一份。
  切页状态由 localStorage 记住，默认落在设置页。里面的示例规则与示例招呼语
  必须保持脱敏 —— 那是给陌生人看的模板，不能混进任何真实公司名、地名或个人经历。
  顶栏那个「安装油猴脚本」**必须是 `<a href="/install.user.js">`**：篡改猴只对
  「导航到一个 `.user.js` 地址」弹安装框，改成按钮 + fetch 拼 blob 只会下载到一个文本文件。
- `server/src/ledger.js`：流水存储与 CSV 导出。
- `server/src/idleExit.js`：大屏页面关掉后让控制进程自己退出。
- `server/launcher/bootstrap.cjs`：引导层（单文件，见上文）。三种身份、解包内嵌资源、
  数据目录解析与旧目录迁移、哈希校验都在这里。
- `server/launcher/assets.mjs`：打包时收集资源、算内容指纹、生成清单。
- `server/launcher/build.mjs`：打包成 `HelloBoss.exe`。构建直接跑 `node launcher/build.mjs`，
  不再有任何 `.cmd` / `.vbs` 脚本。打包产物 `dist/` 里只剩 exe 与使用说明。
- 根目录 `README.md`：面向用户；`AGENTS.md`：面向 AI 维护者（本文件）。

## 代码规范

- 数据结构：在代码阅读性、空间、时间三者之间平衡，对于复杂需求，使用符合要求的数据结构。
- 逻辑耦合：依赖抽象而非具体实现，在适合解耦合的地方进行拆分，但不要过度抽象和解耦。
- 代码冗余：不要过度将多个功能同时存入一个函数之中，拆分功能板块、函数原子化。
- 代码注释：当新增了一些核心功能和工具函数的时候，需要补充代码注释，说明用途和意义。

## 输出偏好

每次搞定任务后，回复结果的时候，都要以“好厚米”开头，剩下没啥了，避免浪费你太多token，ai兄弟。
