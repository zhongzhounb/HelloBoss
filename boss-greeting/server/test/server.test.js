import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, evaluateJob, isLoopbackAddress, isRequestAuthorized, loadServerConfig, isCrossOriginWrite } from '../src/server.js';
import { createIdleExit } from '../src/idleExit.js';
import { createSettingsStore } from '../src/settings.js';

const JOB_OK = {
  signature: 'sig-ok',
  jobName: '嵌入式软件工程师',
  company: '海尔智家',
  companyScale: '10000人以上',
  companyIndustry: '智能硬件',
  city: '青岛',
  salary: '18-25K',
  postDescription: '负责智能家电固件开发,熟悉串口通讯与 MQTT 协议',
};

// 桩:把判定与生成都换掉,只测 server 自己的编排逻辑。
//
// 默认给一份**已配置**的规则。空规则是「一个岗位都不投」的安全默认(有专门的用例守着),
// 而其余用例关心的是「有了规则之后」的编排,不该被它挡住。
function makeDeps(over = {}) {
  return {
    // 健康检查读 deps.profiles.length,所以桩里必须是个真数组,不能省。
    profiles: Array.from({ length: 5 }, (_, i) => ({ variant: `v${i}` })),
    keywords: { priority: ['cpp', 'cpp_rag', 'iot', 'java', 'pdd'] },
    profileOf: () => ({ variant: 'iot', name: '张三', sections: { education: [{ title: '示例大学' }], skills: [{ label: '嵌入式', content: 'x' }] } }),
    selectVariant: () => ({ variant: 'iot', score: 9, evidence: ['MQTT(+5)'] }),
    settings: (() => {
      const store = makeStore();
      store.save({ decisionPrompt: '测试规则:只投青岛的岗位' });
      return store;
    })(),
    decideByPrompt: async () => ({ apply: true, reason: '规则命中', fallback: false }),
    // 默认没配招呼样式 —— 走 AI 生成那条路。配了样式的分支有专门的用例守着。
    pickGreetingSample: () => '',
    buildGreeting: async () => '您好,我是张三,来自示例大学。',
    ...over,
  };
}

// 每个测试都用独立的临时 ledger 文件。
// createServer 的 ledgerFile 默认指向仓库里的 data/jobs.jsonl —— 测试若不显式传,
// 会把假数据写进真实记录文件,而且测试之间互相污染。
function makeServer(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
  return createServer(
    Object.assign({ deps: makeDeps(), ledgerFile: path.join(dir, 'jobs.jsonl') }, overrides),
  );
}

// 独立的临时设置文件。与 ledger 同理:不显式注入的话会写到真实的 data/settings.json。
function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-settings-'));
  return createSettingsStore(path.join(dir, 'settings.json'));
}

test('健康检查返回服务状态', async () => {
  const server = makeServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.profiles, 5);

  server.close();
});

test('/evaluate 通过时返回 apply 与招呼语', async () => {
  const result = await evaluateJob(JOB_OK, makeDeps());
  assert.equal(result.apply, true);
  assert.match(result.greeting, /张三/);
  assert.equal(result.meta.variant, 'iot');
  assert.equal(result.meta.fallback, false);
  assert.equal(result.meta.cacheHit, false);
});

test('城市不通过时不调用生成,apply 为 false', async () => {
  let greetingCalls = 0;
  const deps = makeDeps({
    decideByPrompt: async () => ({ apply: false, reason: '成都不在可投城市', fallback: false }),
    buildGreeting: async () => { greetingCalls += 1; return 'x'; },
  });
  const result = await evaluateJob({ ...JOB_OK, city: '成都' }, deps);

  assert.equal(result.apply, false);
  assert.equal(greetingCalls, 0, '判不投时不应浪费一次生成调用');
  assert.match(result.reason, /成都/);
});

test('AI 判定不可用时跳过该岗位,不投递', async () => {
  // fail-closed:本工具的价值是精选。AI 挂了却照常投,等于对所有岗位海投,违背初衷。
  const deps = makeDeps({
    decideByPrompt: async () => ({ apply: false, reason: '', fallback: true, error: 'ECONNREFUSED' }),
  });

  const result = await evaluateJob(JOB_OK, deps);
  assert.equal(result.apply, false);
  assert.equal(result.meta.fallback, true);
  assert.equal(result.greeting, '', '跳过时不该生成招呼语');
  assert.match(result.reason, /AI 判定不可用/);
});

test('判定不通过时也不生成招呼语', async () => {
  let greetingCalls = 0;
  const deps = makeDeps({
    decideByPrompt: async () => ({ apply: false, reason: '规则判定不投', fallback: false }),
    buildGreeting: async () => {
      greetingCalls += 1;
      return 'x';
    },
  });

  const result = await evaluateJob({ ...JOB_OK, city: '成都' }, deps);
  assert.equal(result.apply, false);
  assert.equal(greetingCalls, 0);
});

