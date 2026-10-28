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

// 招呼语 prompt 里 JD 的截断长度。沿用改造前那份提示词里的 800。
const GREETING_JD_CHARS = 800;

// 简历各部分进提示词的条数与每条字数上限。
//
// 为什么必须卡死:项目 descs 可以很长,全塞进去输入词元暴涨,而招呼语的预算只有
// GREETING_BUDGET_MS(12 秒)—— 超时就退回模板兜底,用户看到的是「招呼语怎么老匹配不上」。
// 截断换来的稳定,比多塞两百字值。
//
// 注意这几项**不能靠调大来提升质量**:12 秒的上限受脚本侧 45 秒超时链约束
// (见 server.js 顶部的超时预算注释),调大预算会先撞上脚本先断开的问题。
const RESUME_PROMPT_LIMITS = {
  education: 2,
  educationChars: 90,
  experience: 2,
  experienceChars: 170,
  projects: 2,
  projectChars: 170,
  skills: 10,
};

function truncateText(text, limit) {
  const value = String(text == null ? '' : text).trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

// 把一条教育 / 实习 / 项目条目压成一行。
//
// **刻意不按固定槽位取字段** —— 两种简历格式把「学历」「时间」「角色」放在不同字段里:
//   .txt 的「单位 | 时间 | 备注」把角色放在 position;
//   .typ 宏格式把角色放在 mid、时间放在 rule(见 resumeParser 的 toItem 与 .txt 分支)。
// 按槽位取必然漏掉其中一种格式,而漏掉的正好是「实习岗位是什么」这种最该让模型看见的信息。
// 这里把所有非空字段按固定顺序拼起来,两种格式都能出全。
function summarizeResumeEntry(entry, charLimit) {
  const source = entry && typeof entry === 'object' ? entry : {};

  const head = [source.title, source.time, source.rule, source.mid, source.position]
    .map((value) => String(value == null ? '' : value).trim())
    .filter(Boolean)
    .join(' | ');

  const detail = (Array.isArray(source.descs) ? source.descs : [])
    .map((desc) => {
      const item = desc && typeof desc === 'object' ? desc : {};
      return [item.label, item.content]
        .map((value) => String(value == null ? '' : value).trim())
        .filter(Boolean)
        .join(': ');
    })
    .filter(Boolean)
    .join('；');

  return truncateText([head, detail].filter(Boolean).join(' — '), charLimit);
}

// 把简历压成给模型看的「事实清单」。
//
// 只给**简历里明写过的东西** —— 这是防编造的根:模型拿不到的事实,它编不出来。
//
// 之前这里只传了姓名、学校和技能标签,于是「海信实习」「国奖竞赛」「开源项目」这些
// 真正能打的卖点一个都没进提示词 —— 生成出来的招呼语只能泛泛而谈「我很感兴趣」,
// 用户想要的卖点,模型根本无从知道。
export function buildResumeFacts(profile) {
  const sections = (profile && profile.sections) || {};
  const lines = [`姓名:${truncateText(profile && profile.name, 30) || '未知'}`];

  const render = (list, limit, entryChars) =>
    (Array.isArray(list) ? list : [])
      .slice(0, limit)
      .map((entry) => summarizeResumeEntry(entry, entryChars))
      .filter(Boolean)
      .join(' / ');

  const education = render(sections.education, RESUME_PROMPT_LIMITS.education, RESUME_PROMPT_LIMITS.educationChars);
  if (education) lines.push(`教育:${education}`);

  const experience = render(sections.experience, RESUME_PROMPT_LIMITS.experience, RESUME_PROMPT_LIMITS.experienceChars);
  if (experience) lines.push(`实习:${experience}`);

  const projects = render(sections.projects, RESUME_PROMPT_LIMITS.projects, RESUME_PROMPT_LIMITS.projectChars);
  if (projects) lines.push(`项目:${projects}`);

  const skills = (Array.isArray(sections.skills) ? sections.skills : [])
    .slice(0, RESUME_PROMPT_LIMITS.skills)
    .map((skill) => String((skill && skill.label) || '').trim())
    .filter(Boolean);
  if (skills.length) lines.push(`技能:${skills.join('、')}`);

  return lines.join('\n');
}

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

// 端点路径决定用哪种接口格式 —— 返回值是 'anthropic' 或 'openai'。
//
// 两种格式的请求体、鉴权头、响应结构三者全不一样,而端点 URL 是最可靠的信号:
// 各家中转(one-api / new-api / LiteLLM / CC Switch 之类)都照抄上游的路径。
// 认不出来时退回 anthropic —— 那是加第二种格式之前唯一支持的那种,已有配置不受影响。
export function detectApiFormat(endpoint) {
  let pathname;
  try {
    pathname = new URL(String(endpoint)).pathname.toLowerCase();
  } catch {
    // 读取路径不校验 URL 形态(见 settings.normalizeSettings),这里也不该抛:
    // 端点写坏时让它跑到 fetch 那一步失败,结果是 fallback,而不是服务端自己崩。
    return 'anthropic';
  }
  // 只看 pathname,所以尾部斜杠与 query 都不影响;顺带也认出了 Azure 那种
  // /openai/deployments/<名字>/chat/completions 的长路径。
  //
  // **刻意不认** /responses:OpenAI Responses API 的请求体(input)与响应结构
  // (output[].content[].text)是第三种形状,把它当成 chat/completions 只会让
  // 「格式不匹配」藏得更深。
  return /\/chat\/completions\/?$/.test(pathname) ? 'openai' : 'anthropic';
}

// 两种格式在报错文案里的名字。端点填错格式时用户只看到一句话,把它写清楚。
const FORMAT_LABELS = {
  anthropic: 'Anthropic Messages',
  openai: 'OpenAI chat/completions',
};

// 下面是两种格式各自的「拼请求」与「从响应里取文本」。
// 拆成四个小函数而不是塞进 callChatApi:那是唯一会发请求的地方,加第三种格式时
// 只需在这里多一对,不必再去动发请求与兜底那部分。
function buildAnthropicRequest({ endpoint, key, model, system, user, maxTokens }) {
  return {
    url: endpoint,
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
  };
}

function buildOpenAiChatRequest({ endpoint, key, model, system, user, maxTokens }) {
  return {
    url: endpoint,
    headers: {
      'content-type': 'application/json',
      // OpenAI 格式走 Bearer。密钥只进请求头 —— 绝不拼进 URL:那会把它留进
      // 各层日志与代理记录里。
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      // 字段名两边都用 max_tokens:网关与 DeepSeek 官方都认它,
      // 只有 OpenAI 自家新模型要 max_completion_tokens(不在本项目射程内)。
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  };
}

// 取不到文本一律返回空串,由调用方当成失败 —— 空响应是最危险的假成功
// (HTTP 200、结构合法、只有内容是空的),不能在这一步悄悄放过。
function parseAnthropicText(payload) {
  return (payload.content || [])
    .filter((part) => part && part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function parseOpenAiChatText(payload) {
  const choices = payload && payload.choices;
  if (!Array.isArray(choices) || !choices.length) return '';
  const message = choices[0] && choices[0].message;
  const content = message && message.content;

  // 刻意不读 message.reasoning_content:那是思维链,不是判定要的 JSON 结论,
  // 也不是招呼语。它非空而 content 为空,正好是「推理 token 吃光了预算」这个
  // 失败模式,应当照旧抛错、让 decideByPrompt 放大预算重试。
  //
  // 少数网关把 content 发成分段数组(与 Anthropic 的分段同形),顺手兼容。
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }
  return typeof content === 'string' ? content : '';
}

// 对上游 LLM 端点发一次请求,返回拼好的**原始文本**。
//
// 用哪种格式由端点 URL 自动识别(见 detectApiFormat),所以用户只需要填端点、密钥、
// 模型三样,不必再选一次格式。
//
// 判定、招呼语生成与大屏「测试连通」共用这一处 —— 之前生成那边在 server.js 里另抄了
// 一份一模一样的 fetch,加配置时得改两个地方,漏一个就是「判定认了新端点、招呼语还打旧的」。
// 加第二种格式时同样只动了这里。
//
// 返回文本而不是解析后的对象:招呼语要的就是原始句子,判定才需要再走 extractJson。
//
// `key` 为空直接抛错、不发请求。这是 fail-closed 的落点:没配密钥 = AI 不可用,
// 调用方据此走 fallback(岗位既不投、也不进缓存),而不是拿旧默认偷偷发出去。
export async function callChatApi({
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

  const apiFormat = detectApiFormat(endpoint);
  const label = FORMAT_LABELS[apiFormat];
  const request = apiFormat === 'openai'
    ? buildOpenAiChatRequest({ endpoint, key, model, system, user, maxTokens })
    : buildAnthropicRequest({ endpoint, key, model, system, user, maxTokens });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });

    // 报错带上「按哪种格式发的」:端点填错(比如把 OpenAI 中转填成了 /messages)时
    // 用户看到的就是这一句,只给一个 HTTP 400 等于什么都没说。
    if (!response.ok) throw new Error(`接口返回 HTTP ${response.status}(按 ${label} 格式请求)`);

    let payload;
    try {
      payload = await response.json();
    } catch {
      // 有的网关出错时回的是一页 HTML 或一句纯文本,JSON.parse 抛出的 SyntaxError
      // 对用户毫无信息量。
      throw new Error(`上游返回的不是 JSON(按 ${label} 格式请求,HTTP ${response.status})`);
    }

    const text = apiFormat === 'openai' ? parseOpenAiChatText(payload) : parseAnthropicText(payload);

    if (!text.trim()) throw new Error('模型返回内容为空（推理 token 可能吃光了预算）');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function callOnce(fetchImpl, ai, system, user, timeoutMs, maxTokens) {
  return extractJson(await callChatApi({ ...ai, system, user, timeoutMs, maxTokens, fetchImpl }));
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
  // 表达「先别用 AI」的方式,必须一路走到 callChatApi 的守卫里变成 fallback。
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

// 招呼语生成的 system prompt。
//
// stylePrompt 是大屏「打招呼样式」里那段用户自己写的要求 —— 它**只影响怎么写,
// 不逐字发出**,所以用户能写「说说方向就行、别提薪资」这类自由要求,
// 而不是被固定句子框住。空串表示没配,退回下面的通用要求。
//
// 长度与「不许编造」那两句是载重内容:少了长度它会放飞成客套模板腔,少了禁编造
// 它会拿简历里根本没有的经历凑句子(示例简历那回就发过「我是示例大学张三,技能方向
// 是语言和工具」)。
export function buildGreetingSystemPrompt(options = {}) {
  const rules = [
    '你是求职助手,替候选人写一句发给招聘方的打招呼语。',

    // 「读这句的人是谁」决定了写到什么粒度,这是整段 prompt 里最容易写错的地方。
    // 早先那条「点名公司名 + 对上的技术点」的要求产出的正是这种句子:
    //   「飞之辰实习做过采购寻源平台后端,用 CompletableFuture 做详情接口异步化」
    // 中小公司的名字 HR 没听过,技术名词他也不关心 —— 整句话读完什么都没记住。
    '读这句的人多半是 HR 或用人部门的对接人,**不是工程师**:',
    '- 不写具体技术名词和实现细节(「CompletableFuture 异步化」这种他看不懂,也不关心);',
    '- 不点名他大概率没听过的中小公司 —— 除非是知名大厂;',
    '- 说到「方向」这个粒度就够了:「做过 Java 后端」「做过上位机客户端」「做过数据链路」。',

    '要求:',
    '- 60 字以内;口语自然,不要客套模板腔;只输出招呼语本身,不要引号。',
    '- 对照 JD 提到的方向,挑简历里**确实做过**的那部分说 —— 可以用 JD 的措辞,但只能说自己做过的。',
    // 这条是硬约束,不能松:JD 只用来挑重点,不是用来编造的依据。
    // 松掉它,JD 里写「熟悉 Kubernetes」而简历里没有时,模型也会替候选人说「熟悉 Kubernetes」。
    '- **简历是唯一的事实来源**:只准用上面列出的经历、技术和数字,一个字都不许编造简历里没有的经历。',
    '  JD 里要求、但简历里确实没有的东西,就略过它 —— 宁可不提,也不许替候选人认领。',
    '- 结尾落到「感觉和这个岗位很合适 / 很对口」这类表达。',
  ];

  // 只认字符串。写成 String(options.stylePrompt || '') 的话,配置被手改成数字时
  // 会把「123」当成用户写的样式要求塞进提示词 —— 那种错比忽略它难查得多。
  // (normalizeSettings 保证正常路径上一定是字符串,这里是防手改。)
  const style = typeof options.stylePrompt === 'string' ? options.stylePrompt.trim() : '';
  if (style) {
    rules.push(
      '',
      '【用户对打招呼样式的要求】',
      style,
      '上面是用户的要求,在不违反前述硬性约束(长度、不许编造)的前提下照办。',
    );
  }

  return rules.join('\n');
}

// 招呼语的 user prompt:简历事实 + 岗位 + JD。
export function buildGreetingPrompt(profile, job, options = {}) {
  const jd = String((job && job.postDescription) || '').slice(0, GREETING_JD_CHARS);

  return {
    system: buildGreetingSystemPrompt(options),
    user: [
      buildResumeFacts(profile),
      '',
      `岗位:${(job && job.jobName) || ''} @ ${(job && job.company) || ''}`,
      jd ? `JD:${jd}` : 'JD:(接口没返回岗位描述,只能按岗位名判断)',
    ].join('\n'),
  };
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
