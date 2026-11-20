import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTemplateGreeting,
  buildProbePrompt,
  buildGreetingPrompt,
  callChatApi,
  decideByPrompt,
  detectApiFormat,
} from './evaluator.js';
import { createLedger, toCsv } from './ledger.js';
import { renderDashboardHtml } from './dashboard.js';
import { createIdleExit, DEFAULT_GRACE_MS } from './idleExit.js';
import {
  createSettingsStore,
  redactSettings,
  MAX_ENDPOINT_CHARS,
  MAX_KEY_CHARS,
  MAX_MODEL_CHARS,
} from './settings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// 运行期数据(配置、知识库、流水)的位置。
//
// 默认挨着源码 —— npm start、测试、开发模式都是这个行为,和改造前一致。
// exe 模式下引导层会设 HELLOBOSS_DATA_DIR 指到 %LOCALAPPDATA%\HelloBoss\data:
// 单文件分发之后「exe 和 data 一起走」这件事没法再靠目录相邻来保证,数据就跟着用户走。
// 判定子进程也继承同一个值,两个进程必须看同一份配置。
const DATA_DIR = process.env.HELLOBOSS_DATA_DIR
  ? path.resolve(process.env.HELLOBOSS_DATA_DIR)
  : path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8787);
// 超时预算的严格链条:脚本侧等 45 秒 > 服务端最坏 42 秒(判定 30 + 生成 12)。
// 每层必须小于上一层,否则脚本先断开而服务端还在跑,日志会对不上。
//
// 判定给到 30 秒是实测结论:同一个调用在本地代理上的延迟在 4.5～17.3 秒之间波动。
// 按 12 秒给时第一次尝试只拿 60%(7.2 秒),实测三次里有两次超时、岗位被跳。
// (这套延迟数字是当初为「抽取四个谓词」那次调用测的;现在同样是「一次判定调用」,
//   所以预算原样沿用。)
const DECISION_BUDGET_MS = 30000;
const GREETING_BUDGET_MS = 12000;
// 招呼语只有一句话,不需要判定的预算;这个值沿用改造前 server.js 里那份
// 内联 fetch 写死的 2000,行为不变。
const GREETING_MAX_TOKENS = 2000;
// 大屏「测试连通」按钮的预算。它只验证端点能不能回话,不参与判定,所以给得比判定小。
// 刻意不搬 decideByPrompt 里那套「小预算失败再放大重试」:那套是给判定用的,
// 抄一份就等于要维护两处预算。代价是推理模型可能因预算被推理吃光而报失败 ——
// 但那种配置判定本来也会失败,报红是诚实的(错误文案会点明「推理 token 吃光了预算」)。
const AI_TEST_MAX_TOKENS = 2000;
const AI_TEST_BUDGET_MS = 15000;

// 大屏那条长连接的保活间隔。本机连线基本不会被掐,但空闲连接会被省电策略或中间设备
// 断掉,定期写一帧注释行把它吊住。
const WATCH_HEARTBEAT_MS = 25000;

// 跨站写入防护:管的是「谁能在别的站点上替我们发起写入」。
//
// 起因是 POST /api/settings 把「哪些岗位会被自动投」变成了可远程改的东西。
// 浏览器跨站发起的请求**一定**带 Origin,比对 host 就能挡住跨站表单提交。
//
// 不带 Origin 的一律放行:命令行 curl、油猴脚本的 GM_xmlhttpRequest 都不带,它们也不需要这层。
export function isCrossOriginWrite(headers) {
  const origin = String((headers && headers.origin) || '').trim();
  if (!origin) return false;

  try {
    return new URL(origin).host !== String((headers && headers.host) || '');
  } catch {
    // Origin 解析不了(如字面量 "null")= 不是正常浏览器请求,按跨站处理。
    return true;
  }
}

// IPv4 映射写法(::ffff:192.168.1.7)必须先剥壳再比 —— 监听双栈地址时本机请求
// 就是这种形态,不剥壳会把本机自己的浏览器也判成"外来访问"。
//
// 现在只剩 /api/shutdown 在用:那个接口能让整个控制进程退出,只允许本机的引导层调用。
export function isLoopbackAddress(remoteAddress) {
  const address = String(remoteAddress || '').trim().toLowerCase();
  if (!address) return false;

  const bare = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return bare === '::1' || bare === 'localhost' || bare.startsWith('127.');
}

