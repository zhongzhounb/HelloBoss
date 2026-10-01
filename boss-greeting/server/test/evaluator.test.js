import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractJson,
  buildUserPrompt,
  buildDecisionPrompt,
  callMessagesApi,
  decideByPrompt,
  pickSample,
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

// ---- 招呼样例 ----

test('pickSample 覆盖整个数组且不越界', () => {
  const samples = ['a', 'b', 'c'];
  assert.equal(pickSample(samples, () => 0), 'a');
  assert.equal(pickSample(samples, () => 0.5), 'b');
  assert.equal(pickSample(samples, () => 0.99), 'c');
  // 注入的桩可能返回 1(真实 Math.random 不会),必须夹住而不是给出 undefined
  assert.equal(pickSample(samples, () => 1), 'c');
});

test('pickSample 对空数组与非法输入返回空串', () => {
  assert.equal(pickSample([], () => 0), '');
  assert.equal(pickSample(undefined), '');
  assert.equal(pickSample('不是数组'), '');
});

test('招呼语 system prompt 限定长度,并禁止编造经历', () => {
  const prompt = buildGreetingSystemPrompt();
  // 载重内容仍在:少了长度那句,模型会放飞成客套模板腔;
  // 少了「不要编造」那句,它会拿简历里根本没有的经历凑句子。
  assert.match(prompt, /60 字以内/);
  assert.match(prompt, /不要编造简历里没有的经历/);
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

test('callMessagesApi 用传入的端点、密钥与模型', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return okResponse('你好');
  };

  const text = await callMessagesApi({
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

test('callMessagesApi 把多段 text 拼起来，忽略非 text 的段落', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: '前半' }, { type: '其他', text: '忽略' }, { type: 'text', text: '后半' }] }),
  });

  const text = await callMessagesApi({ endpoint: 'https://x/v1/messages', key: 'k', model: 'm', system: 's', user: 'u', fetchImpl: fakeFetch });
  assert.equal(text, '前半后半');
});

test('callMessagesApi 缺密钥时抛错，且一个请求都不发', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return okResponse('不该走到这里');
  };

  await assert.rejects(
    () => callMessagesApi({ endpoint: 'https://x/v1/messages', key: '', model: 'm', system: 's', user: 'u', fetchImpl: fakeFetch }),
    /API Key/,
  );
  assert.equal(calls, 0, '空密钥必须在发请求之前就被拦住 —— 否则会拿空 key 打远端');
});

test('callMessagesApi 把 HTTP 200 + 空 content 判为失败', async () => {
  // 这是真实踩过的坑:推理 token 吃光预算时端点返回 200、结构合法、内容为空,
  // 极易被当成成功。
  const fakeFetch = async () => ({ ok: true, json: async () => ({ content: [] }) });

  await assert.rejects(
    () => callMessagesApi({ endpoint: 'https://x/v1/messages', key: 'k', model: 'm', system: 's', user: 'u', fetchImpl: fakeFetch }),
    /内容为空/,
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
  assert.ok(probe.system.trim(), 'system 不能为空 —— callMessagesApi 会原样发出去');
  assert.ok(probe.user.trim());
  // 探测只要一个字的回答:内容越短,该花的预算越少,测试越快。
  assert.ok(probe.user.length < 20, '探测 prompt 不该啰嗦');
});
