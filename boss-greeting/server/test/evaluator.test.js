import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractJson,
  buildUserPrompt,
  buildDecisionPrompt,
  callChatApi,
  decideByPrompt,
  detectApiFormat,
  buildResumeFacts,
  buildGreetingPrompt,
  buildGreetingSystemPrompt,
  buildTemplateGreeting,
  buildProbePrompt,
} from '../src/evaluator.js';
import { parseResumeByExtension } from '../src/resumeParser.js';

// 用仓库自带的示例简历(推荐格式是 .txt),而不是本机某份真实简历 ——
// 这条测试要在任何人的 clone 上都跑得通。
// 注意它是**在 import 阶段**读的:路径不对会让整个测试文件加载失败,而不是某一条用例失败。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = parseResumeByExtension(
  'example.txt',
  fs.readFileSync(path.resolve(HERE, '..', 'resumes', 'example.txt'), 'utf8'),
);

test('extractJson 解析裸 JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test('extractJson 解析围栏包裹的 JSON', () => {
  const text = '分析如下:\n```json\n{"a": 2}\n```\n完毕';
  assert.deepEqual(extractJson(text), { a: 2 });
});

test('extractJson 解析前后带说明文字的 JSON', () => {
  assert.deepEqual(extractJson('结果是 {"a":3} 就这样'), { a: 3 });
});

test('extractJson 对无法解析的内容抛错', () => {
  assert.throws(() => extractJson('完全没有 JSON'), /未找到 JSON/);
});

test('用户提示词包含岗位信息与简历要点', () => {
  const user = buildUserPrompt({ jobName: 'Qt开发', postDescription: '上位机' }, PROFILE);
  assert.match(user, /Qt开发/);
  assert.match(user, /上位机/);
  assert.match(user, /JavaScript/, '简历里的技能要点要带进去,否则模型无据可依');
});

// ---- 判定规则（prompt 就是唯一的事实来源） ----

test('判定 prompt 原样带上用户写的规则', () => {
  // 规则文本不做任何解释、补全或改写 —— 阈值、城市名单、大厂定义全在用户手里,
  // 服务端不再持有任何一份结构化配置(那是这次删掉 preferences.json 的核心)。
  const rule = '只投青岛和北京的岗位;月薪 20K 以上直接投;创业公司小于 50 人不投。';
  const prompt = buildDecisionPrompt(rule);
  assert.ok(prompt.includes(rule), '规则原文必须一字不差地带进 prompt');
});

test('判定 prompt 写明输出契约与「没涵盖就不放行」', () => {
  const prompt = buildDecisionPrompt('随便什么规则');
  assert.match(prompt, /"apply"/, '必须给出 JSON 字段名,否则模型会自由发挥');
  assert.match(prompt, /不放行/, '规则没涵盖的情况要明确要求守口,而不是让模型自行放行');
  assert.match(prompt, /60 字以内/);
});

test('AI 裁决返回布尔 apply 时正常通过', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: '{"apply":true,"reason":"薪资达标"}' }] }),
  });

  const result = await decideByPrompt({ jobName: 'x' }, PROFILE, '规则', { fetchImpl: fakeFetch });
  assert.equal(result.fallback, false);
  assert.equal(result.apply, true);
  assert.equal(result.reason, '薪资达标');
});

test('AI 裁决为「不投」是正常结论,不是 fallback', async () => {
  // 区别于「判不了」:脚本据此记 verdict=false(判定不投)而不是 null(没有结论),
  // 两者在大屏上是不同的行,混掉会让 AI 抖动看起来像真的筛掉了岗位。
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: '{"apply":false,"reason":"城市不符"}' }] }),
  });

  const result = await decideByPrompt({ jobName: 'x' }, PROFILE, '规则', { fetchImpl: fakeFetch });
  assert.equal(result.fallback, false);
  assert.equal(result.apply, false);
  assert.equal(result.reason, '城市不符');
});

