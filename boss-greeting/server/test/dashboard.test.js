import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderDashboardHtml } from '../src/dashboard.js';

test('返回一个完整的 HTML 文档', () => {
  const html = renderDashboardHtml();
  assert.match(html, /^<!DOCTYPE html>/i);
  assert.match(html, /<\/html>\s*$/);
  assert.match(html, /charset="utf-8"/i);
});

test('页面不含任何外部资源引用（零依赖约定）', () => {
  const html = renderDashboardHtml();
  assert.doesNotMatch(html, /<script[^>]+src=/i, '不得引入外部脚本');
  assert.doesNotMatch(html, /<link[^>]+href=["']http/i, '不得引入外部样式');
  assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1|localhost)/i, '不得引用外部地址');
});

test('包含四个统计项与两个范围', () => {
  const html = renderDashboardHtml();
  for (const label of ['已判定', '已沟通', '已跳过', '发送异常']) {
    assert.ok(html.includes(label), `页面应包含统计项「${label}」`);
  }
  assert.ok(html.includes('本轮'));
  assert.ok(html.includes('累计'));
});

test('轮询间隔与行数上限可配置,并落到页面里', () => {
  const html = renderDashboardHtml({ pollMs: 2500, maxRows: 100 });
  assert.ok(html.includes('2500'), '轮询间隔应写进页面');
  assert.ok(html.includes('100'), '行数上限应写进页面');
});

test('包含轮询与导出所需的两个接口路径', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('/api/records'));
  assert.ok(html.includes('/api/export.csv'));
});

test('上半屏含配置面板与柱状图容器', () => {
  const html = renderDashboardHtml();
  for (const label of ['打招呼判定', '打招呼样式', '每日投递量', 'AI 接入']) {
    assert.ok(html.includes(label), `上半屏应有「${label}」`);
  }
  // 这些 id 是 JS 读写配置时按 id 取的,改名会静默失效 —— 一起守着。
  assert.ok(html.includes('id="decisionPrompt"'));
  assert.ok(html.includes('id="greetingPrompt"'));
  assert.ok(html.includes('id="chart"'));
});

test('投递数量与时段不再出现在服务端配置里', () => {
  const html = renderDashboardHtml();
  // 两项完全由油猴脚本控制。服务端再留一份,只会出现「脚本以为还能投、
  // 服务端已经拦下」的错位。
  assert.ok(!html.includes('dailySendLimit'), '每日投递上限应已删除');
  assert.ok(!html.includes('activeHours'), '允许投递时段应已删除');
  assert.ok(!html.includes('投递时段'), '时段面板应已删除');
});

test('顶部有标题栏、服务开关与手机访问按钮', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('HelloBoss'), '标题栏应写「HelloBoss」');
  assert.ok(html.includes('id="svcBtn"'));
  // 控制台默认不启动判定服务,按钮一开始就该是「启动服务」。
  assert.match(html, /id="svcBtn"[^>]*>启动服务</, '按钮初始文案应为「启动服务」');
  assert.ok(html.includes('id="lanBtn"'), '手机看大屏要能在页面里开关');
  assert.ok(html.includes('id="ctrlStatus"'), '启停失败要有地方显示原因');
  assert.ok(html.includes('id="lanInfo"'), '开启手机访问后要显示地址');
});

test('打招呼判定是「编辑 / 保存」双态', () => {
  const html = renderDashboardHtml();
  // 初始文案是「编辑」= 已锁定态;点它才解锁成可写、按钮变「保存」。
  assert.match(html, /id="btnPrompt"[^>]*>编辑</);
  assert.ok(html.includes("editing ? '保存' : '编辑'"), '两个文案都要有');
  assert.ok(html.includes('readOnly'), '锁定要用 readonly,不能只靠样式');
});

test('没配规则时给出醒目警告,并能让用户一键填入示例', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="ruleWarn"'), '要有专门的警告条元素');
  assert.ok(html.includes('不会投递任何岗位'), '要说清后果,不能只显示一个 0');
  assert.ok(html.includes('id="btnSample"'), '要有「填入示例」按钮');
  assert.ok(html.includes('SAMPLE_RULE'), '示例文案要内联在页面里,不依赖外部资源');
  // 警告条必须跟着**已保存**的规则走,而不是文本框里的草稿 ——
  // 否则用户刚敲两个字红条就消失了,而实际上规则还没保存、一个岗位都投不出去。
  assert.ok(html.includes("classList.toggle('show', !savedRule.trim())"), '警告应依据已保存的规则');
  // 空规则时直接开放编辑:一个空框还锁着,会让第一次用的人以为功能坏了。
  assert.ok(html.includes("savedRule.trim() ? 'locked' : 'editing'"), '空规则时应直接可编辑');
});