// 缓存身份必须能区分「同一公司在不同城市的同名岗位」。
//
// 脚本传来的 signature 是**列表去重键**(岗位名|公司|薪资),不含城市也不含岗位 ID。
// 直接拿它作缓存键,会让两地的同名同薪岗位共用一条判定 —— 把 A 城的结论用到 B 城,
// 而城市正是用户明确要筛选的维度。故优先用强 ID,退回组合键时必带 city。
function jobSignature(job) {
  const strong = job.encryptJobId || job.securityId || job.lid;
  if (strong) return String(strong);
  return [job.signature, job.company, job.jobName, job.city].filter(Boolean).join('|');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function evaluateJob(job, deps) {
  const startedAt = Date.now();

  // 配置由调用方注入而不是自己读文件:否则桩测试会失去隔离。
  // 每次判定都重新 get() 一次,所以大屏上保存后立即生效,不必重启服务。
  const settings = deps.settings ? deps.settings.get() : {};
  const rule = String(settings.decisionPrompt || '').trim();
  // 知识库就是候选人背景全文,取代了原来的 resumes/ 目录扫描。空着 = 没有事实来源。
  const knowledge = String(settings.knowledge || '').trim();

  const baseMeta = { greetingFallback: false, cacheHit: false, latencyMs: 0 };

  // 没有知识库 = 无从判断岗位与候选人是否匹配,同样一个都不放行。
  //
  // fallback: true 有两个作用:不进缓存(与 AI 不可用同一套规则),以及让调用方
  // 能把它和「AI 判掉了」区分开 —— 前者是「没判成」,端点/知识库补齐后还能重判。
  if (!knowledge) {
    return {
      apply: false,
      reason: '尚未填写知识库,已跳过该岗位 —— 请到「① 设置 → 打招呼样式」下面把简历内容粘进去',
      greeting: '',
      meta: { ...baseMeta, fallback: true, noKnowledge: true, latencyMs: Date.now() - startedAt },
    };
  }

  // 没有规则 = 没有任何判定依据。这里**不放行任何岗位**。
  //
  // 这是本工具唯一一处「安全默认」:自动发出去的招呼语收不回来,漏投的岗位下次还能再投。
  // 一个没配规则就直接开投的版本,等于把用户的账号交给运气 —— 而它一旦开源出去,
  // 别人是照着仓库里的默认值跑的,根本不知道自己在按谁的规则投。
  if (!rule) {
    return {
      apply: false,
      reason: '尚未配置投递规则,已跳过该岗位 —— 请在大屏「打招呼判定」里填写规则',
      greeting: '',
      meta: { ...baseMeta, fallback: true, noRule: true, latencyMs: Date.now() - startedAt },
    };
  }

  const decision = await deps.decideByPrompt(job, knowledge, rule);

  // 拿不到结论(判定服务不可用)与「判定不投」必须分开:前者不进缓存,
  // 端点恢复后同一岗位还能重判;混在一起会把一次抖动钉成永久的「不投」。
  if (decision.fallback) {
    return {
      apply: false,
      reason: `AI 判定不可用(${decision.error || '未知原因'}),跳过该岗位`,
      greeting: '',
      meta: {
        ...baseMeta,
        fallback: true,
        latencyMs: Date.now() - startedAt,
        ...(decision.error ? { error: decision.error } : {}),
      },
    };
  }

  // 判不投就不生成招呼语 —— 省一次调用,也避免日志里出现不会被发出去的文本。
  let greeting = '';
  let greetingFallback = false;

  if (decision.apply) {
    // 招呼语一律由模型写,不再有「回落到用户写的固定句子」这条路。
    //
    // 固定句子的好处是每个字都经过用户确认,代价是**跟岗位无关** —— 而一字不变地
    // 连发几百遍正是账号被判群发的头号原因。现在「匹配不上时怎么自荐」也写成
    // greetingPrompt 里的一句要求,由模型每次换个说法表达,自由度更高。
    //
    // 唯一的硬兜底是 buildTemplateGreeting:生成不可用时至少发一句出去。
    // 判定已经通过,不该因为一句措辞把岗位丢掉。
    try {
      const generated = await deps.buildGreeting(job, knowledge);
      if (generated) greeting = generated;
    } catch {
      // 措辞生成失败不该丢掉一个已判定要投的岗位 —— 落到下面的模板兜底。
    }

    if (!greeting) {
      greeting = buildTemplateGreeting(knowledge, job);
      greetingFallback = true;
    }
  }

  return {
    apply: decision.apply,
    reason: decision.reason,
    greeting,
    meta: {
      ...baseMeta,
      fallback: false,
      greetingFallback,
      latencyMs: Date.now() - startedAt,
    },
  };
}

// 生成招呼语:知识库 + 岗位 + JD,交给模型写一句。
//
// stylePrompt 是大屏「打招呼样式」里那段用户要求,只影响怎么写,不逐字发出。
// 导出是为了能单测:它是「拼提示词 → 调模型」这条链唯一能被一次跑通的地方。
export async function buildGreetingViaLlm(job, knowledge, options) {
  const prompt = buildGreetingPrompt(knowledge, job, { stylePrompt: options.stylePrompt });
  const text = await options.callLlm(prompt.system, prompt.user);
  return String(text == null ? '' : text).trim();
}

export function createServer(options = {}) {
  // 运行数据落在服务目录的 data/ 下,不进 git。测试显式传 ledgerFile,
  // 避免把假记录写进真实文件、以及测试之间互相污染。
  const ledgerFile = options.ledgerFile || path.join(DATA_DIR, 'jobs.jsonl');
  // 进程启动时刻即"本轮"的标识 —— 页面据此区分本轮与累计。
  // 只取一次:两次调用会得到不同毫秒值,导致 setRunId 与响应里的 runId 对不上。
  const runId = new Date().toISOString();
  const ledger = createLedger(ledgerFile);
  ledger.setRunId(runId);

  // 默认依赖只读配置(判定与招呼语只依赖大屏上填的知识库),注入 deps 的调用方(测试)
  // 自带这些依赖,不走这条路。
  const deps = options.deps || buildDefaultDeps();

  // 判定服务由谁管。exe 起的控制进程会传进来一个控制器(可启动/停止后台判定服务);
  // npm start 与测试不传 = 判定就在本进程里,和以前完全一样。
  const serviceControl = options.serviceControl || null;
  // 控制进程自己的退出入口。每次双击 exe 都由新实例调用它接管端口 —— 用户想要的是
  // 「打开现在的 HelloBoss」,而不是复用可能已经跑了一整夜的旧实例。
  // 只有 exe 的控制进程会传;npm start 与测试不传时这个接口明确回 503。
  const shutdownControl = options.shutdownControl || null;

  // 油猴主脚本的位置。exe 模式下由引导层传进来(那份在解包目录里);
  // npm start / 开发模式退回仓库里的原文件。
  //
  // 默认值刻意指向仓库**上一级** —— 脚本是给浏览器装的,不属于服务,不该被复制进 server/。
  const userscriptFile = options.userscriptFile
    || path.resolve(ROOT, '..', 'zhipin-auto-greeting.user.js');

  // 谁在看大屏(见 src/idleExit.js)。不传 = 不记账,服务也不会自己退出,
  // 这是 npm start 与绝大多数测试的用法。
  const idle = options.idle || null;

  const cache = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      // 统一解析路径:看板的路由带查询串(?since=N),全等比较匹配不上。
      // 基址是占位符 —— 只用来把相对 URL 补全成可解析的绝对 URL,不会被请求。
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = parsed.pathname;

      if (req.method === 'GET' && pathname === '/health') {
        // aiConfigured 让大屏能提示「还没配密钥,判定会全部跳过」。少了它,用户看到的
        // 现象是「岗位一个都没投」,而看不出根因是没填 key —— 只报了个 ok:true。
        // 只回布尔,不回密钥本身。
        const current = deps.settings ? deps.settings.get() : {};
        sendJson(res, 200, {
          ok: true,
          // 大屏据此决定要不要挂「没填知识库」的警告条。空知识库 = 一个岗位都不投。
          hasKnowledge: Boolean(String(current.knowledge || '').trim()),
          cache: cache.size,
          aiConfigured: Boolean(String(current.aiKey || '').trim()),
        });
        return;
      }

      // ---- 判定服务的启停(只有 exe 起的控制进程才管得到) ----
      //
      // 大屏本身由控制进程提供,所以「服务停了」时页面照样能开、能看记录、能改配置。
      // 被停掉的只是真正接 /evaluate 的那个后台进程。
      const serviceStatus = () => (serviceControl
        ? serviceControl.status()
        : { managed: false, running: true, state: 'running' });

      if (req.method === 'GET' && pathname === '/api/service') {
        sendJson(res, 200, serviceStatus());
        return;
      }

      if (req.method === 'POST' && (pathname === '/api/service/start' || pathname === '/api/service/stop')) {
        if (isCrossOriginWrite(req.headers)) {
          sendJson(res, 403, { error: '拒绝跨站写入' });
          return;
        }
        // 页面统一用 POST JSON 提交;这里不读请求体,但要把它收掉,否则 keep-alive
        // 连接上残留的请求体会被当成下一个请求的开头。
        await readBody(req);

        if (!serviceControl) {
          sendJson(res, 503, { error: '当前是命令行启动,判定服务不由大屏管理' });
          return;
        }

        const action = pathname.endsWith('/start') ? 'start' : 'stop';
        try {
          const next = await serviceControl[action]();
          sendJson(res, 200, next);
        } catch (error) {
          // 起不来也要把当前状态带回去,页面据此把按钮恢复成「启动服务」。
          sendJson(res, 500, { ...serviceStatus(), error: error.message });
        }
        return;
      }

      // ---- 旧实例退场:新一次双击 exe 时由引导层调用 ----
      //
      // 必须在响应发完之后再关服务:同步 shutdown 会把这根连接一起收掉,
      // 调用方只会看到连接被重置,于是一直等到超时。
      // 大屏页面上没有这个入口 —— 它只服务于「新实例接管端口」这一种场景。
      if (req.method === 'POST' && pathname === '/api/shutdown') {
        if (isCrossOriginWrite(req.headers)) {
          sendJson(res, 403, { error: '拒绝跨站写入' });
          return;
        }
        // 只有本机的引导层需要它。它能让整个控制台退出,所以只接受回环地址 ——
        // 将来若有隧道 / 反代把外部流量转到本机,也不该顺手停掉用户的服务。
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
          await readBody(req);
          sendJson(res, 403, { error: '只允许从本机停止控制进程' });
          return;
        }
        await readBody(req);

        if (!shutdownControl) {
          sendJson(res, 503, { error: '当前是命令行启动,没有可停止的控制进程' });
          return;
        }

        res.once('finish', shutdownControl);
        sendJson(res, 200, { ok: true });
        return;
      }

      // 大屏页面在这里挂一条长连接:这条连接在 = 有人看着,断了 = 页面关了。
      // 服务据此自己退出(见 src/idleExit.js)。
      if (req.method === 'GET' && pathname === '/api/watch') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          // 不能让浏览器或中间层把这个流缓存、攒起来,否则「页面关了」这个信号会迟到。
          'cache-control': 'no-store',
          // 刻意不设 content-length:长度未知的流走 chunked 编码,设了就写不出去。
        });

        // 先写一帧,让页面立刻收到响应头 —— EventSource 拿到第一块数据才触发 onopen。
        res.write(': connected\n\n');

        // 往一个刚断掉的 socket 写会触发 error 事件,没人接就是未捕获异常、直接把服务带走。
        // 这条连接死了无所谓,服务不能跟着死。
        res.on('error', () => {});

        const release = idle ? idle.add(res) : null;
        // 定期写一帧注释行(EventSource 会忽略它)。它不只是保活:客户端进程被强杀时
        // 不会发 FIN,只有这次写失败才能让服务端察觉到连接已经没了。
        const ping = setInterval(() => {
          if (res.writableEnded || res.destroyed) return;
          res.write(': ping\n\n');
        }, WATCH_HEARTBEAT_MS);

        res.on('close', () => {
          clearInterval(ping);
          if (release) release();
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/evaluate') {
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: '请求体不是合法 JSON' });
          return;
        }

        const job = payload && payload.job;
        if (!job || typeof job !== 'object') {
          sendJson(res, 400, { error: '缺少 job 字段' });
          return;
        }

        // 控制进程自己不判定:判定在后台服务进程里。服务没启动时明确回 503,
        // 让脚本侧看到「服务未启动」而不是一个含糊的网络错误。
        if (serviceControl) {
          if (!serviceControl.isRunning()) {
            sendJson(res, 503, { error: '判定服务未启动:请在大屏右上角点「启动服务」' });
            return;
          }
          await serviceControl.forwardEvaluate(raw, res);
          return;
        }

        const key = jobSignature(job);
        if (cache.has(key)) {
          const hit = cache.get(key);
          sendJson(res, 200, { ...hit, meta: { ...hit.meta, cacheHit: true } });
          return;
        }

        const result = await evaluateJob(job, deps);
        // 判定不可用的结果**不进缓存**。否则端点短暂抖动期间评估过的岗位会被钉死成
        // "跳过",即使端点恢复、甚至脚本重跑,同一进程内也永远拿不到重新判定 ——
        // 而缓存的本意只是省掉重复调用,不是把一次故障固化下来。
        if (!result.meta.fallback) cache.set(key, result);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' && pathname === '/dashboard') {
        const body = renderDashboardHtml();
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      // 从大屏上「一键安装油猴脚本」。
      //
      // 为什么由服务发而不是让用户去文件夹里找:篡改猴只对**以 .user.js 结尾的导航**
      // 弹安装框,而 `file://` 打不开的机器不少(浏览器默认禁止本地文件访问),
      // 拖进浏览器也不同浏览器行为不一。走 HTTP 就是一次正常的链接点击。
      //
      // 路径必须以 `.user.js` 结尾 —— 这是篡改猴认安装请求的唯一依据,改名字就不弹框了。
      if (req.method === 'GET' && (pathname === '/install.user.js' || pathname === '/zhipin-auto-greeting.user.js')) {
        let script;
        try {
          script = fs.readFileSync(userscriptFile, 'utf8');
        } catch (error) {
          // 找不到脚本要说清「是谁在找、去哪找了」,否则用户只看到 404 无从下手。
          sendJson(res, 404, { error: `找不到油猴脚本(${userscriptFile}):${error.message}` });
          return;
        }
        res.writeHead(200, {
          // 篡改猴按内容类型判断要不要接管;给 text/plain 它会当成普通文件显示出来。
          'content-type': 'text/javascript; charset=utf-8',
          'content-length': Buffer.byteLength(script),
          // 脚本会被反复读取(用户可能装多次),但内容只跟 exe 版本有关,不设强缓存。
          'cache-control': 'no-store',
        });
        res.end(script);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/records') {
        // since 缺省或非法时 ledger.readSince 视作 0,即全量返回。
        sendJson(res, 200, {
          runId,
          seq: ledger.seq(),
          stats: ledger.stats(),
          // 大字按钮的状态跟着同一个轮询走,页面不必再单独起一个定时器。
          service: serviceStatus(),
          // 柱状图要的是**全量历史**,而 records 是增量的 —— 所以每天的分组由服务端算好
          // 一并返回,而不是让页面去拼增量。放同一个响应里还有个好处:图表和表格用的是
          // 同一次轮询的同一份数据,不会出现「表格更新了而图表还是上一轮」的错位。
          daily: ledger.dailyCounts(),
          records: ledger.readSince(parsed.searchParams.get('since')),
        });
        return;
      }

      if (pathname === '/api/settings') {
        const store = deps.settings;
        // 配置存储由 deps 注入。桩测试若不提供就没有后端可谈 —— 显式报错比 500 好查。
        if (!store) {
          sendJson(res, 503, { error: '服务未启用配置存储' });
          return;
        }

        if (req.method === 'GET') {
          // 脱敏后才出网:明文密钥绝不进响应体。响应体可能被页面或个人抓包留存,
          // 密钥没有任何理由出现在里面。
          sendJson(res, 200, redactSettings(store.get()));
          return;
        }

        if (req.method === 'POST') {
          if (isCrossOriginWrite(req.headers)) {
            sendJson(res, 403, { error: '拒绝跨站写入' });
            return;
          }

          const raw = await readBody(req);
          let payload;
          try {
            payload = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { error: '请求体不是合法 JSON' });
            return;
          }

          let saved;
          try {
            saved = store.save(payload);
          } catch (error) {
            // 校验失败的原因要给到用户看 —— 大屏上直接显示这句话。
            sendJson(res, 400, { error: error.message });
            return;
          }

          // 判定结果按岗位签名缓存(prompt 影响 apply/reason,招呼样式影响 greeting),
          // 配置一变已缓存的结论就过期了。不清的话用户改完重跑,看到的还是旧结论,
          // 会以为「改了没用」。清缓存不会导致重复投递:脚本侧有本地「已沟通」记录去重。
          cache.clear();
          // 判定结果缓存在后台服务进程里,配置一变要让它也清掉 —— 否则用户改完规则
          // 重跑,看到的还是旧结论。服务没启动时不用管:它启动时会重新读配置。
          if (serviceControl) serviceControl.clearCache();
          sendJson(res, 200, { ok: true, settings: redactSettings(saved) });
          return;
        }
      }

      // 内部接口:控制进程保存配置后,让后台判定服务清掉自己的判定缓存。
      // 走同一套跨站写入防护 —— 它虽然是本机调用,但没有理由比别的写接口更宽松。
      if (req.method === 'POST' && pathname === '/api/cache/clear') {
        if (isCrossOriginWrite(req.headers)) {
          sendJson(res, 403, { error: '拒绝跨站写入' });
          return;
        }
        cache.clear();
        sendJson(res, 200, { ok: true });
        return;
      }

      // 大屏「测试连通」:拿页面上当前填的端点/模型/密钥实际打一次上游,把结论回给页面。
      // 刻意不落盘 —— 用户是在保存前先试,试通了再保存。
      if (req.method === 'POST' && pathname === '/api/ai/test') {
        if (isCrossOriginWrite(req.headers)) {
          sendJson(res, 403, { error: '拒绝跨站写入' });
          return;
        }
        if (!deps.testAi) {
          sendJson(res, 503, { error: '服务未启用 AI 探测' });
          return;
        }

        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: '请求体不是合法 JSON' });
          return;
        }

        // 三个字段都「页面上填了就用页面上的,留空回落到已保存的」—— 尤其是密钥:
        // 密钥框永远不回填,留空就意味着「用存好的那把」,与保存时「空 aiKey = 不修改」
        // 是同一个约定(见 settings.validatePatch)。
        const stored = deps.settings ? deps.settings.get() : {};
        const config = {
          endpoint: String(payload.aiEndpoint || stored.aiEndpoint || '').trim(),
          model: String(payload.aiModel || stored.aiModel || '').trim(),
          key: String(payload.aiKey || stored.aiKey || '').trim(),
        };

        // readBody 没有大小上限,而这三项最终会原样进上游的请求体 —— 在这里挡一道。
        if (config.endpoint.length > MAX_ENDPOINT_CHARS
          || config.model.length > MAX_MODEL_CHARS
          || config.key.length > MAX_KEY_CHARS) {
          sendJson(res, 400, { error: '端点 / 模型 / 密钥超出长度上限' });
          return;
        }
        if (!/^https?:\/\//i.test(config.endpoint)) {
          sendJson(res, 400, { error: '端点需要以 http:// 或 https:// 开头' });
          return;
        }

        const startedAt = Date.now();
        // 这次探测实际按哪种格式打的。格式是按端点 URL 自动识别的(见 evaluator.detectApiFormat),
        // 用户填了个「路径不带 /messages 也不带 /chat/completions」的中转时,这是唯一能看出
        // 判成了哪一种的地方 —— 连成功带失败一起回给大屏。
        const format = detectApiFormat(config.endpoint);
        try {
          await deps.testAi(config);
          // 响应体里只出结论、格式与模型名。明文密钥绝不进响应体。
          sendJson(res, 200, { ok: true, ms: Date.now() - startedAt, model: config.model, format });
        } catch (error) {
          // 探测失败是「问到了上游、上游说不行」(密钥错 / 端点错 / 超时),不是调用本接口的
          // 方式错了,所以照回 200 —— 大屏只看 ok 决定红绿,不必再分辨 HTTP 状态。
          sendJson(res, 200, { ok: false, ms: Date.now() - startedAt, error: error.message, format });
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/export.csv') {
        // BOM 不能省:没有它 Excel 会把中文读成乱码。
        const body = `\uFEFF${toCsv(ledger.all())}`;
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      if (req.method === 'POST' && pathname === '/report') {
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: '请求体不是合法 JSON' });
          return;
        }

        // 服务端补上 runId 再落盘:契约规定 runId 是「服务进程启动时刻」,
        // 上报方(脚本)无从得知,只能由服务端盖。缺了它 record.runId 恒为空串,
        // 而 stats() 用 record.runId === currentRunId 判定「本轮」—— 不补的话
        // 页面的「本轮」永远显示 0。放在展开之后,以服务端的值为准。
        // at 同理兜底:上报方漏带 at 时若原样落盘,大屏时间列会是空白。
        // 与 runId 不同,at 由上报方决定(它才是那一刻的观察者),所以只在缺失时补。
        const { record, persisted } = ledger.append({
          ...payload,
          runId,
          at: payload.at || new Date().toISOString(),
        });
        // 落盘失败回 500 让脚本知道,但记录已进内存、页面仍看得到,服务不崩。
        sendJson(res, persisted ? 200 : 500, { ok: persisted, seq: record.seq });
        return;
      }

      sendJson(res, 404, { error: '未知路由' });
    } catch (error) {
      sendJson(res, 500, { error: (error && error.message) || String(error) });
    }
  });

  return server;
}