test('apply 不是布尔值时判为 fallback 而不是放行', async () => {
  let calls = 0;
  const bogusFetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"apply":"yes","reason":"x"}' }] }) };
  };

  const result = await decideByPrompt({ jobName: 'x' }, PROFILE, '规则', { fetchImpl: bogusFetch });
  assert.equal(result.fallback, true);
  assert.equal(result.apply, false, '拿不到结论时必须是「不投」,不能默认放行成海投');
  assert.match(result.error, /布尔值/);
  assert.equal(calls, 2, '应当重试一次');
});

test('LLM 返回非法 JSON 时走兜底', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: '我不知道' }] }),
  });

  const result = await decideByPrompt({ jobName: 'x' }, PROFILE, '规则', { fetchImpl: fakeFetch });
  assert.equal(result.fallback, true);
  assert.match(result.error, /未找到 JSON/);
});

test('判定失败时带上错误原因', async () => {
  const fakeFetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  const result = await decideByPrompt({ jobName: 'x' }, PROFILE, '规则', { fetchImpl: fakeFetch });
  assert.equal(result.fallback, true);
  assert.match(result.error, /502/);
});

test('总预算封顶:两次尝试的合计耗时不得突破 budgetMs', async () => {
  // 抓的是「单次超时 × 重试次数」这种设计 —— 那样最坏耗时翻倍,会突破服务端 30 秒预算和
  // 脚本侧超时。mock 必须响应 abort,与真实 fetch 一致,否则 abort 不生效测试会挂死。
  const hangingFetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });

  const startedAt = Date.now();
  const result = await decideByPrompt({ jobName: 'x' }, PROFILE, '规则', {
    fetchImpl: hangingFetch,
    budgetMs: 700,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.fallback, true);
  assert.ok(elapsed <= 1100, `总耗时 ${elapsed}ms 应受 700ms 预算约束`);
});

test('空响应触发重试,且重试放大 max_tokens', async () => {
  // 覆盖推理 token 吃光预算这条分支(实测的真实失败形态:HTTP 200 + 合法结构 + 空 content),
  // 以及发出的请求体本身 —— max_tokens 是承重参数,不该没人守着。
  const seenMaxTokens = [];
  const emptyThenOk = async (url, init) => {
    const body = JSON.parse(init.body);
    seenMaxTokens.push(body.max_tokens);
    if (seenMaxTokens.length === 1) {
      return { ok: true, json: async () => ({ content: [] }) };
    }
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '{"apply":true,"reason":"ok"}' }] }),
    };
  };

  const result = await decideByPrompt({ jobName: 'x' }, PROFILE, '规则', { fetchImpl: emptyThenOk });

  assert.equal(result.fallback, false);
  assert.equal(seenMaxTokens.length, 2, '空响应应当触发重试');
  assert.ok(
    seenMaxTokens[1] > seenMaxTokens[0],
    `重试应放大 max_tokens,实际 ${seenMaxTokens[0]} -> ${seenMaxTokens[1]}`,
  );
});

// ---- 招呼样式：一段给模型的要求，不逐字发出 ----

test('招呼语 system prompt 限定长度,并禁止编造经历', () => {
  const prompt = buildGreetingSystemPrompt();
  // 载重内容仍在:少了长度它会放飞成客套模板腔;少了「不许编造」那句,
  // 它会拿简历里根本没有的经历凑句子。
  assert.match(prompt, /60 字以内/);
  assert.match(prompt, /编造简历里没有的经历/);
});

test('招呼语 system prompt:读者是 HR,不是工程师', () => {
  const prompt = buildGreetingSystemPrompt();
  // 这段 prompt 的核心是「写给谁看」。早先那条「点名公司名 + 对上的技术点」的要求
  // 产出过「飞之辰实习做过采购寻源平台后端,用 CompletableFuture 做详情接口异步化」——
  // 中小公司的名字 HR 没听过,技术名词他也不关心,一整句读完什么都没记住。
  assert.match(prompt, /不是工程师/, '必须点明读者不懂技术');
  assert.match(prompt, /技术名词/, '要明确禁止堆技术名词');
  assert.match(prompt, /中小公司/, '要禁止点名 HR 大概率没听过的公司');
  assert.match(prompt, /方向/, '要给出该写到什么粒度');
});