test('「填入示例」不覆盖已有内容', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('没有覆盖'), '非空时不能默默把用户写的内容冲掉');
});


test('打招呼样式是一个 prompt 文本框,不再是固定句子列表', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="greetingPrompt"'), '样式要有多行输入');
  assert.ok(html.includes('id="btnGreetingSave"'), '要有保存按钮');
  // 这句必须写在面板上:用户以为「写进去的话会被原样发给招聘方」就什么都不敢写了,
  // 而它其实只是给模型的要求。说不清这一点,这个框就废了。
  assert.ok(html.includes('不逐字发出'), '要说清这是给 AI 的要求,不是要发出去的文本');
  // 旧那套「一行一条、增删改」的列表应该彻底消失 —— 留着一半最糟糕。
  assert.ok(!html.includes('id="samples"'), '不该再有固定句子列表');
  assert.ok(!html.includes('persistSamples'));
});

test('下半屏也用面板框住', () => {
  const html = renderDashboardHtml();
  assert.match(html, /class="bottom panel"/, '下半部分应当也是 panel,才有边框');
});

test('记录表的时间列带日期,并按日期+时间排序后只留最近 100 条', () => {
  const html = renderDashboardHtml();
  // 跨天挂机时只有时分秒会让昨天的记录和今天的分不开。
  assert.ok(html.includes("pad(d.getMonth() + 1) + '/' + pad(d.getDate())"), '时间列要显示「月/日」');
  assert.ok(html.includes('var MAX_ROWS = 100;'), '默认只保留最近 100 条');
  // /report 不等待响应,到达顺序未必等于 at 的先后 —— 每行带 at,插入时按它定位。
  assert.ok(html.includes('data-at='), '行上要带 at 供排序');
  assert.ok(html.includes('function insertRecord'), '应按时间戳找位置插入,不能一股脑插表头');
  // 列表从早到晚,超上限时裁掉的是表头(最旧)那条。
  assert.ok(html.includes('rowsEl.removeChild(rowsEl.firstChild)'), '保留最近 100 条 = 裁掉最旧的');
  // 最新一条在表尾,追加后要跟着滚到底;用户往上翻时不抢滚动位置。
  assert.ok(html.includes('id="tableWrap"'), '滚动容器要能被脚本取到');
  assert.ok(html.includes('tableWrapEl.scrollTop = tableWrapEl.scrollHeight'), '新记录到达时自动滚到底');
  assert.ok(html.includes('var follow = isAtBottom()'), '只在原本贴底时跟随');
});


test('配置面板读写 /api/settings,且只在启动时读一次', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('/api/settings'), '配置面板要能读也要能写');
  assert.ok(html.includes("method: 'POST'"), '保存要走 POST');
  // 配置只在加载时拉一次。进了轮询循环的话,用户正在输入的草稿会被服务端的旧值覆盖。
  // 只数带分号的调用 —— 函数声明 `function loadSettings() {` 也含这个名字,不排除它会多数一次。
  const loads = html.match(/loadSettings\(\);/g) || [];
  assert.equal(loads.length, 1, `loadSettings 应只在启动时调用一次,实际 ${loads.length} 次`);
});

test('柱状图是纯 CSS 实现的,没有引入图表库', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('.bar'), '柱子应是 CSS 类而不是 canvas/svg 绘制');
  assert.doesNotMatch(html, /<canvas/i);
});

test('柱状图两条线是「已投递 / 已判定」,不再是「已沟通 / 未沟通」', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('<i class="ok"></i>已投递'), '第一根柱子应是「已投递」');
  assert.ok(html.includes('<i class="no"></i>已判定'), '第二根柱子应是「已判定」');
  // 「未沟通」把黑名单 / 已沟通这类没走到判定的前置跳过也算进去,和「已判定」不是一回事,
  // 会让人误以为柱子里全是 AI 判掉的岗位 —— 图里不该再出现这个词。
  assert.ok(!html.includes('未沟通'), '图例与提示里不该再出现「未沟通」');
  assert.ok(html.includes(' 已投递 '), 'tooltip 要跟着改成新口径');
});