function buildDefaultDeps() {
  // 大屏上可改的判定规则、招呼样式、知识库与 AI 接入。放 data/ 下(已在 .gitignore),
  // 免得个人的知识库与招呼样式被提交进仓库。
  const settings = createSettingsStore(path.join(DATA_DIR, 'settings.json'));

  // 每次调用都现取一次 —— 大屏上保存后立即生效,不必重启服务。
  // 密钥为空时 callChatApi 直接抛错,判定与生成各自走既有的 fallback 分支。
  const aiConfig = () => {
    const current = settings.get();
    return { endpoint: current.aiEndpoint, key: current.aiKey, model: current.aiModel };
  };

  return {
    settings,
    decideByPrompt: (job, knowledge, ruleText) =>
      decideByPrompt(job, knowledge, ruleText, {
        budgetMs: DECISION_BUDGET_MS,
        ai: aiConfig(),
      }),
    buildGreeting: (job, knowledge) =>
      buildGreetingViaLlm(job, knowledge, {
        // 用户在大屏「打招呼样式」里写的那段要求。空串 = 没配,走通用要求。
        // 每次现取一次设置,大屏上改完下一个岗位就生效。
        stylePrompt: settings.get().greetingPrompt,
        // 生成也要有超时。没有上限的话,端点卡住时服务端会一直挂着,
        // 直到脚本侧 45 秒超时断开 —— 请求白做,还占着连接。
        // 请求头、请求体、超时现在统一由 callChatApi 负责(与判定共用同一处),
        // 这里不再另抄一份 fetch —— 抄一份就意味着加配置时要改两个地方。
        callLlm: (system, user) =>
          callChatApi({
            ...aiConfig(),
            system,
            user,
            maxTokens: GREETING_MAX_TOKENS,
            timeoutMs: GREETING_BUDGET_MS,
          }),
      }),
    // 大屏「测试连通」用。与判定、招呼语共用 callChatApi 这一处调用 ——
    // 请求头、请求体、超时都不另抄一份,否则加配置时要改两个地方。
    testAi: (config) => {
      const probe = buildProbePrompt();
      return callChatApi({
        ...config,
        system: probe.system,
        user: probe.user,
        maxTokens: AI_TEST_MAX_TOKENS,
        timeoutMs: AI_TEST_BUDGET_MS,
      });
    },
  };
}