test('招呼语 system prompt:简历是唯一事实来源,不许按 JD 认领经历', () => {
  const prompt = buildGreetingSystemPrompt();
  // 这条是硬约束,松不得:JD 只用来挑重点,不是用来编造的依据。
  // 松掉它,JD 里写「熟悉 Kubernetes」而简历里没有时,模型会替候选人认领。
  assert.match(prompt, /简历是唯一的事实来源/);
  assert.match(prompt, /宁可不提/, 'JD 要而简历没有的东西要略过,不许认领');
  // 也不能走到另一个极端:写成「你好,我对贵司岗位很感兴趣」那种谁都能发的空话。
  assert.match(prompt, /确实做过/);
});

test('招呼样式进 system,且被标成用户的额外要求', () => {
  const style = '语气自信但别太推销,不要用感叹号,别提薪资。';
  const prompt = buildGreetingSystemPrompt({ stylePrompt: style });

  assert.match(prompt, /用户对打招呼样式的要求/);
  assert.ok(prompt.includes(style), '用户写的要求要原样带上,不能被改写');
  // 硬性约束不能被样式要求顶掉 —— 用户就算写「写长一点」也不该真的写 500 字。
  assert.match(prompt, /60 字以内/);
  assert.match(prompt, /编造简历里没有的经历/);
});

test('样式为空时不留下一个空的要求段落', () => {
  for (const value of ['', '   ', undefined, null, 123]) {
    const prompt = buildGreetingSystemPrompt({ stylePrompt: value });
    assert.doesNotMatch(prompt, /用户对打招呼样式的要求/, `空值 ${JSON.stringify(value)} 不该加一段空要求`);
  }
});

test('样式只挂在 system 上,不混进岗位/简历那一段', () => {
  const style = '不要用感叹号。';
  const prompt = buildGreetingPrompt(
    { name: '张三', sections: {} },
    { jobName: '后端', company: '某公司' },
    { stylePrompt: style },
  );
  assert.ok(prompt.system.includes(style));
  assert.doesNotMatch(prompt.user, /感叹号/, '样式要求不该出现在简历/岗位那一段');
});

// ---- 简历事实清单 ----

// 两种简历格式把「学历/角色/时间」放在不同字段里:
//   .txt 的「单位 | 时间 | 备注」→ 角色在 position;
//   .typ 宏格式 → 角色在 mid、时间在 rule。
// 下面两份 fixture 只有字段摆放不同,内容一一对应。
const TXT_STYLE_PROFILE = {
  name: '钟骋',
  sections: {
    education: [{ title: '中国海洋大学（985）', time: '2024.09 -- 2027.06', position: '硕士 · 计算机技术', descs: [] }],
    experience: [{
      title: '海信（Hisense）',
      time: '2026.06 -- 2026.09',
      position: '测试开发实习生',
      descs: [{ label: '上位机客户端开发', content: '独立完成 Qt 上位机客户端开发。' }],
    }],
    projects: [{ title: '分布式卡牌对战系统', time: '2025.06 -- 2026.03', position: '全栈独立开发', descs: [] }],
    skills: [{ label: 'C/C++ 开发' }],
  },
};

const TYP_STYLE_PROFILE = {
  name: '钟骋',
  sections: {
    education: [{
      title: '中国海洋大学（985）',
      time: '硕士 | 计算机技术',
      rule: '2024.09 -- 2027.06',
      position: 'CCF-CCSP国铜、蓝桥杯国二',
      descs: [],
    }],
    experience: [{
      title: '海信（Hisense）',
      time: '2026.06 -- 2026.09',
      mid: '测试开发实习生',
      position: '从0到1开发产品安全自动化测试软件',
      descs: [],
    }],
    projects: [{ title: '分布式卡牌对战系统', time: '2025.06 -- 2026.03', mid: '全栈独立开发', descs: [] }],
    skills: [{ label: 'C/C++ 开发' }],
  },
};