test('生成招呼语抛异常时退回模板,判定通过仍投递', async () => {
  // 与判定失败不同:岗位本身合适,不该因为一句措辞丢掉。
  const deps = makeDeps({
    buildGreeting: async () => {
      throw new Error('生成接口返回 HTTP 500');
    },
  });

  const result = await evaluateJob(JOB_OK, deps);
  assert.equal(result.apply, true);
  assert.equal(result.meta.greetingFallback, true);
  assert.equal(result.meta.fallback, false);
  assert.match(result.greeting, /张三/);
});

test('生成返回空串时退回模板,判定通过仍投递', async () => {
  const deps = makeDeps({ buildGreeting: async () => '' });

  const result = await evaluateJob(JOB_OK, deps);
  assert.equal(result.apply, true);
  assert.equal(result.meta.greetingFallback, true);
  assert.match(result.greeting, /张三/);
});

test('配了招呼样式时原样发出那一条,不再调生成', async () => {
  // 样例是用户自己写、自己认的内容 —— 直发出去,杜绝模型拿简历自由发挥
  // (示例简历那回就发出过「我是示例大学张三」)。
  let greetingCalls = 0;
  const deps = makeDeps({
    pickGreetingSample: () => '985硕,大厂实习,很划算的!',
    buildGreeting: async () => { greetingCalls += 1; return 'AI 生成的句子'; },
  });

  const result = await evaluateJob(JOB_OK, deps);
  assert.equal(result.apply, true);
  assert.equal(result.greeting, '985硕,大厂实习,很划算的!', '样例应原样发出,不被改写');
  assert.equal(greetingCalls, 0, '样例直发时不该再调一次生成');
  assert.equal(result.meta.greetingFallback, false, '样例直发不是兜底');
});

test('没配招呼样式时仍走生成', async () => {
  const deps = makeDeps({ pickGreetingSample: () => '' });

  const result = await evaluateJob(JOB_OK, deps);
  assert.match(result.greeting, /张三/, '空样例不该把招呼语变成空串');
  assert.equal(result.meta.greetingFallback, false);
});

test('相同 signature 第二次命中缓存,不再调 LLM', async () => {
  let llmCalls = 0;
  const deps = makeDeps({
    decideByPrompt: async () => {
      llmCalls += 1;
      return { apply: true, reason: '规则命中', fallback: false };
    },
  });

  const server = makeServer({ deps });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/evaluate`;

  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job: JOB_OK }) });
  const second = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job: JOB_OK }) });
  const body = await second.json();

  assert.equal(llmCalls, 1);
  assert.equal(body.meta.cacheHit, true);

  server.close();
});

test('判定不可用的结果不进缓存,端点恢复后能重新判定', async () => {
  // 回归测试:若把 fallback 结果也缓存,一次短暂抖动会把该岗位在本进程内永久钉成
  // "跳过" —— 脚本重跑也救不回来,只能重启服务。这会让 fail-closed 从"暂时跳过"
  // 退化成"永久拉黑",正是它想避免的。
  let llmCalls = 0;
  let endpointDown = true;
  const deps = makeDeps({
    decideByPrompt: async () => {
      llmCalls += 1;
      if (endpointDown) {
        return { apply: false, reason: '', fallback: true, error: 'ECONNREFUSED' };
      }
      return { apply: true, reason: '规则命中', fallback: false };
    },
  });

  const server = makeServer({ deps });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/evaluate`;
  const post = () => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ job: JOB_OK }),
  });

  const first = await (await post()).json();
  assert.equal(first.apply, false);
  assert.equal(first.meta.fallback, true);

  endpointDown = false;
  const second = await (await post()).json();
  assert.equal(second.meta.cacheHit, false, '判定不可用的结果不该命中缓存');
  assert.equal(second.apply, true, '端点恢复后应重新判定并正常投递');
  assert.equal(llmCalls, 2, '第二次必须真的重新调用,而不是读缓存');

  server.close();
});

test('同名同薪但城市不同的岗位不共用缓存', async () => {
  // 回归测试:脚本传来的 signature 不含城市。若直接拿它当缓存键,
  // 北京的判定结果会被用到成都的岗位上 —— 而成都正是用户排除的城市。
  let llmCalls = 0;
  const deps = makeDeps({
    decideByPrompt: async () => {
      llmCalls += 1;
      return { apply: true, reason: '规则命中', fallback: false };
    },
  });

  const server = makeServer({ deps });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/evaluate`;
  const post = (job) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ job }),
  });

  await post({ ...JOB_OK, signature: 'sig-shared', city: '北京' });
  const second = await (await post({ ...JOB_OK, signature: 'sig-shared', city: '成都' })).json();

  assert.equal(second.meta.cacheHit, false, '城市不同的岗位不应命中同一条缓存');
  assert.equal(llmCalls, 2);

  server.close();
});

test('缺少 job 字段时返回 400', async () => {
  const server = makeServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/evaluate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);

  server.close();
});

test('版本选不出来时用 priority 首位兜底', async () => {
  const deps = makeDeps({ selectVariant: () => ({ variant: null, score: 0, evidence: [] }) });
  const result = await evaluateJob(JOB_OK, deps);
  assert.ok(result.meta.variant, '不能因为选版失败就整体失败');
});

test('/report 写入后能被 /api/records 读到', async () => {
  const server = makeServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const post = await fetch(`http://127.0.0.1:${port}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ company: '中科飞测', jobName: '软测', stage: 'sent', verdict: true }),
  });
  assert.equal(post.status, 200);

  const body = await (await fetch(`http://127.0.0.1:${port}/api/records?since=0`)).json();
  assert.equal(body.records.length, 1);
  assert.equal(body.records[0].company, '中科飞测');
  assert.equal(body.records[0].seq, 1);
  assert.ok(body.runId);
  assert.ok(body.stats.current.sent === 1);

  server.close();
});

