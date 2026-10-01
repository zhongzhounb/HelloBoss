// 判定与招呼语的 LLM 调用。
//
// **这里没有任何硬编码的筛选规则。** 投/不投完全由用户在设置页写的自然语言 prompt 决定
// (`decideByPrompt`),服务端只负责把简历、岗位和那段规则拼成请求,并把模型的回答解析成
// 一个布尔结论。想适配另一个人,只需要换掉那段规则,不用改这个文件。
//
// 所以「读不出数字就误投」这类风险不再由代码兜底,而是靠 prompt 里写明 —— 这也是为什么
// 空规则时服务端直接跳过所有岗位(fail-closed),而不是拿一套默认规则顶上。

// 端点 / 密钥 / 模型现在由调用方注入(见 server.js 的 aiConfig,取值于大屏上可改的
// data/settings.json)。下面这三个常量**只剩向后兼容用途**:调用方没传 ai 配置时兜底,
// 现有测试走的正是这条路径。服务端运行时一定显式传,不会落到这里。
const LEGACY_ENDPOINT = 'http://127.0.0.1:15721/v1/messages';
const LEGACY_MODEL = 'claude-haiku-4-5'; // 早期的本地代理会把它路由到实际的 deepseek 模型
const LEGACY_KEY = 'PROXY_MANAGED';
// 底层是推理模型,推理过程与答案共用 max_tokens 预算。预算被推理吃光时返回
// HTTP 200 + 空 content 数组 —— 状态码正常、结构合法,只有内容是空的,极易被当成成功。
//
// 实测三轮:健康时段平均 6.5 秒、空响应 0/9;端点变慢的时段延迟升到 12~25 秒且开始出现空响应。
// 即空响应是端点"慢周期"的伴随现象,不是固定预算不够。
// 所以首轮用小预算保速度,只在快速失败时放大预算重试 —— 不给健康时段白加延迟。
const MAX_TOKENS = 2000;
const MAX_TOKENS_RETRY = 8000;

export function buildUserPrompt(job, profile) {
  const skills = (profile.sections.skills || [])
    .map((s) => `${s.label}:${s.content}`)
    .join('\n');

  return [
    '【候选人简历摘要】',
    `姓名:${profile.name}`,
    `方向版本:${profile.variant}`,
    `技能:`,
    skills,
    '',
    '【待判定的岗位】',
    `岗位名:${job.jobName || '(未知)'}`,
    `公司名:${job.company || job.companyFullName || '(未知)'}`,
    `公司规模:${job.companyScale || '(未知)'}`,
    `公司行业:${job.companyIndustry || '(未知)'}`,
    `融资阶段:${job.companyStage || '(未知)'}`,
    `城市:${job.city || '(未知)'}`,
    `薪资:${job.salary || '(未标注)'}`,
    `经验要求:${job.experience || '(未知)'}`,
    `学历要求:${job.degree || '(未知)'}`,
    `技能标签:${Array.isArray(job.showSkills) ? job.showSkills.join('、') : '(无)'}`,
    '',
    '【岗位 JD 原文】',
    job.postDescription || '(无)',
  ].join('\n');
}

// 用户自定义判定规则时的 system prompt。规则原文**原样**带上,不做任何解释或补全 ——
// 阈值、城市名单、大厂定义这些全在规则里由用户自己写,服务端不再持有任何一份。
export function buildDecisionPrompt(ruleText) {
  return [
    '你是求职投递闸门。读候选人的简历摘要和一个招聘岗位,判断这个岗位值不值得投递。',
    '',
    '【用户设定的投递规则】',
    ruleText,
    '',
    '严格按上面的规则判断。规则里没有涵盖的情况倾向于**不放行** ——',
    '自动发出去的招呼语收不回来,漏投的岗位下次还能再投一遍。',
    '岗位信息里缺哪一项,就先看规则有没有对缺数据的兜底说法;没有就当这一项不满足。',
    '',
    '只输出一个 JSON 对象,不要任何其他文字。格式:',
    '{"apply":true,"reason":"简短理由(点明命中了哪条规则)"}',
    'apply 为 true 表示投递,false 表示跳过。reason 用中文,60 字以内。',
  ].join('\n');
}

