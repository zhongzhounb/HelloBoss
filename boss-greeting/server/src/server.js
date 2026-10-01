import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllResumes, VARIANTS } from './resumeParser.js';
import { selectVariant, buildJdText } from './variantSelector.js';
import {
  buildTemplateGreeting,
  callMessagesApi,
  decideByPrompt,
  pickSample,
  buildGreetingSystemPrompt,
} from './evaluator.js';
import { createLedger, toCsv } from './ledger.js';
import { renderDashboardHtml } from './dashboard.js';
import { createSettingsStore, redactSettings } from './settings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.PORT || 8787);
// 简历目录。默认是仓库内的 resumes/ —— 里面带了一份示例,所以 clone 下来不配任何
// 东西也能启动。换成自己的:把 .typ 丢进去,或用 RESUME_SRC 指到别处。
const RESUME_SRC = process.env.RESUME_SRC || path.join(ROOT, 'resumes');
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 手机端看大屏用的 cookie 名。取这个名字是因为「大屏」在本项目里就是它的唯一用途。
const COOKIE_NAME = 'big_screen_token';
const COOKIE_MAX_AGE_SECONDS = 2592000;

const SERVER_CONFIG_FILE = path.join(ROOT, 'config', 'server.json');

// 服务自身的运行配置:要不要对局域网开放、以及访问令牌。
//
// 缺文件时返回「只听回环、无鉴权」—— 仓库克隆下来不准备任何东西就能跑,
// 现有测试与本机日常用法都不受影响。只有显式 lan: true 才会绑全网卡。
export function loadServerConfig(file) {
  const target = file || SERVER_CONFIG_FILE;
  let raw = {};

  if (fs.existsSync(target)) {
    try {
      raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (error) {
      throw new Error(`服务配置解析失败:${target}\n原始错误:${error.message}`);
    }
  }

  const lan = Boolean(raw) && raw.lan === true;
  const token = String((raw && raw.token) || '').trim();

  // 开了局域网却没配令牌 = 把岗位记录连同写接口一并交给同网段。宁可起不来。
  if (lan && !token) {
    throw new Error(
      '服务配置开启了局域网访问(lan: true)但没有 token。\n' +
      `请补上 ${target} 的 token 字段(或用 开机自启-安装.cmd 生成),否则拒绝启动。`,
    );
  }

  return { lan, token };
}

// IPv4 映射写法(::ffff:192.168.1.7)必须先剥壳再比 —— 监听双栈地址时本机请求
// 就是这种形态,不剥壳会把本机自己的浏览器也判成"外来访问"。
export function isLoopbackAddress(remoteAddress) {
  const address = String(remoteAddress || '').trim().toLowerCase();
  if (!address) return false;

  const bare = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return bare === '::1' || bare === 'localhost' || bare.startsWith('127.');
}

// 从 Cookie 头里取一个键。值本身可能含 =,所以只按第一个 = 切开。
function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}

// 令牌可以走 Authorization 头,也可以走 cookie —— 手机浏览器只能走 cookie:
// 页面里 fetch('/api/records') 与「导出 CSV」的 <a href> 都带不了自定义请求头。
//
// 回环豁免只挡"局域网里别人访问",挡不住"本机自己把外网流量转进来"(隧道/反代)。
// 真挂了隧道就把 allowLoopback 关掉,那边油猴脚本也要跟着带令牌。
export function isRequestAuthorized({ remoteAddress, headers, token, allowLoopback }) {
  if (!token) return true;
  if (allowLoopback !== false && isLoopbackAddress(remoteAddress)) return true;

  const authorization = String((headers && headers.authorization) || '');
  if (authorization.startsWith('Bearer ') && authorization.slice('Bearer '.length).trim() === token) {
    return true;
  }

  return readCookie(headers && headers.cookie, COOKIE_NAME) === token;
}