test('/report 缺 at 时由服务端补一个非空时间戳', async () => {
  // 上报方漏带 at 时若原样落盘,大屏的时间列会是空白 —— 而时间列是排查
  // "这条记录什么时候发生的"的唯一线索,不能为空。
  const server = makeServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  await fetch(`http://127.0.0.1:${port}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ company: '中科飞测', jobName: '软测', stage: 'sent', verdict: true }),
  });

  const body = await (await fetch(`http://127.0.0.1:${port}/api/records?since=0`)).json();
  assert.ok(body.records[0].at, '缺 at 时应补上,不能是空串');
  assert.ok(!Number.isNaN(Date.parse(body.records[0].at)), '补的 at 必须是可解析的时间');

  server.close();
});

test('/report 自带 at 时原样保留', async () => {
  // 与 runId 相反,at 由上报方决定(它才是那一刻的观察者),服务端只做兜底。
  const server = makeServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const at = '2026-09-25T03:04:05.000Z';
  await fetch(`http://127.0.0.1:${port}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ company: 'A', at }),
  });

  const body = await (await fetch(`http://127.0.0.1:${port}/api/records?since=0`)).json();
  assert.equal(body.records[0].at, at);

  server.close();
});

test('/api/records 的 since 只返回增量', async () => {
  const server = makeServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  const report = (body) => fetch(`${url}/report`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  await report({ company: 'A' });
  await report({ company: 'B' });

  const all = await (await fetch(`${url}/api/records?since=0`)).json();
  assert.equal(all.records.length, 2);

  const delta = await (await fetch(`${url}/api/records?since=1`)).json();
  assert.equal(delta.records.length, 1);
  assert.equal(delta.records[0].company, 'B');

  server.close();
});

test('/api/export.csv 带 UTF-8 BOM 且转义正确', async () => {
  const server = makeServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;

  await fetch(`${url}/report`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ company: 'A, Inc', reason: '他说"你好"' }),
  });

  const res = await fetch(`${url}/api/export.csv`);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  // 必须在字节层面验证 BOM:res.text() 按 fetch 规范会剥掉开头的 BOM,
  // 若用 text() 断言,服务明明发了 BOM 也会判为失败。
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], '应带 UTF-8 BOM，否则 Excel 打开中文乱码');
  // Buffer.toString 保留 BOM 字符,下一行的 startsWith 断言据此成立,转义断言照旧。
  const text = bytes.toString('utf8');

  assert.ok(text.startsWith('\uFEFF'), '应带 UTF-8 BOM，否则 Excel 打开中文乱码');
  assert.match(text, /"A, Inc"/);
  assert.match(text, /"他说""你好""/);

  server.close();
});

test('/dashboard 返回 HTML 页面', async () => {
  const server = makeServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/dashboard`);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<!DOCTYPE html>/i);

  server.close();
});

test('/report 收到非法 JSON 时返回 400', async () => {
  const server = makeServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/report`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{坏的',
  });
  assert.equal(res.status, 400);

  server.close();
});

// ---------- 局域网访问鉴权 ----------
//
// 规则:不配 token 就完全维持老行为;配了 token 则"本机回环免令牌、外来必须带令牌"。
// 因此测试必须能把回环豁免关掉(allowLoopback: false),否则从 127.0.0.1 发起的
// 请求永远走豁免分支,鉴权这段代码一行都测不到。

test('loadServerConfig: 缺文件时不开放局域网、不鉴权', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const config = loadServerConfig(path.join(dir, 'server.json'));
  assert.deepEqual(config, { lan: false, token: '' });
});

test('loadServerConfig: 开了局域网却没令牌时拒绝启动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const file = path.join(dir, 'server.json');
  fs.writeFileSync(file, JSON.stringify({ lan: true, token: '  ' }), 'utf8');
  assert.throws(() => loadServerConfig(file), /没有 token/);
});

test('loadServerConfig: 读得到 lan 与 token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const file = path.join(dir, 'server.json');
  fs.writeFileSync(file, JSON.stringify({ lan: true, token: 'abc123' }), 'utf8');
  assert.deepEqual(loadServerConfig(file), { lan: true, token: 'abc123' });
});