/**
 * 启动服务并开始监听,返回 http.Server。
 *
 * 这是「单进程」入口:`node src/server.js` 与 npm start 走这里,判定也在这个进程里。
 * 打包出来的 HelloBoss.exe 不走它 —— 控制进程用 src/supervisor.js,判定服务用自己的
 * 子进程入口(见 launcher/bootstrap.cjs)。把两种启动方式分开,是为了让「默认不启动
 * 判定服务」成立,而不是在一个进程里假装停掉。
 *
 * 配置错误会抛出去而不是自己 process.exit:入口那侧要先把错误写进日志、再弹窗
 * 告诉用户,而不是当作「服务偷偷没起来」。
 *
 * @param {object} [options]
 * @param {boolean} [options.exitWhenIdle] 覆盖「大屏关了自动退出」,不传则看环境变量
 */
export function startServer(options = {}) {
  // 「大屏页面关掉就把服务停掉」只给 npm 开发路径与自动退出测试用。
  // HelloBoss.exe 的控制进程自己管理空闲退出(见 src/supervisor.js),不走这里。
  const exitWhenIdle = options.exitWhenIdle ?? process.env.BOSS_EXIT_WHEN_IDLE === '1';

  // 顺序:记账器要先建出来才能交给 createServer,而它的 onIdle 又要用到 server,
  // 所以 server 先声明后赋值 —— 别改成 const,那样会踩到暂时性死区。
  let server = null;
  let exiting = false;

  function shutdown(reason) {
    if (exiting) return;
    exiting = true;
    console.log(`[HelloBoss] ${reason},服务退出`);

    // 先让在看的页面收尾:把大屏那条流结束掉,连接回到空闲,close() 才收得回来。
    // 刻意不用 closeAllConnections() —— 那会把正在跑的判定请求一起掐掉,
    // 白白废掉油猴脚本那 45 秒的等待预算。
    if (idle) idle.releaseAll();
    server.close(() => process.exit(0));

    // 兜底:close() 万一被残留的 socket 卡住,这个隐藏进程就既退不掉、用户也察觉不到。
    // 45 秒取自脚本侧的等待预算 —— 过了这个点,已经没有人在等它的回答了。
    setTimeout(() => {
      console.log('[HelloBoss] 收尾超时,强制退出');
      process.exit(0);
    }, 45_000).unref();
  }

  const idle = exitWhenIdle
    ? createIdleExit({
      // 环境变量只给测试和调试用(测试要让它几毫秒就退,不然一个用例要等一分钟)。
      graceMs: Number(process.env.BOSS_IDLE_GRACE_MS) || DEFAULT_GRACE_MS,
      onIdle: () => shutdown('大屏已关闭'),
    })
    : null;

  server = createServer({ idle });

  // 只听回环。手机看大屏(局域网监听)已经整套移除 —— 大屏只在本机开。
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[HelloBoss] 监听 http://127.0.0.1:${PORT}`);
    console.log(`[HelloBoss] 健康检查 http://127.0.0.1:${PORT}/health`);
    // 页面还没连上之前先给一段宽限,免得「服务刚起来、Edge 还没渲染出大屏」就被判成没人看。
    if (idle) idle.start();
  });

  return server;
}

// 直接用 node src/server.js 启动时才监听;被测试 import、或被 exe 的引导脚本
// import 时都不走这里(后者只取 createServer,自己决定监听哪个端口)。
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  try {
    startServer();
  } catch (error) {
    // 配置错误直接给人话并退出,别让栈把真正的原因冲掉。
    console.error(`[HelloBoss] 启动失败:${error.message}`);
    process.exit(1);
  }
}