// 跨站写入防护。与令牌鉴权是两件事:令牌管「谁能访问」,这里管「谁能在别的站点上
// 替我们发起写入」。
//
// 起因是 POST /api/settings 把「哪些岗位会被自动投」变成了可远程改的东西,而大屏可能
// 通过令牌对局域网开放(手机看大屏)—— 拿到令牌的人原本只能看和灌 /report,现在还能
// 改判定规则,是权限升级。浏览器跨站发起的请求**一定**带 Origin,比对 host 就能挡住
// 拿着 cookie 的跨站表单提交(令牌 cookie 是 SameSite=Lax,本已挡住大部分,这是第二道)。
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

  // 简历版本选择仍然是本地关键词匹配(见 variantSelector.js)—— 它决定招呼语往哪个
  // 技术方向说,不是投/不投的筛选规则,所以不受「规则全交给 prompt」这次改动影响。
  const selection = deps.selectVariant(buildJdText(job), deps.profiles, deps.keywords);
  // 选版失败不能导致整体失败 —— 退回 priority 首位,只是招呼语方向可能不准。
  const variant = selection.variant || deps.keywords.priority?.[0] || VARIANTS[0];
  const profile = deps.profileOf(variant);

  // 配置由调用方注入而不是自己读文件:否则桩测试会失去隔离。
  // 每次判定都重新 get() 一次,所以大屏上保存后立即生效,不必重启服务。
  const settings = deps.settings ? deps.settings.get() : {};
  const rule = String(settings.decisionPrompt || '').trim();

  const baseMeta = {
    variant,
    variantScore: selection.score,
    variantEvidence: selection.evidence,
    greetingFallback: false,
    cacheHit: false,
    latencyMs: 0,
  };

  // 没有简历 = 无从判断岗位与候选人是否匹配,同样一个都不放行。
  //
  // 这条必须挡在 buildUserPrompt 之前:evaluator 里那句 `profile.sections.skills`
  // 在 profile 为 undefined 时会抛错,而它在 decideByPrompt 的重试 try/catch **之外**,
  // 会一路冒到路由变成 500 —— 用户看到的是「服务坏了」,而不是「我还没放简历」。
  //
  // fallback: true 有两个作用:不进缓存(与 AI 不可用同一套规则),以及让调用方
  // 能把它和「AI 判掉了」区分开 —— 前者是「没判成」,端点/简历补齐后还能重判。
  if (!profile) {
    return {
      apply: false,
      reason: '尚未加载简历,已跳过该岗位 —— 请把 .typ 简历放进 resumes/ 目录',
      greeting: '',
      meta: { ...baseMeta, fallback: true, noResume: true, latencyMs: Date.now() - startedAt },
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

  const decision = await deps.decideByPrompt(job, profile, rule);

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
    try {
      const generated = await deps.buildGreeting(job, profile);
      if (generated) {
        greeting = generated;
      } else {
        greeting = buildTemplateGreeting(profile, job);
        greetingFallback = true;
      }
    } catch {
      // 判定已通过,只是措辞生成失败 —— 退回模板照常投。
      // 这与判定失败不同:岗位本身是合适的,不该因为一句措辞丢掉。
      greeting = buildTemplateGreeting(profile, job);
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

// 生成招呼语:用 LLM 把简历事实和 JD 措辞对上。失败也返回空串,由上层兜底。
async function buildGreetingViaLlm(job, profile, options) {
  const { callLlm, sample } = options;
  // 风格要求由 options.sample 提供(用户在设置页填的样例里随机挑一条,没填则为空串)。
  const system = buildGreetingSystemPrompt(sample);

  const user = [
    `简历:${profile.name},${profile.sections.education[0]?.title || ''},技能方向:${profile.sections.skills.map((s) => s.label).join('、')}`,
    `岗位:${job.jobName || ''} @ ${job.company || ''}`,
    `JD:${(job.postDescription || '').slice(0, 800)}`,
  ].join('\n');

  const text = await callLlm(system, user);
  return String(text || '').trim();
}

export function createServer(options = {}) {
  const deps = options.deps || buildDefaultDeps();
  // 运行数据落在服务目录的 data/ 下,不进 git。测试显式传 ledgerFile,
  // 避免把假记录写进真实文件、以及测试之间互相污染。
  const ledgerFile = options.ledgerFile || path.join(ROOT, 'data', 'jobs.jsonl');
  // 进程启动时刻即"本轮"的标识 —— 页面据此区分本轮与累计。
  // 只取一次:两次调用会得到不同毫秒值,导致 setRunId 与响应里的 runId 对不上。
  const runId = new Date().toISOString();
  const ledger = createLedger(ledgerFile);
  ledger.setRunId(runId);

  // token 为空 = 不开鉴权(默认,与本机单机用法一致)。
  // allowLoopback 默认 true:本机浏览器和油猴脚本都走 127.0.0.1,不带令牌也该放行。
  // 它存在的意义是让测试能把豁免关掉,从而覆盖到鉴权分支。
  const token = String(options.token || '').trim();
  const allowLoopback = options.allowLoopback !== false;

  const cache = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      // 统一解析路径:看板的路由带查询串(?since=N),全等比较匹配不上。
      // 基址是占位符 —— 只用来把相对 URL 补全成可解析的绝对 URL,不会被请求。
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = parsed.pathname;

      // 带令牌访问一次看板 → 换 cookie 再跳到不带令牌的干净地址,免得令牌长期留在
      // 地址栏与历史记录里。这一步放在鉴权之前:本机(回环免令牌)走同一个地址也会被清干净。
      const queryToken = parsed.searchParams.get('token');
      if (req.method === 'GET' && pathname === '/dashboard' && queryToken && token) {
        if (queryToken !== token) {
          sendJson(res, 401, { error: '令牌不正确' });
          return;
        }
        res.writeHead(302, {
          location: '/dashboard',
          'set-cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
        });
        res.end();
        return;
      }

      // 鉴权挡在所有路由之前 —— 未授权的 /report 绝不能写进 ledger。
      if (token && !isRequestAuthorized({
        remoteAddress: req.socket.remoteAddress,
        headers: req.headers,
        token,
        allowLoopback,
      })) {
        sendJson(res, 401, { error: `需要访问令牌:请用 http://<本机IP>:${PORT}/dashboard?token=<令牌> 打开一次` });
        return;
      }

      if (req.method === 'GET' && pathname === '/health') {
        // aiConfigured 让大屏能提示「还没配密钥,判定会全部跳过」。少了它,用户看到的
        // 现象是「岗位一个都没投」,而看不出根因是没填 key —— 只报了个 ok:true。
        // 只回布尔,不回密钥本身。
        const current = deps.settings ? deps.settings.get() : {};
        sendJson(res, 200, {
          ok: true,
          profiles: deps.profiles.length,
          cache: cache.size,
          aiConfigured: Boolean(String(current.aiKey || '').trim()),
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

      if (req.method === 'GET' && pathname === '/api/records') {
        // since 缺省或非法时 ledger.readSince 视作 0,即全量返回。
        sendJson(res, 200, {
          runId,
          seq: ledger.seq(),
          stats: ledger.stats(),
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
          // 脱敏后才出网:明文密钥绝不进响应体 —— 大屏可以带令牌对整个局域网开放。
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

          // 判定结果按岗位签名缓存(prompt 影响 apply/reason,样例影响 greeting),
          // 配置一变已缓存的结论就过期了。不清的话用户改完重跑,看到的还是旧结论,
          // 会以为「改了没用」。清缓存不会导致重复投递:脚本侧有本地「已沟通」记录去重。
          cache.clear();
          sendJson(res, 200, { ok: true, settings: redactSettings(saved) });
          return;
        }
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

// 读不到简历**不阻止启动**。
//
// 服务里还有大屏、记录、导 CSV 这些不依赖简历的部分;而「为什么一个岗位都没投」
// 正确的提示方式是 /health 里的 profiles: 0 加大屏上的警告条,不是让进程起不来 ——
// 那样用户连去哪儿看提示都不知道。原先是裸抛,别人 clone 下来必崩。
function loadProfiles(srcDir) {
  try {
    const profiles = parseAllResumes(srcDir);
    if (!profiles.length) {
      console.warn(`[resume] ${srcDir} 里没有可用的 .typ 简历 —— 判定将全部跳过`);
    }
    return profiles;
  } catch (error) {
    console.warn(`[resume] 简历目录读取失败(${srcDir}):${error.message} —— 判定将全部跳过`);
    return [];
  }
}

function buildDefaultDeps() {
  const profiles = loadProfiles(RESUME_SRC);
  // 只剩选简历版本用的关键词表。判定规则不再有任何结构化配置 ——
  // 它整段住在大屏的 prompt 里,换一个人用只需要换那段文字。
  const keywords = readJson(path.join(ROOT, 'config', 'keywords.json'));
  const byVariant = new Map(profiles.map((p) => [p.variant, p]));

  // 大屏上可改的判定规则与招呼样例。放 data/ 下(已在 .gitignore),
  // 免得个人的招呼样例被提交进仓库。
  const settings = createSettingsStore(path.join(ROOT, 'data', 'settings.json'));

  // 每次调用都现取一次 —— 大屏上保存后立即生效,不必重启服务。
  // 密钥为空时 callMessagesApi 直接抛错,判定与生成各自走既有的 fallback 分支。
  const aiConfig = () => {
    const current = settings.get();
    return { endpoint: current.aiEndpoint, key: current.aiKey, model: current.aiModel };
  };

  return {
    profiles,
    keywords,
    settings,
    profileOf: (variant) => byVariant.get(variant) || profiles[0],
    selectVariant,
    decideByPrompt: (job, profile, ruleText) =>
      decideByPrompt(job, profile, ruleText, {
        budgetMs: DECISION_BUDGET_MS,
        ai: aiConfig(),
      }),
    buildGreeting: (job, profile) =>
      buildGreetingViaLlm(job, profile, {
        // 每次生成都现取一次样例 —— 大屏上改完立即生效,不必重启服务。
        sample: pickSample(settings.get().greetingSamples),
        // 生成也要有超时。没有上限的话,端点卡住时服务端会一直挂着,
        // 直到脚本侧 45 秒超时断开 —— 请求白做,还占着连接。
        // 请求头、请求体、超时现在统一由 callMessagesApi 负责(与判定共用同一处),
        // 这里不再另抄一份 fetch —— 抄一份就意味着加配置时要改两个地方。
        callLlm: (system, user) =>
          callMessagesApi({
            ...aiConfig(),
            system,
            user,
            maxTokens: GREETING_MAX_TOKENS,
            timeoutMs: GREETING_BUDGET_MS,
          }),
      }),
  };
}

// 本机的局域网 IPv4,给手机访问用。只挑 IPv4:家里路由器给的多半是 v4,
// 而 IPv6 地址又长又会变,写进提示里只会误导。
export function lanAddresses() {
  const result = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos || []) {
      // family 在新版本 Node 里是 'IPv4',老版本是数字 4,两种都认。
      if ((info.family === 'IPv4' || info.family === 4) && !info.internal) result.push(info.address);
    }
  }
  return result;
}

// 直接用 node src/server.js 启动时才监听;被测试 import 时不启动。
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  let serverConfig;
  try {
    serverConfig = loadServerConfig();
  } catch (error) {
    // 配置错误直接给人话并退出,别让栈把真正的原因冲掉。
    console.error(`[boss-ai-gate] 启动失败:${error.message}`);
    process.exit(1);
  }

  const server = createServer({ token: serverConfig.token });
  // lan 用 '::' 而不是 '0.0.0.0' —— 后者只绑 IPv4,手机侧解析到 IPv6 就连不上。
  const host = serverConfig.lan ? '::' : '127.0.0.1';

  server.listen(PORT, host, () => {
    console.log(`[boss-ai-gate] 监听 http://127.0.0.1:${PORT}`);
    console.log(`[boss-ai-gate] 健康检查 http://127.0.0.1:${PORT}/health`);
    if (!serverConfig.lan) return;

    console.log('[boss-ai-gate] 已对局域网开放(非本机访问需要令牌)');
    for (const address of lanAddresses()) {
      console.log(`[boss-ai-gate] 手机访问 http://${address}:${PORT}/dashboard?token=${serverConfig.token}`);
    }
  });
}
