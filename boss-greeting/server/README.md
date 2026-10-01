# server —— 岗位判定服务与大屏

`boss-greeting/` 的本地服务。判定岗位值不值得投、生成招呼语、托管大屏、存判定流水。

- **零依赖**，只用 Node 内置模块。不需要 `npm install`。要求 Node 22+（用了内置的 `node --test` 与 `fetch`）。
- 名字里的 `boss-ai-gate` 是它作为独立项目时的旧名，现在保留在 `package.json` 与日志前缀里。

```bash
npm start     # 默认 http://127.0.0.1:8787
npm test      # 171 个用例
```

Windows 一键脚本：

| 脚本 | 作用 |
|---|---|
| `打开大屏.vbs` | **推荐入口**。服务没起就先隐藏着拉起来，再在 Edge 里开大屏与 BOSS 两个标签页 |
| `启动服务.cmd` | 只启动 + 健康检查，失败以退出码 1 结束 |
| `重启服务.cmd` | 按端口杀掉旧进程再拉起。**改完 `src/` 必须用它**，Node 不热加载 |
| `手机看大屏-开启.cmd` | 需管理员：生成令牌 + 放行防火墙 8787 端口 |
| `手机看大屏-关闭.cmd` | 需管理员：撤掉防火墙规则 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `RESUME_SRC` | `<本目录>/resumes` | 简历目录。指向不存在的目录不会崩 —— 服务照常起，判定全部跳过并在大屏上提示 |

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ ok, profiles, cache, aiConfigured }`。`profiles` 是解析到的简历份数，`aiConfigured` 是密钥是否已配 —— 大屏靠这两个显示警告条 |
| POST | `/evaluate` | 判定一个岗位。`{ job: {...} }` → `{ apply, reason, greeting, meta }` |
| GET | `/dashboard` | 大屏页面 |
| GET | `/api/records?since=<seq>` | 增量流水 + 统计 + 每日分组 |
| GET / POST | `/api/settings` | 读 / 改配置。POST 会同时清空判定缓存（配置变了旧结论就过期了） |
| GET | `/api/export.csv` | 全量流水导出为 CSV（带 BOM，Excel 打开中文不乱码） |
| POST | `/report` | 追加一条流水。`runId` 与 `at` 由服务端补 |

## 配置分三处，各有各的归口

| 文件 | 改法 | 内容 |
|---|---|---|
| `data/settings.json` | **在大屏上改** | 判定规则、招呼语样例、AI 端点/密钥/模型。运行时数据，不进 git |
| `config/keywords.json` | 手改，需重启 | 选简历版本用的关键词权重表 |
| `config/server.json` | 手改，需重启 | 局域网开关与访问令牌。缺文件 = 只听本机、无鉴权 |

`config/server.example.json` 是 `server.json` 的形状示例。

## AI 接入

只支持 **Anthropic Messages 格式**。端点、密钥、模型都在大屏的「AI 接入」面板里配，
默认指向 `https://api.anthropic.com/v1/messages`、密钥留空。

除了 Anthropic 官方，各类 Claude 中转（one-api / new-api / LiteLLM / CC Switch 之类）也都是这个格式，
把端点换掉即可。

### 密钥不出网

大屏可以用令牌对局域网开放，所以响应体里**永远不含明文密钥**：

- `GET /api/settings` 返回的 `aiKey` 恒为空串，另给 `hasAiKey` 与 `aiKeyHint`（末四位）供显示。
- 空串同时是「本次未修改密钥」的哨兵 —— 大屏的密钥框不回填，用户改完规则顺手保存时那一栏是空的，
  若把空串当清空，保存规则就会悄悄废掉密钥。真要清空走 `clearAiKey`。
- 密钥只存在 `data/settings.json`（已 gitignore），不会随流水上报。

### 超时预算是一条严格递减的链

脚本侧等 45 秒 > 服务端最坏 42 秒（判定 30 + 生成 12）。每层必须小于上一层，
否则脚本先断开而服务端还在跑，日志会对不上。

底层是推理模型，推理过程与答案**共用** `max_tokens` 预算。预算被推理吃光时会返回
**HTTP 200 + 空 content 数组** —— 状态码正常、结构合法、只有内容是空的，极易被当成成功。
所以首轮用小预算保速度，只在快速失败时放大预算重试。

## 安全模型

- **默认只听回环地址**，不开鉴权。克隆下来不配任何东西就能跑。
- 开了局域网（`config/server.json` 里 `lan: true`）则**必须配令牌**，否则拒绝启动 ——
  那关系到把岗位记录连同写接口交给整个同网段。
- 令牌可以走 `Authorization: Bearer`，也可以走 cookie（手机浏览器只能走 cookie，
  页面里的 `fetch` 与「导出 CSV」的链接都带不了自定义请求头）。
- **回环地址豁免令牌**，所以本机浏览器与油猴脚本不用改。
- 写配置的接口额外做**跨站写入防护**：浏览器跨站发起的请求一定带 `Origin`，
  比对 host 即可挡住拿着 cookie 的跨站表单提交。不带 `Origin` 的一律放行（curl 与油猴脚本都不带）。

## 目录

```
server/
├── src/
│   ├── server.js           HTTP 路由、鉴权、判定编排
│   ├── evaluator.js        Anthropic Messages 调用、判定与招呼语 prompt
│   ├── settings.js         配置存取与校验、密钥脱敏
│   ├── dashboard.js        大屏页面（单文件模板字符串，原生 DOM）
│   ├── ledger.js           流水存储（JSONL）与 CSV 导出
│   ├── resumeParser.js     解析 .typ 简历
│   ├── typst.js            .typ 的轻量词法工具
│   └── variantSelector.js  按 JD 关键词挑简历版本
├── config/                 关键词表；server.json（运行期生成）
├── resumes/                简历目录，带一份示例
├── data/                   运行期数据（不进 git）
└── test/                   171 个用例
```