test('简历事实清单带上实习与项目 —— 那才是能点名匹配的素材', () => {
  // 这条守的是这次改动的根本:以前只传姓名+学校+技能标签,
  // 「海信实习」「项目」全都没进提示词,模型无从知道,只能写「我很感兴趣」。
  for (const profile of [TXT_STYLE_PROFILE, TYP_STYLE_PROFILE]) {
    const facts = buildResumeFacts(profile);
    assert.match(facts, /海信/, '实习公司必须进提示词');
    assert.match(facts, /测试开发实习生/, '实习角色必须进提示词');
    assert.match(facts, /分布式卡牌对战系统/, '项目必须进提示词');
    assert.match(facts, /中国海洋大学/, '学校必须进提示词');
    assert.match(facts, /C\/C\+\+ 开发/, '技能标签仍在');
  }
});

test('两种简历格式的字段摆放不同，事实清单都得取全', () => {
  // .txt 把角色放在 position,.typ 把它放在 mid —— 按固定槽位取必然漏一种,
  // 而漏掉的正好是「实习岗位是什么」这种最该让模型看见的信息。
  assert.match(buildResumeFacts(TXT_STYLE_PROFILE), /测试开发实习生/);
  assert.match(buildResumeFacts(TYP_STYLE_PROFILE), /测试开发实习生/);
  // .typ 把获奖塞在 position、.txt 把学历塞在 position,两者都不能丢。
  assert.match(buildResumeFacts(TYP_STYLE_PROFILE), /蓝桥杯国二/);
  assert.match(buildResumeFacts(TXT_STYLE_PROFILE), /硕士/);
});

test('简历事实清单有长度上限,不会把整份简历塞进提示词', () => {
  // 提示词预算受 12 秒招呼语超时约束,塞爆它换来的只有「老是匹配不上」。
  const huge = {
    name: 'x'.repeat(500),
    sections: {
      experience: Array.from({ length: 10 }, (_, i) => ({
        title: `公司${i}`,
        position: 'y'.repeat(2000),
        descs: [{ label: 'l', content: 'z'.repeat(2000) }],
      })),
      projects: Array.from({ length: 10 }, (_, i) => ({ title: `项目${i}`, position: 'p'.repeat(2000), descs: [] })),
      skills: Array.from({ length: 50 }, (_, i) => ({ label: `技能${i}` })),
      education: [],
    },
  };

  const facts = buildResumeFacts(huge);
  assert.ok(facts.length < 1200, `事实清单应被截断,实际 ${facts.length} 字`);
  assert.doesNotMatch(facts, /公司2/, '实习只取前 2 条');
  assert.doesNotMatch(facts, /项目2/, '项目只取前 2 条');
  // 截断处要有省略号,让人看得出是被砍过的。
  assert.match(facts, /…/);
});

test('简历事实清单对空/残缺输入不抛', () => {
  assert.match(buildResumeFacts(undefined), /姓名:未知/);
  assert.match(buildResumeFacts({}), /姓名:未知/);
  assert.match(buildResumeFacts({ name: '张三' }), /姓名:张三/);
  // descs 里混进非对象项不该炸。
  assert.doesNotThrow(() => buildResumeFacts({ name: 'a', sections: { experience: [{ title: 't', descs: [null, 'x'] }] } }));
});

test('招呼语提示词同时带上简历事实、岗位名、公司与 JD', () => {
  const prompt = buildGreetingPrompt(TXT_STYLE_PROFILE, {
    jobName: '上位机开发工程师',
    company: '某自动化公司',
    postDescription: '负责 Qt 上位机客户端与下位机串口通讯开发',
  });

  assert.match(prompt.user, /海信/);
  assert.match(prompt.user, /上位机开发工程师/);
  assert.match(prompt.user, /某自动化公司/);
  assert.match(prompt.user, /串口通讯/);
  assert.ok(prompt.system.trim(), 'system 不能为空 —— callChatApi 会原样发出去');
});