test('isLoopbackAddress 认回环的各种写法', () => {
  for (const address of ['127.0.0.1', '127.5.5.5', '::1', '::ffff:127.0.0.1', 'LOCALHOST']) {
    assert.equal(isLoopbackAddress(address), true, `${address} 应判为回环`);
  }
  for (const address of ['::ffff:192.168.1.7', '192.168.1.7', '8.8.8.8', '', undefined]) {
    assert.equal(isLoopbackAddress(address), false, `${address} 不该判为回环`);
  }
});

test('isRequestAuthorized: 没配令牌时全部放行', () => {
  assert.equal(isRequestAuthorized({ remoteAddress: '8.8.8.8', headers: {}, token: '' }), true);
});

test('isRequestAuthorized: 回环免令牌,外来要令牌', () => {
  const token = 'secret-token';
  assert.equal(isRequestAuthorized({ remoteAddress: '127.0.0.1', headers: {}, token }), true);
  assert.equal(isRequestAuthorized({ remoteAddress: '192.168.1.7', headers: {}, token }), false);
  assert.equal(
    isRequestAuthorized({ remoteAddress: '192.168.1.7', headers: { authorization: `Bearer ${token}` }, token }),
    true,
  );
  assert.equal(
    isRequestAuthorized({ remoteAddress: '192.168.1.7', headers: { authorization: 'Bearer 错的' }, token }),
    false,
  );
  assert.equal(
    isRequestAuthorized({ remoteAddress: '192.168.1.7', headers: { cookie: `big_screen_token=${token}` }, token }),
    true,
  );
});

test('isRequestAuthorized: 关掉回环豁免后本机也要令牌', () => {
  const token = 'secret-token';
  const base = { remoteAddress: '127.0.0.1', headers: {}, token, allowLoopback: false };
  assert.equal(isRequestAuthorized(base), false);
  assert.equal(isRequestAuthorized({ ...base, headers: { authorization: `Bearer ${token}` } }), true);
});

test('鉴权: 未带令牌的读接口与上报接口都返回 401', async () => {
  const server = makeServer({ token: 'secret-token', allowLoopback: false });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  assert.equal((await fetch(`http://127.0.0.1:${port}/api/records`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/dashboard`)).status, 401);
  // 写配置的接口尤其要挡在鉴权之内 —— 它决定了「哪些岗位会被自动投」。
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/settings`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decisionPrompt: '全部投' }),
  })).status, 401);

  const report = await fetch(`http://127.0.0.1:${port}/report`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company: '甲' }),
  });
  assert.equal(report.status, 401);

  const evaluate = await fetch(`http://127.0.0.1:${port}/evaluate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job: JOB_OK }),
  });
  assert.equal(evaluate.status, 401);

  // 未授权的 /report 必须被闸在写库之前 —— 带上令牌再看,记录数应当仍是 0。
  const records = await (await fetch(`http://127.0.0.1:${port}/api/records`, {
    headers: { authorization: 'Bearer secret-token' },
  })).json();
  assert.equal(records.records.length, 0);

  server.close();
});

test('鉴权: 带对令牌的请求照常工作', async () => {
  const server = makeServer({ token: 'secret-token', allowLoopback: false });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/records?since=0`, {
    headers: { authorization: 'Bearer secret-token' },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).seq, 0);

  server.close();
});

test('鉴权: 本机回环不带令牌也能看(默认豁免)', async () => {
  const server = makeServer({ token: 'secret-token' });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  assert.equal((await fetch(`http://127.0.0.1:${port}/api/records`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/dashboard`)).status, 200);

  server.close();
});

test('鉴权: 带令牌访问看板会换 cookie 并跳到干净地址', async () => {
  const server = makeServer({ token: 'secret-token', allowLoopback: false });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const entry = await fetch(`http://127.0.0.1:${port}/dashboard?token=secret-token`, { redirect: 'manual' });
  assert.equal(entry.status, 302);
  assert.equal(entry.headers.get('location'), '/dashboard');
  const cookie = entry.headers.get('set-cookie');
  assert.match(cookie, /big_screen_token=secret-token/);
  assert.match(cookie, /HttpOnly/i);
  // Max-Age 必须是秒数 —— 写成 "30d" 这类非法值浏览器会直接忽略,退化成会话 cookie。
  assert.match(cookie, /Max-Age=2592000/);

  const page = await fetch(`http://127.0.0.1:${port}/dashboard`, {
    headers: { cookie: `big_screen_token=secret-token` },
  });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<!DOCTYPE html>/i);

  server.close();
});