export function extractJson(text) {
  const raw = String(text ?? '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('响应中未找到 JSON');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

// 对 Anthropic Messages 端点发一次请求,返回拼好的**原始文本**。
//
// 判定与招呼语生成共用这一处 —— 之前生成那边在 server.js 里另抄了一份一模一样的
// fetch,加配置时得改两个地方,漏一个就是「判定认了新端点、招呼语还打旧的」。
//
// 返回文本而不是解析后的对象:招呼语要的就是原始句子,判定才需要再走 extractJson。
//
// `key` 为空直接抛错、不发请求。这是 fail-closed 的落点:没配密钥 = AI 不可用,
// 调用方据此走 fallback(岗位既不投、也不进缓存),而不是拿旧默认偷偷发出去。
export async function callMessagesApi({
  endpoint,
  key,
  model,
  system,
  user,
  maxTokens = MAX_TOKENS,
  timeoutMs = 30000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!key) throw new Error('尚未配置 API Key,请在服务大屏的「AI 接入」里填写');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': key,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`接口返回 HTTP ${response.status}`);

    const payload = await response.json();
    const text = (payload.content || [])
      .filter((part) => part && part.type === 'text')
      .map((part) => part.text)
      .join('');

    if (!text.trim()) throw new Error('模型返回内容为空（推理 token 可能吃光了预算）');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function callOnce(fetchImpl, ai, system, user, timeoutMs, maxTokens) {
  return extractJson(await callMessagesApi({ ...ai, system, user, timeoutMs, maxTokens, fetchImpl }));
}

// 用用户写的规则直接裁决投/不投。
//
// 返回值里的 `fallback: true` 只表示「拿不到结论」,既不是投也不是不投 —— 调用方据此
// 跳过该岗位且不进缓存。把 fallback 与 `apply: false` 混为一谈,会让 AI 抖动期间的岗位
// 被当成「判定不投」记进大屏,分不清「AI 判掉了」和「AI 没判成」。
export async function decideByPrompt(job, profile, ruleText, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  // budgetMs 是**整个函数的总预算**,不是单次超时。
  // 用单次超时 × 重试次数会让最坏耗时翻倍,突破服务端预算和脚本侧超时。
  const budgetMs = options.budgetMs ?? 30000;
  // AI 接入配置。用 `=== undefined` 判「没传」而不是 `options.ai.key || LEGACY_KEY`:
  // 后者会把「用户显式清空了密钥」重新变成 LEGACY_KEY 并发给远端。清空密钥是用户
  // 表达「先别用 AI」的方式,必须一路走到 callMessagesApi 的守卫里变成 fallback。
  const ai = options.ai === undefined
    ? { endpoint: LEGACY_ENDPOINT, key: LEGACY_KEY, model: LEGACY_MODEL }
    : options.ai;
  const deadline = Date.now() + budgetMs;
  const system = buildDecisionPrompt(ruleText);
  const user = buildUserPrompt(job, profile);

  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const remaining = deadline - Date.now();
    // 剩余不足 500ms 就别发了 —— 发了也必然超时,白等一轮。
    if (remaining <= 500) break;
    // 每次都用光剩余时间。首轮若是**超时**失败,说明端点卡住,剩余时间已不够重试,
    // 循环自然退出;首轮若是**快速**失败(如空响应),才有时间留给重试。
    const maxTokens = attempt === 1 ? MAX_TOKENS : MAX_TOKENS_RETRY;
    try {
      const raw = await callOnce(fetchImpl, ai, system, user, remaining, maxTokens);
      // 缺 apply 或类型不对 = 拿不到结论,按失败处理而不是默认放行。
      // 默认放行会让闸门在模型改口时静默失效(变成海投),正是本工具要避免的。
      if (typeof raw.apply !== 'boolean') {
        throw new Error('模型未返回布尔值 apply');
      }
      return { apply: raw.apply, reason: String(raw.reason ?? ''), fallback: false };
    } catch (error) {
      lastError = error;
    }
  }

  const message = (lastError && lastError.message) || String(lastError);
  return { apply: false, reason: '', fallback: true, error: message };
}

// 从用户的招呼样例里随机挑一条。空数组返回空串 —— 调用方据此决定「没配样式,
// 退回 AI 生成」还是「配了,原样发这条」(见 server.js 的 evaluateJob)。
export function pickSample(samples, random = Math.random) {
  if (!Array.isArray(samples) || !samples.length) return '';
  const index = Math.floor(random() * samples.length);
  // Math.random 不会返回 1,但注入的 random 桩可能会 —— 夹一下免得越界。
  return samples[Math.min(Math.max(index, 0), samples.length - 1)] || '';
}

// 招呼语生成的 system prompt。**只在用户没配「打招呼样式」时才会用到** ——
// 配了样式的话,服务端直接把那条样例原样发出去,不经过模型(见 server.js 的 evaluateJob)。
export function buildGreetingSystemPrompt() {
  return [
    '你是求职助手。根据候选人简历与目标岗位,写一句中文打招呼语。',
    '要求:60 字以内;口语自然,不要客套模板腔;点出与岗位最相关的 1-2 项经历;不要编造简历里没有的经历;只输出招呼语本身,不要引号。',
  ].join('\n');
}

// LLM 不可用时的兜底招呼语。宁可发出去一条普通的,也不要静默漏投。
export function buildTemplateGreeting(profile, job) {
  const school = profile.sections.education[0]?.title || '在读';
  const skill = profile.sections.skills[0]?.label || '';
  const jobName = job.jobName || '该岗位';
  return `您好,我是${profile.name},来自${school},${skill}方向。看到贵司「${jobName}」岗位比较感兴趣,希望进一步沟通,谢谢。`;
}

// 大屏「测试连通」按钮用的探测请求。它不参与判定,只用来验证端点 / 密钥 / 模型
// 能不能真的回话,所以要求回的内容越短越好。
export function buildProbePrompt() {
  return {
    system: '你是连通性测试助手。',
    user: '只回复两个字:ok',
  };
}