test('JD 缺失时提示词如实说明，而不是留个空标签让模型瞎猜', () => {
  const prompt = buildGreetingPrompt(TXT_STYLE_PROFILE, { jobName: '某岗位', company: '某公司' });
  assert.doesNotMatch(prompt.user, /JD:\s*$/, '不该留一个空的 JD 标签');
  assert.match(prompt.user, /没返回岗位描述/);
});

test('模板兜底招呼语包含姓名、学校与岗位名', () => {
  const text = buildTemplateGreeting(PROFILE, { jobName: 'Qt开发工程师' });
  assert.match(text, /张三/);
  assert.match(text, /示例大学/);
  assert.match(text, /Qt开发工程师/);
});

// ---- AI 接入配置（端点 / 密钥 / 模型由调用方注入） ----

function okResponse(text) {
  return { ok: true, json: async () => ({ content: [{ type: 'text', text }] }) };
}

test('callChatApi 用传入的端点、密钥与模型', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return okResponse('你好');
  };

  const text = await callChatApi({
    endpoint: 'https://relay.example/v1/messages',
    key: 'sk-user-key',
    model: 'my-model',
    system: 'S',
    user: 'U',
    maxTokens: 16,
    fetchImpl: fakeFetch,
  });

  assert.equal(text, '你好');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://relay.example/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-user-key');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'my-model');
  assert.equal(body.max_tokens, 16, 'maxTokens 要透传到请求体,否则重试放大预算会失效');
  assert.equal(body.system, 'S');
});

test('callChatApi 把多段 text 拼起来，忽略非 text 的段落', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: '前半' }, { type: '其他', text: '忽略' }, { type: 'text', text: '后半' }] }),
  });

  const text = await callChatApi({ endpoint: 'https://x/v1/messages', key: 'k', model: 'm', system: 's', user: 'u', fetchImpl: fakeFetch });
  assert.equal(text, '前半后半');
});

test('callChatApi 缺密钥时抛错，且一个请求都不发', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return okResponse('不该走到这里');
  };

  await assert.rejects(
    () => callChatApi({ endpoint: 'https://x/v1/messages', key: '', model: 'm', system: 's', user: 'u', fetchImpl: fakeFetch }),
    /API Key/,
  );
  assert.equal(calls, 0, '空密钥必须在发请求之前就被拦住 —— 否则会拿空 key 打远端');
});

test('callChatApi 把 HTTP 200 + 空 content 判为失败', async () => {
  // 这是真实踩过的坑:推理 token 吃光预算时端点返回 200、结构合法、内容为空,
  // 极易被当成成功。
  const fakeFetch = async () => ({ ok: true, json: async () => ({ content: [] }) });

  await assert.rejects(
    () => callChatApi({ endpoint: 'https://x/v1/messages', key: 'k', model: 'm', system: 's', user: 'u', fetchImpl: fakeFetch }),
    /内容为空/,
  );
});

// ---- OpenAI chat/completions 格式（按端点 URL 自动识别，不额外配置） ----

function okChatResponse(content) {
  return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) };
}

test('detectApiFormat 按端点路径判定格式', () => {
  // 中转照抄上游路径,所以路径是最可靠的信号。
  assert.equal(detectApiFormat('https://api.commandcode.ai/provider/v1/chat/completions'), 'openai');
  assert.equal(detectApiFormat('https://x/v1/chat/completions/'), 'openai', '尾部斜杠不该影响判定');
  assert.equal(detectApiFormat('https://x/openai/deployments/gpt/chat/completions?api-version=1'), 'openai',
    'Azure 那种长路径与 query 都不该影响判定');

  assert.equal(detectApiFormat('https://api.anthropic.com/v1/messages'), 'anthropic');
  assert.equal(detectApiFormat('http://127.0.0.1:15721/v1/messages'), 'anthropic');

  // 认不出来时退回 anthropic:那是加第二种格式之前唯一支持的那种。
  assert.equal(detectApiFormat('https://relay.example/llm'), 'anthropic');
  assert.equal(detectApiFormat(''), 'anthropic');
  assert.equal(detectApiFormat(undefined), 'anthropic', '坏端点不该在这里抛,让它跑到 fetch 那步失败');
  assert.equal(detectApiFormat('https://x/v1/responses'), 'anthropic',
    'Responses API 是第三种形状,刻意不认 —— 认成 chat/completions 只会错得更隐蔽');
});