test('鉴权: 令牌不对时看板返回 401 且不下发 cookie', async () => {
  const server = makeServer({ token: 'secret-token', allowLoopback: false });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/dashboard?token=错的`, { redirect: 'manual' });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);

  server.close();
});

// ---- 自定义判定规则(设置页) ----

test('evaluateJob: 没配规则时一个岗位都不投', async () => {
  // 安全默认的守门测试。自动发出去的招呼语收不回来,所以「没有判定依据」必须表现为
  // 不投,而不是退回某个内置规则照常投 —— 开源出去后,别人是照着仓库里的默认状态跑的,
  // 一个"没配就开投"的版本会让他在不知情的情况下按别人的标准投递。
  let called = 0;
  const deps = makeDeps({
    settings: { get: () => ({ decisionPrompt: '   ', greetingSamples: [] }) },
    decideByPrompt: async () => { called += 1; return { apply: true, reason: 'x', fallback: false }; },
  });

  const result = await evaluateJob(JOB_OK, deps);
  assert.equal(result.apply, false);
  assert.equal(result.meta.noRule, true, '要能和「AI 挂了」区分开,否则用户不知道该去配规则还是等端点恢复');
  assert.equal(result.meta.fallback, true, '没结论就不该进缓存,配好规则后同一岗位要能重判');
  assert.equal(result.greeting, '');
  assert.equal(called, 0, '没规则就不该去调 LLM');
  assert.match(result.reason, /尚未配置投递规则/);
});

test('evaluateJob: 没有简历时一个岗位都不投,且不调 LLM、不抛错', async () => {
  // 这条挡的是一个真实的 500:profile 为 undefined 时 buildUserPrompt 会去读
  // profile.sections.skills 而抛错,且那段在 decideByPrompt 的重试 try/catch **之外**,
  // 会一路冒到路由 —— 用户看到的是「服务坏了」,而不是「我还没放简历」。
  let called = 0;
  const deps = makeDeps({
    profiles: [],
    profileOf: () => undefined,
    selectVariant: () => ({ variant: null, score: 0, evidence: [] }),
    // 刻意给一条**非空**规则:证明「有规则但没简历」也照样不放行。
    settings: { get: () => ({ decisionPrompt: '只要青岛就投', greetingSamples: [] }) },
    decideByPrompt: async () => { called += 1; return { apply: true, reason: 'x', fallback: false }; },
  });

  const result = await evaluateJob(JOB_OK, deps);

  assert.equal(result.apply, false);
  assert.equal(result.greeting, '');
  assert.equal(result.meta.noResume, true, '要和「没配规则」「AI 挂了」都区分开');
  assert.equal(result.meta.fallback, true, '没结论就不进缓存 —— 补上简历后同一岗位要能重判');
  assert.equal(called, 0, '没有简历就不该去调 LLM');
  assert.match(result.reason, /尚未加载简历/);
});

test('evaluateJob: 配了规则时把规则原文交给裁决函数', async () => {
  let calledWith = '';
  const deps = makeDeps({
    settings: { get: () => ({ decisionPrompt: '只要青岛就投', greetingSamples: [] }) },
    decideByPrompt: async (job, profile, ruleText) => {
      calledWith = ruleText;
      return { apply: true, reason: '城市命中', fallback: false };
    },
  });

  const result = await evaluateJob(JOB_OK, deps);
  assert.equal(calledWith, '只要青岛就投', '规则原文应一字不差地传给裁决函数');
  assert.equal(result.apply, true);
  assert.equal(result.reason, '城市命中');
});

test('evaluateJob: 规则裁决失败时按「判不了」处理,不是「判定不投」', async () => {
  const deps = makeDeps({
    settings: { get: () => ({ decisionPrompt: '规则', greetingSamples: [] }) },
    decideByPrompt: async () => ({ apply: false, reason: '', fallback: true, error: '端点超时' }),
  });

  const result = await evaluateJob(JOB_OK, deps);
  assert.equal(result.apply, false);
  assert.equal(result.meta.fallback, true);
  assert.match(result.reason, /AI 判定不可用/);
  assert.match(result.reason, /端点超时/);
});

test('GET /api/settings 返回已保存的配置', async () => {
  const store = makeStore();
  store.save({ decisionPrompt: '20k 以上直接投', greetingSamples: ['985硕'] });

  const server = makeServer({ deps: makeDeps({ settings: store }) });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const body = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
  assert.equal(body.decisionPrompt, '20k 以上直接投');
  assert.deepEqual(body.greetingSamples, ['985硕']);

  server.close();
});

test('没注入配置存储时设置接口返回 503 而不是 500', async () => {
  // 显式抹掉 settings —— makeDeps 默认是会给一个真存储的,
  // 这里要的正是「注入方没提供配置存储」的情形。
  const server = makeServer({ deps: makeDeps({ settings: undefined }) });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  assert.equal((await fetch(`http://127.0.0.1:${port}/api/settings`)).status, 503);

  server.close();
});