test('「筛选倍数」在提示语下方独立一行,样本不足时显示占位符', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="ratio"'), '倍数要有独立的显示位');
  assert.ok(html.includes('筛选倍数'), '要写清是倍数 —— 它恒 ≥1,叫百分比会误导');
  // 位置:紧跟在「已判定 = …」那行说明之后。挂在图上会跟着柱状图重绘,放在说明下面更稳。
  const hintAt = html.indexOf('已判定 = 当天拿到 AI 判定结论');
  const ratioAt = html.indexOf('id="ratio"');
  assert.ok(hintAt > 0 && ratioAt > hintAt, '倍数应排在说明文字下方');
  // 阈值:窗口内已投递不足 20 份就不给数字 —— 样本太小算出来的倍数会被当成结论。
  assert.ok(html.includes('MIN_SENT_FOR_RATIO = 20'), '阈值默认 20');
  assert.ok(html.includes('sumSent >= MIN_SENT_FOR_RATIO'), '按阈值分支');
  assert.ok(html.includes("'筛选倍数 --'"), '样本不足时走占位符分支');
  assert.ok(html.includes('sumJudged / sumSent'), '先求和再相除,不能按天平均');
  assert.ok(html.includes('toFixed(2)'), '保留两位小数');
});

// ---- AI 接入面板 ----
//
// 这一组守的是「密钥不进大屏、也不会被误清」。开源后用户要在这里填自己的
// 端点与密钥,而大屏是可以带令牌对局域网开放的。

test('AI 接入面板有端点 / 密钥 / 模型三个字段', () => {
  const html = renderDashboardHtml();
  for (const id of ['aiEndpoint', 'aiKey', 'aiModel']) {
    assert.ok(html.includes(`id="${id}"`), `缺少输入框 ${id}`);
  }
  assert.ok(html.includes('id="btnAiSave"'), '要有保存按钮');
  assert.ok(html.includes('id="btnAiClear"'), '要有显式的清除密钥入口');
});

test('密钥框是 password，且页面里没有任何回填明文的赋值', () => {
  const html = renderDashboardHtml();
  assert.match(html, /id="aiKey"[^>]*type="password"/, '密钥要以密码框呈现,不能明文摆在屏幕上');
  assert.ok(html.includes('autocomplete="off"'), '别让浏览器把它当登录密码记住或自动填');
  // 服务端不回传明文,页面自然也不该有从响应回填 aiKey 的代码。
  assert.doesNotMatch(html, /aiKeyEl\.value\s*=\s*data\.aiKey/, 'aiKey 不能从响应回填');
  assert.ok(html.includes('setKeyHint'), '「已配置 / 未配置」要靠提示文字表达,否则空框看起来像没存上');
});

test('密钥留空时不进入提交体 —— 只改端点或模型不能顺手清掉密钥', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('if (key) patch.aiKey = key'), '空密钥不应被提交');
});

test('清除密钥走 clearAiKey，而不是提交一个空 aiKey', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('clearAiKey: true'), '「清除」必须是明确意图,不能与「未修改」共用空串');
});

test('配置加载后回填端点与模型，并刷新密钥提示', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('aiEndpointEl.value = data.aiEndpoint'), '端点要回填,否则用户看不到当前值');
  assert.ok(html.includes('aiModelEl.value = data.aiModel'));
  assert.ok(html.includes('setKeyHint(data.hasAiKey'), '加载后要刷新「已配置 / 未配置」提示');
});

test('没加载到简历时有单独的警告条，依据是 /health 的 profiles', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="profileWarn"'), '要有专门的简历警告条元素');
  assert.ok(html.includes('没加载到简历'), '要说清后果,不能只在某个角落显示一个 0');
  assert.ok(html.includes('resumes/'), '要告诉用户去哪儿放简历,否则只知道「没投」不知道怎么办');
  // 判断依据必须接在健康检查的结果上。规则警告条看的是 settings,两者不同源 ——
  // 混用会让「有规则但没简历」这种情况一条提示都不出。
  assert.ok(html.includes('health.profiles === 0'), '警告条的显示条件要接在 /health 的结果上');
});

test('大屏挂一条长连接给控制进程当「有人在看」的信号', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes("new EventSource('/api/watch')"), '要连上 /api/watch 这条流');
  assert.ok(html.includes('openWatch();'), '首屏就要把这条连接挂上,不能等用户点按钮');
  // 这条连接只回答「页面还在不在」。判定服务开没开是另一回事,不能拿连接状态推断 ——
  // 判定服务停着时,控制台和大屏连接都好好的。
  assert.ok(!html.includes("watch.addEventListener('open'"), 'SSE 连接不该再写服务按钮');
});

test('服务开关的状态跟着 /api/records 的 service 字段走', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('applyService(data.service)'), '轮询响应里带服务状态,不必另起定时器');
  assert.ok(html.includes("var action = service.running ? 'stop' : 'start'"), '按钮是按当前状态启停');
  assert.ok(html.includes("postJson('/api/service/' + action"), '启停要走 /api/service');
  assert.doesNotMatch(html, /svcState/, '不该再有旧的连接状态变量');
});