test('callChatApi 对 chat/completions 端点改用 OpenAI 的请求形状', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return okChatResponse('你好');
  };

  const text = await callChatApi({
    endpoint: 'https://api.commandcode.ai/provider/v1/chat/completions',
    key: 'sk-cc-key',
    model: 'deepseek/deepseek-v4.1-flash-fast',
    system: 'S',
    user: 'U',
    maxTokens: 16,
    fetchImpl: fakeFetch,
  });

  assert.equal(text, '你好');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.commandcode.ai/provider/v1/chat/completions');
  // 密钥只进请求头,绝不能拼进 URL —— 那会把它留进各层日志与代理记录。
  assert.equal(calls[0].url.includes('sk-cc-key'), false);
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-cc-key');
  assert.equal(calls[0].init.headers['x-api-key'], undefined, 'OpenAI 格式不该再发 Anthropic 的鉴权头');
  assert.equal(calls[0].init.headers['anthropic-version'], undefined);

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'deepseek/deepseek-v4.1-flash-fast');
  assert.equal(body.max_tokens, 16, 'maxTokens 要透传,否则重试放大预算会失效');
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' },
  ], 'OpenAI 格式把 system 放进 messages,而不是顶层字段');
});

test('callChatApi 读 choices[0].message.content,也兼容分段数组', async () => {
  const stringContent = async () => okChatResponse('{"apply":true,"reason":"ok"}');
  assert.equal(
    await callChatApi({ endpoint: 'https://x/v1/chat/completions', key: 'k', model: 'm', system: 's', user: 'u', fetchImpl: stringContent }),
    '{"apply":true,"reason":"ok"}',
  );

  // 少数网关把 content 发成分段数组(与 Anthropic 的分段同形)。
  const partsContent = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: [{ type: 'text', text: '前半' }, { type: 'text', text: '后半' }] } }] }),
  });
  assert.equal(
    await callChatApi({ endpoint: 'https://x/v1/chat/completions', key: 'k', model: 'm', system: 's', user: 'u', fetchImpl: partsContent }),
    '前半后半',
  );
});

test('callChatApi 把 OpenAI 格式的空 content 判为失败,且不拿 reasoning_content 顶替', async () => {
  // 推理模型吃光预算时,content 为空而 reasoning_content 有内容 —— 思维链不是要的
  // 结论,拿它顶替等于让判定读一段自言自语。这条必须继续抛错,好让 decideByPrompt
  // 放大预算重试。
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '', reasoning_content: '让我想想……' }, finish_reason: 'length' }] }),
  });

  await assert.rejects(
    () => callChatApi({ endpoint: 'https://x/v1/chat/completions', key: 'k', model: 'm', system: 's', user: 'u', fetchImpl: fakeFetch }),
    /内容为空/,
  );

  // 连 choices 都没有(网关出错时回个空壳)也算失败,不能当成「模型说没事」。
  const noChoices = async () => ({ ok: true, json: async () => ({ error: { message: 'rate limited' } }) });
  await assert.rejects(
    () => callChatApi({ endpoint: 'https://x/v1/chat/completions', key: 'k', model: 'm', system: 's', user: 'u', fetchImpl: noChoices }),
    /内容为空/,
  );
});