test('POST /api/settings 保存后能读回', async () => {
  const store = makeStore();
  const server = makeServer({ deps: makeDeps({ settings: store }) });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;

  const res = await fetch(`${url}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decisionPrompt: '规则 A', greetingSamples: ['样例 1', '样例 2'] }),
  });
  assert.equal(res.status, 200);

  const body = await (await fetch(`${url}/api/settings`)).json();
  assert.equal(body.decisionPrompt, '规则 A');
  assert.deepEqual(body.greetingSamples, ['样例 1', '样例 2']);
  // 落盘也要确认 —— 只进内存的话重启就丢了。
  assert.equal(store.get().decisionPrompt, '规则 A');

  server.close();
});

test('POST /api/settings 非法输入返回 400 并带原因', async () => {
  const server = makeServer({ deps: makeDeps({ settings: makeStore() }) });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ greetingSamples: '不是数组' }),
  });
  assert.equal(res.status, 400);
  // 原因要能直接显示给用户看,不能是笼统的「参数错误」。
  assert.match((await res.json()).error, /字符串数组/);

  server.close();
});

test('POST /api/settings 请求体不是 JSON 时返回 400', async () => {
  const server = makeServer({ deps: makeDeps({ settings: makeStore() }) });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{坏的',
  });
  assert.equal(res.status, 400);

  server.close();
});

test('POST /api/settings 拒绝跨站写入', async () => {
  const store = makeStore();
  const server = makeServer({ deps: makeDeps({ settings: store }) });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ decisionPrompt: '全部投' }),
  });
  assert.equal(res.status, 403);
  assert.equal(store.get().decisionPrompt, '', '被拒的写入不能落盘');

  server.close();
});

// ---- AI 接入配置的 HTTP 边界 ----
//
// 这一组守的是「明文密钥不出网」。大屏可以带令牌对局域网开放,响应体里的密钥
// 等于交给同网段的每一台设备。

test('GET /api/settings 不回传明文密钥，只给末四位提示', async () => {
  const store = makeStore();
  store.save({ aiEndpoint: 'https://api.anthropic.com/v1/messages', aiKey: 'sk-ant-secret-abcd' });

  const server = makeServer({ deps: makeDeps({ settings: store }) });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const raw = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).text();
  assert.equal(raw.includes('sk-ant-secret-abcd'), false, '明文密钥绝不能出现在响应体里');

  const body = JSON.parse(raw);
  assert.equal(body.aiKey, '', 'aiKey 必须恒为空串 —— 它同时充当「本次未修改」的哨兵');
  assert.equal(body.hasAiKey, true);
  assert.equal(body.aiKeyHint, '…abcd');
  // 其余字段要照常回填,否则大屏上的输入框是空的。
  assert.equal(body.aiEndpoint, 'https://api.anthropic.com/v1/messages');
  assert.equal(body.aiModel, 'claude-haiku-4-5');

  server.close();
});

test('POST /api/settings 只改判定规则时，已存密钥不被清掉', async () => {
  // 这是脱敏设计的关键回归:大屏的密钥框不回填,用户改完规则提交时
  // 那一栏是空的 —— 若把空 aiKey 当清空,保存规则会顺手废掉密钥。
  const store = makeStore();
  store.save({ aiKey: 'sk-ant-real-key' });

  const server = makeServer({ deps: makeDeps({ settings: store }) });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decisionPrompt: '新规则', aiKey: '' }),
  });
  assert.equal(res.status, 200);
  assert.equal(store.get().aiKey, 'sk-ant-real-key', '改规则不能顺手废掉密钥');
  assert.equal(store.get().decisionPrompt, '新规则');

  server.close();
});

test('POST /api/settings 能用 clearAiKey 显式清除密钥', async () => {
  const store = makeStore();
  store.save({ aiKey: 'sk-ant-real-key' });

  const server = makeServer({ deps: makeDeps({ settings: store }) });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clearAiKey: true }),
  });
  assert.equal(res.status, 200);
  assert.equal(store.get().aiKey, '');

  server.close();
});

test('POST /api/settings 的响应也不回显密钥', async () => {
  const server = makeServer({ deps: makeDeps({ settings: makeStore() }) });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ aiKey: 'sk-ant-just-saved-wxyz' }),
  });

  const raw = await res.text();
  assert.equal(raw.includes('sk-ant-just-saved-wxyz'), false, '保存的响应体里也不能带明文密钥');
  assert.equal(JSON.parse(raw).settings.aiKeyHint, '…wxyz');

  server.close();
});

test('POST /api/settings 拒绝非法端点并给出可读原因', async () => {
  const store = makeStore();
  const server = makeServer({ deps: makeDeps({ settings: store }) });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ aiEndpoint: '这不是地址' }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /合法 URL/);
  assert.equal(store.get().aiEndpoint, 'https://api.anthropic.com/v1/messages', '被拒的写入不能落盘');

  server.close();
});

test('健康检查报告 AI 是否已配置（但不回传密钥）', async () => {
  const empty = makeServer({ deps: makeDeps({ settings: makeStore() }) });
  await new Promise((r) => empty.listen(0, r));
  const emptyBody = await (await fetch(`http://127.0.0.1:${empty.address().port}/health`)).json();
  assert.equal(emptyBody.aiConfigured, false, '没配密钥时要报 false —— 大屏据此提示「判定会全部跳过」');
  empty.close();

  const store = makeStore();
  store.save({ aiKey: 'sk-ant-x' });
  const configured = makeServer({ deps: makeDeps({ settings: store }) });
  await new Promise((r) => configured.listen(0, r));
  const raw = await (await fetch(`http://127.0.0.1:${configured.address().port}/health`)).text();
  assert.equal(JSON.parse(raw).aiConfigured, true);
  assert.equal(raw.includes('sk-ant-x'), false, '健康检查只报布尔，不回传密钥');

  configured.close();
});

test('一份简历都没有时服务照常启动，/health 报告 profiles: 0', async () => {
  // 开源后的默认状态可能正是「还没放简历」。这时服务必须能起来 —— 否则用户
  // 连大屏都打不开,也就永远看不到那句「把简历放进 resumes/」的提示。
  const server = makeServer({ deps: makeDeps({ profiles: [], profileOf: () => undefined }) });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(body.ok, true, '没有简历也要报 ok —— 服务本身是好的,缺的是配置');
  assert.equal(body.profiles, 0, '大屏靠这个数字决定要不要显示「没加载到简历」的警告条');

  const dash = await fetch(`http://127.0.0.1:${port}/dashboard`);
  assert.equal(dash.status, 200, '大屏要能打开,用户才有地方看到提示');

  server.close();
});

test('改配置后判定缓存被清空,新规则立即生效', async () => {
  // 缓存的 bug 形态很隐蔽:缓存命中时连 meta 都照抄旧结果,用户改完规则重跑,
  // 看到的是旧结论,只会以为「改了没用」—— 而不是怀疑缓存。
  const store = makeStore();
  const deps = makeDeps({
    settings: store,
    // 桩:规则里出现「放行」就投,否则不投。规则变了结论必须跟着变。
    // 两个词必须无包含关系 —— 用「投/不投」的话 includes('投') 恒为真,测不出缓存。
    decideByPrompt: async (job, profile, ruleText) => ({
      apply: ruleText.includes('放行'), reason: ruleText, fallback: false,
    }),
  });
  const server = makeServer({ deps });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;

  const evaluate = async () => (await (await fetch(`${url}/evaluate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ job: JOB_OK }),
  })).json());

  const save = (decisionPrompt) => fetch(`${url}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decisionPrompt }),
  });

  await save('青岛放行');
  const first = await evaluate();
  assert.equal(first.apply, true);
  assert.equal(first.meta.cacheHit, false);

  // 同一个岗位再判一次:应当命中缓存(证明缓存机制本身在工作)。
  assert.equal((await evaluate()).meta.cacheHit, true);

  await save('青岛拦下');
  const third = await evaluate();
  assert.equal(third.apply, false, '改完规则必须按新规则重判,不能吃旧缓存');
  assert.equal(third.meta.cacheHit, false);

  server.close();
});