test('手机看大屏由页面开关,不再依赖单独的 .cmd 脚本', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes("fetch('/api/lan')"), '加载时要读当前局域网状态');
  assert.ok(html.includes("postJson('/api/lan'"), '开关要走 /api/lan');
  assert.ok(html.includes('关闭手机访问'), '开着时按钮要能关掉');
});

test('页面上写清了「控制台跟着本页,关掉就停」', () => {
  const html = renderDashboardHtml();
  // 这是行为的一部分,不能只写在 README 里:用户关掉页面的那一刻,
  // 判定服务就没了,而判定是 fail-closed —— 后果是一个岗位都不投,却看不出为什么。
  assert.ok(html.includes('关掉这个标签页'), '要说清关掉本页的后果');
  assert.ok(html.includes('最小化'), '最小化不影响,这一条同样要说,否则用户会不敢切标签页');
});

test('AI 面板有「测试连通」按钮,测的是页面上当前填的值', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="btnAiTest"'), '要有测试连通按钮');
  assert.ok(html.includes("postJson('/api/ai/test'"), '要走探测接口');

  // 密钥框留空 = 用已保存的那把:提交体里别塞空密钥。
  // 服务端本身也按这个约定兜底,但页面少发一个字段更不容易出错,也和保存时的写法一致。
  assert.ok(html.includes('if (key) body.aiKey = key'), '空密钥不进测试请求');
  // 探测要十几秒,没有「测试中…」的话用户会以为没点中而连点。
  assert.ok(html.includes('测试中…'), '要有进行中的反馈');
  // 失败要把上游原话摆出来,不能只显示一个「失败」。
  assert.ok(html.includes("'测试失败:' + data.error"), '失败原因要照搬上游原话');
});

test('判定规则的「填入示例」是脱敏过的通用模板', () => {
  const html = renderDashboardHtml();
  // 脱敏:真实公司名与真实地名一个都不能进示例
  for (const name of ['华为', '字节跳动', '拼多多', '虾皮', '快手', '长川科技', 'TCL']) {
    assert.ok(!html.includes(name), `示例规则不得包含真实公司「${name}」`);
  }
  assert.ok(!html.includes('章贡区'), '示例规则不得包含真实地名');
  // 结构:示例仍要示范「多条件 + 一票通过项 + 读不到不放行」
  assert.ok(html.includes('【黑名单】某某科技、某某网络'), '示例应保留黑名单这个结构');
  assert.ok(html.includes('读不出来时自己判断'), '示例应保留「读不到不放行」这一条');
});

test('招呼语面板有「填入示例」，且示例文案不含真实卖点', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="btnGreetingSample"'), '招呼语面板应有「填入示例」按钮');
  assert.ok(html.includes('SAMPLE_GREETING_PROMPT'), '示例常量应存在');
  // 示例是给陌生人看的模板,不能混进真实学历/奖项 —— 与规则面板同一条规矩。
  assert.ok(!html.includes('985硕'), '示例不得包含真实学历');
  assert.ok(!html.includes('国奖竞赛'), '示例不得包含真实奖项');
});


test('内联 JS 里每个 getElementById 都能在页面里找到对应元素', () => {
  const html = renderDashboardHtml();
  const [script] = html.match(/<script>([\s\S]*?)<\/script>/).slice(1);

  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = [...new Set([...script.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]))];
  const missing = used.filter((id) => !ids.has(id));

  // 少一个 id 不会让页面报错,只会让对应的功能静默失效(比如配置读回来填不进输入框),
  // 所以在测试里挡住,而不是等大屏上看到空框才发现。
  assert.deepEqual(missing, [], `这些元素取不到:${missing.join(', ')}`);
});

test('内联 JS 是完整可解析的一段脚本', () => {
  const html = renderDashboardHtml();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, '零依赖约定:只应有一段内联脚本');
  assert.ok(scripts[0][1].includes('function'), '内联脚本不该是空壳');
});

test('内联脚本能编译 —— 外层模板字符串的转义错误在这里现形', () => {
  const html = renderDashboardHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  // vm.Script 只编译不执行，不需要 DOM。它抓的是一类**只在浏览器里才现形**的错误:
  // 整段页面住在一个模板字符串里，内联脚本里写 '\n' 会被外层先解析成真换行，
  // 把字符串字面量切成两行。模板本身完全合法，测试不改的话页面表现为
  // 「整页 JS 全不执行」—— 按钮全没反应，控制台一行红字。要写 \\n。
  assert.doesNotThrow(() => new vm.Script(script), '内联脚本必须语法合法');
});