test('OpenAI 端点下空响应同样触发重试并放大 max_tokens', async () => {
  // 判定链路上的重试与格式无关,但它在两种格式下都得成立。
  const seenMaxTokens = [];
  let call = 0;
  const fakeFetch = async (url, init) => {
    call += 1;
    seenMaxTokens.push(JSON.parse(init.body).max_tokens);
    if (call === 1) return { ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) };
    return okChatResponse('{"apply":true,"reason":"ok"}');
  };

  const result = await decideByPrompt({ jobName: 'x' }, PROFILE, '规则', {
    fetchImpl: fakeFetch,
    ai: { endpoint: 'https://x/v1/chat/completions', key: 'k', model: 'm' },
  });

  assert.equal(result.fallback, false);
  assert.equal(result.apply, true);
  assert.equal(seenMaxTokens.length, 2, '首轮空响应应当重试');
  assert.ok(seenMaxTokens[1] > seenMaxTokens[0], `重试应放大 max_tokens,实际 ${seenMaxTokens[0]} -> ${seenMaxTokens[1]}`);
});

test('上游报错时把「按哪种格式请求的」写进错误里', async () => {
  // 端点填错格式时用户只看到这一句话,所以它必须能指出用的是哪种格式。
  const fakeFetch = async () => ({ ok: false, status: 400 });
  await assert.rejects(
    () => callChatApi({ endpoint: 'https://x/v1/chat/completions', key: 'k', model: 'm', system: 's', user: 'u', fetchImpl: fakeFetch }),
    /HTTP 400.*OpenAI chat\/completions/,
  );
  await assert.rejects(
    () => callChatApi({ endpoint: 'https://x/v1/messages', key: 'k', model: 'm', system: 's', user: 'u', fetchImpl: fakeFetch }),
    /HTTP 400.*Anthropic Messages/,
  );

  // 网关出错时回一页 HTML 是常事,裸的 SyntaxError 对用户毫无信息量。
  const htmlBody = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  await assert.rejects(
    () => callChatApi({ endpoint: 'https://x/v1/chat/completions', key: 'k', model: 'm', system: 's', user: 'u', fetchImpl: htmlBody }),
    /不是 JSON/,
  );
});

test('decideByPrompt 不传 ai 时沿用旧默认端点（向后兼容）', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return okResponse('{"apply":true,"reason":"ok"}');
  };

  await decideByPrompt({ jobName: 'x' }, PROFILE, '规则', { fetchImpl: fakeFetch });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:15721/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], 'PROXY_MANAGED');
});

test('decideByPrompt 显式传入 ai 时完全以传入为准', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return okResponse('{"apply":false,"reason":"不投"}');
  };

  const result = await decideByPrompt({ jobName: 'x' }, PROFILE, '规则', {
    fetchImpl: fakeFetch,
    ai: { endpoint: 'https://api.anthropic.com/v1/messages', key: 'sk-ant-user', model: 'claude-sonnet-5' },
  });

  assert.equal(result.fallback, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-ant-user');
  assert.equal(JSON.parse(calls[0].init.body).model, 'claude-sonnet-5');
});

test('decideByPrompt 显式传空密钥时直接 fallback，绝不回落到旧默认密钥', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return okResponse('{"apply":true,"reason":"不该放行"}');
  };

  const result = await decideByPrompt({ jobName: 'x' }, PROFILE, '规则', {
    fetchImpl: fakeFetch,
    ai: { endpoint: 'https://api.anthropic.com/v1/messages', key: '', model: 'claude-haiku-4-5' },
  });

  assert.equal(calls, 0, '空密钥必须一路走到守卫里变成 fallback，而不是换回 LEGACY_KEY 发出去');
  assert.equal(result.fallback, true);
  assert.equal(result.apply, false, 'fail-closed：拿不到结论一律不放行');
  assert.match(result.error, /API Key/);
});

test('探测 prompt 同时给出 system 与 user，供「测试连通」使用', () => {
  const probe = buildProbePrompt();
  assert.ok(probe.system.trim(), 'system 不能为空 —— callChatApi 会原样发出去');
  assert.ok(probe.user.trim());
  // 探测只要一个字的回答:内容越短,该花的预算越少,测试越快。
  assert.ok(probe.user.length < 20, '探测 prompt 不该啰嗦');
});