test('/api/records 响应里带上每日分组', async () => {
  const server = makeServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;

  await fetch(`${url}/report`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ company: '甲', at: '2026-09-24T02:00:00.000Z', stage: 'sent', verdict: true }),
  });
  await fetch(`${url}/report`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ company: '乙', at: '2026-09-24T06:00:00.000Z', stage: 'skipped', verdict: false }),
  });

  const body = await (await fetch(`${url}/api/records?since=0`)).json();
  assert.equal(body.daily.length, 1);
  assert.equal(body.daily[0].sent, 1);
  // 已投递的两个都在已判定里,所以判定数不小于投递数 —— 两条线不是相加关系。
  assert.equal(body.daily[0].judged, 2);
  // 日期取决于服务进程所在时区,所以只断言格式,不写死具体是哪天。
  assert.match(body.daily[0].date, /^\d{4}-\d{2}-\d{2}$/);

  server.close();
});

test('isCrossOriginWrite 只拦真正跨站的浏览器请求', () => {
  // 不带 Origin 的是 curl / GM_xmlhttpRequest,这些必须放行,否则脚本侧和命令行全废。
  assert.equal(isCrossOriginWrite({ host: '127.0.0.1:8787' }), false);
  assert.equal(isCrossOriginWrite({}), false);
  // 同源放行(手机通过局域网 IP 访问也属于同源)。
  assert.equal(isCrossOriginWrite({ origin: 'http://192.168.1.5:8787', host: '192.168.1.5:8787' }), false);
  // 跨站拦住。
  assert.equal(isCrossOriginWrite({ origin: 'http://evil.example', host: '127.0.0.1:8787' }), true);
  // Origin 解析不了(如字面量 "null")按跨站处理。
  assert.equal(isCrossOriginWrite({ origin: 'null', host: '127.0.0.1:8787' }), true);
});

// 等一个条件成立。连接断开这类事件不会在 abort() 的同一刻发生,直接断言会时灵时不灵。
async function waitFor(condition, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(message);
}

test('/api/watch 建立长连接并登记,断开后注销', async () => {
  const idle = createIdleExit({ graceMs: 60_000, firstGraceMs: 60_000, onIdle: () => {} });
  const server = makeServer({ idle });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/watch`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  // 读到第一帧才算连上:服务端是先写响应头、随即登记的,拿到数据就说明已登记。
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /: connected/);
  assert.equal(idle.count(), 1, '大屏连上就该被算作「有人在看」');

  // 必须主动断开:长连接挂着的话 server.close() 会一直等它。
  controller.abort();
  await waitFor(() => idle.count() === 0, '断开后应注销,否则服务永远不会自己退出');

  server.close();
});

test('/api/watch 在没接 idle 时照样吐流(开发模式 npm start 就是这种)', async () => {
  const server = makeServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/watch`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const first = await res.body.getReader().read();
  assert.match(new TextDecoder().decode(first.value), /: connected/);

  controller.abort();
  server.close();
});

// ---- 大屏「测试连通」 ----
//
// 与 AI 接入同一组约束:探测拿的是**页面上当前填的**值(密钥留空则回落到已存的),
// 而响应体里绝不出现明文密钥。

function testUrl(server) {
  return `http://127.0.0.1:${server.address().port}/api/ai/test`;
}

function postTest(server, body, headers = {}) {
  return fetch(testUrl(server), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('POST /api/ai/test 用页面上填的端点/模型/密钥探测', async () => {
  // 用户在保存前先试,试的必须是眼前这份 —— 否则「填了新密钥、测试却用的旧的」会误导人。
  const store = makeStore();
  store.save({ aiKey: 'sk-ant-stored-1111' });
  const seen = [];
  const server = makeServer({
    deps: makeDeps({ settings: store, testAi: async (config) => { seen.push(config); } }),
  });
  await new Promise((r) => server.listen(0, r));

  const res = await postTest(server, {
    aiEndpoint: 'https://proxy.example/v1/messages',
    aiModel: 'my-model',
    aiKey: 'sk-ant-typed-2222',
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.model, 'my-model', '回哪个模型答的 —— 用户要能确认没写错名字');
  assert.equal(typeof body.ms, 'number', '耗时给页面显示');
  assert.deepEqual(seen[0], {
    endpoint: 'https://proxy.example/v1/messages',
    model: 'my-model',
    key: 'sk-ant-typed-2222',
  });

  server.close();
});

test('POST /api/ai/test 密钥留空时回落到已保存的密钥', async () => {
  // 密钥框永远不回填,想验证存着的那把就只能留空点测试 ——
  // 这条与保存时「空 aiKey = 不修改」是同一个约定(见 settings.validatePatch)。
  const store = makeStore();
  store.save({ aiKey: 'sk-ant-stored-1111' });
  const seen = [];
  const server = makeServer({
    deps: makeDeps({ settings: store, testAi: async (config) => { seen.push(config); } }),
  });
  await new Promise((r) => server.listen(0, r));

  const res = await postTest(server, { aiKey: '' });
  assert.equal((await res.json()).ok, true);
  assert.equal(seen[0].key, 'sk-ant-stored-1111');
  // 没填端点/模型时同样回落到已存配置,不能拿空串去打上游。
  assert.equal(seen[0].endpoint, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[0].model, 'claude-haiku-4-5');

  server.close();
});

test('POST /api/ai/test 探测失败回 200 + ok:false,并透传上游原话', async () => {
  const server = makeServer({
    deps: makeDeps({ testAi: async () => { throw new Error('接口返回 HTTP 401'); } }),
  });
  await new Promise((r) => server.listen(0, r));

  const res = await postTest(server, { aiEndpoint: 'https://proxy.example/v1/messages' });
  // 「问到了上游、上游说不行」不是调用本接口的方式错了,所以照回 200 ——
  // 大屏只看 ok 决定红绿,不必再分辨 HTTP 状态。
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, '接口返回 HTTP 401', '上游给的原话要照搬,编一句「连接失败」等于把线索扔了');

  server.close();
});

test('POST /api/ai/test 的响应体里不含明文密钥', async () => {
  // 大屏可以带令牌对局域网开放,探测接口是又一处新的 HTTP 边界。
  const server = makeServer({ deps: makeDeps({ settings: makeStore(), testAi: async () => {} }) });
  await new Promise((r) => server.listen(0, r));

  const raw = await (await postTest(server, {
    aiEndpoint: 'https://proxy.example/v1/messages',
    aiKey: 'sk-ant-never-echo-9999',
  })).text();
  assert.equal(raw.includes('sk-ant-never-echo-9999'), false);

  server.close();
});

test('POST /api/ai/test 的入参校验与跨站防护', async () => {
  const seen = [];
  const server = makeServer({ deps: makeDeps({ testAi: async (config) => { seen.push(config); } }) });
  await new Promise((r) => server.listen(0, r));

  // 跨站表单拿着 cookie 也能打到这里,先挡住。
  assert.equal((await postTest(server, {}, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await postTest(server, '不是 JSON')).status, 400);

  // 端点不是 http(s) 时连探测都不该发出去。
  const bad = await postTest(server, { aiEndpoint: '这不是地址' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /http/);

  // 超长入参在这里挡掉:readBody 本身没有大小上限,而这几项会原样进上游请求体。
  assert.equal((await postTest(server, { aiModel: 'm'.repeat(101) })).status, 400);

  assert.equal(seen.length, 0, '被挡下的请求一个都不该真的发出去');

  server.close();
});

test('POST /api/ai/test 在服务没接探测能力时回 503', async () => {
  // makeDeps() 默认不带 testAi。显式报错比 500 好查。
  const server = makeServer();
  await new Promise((r) => server.listen(0, r));

  const res = await postTest(server, { aiEndpoint: 'https://proxy.example/v1/messages' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /AI 探测/);

  server.close();
});

