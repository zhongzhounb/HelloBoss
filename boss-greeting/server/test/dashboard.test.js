import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderDashboardHtml } from '../src/dashboard.js';

// 从整页 HTML 里截出一段带某个特征的元素及其内容(含嵌套同名标签)。
// 分页之后「某块只在设置页 / 只在投递页」是要守住的性质,而两个页面容器里都嵌着
// 若干 <section class="panel"> —— 用正则找第一个 </section> 会在第一个面板处截断。
// 这里按标签深度配平,只依赖零依赖的字符串扫描。
function sliceTag(html, tag, marker) {
  let start = -1;
  for (let at = html.indexOf('<' + tag, 0); at >= 0; at = html.indexOf('<' + tag, at + 1)) {
    const close = html.indexOf('>', at);
    const head = html.slice(at, close + 1);
    // 找的是「开头标签里带这个特征」的那一个,且不能是自闭合。
    if (head.includes(marker) && !head.endsWith('/>')) { start = at; break; }
  }
  assert.ok(start >= 0, `页面里找不到 ${tag} ${marker}`);

  const pattern = new RegExp(`<(/?)${tag}(?:\\s[^>]*)?>`, 'g');
  pattern.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = pattern.exec(html))) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, pattern.lastIndex);
  }
  assert.fail(`${tag} ${marker} 没有闭合`);
}

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

test('顶部有标题栏与服务开关,且不再有手机看大屏', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('HelloBoss'), '标题栏应写「HelloBoss」');
  assert.ok(html.includes('id="svcBtn"'));
  // 控制台默认不启动判定服务,按钮一开始就该是「启动服务」。
  assert.match(html, /id="svcBtn"[^>]*>启动服务</, '按钮初始文案应为「启动服务」');
  assert.ok(html.includes('id="ctrlStatus"'), '启停失败要有地方显示原因');
  // 手机看大屏(局域网监听)已整套移除,页面上不该再留入口。
  assert.ok(!html.includes('id="lanBtn"'), '不该再有手机看大屏按钮');
  assert.ok(!html.includes('/api/lan'), '不该再请求局域网接口');
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

// ---- 两页结构:设置 / 投递记录 ----
//
// 一屏塞四栏时,新用户分不清「要先配什么」和「投递结果在哪」。
// 两页的分工要能一眼看出来,且配置与记录各自归位。

test('页面分成「设置」「投递记录」两页,且一次只显示一页', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="viewSettings"'), '要有设置页容器');
  assert.ok(html.includes('id="viewDelivery"'), '要有投递记录页容器');
  assert.ok(html.includes('data-view="settings"'), '要有切页按钮');
  assert.ok(html.includes('data-view="delivery"'));
  assert.ok(html.includes('function switchView'), '切页要由一个函数统一处理');
  // 两页靠 .active 互斥显示 —— 如果两个容器同时可见,就等于没分页。
  assert.ok(html.includes(".view.active { display: grid;"), '只有 active 的那个页面可见');
});

test('设置页放规则、样式和 AI 接入;投递页放柱状图与记录表', () => {
  const html = renderDashboardHtml();
  const settings = sliceTag(html, 'section', 'id="viewSettings"');
  const delivery = sliceTag(html, 'section', 'id="viewDelivery"');

  for (const label of ['打招呼判定', '打招呼样式', 'AI 接入']) {
    assert.ok(settings.includes(label), `设置页应有「${label}」`);
  }
  assert.ok(settings.includes('id="decisionPrompt"'));
  assert.ok(settings.includes('id="greetingPrompt"'));
  assert.ok(settings.includes('id="aiEndpoint"'));

  assert.ok(delivery.includes('id="chart"'), '投递页要有柱状图');
  assert.ok(delivery.includes('id="rows"'), '投递页要有记录表');
  assert.ok(delivery.includes('id="stats"'), '投递页要有统计数字');
  // 配置项不该出现在投递页:两个页面都能配的话,「设置页」这个分工就没了。
  assert.ok(!delivery.includes('id="decisionPrompt"'), '投递页不该再摆一份规则框');
  assert.ok(!delivery.includes('id="aiKey"'), '投递页不该再摆一份密钥框');
});

test('投递页是左右布局:左边柱状图,右边记录表', () => {
  const html = renderDashboardHtml();
  // 上下布局时垂直空间被图吃掉,记录表只剩几行;左右分栏后表能吃掉整列高度。
  assert.match(html, /#viewDelivery \{[^}]*grid-template-columns:\s*minmax/,
    '投递页应是两列网格');
  assert.doesNotMatch(html, /#viewDelivery \{[^}]*grid-template-rows: auto minmax\(0, 1fr\)/,
    '不该再是「上面图、下面表」的上下布局');
  // 图表所在的那栏占满整列高度,否则固定高度的图会在面板里留一大片空白。
  assert.ok(html.includes('.chart { display: flex; flex: 1;'), '图表应吃掉剩余高度');
});

test('默认落在设置页,上次停在投递页时能记住', () => {
  const html = renderDashboardHtml();
  // 一进来就该看到「要先配什么」;没配过的人不会想在空记录页上待着。
  assert.ok(html.includes("return localStorage.getItem(VIEW_KEY) === 'delivery' ? 'delivery' : 'settings';"),
    '默认应是设置页');
  // 避免每刷新一次都跳回设置页 —— 大屏常开着瞄记录。
  assert.ok(html.includes('switchView(initialView());'), '启动时按记忆的页面渲染');
  // localStorage 在部分浏览器策略下会直接抛,不能让它把整段脚本带崩。
  assert.ok(html.includes('try {'), '读写 localStorage 要兜住异常');
});

test('切到投递页时把记录表滚到底', () => {
  const html = renderDashboardHtml();
  // 隐藏期间新记录已经追加进来,但 display:none 时 scrollHeight 是 0 ——
  // 只能在切回来的那一刻补一次滚动,否则看到的是一天前的第一条。
  assert.ok(html.includes("if (delivery) tableWrapEl.scrollTop = tableWrapEl.scrollHeight;"),
    '切页后要贴底');
});

test('红条留在标题栏,两页都看得到', () => {
  const html = renderDashboardHtml();
  const head = sliceTag(html, 'div', 'class="head"');
  // 「不会投递任何岗位」是整页后果,不该只在设置页提示 ——
  // 用户盯着投递页纳闷为什么没记录时,得能直接看到原因。
  assert.ok(head.includes('id="ruleWarn"'), '规则警告条应在标题栏');
  assert.ok(head.includes('id="knowledgeWarn"'), '知识库警告条应在标题栏');
});

test('轮询与 watch 连接不随切页重建', () => {
  const html = renderDashboardHtml();
  // 两页共用一个轮询和一条 SSE;每页各自维护一套会让游标与服务灯重复、也可能双插记录。
  const polls = html.match(/setInterval\(poll/g) || [];
  assert.equal(polls.length, 1, `轮询只该有一处,实际 ${polls.length} 处`);
  const watches = html.match(/new EventSource/g) || [];
  assert.equal(watches.length, 1, `watch 连接只该挂在 openWatch 里`);
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
  //
  // 数的是「调用」而不是某种固定写法:首屏教学那边写的是
  // `loadSettings().then(maybeAskTour)`,后面接什么方法不该让这条断言失效。
  // 函数声明 `function loadSettings() {` 不当成调用。
  const calls = [...html.matchAll(/loadSettings\s*\(\s*\)/g)];
  const invocations = calls.filter((m) => !/function\s+$/.test(html.slice(0, m.index)));
  assert.equal(invocations.length, 1, `loadSettings 应只在启动时调用一次,实际 ${invocations.length} 次`);
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

test('知识库为空时有单独的警告条，依据是 /health 的 hasKnowledge', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="knowledgeWarn"'), '要有专门的知识库警告条元素');
  assert.ok(html.includes('知识库还是空的'), '要说清后果,不能只在某个角落显示一个 0');
  assert.ok(html.includes('粘进'), '要告诉用户去哪儿填知识库,否则只知道「没投」不知道怎么办');
  // 判断依据必须接在健康检查的结果上。规则警告条看的是 settings,两者不同源 ——
  // 混用会让「有规则但没知识库」这种情况一条提示都不出。
  assert.ok(html.includes('health.hasKnowledge === false'), '警告条的显示条件要接在 /health 的结果上');
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

test('知识库是设置页的一部分，和打招呼样式挨着', () => {
  const html = renderDashboardHtml();
  const settings = html.slice(html.indexOf('id="viewSettings"'), html.indexOf('id="viewDelivery"'));
  assert.ok(settings.includes('id="knowledge"'), '设置页要有知识库文本框');
  assert.ok(settings.includes('id="btnKnowledgeSave"'), '知识库要能单独保存');
  // 知识库排在打招呼样式之后 —— 「怎么写」在上、「写什么」在下,是这一页的分工。
  const styleAt = settings.indexOf('id="greetingPrompt"');
  const knowledgeAt = settings.indexOf('id="knowledge"');
  assert.ok(styleAt > 0 && knowledgeAt > styleAt, '知识库应排在打招呼样式下面');
  // 保存走同一套 settings 接口。
  assert.ok(html.includes('postSettings({ knowledge: knowledgeEl.value })'), '知识库保存要走 /api/settings');
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

test('顶栏有「安装油猴脚本」的链接,且是指向 .user.js 的真链接', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="installScript"'), '要有安装脚本的入口');

  // 必须是 <a href="…user.js"> —— 篡改猴靠「导航到一个 .user.js 地址」触发安装框,
  // 换成按钮 + fetch 拼 blob 就不会弹安装页,用户只会下载到一个看不懂的文本文件。
  const link = html.match(/<a[^>]+id="installScript"[^>]*>/);
  assert.ok(link, '安装入口要是一个 <a> 标签');
  assert.match(link[0], /href="\/install\.user\.js"/, '要指向服务的安装路径');
});

// ---- 首次使用教学 ----
//
// 新人最常见的卡点不是「不会填」,而是「不知道该去哪填、装没装上」。所以首屏问一句
// 要不要教,要的话按顺序指到每一块该动的地方。

test('首屏会问要不要开启使用教学,并且能选择跳过', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="tourAsk"'), '要有「要不要开启教学」的对话框');
  assert.ok(html.includes('id="tourAccept"'), '要有「开启教学」');
  assert.ok(html.includes('id="tourDecline"'), '要能选择不教 —— 不强迫');
  // 默认隐藏:HTML 里不能一上来就显示,否则脚本没跑起来也挡着页面。
  assert.match(html, /<div class="tour-ask" id="tourAsk" hidden>/, '询问框默认应隐藏');
});

test('顶栏有「使用教学」入口,看完还能重新打开', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="btnTour"'), '要有重新打开教学的按钮');
});

test('教学里每一步指向的 id 都真的存在于页面', () => {
  const html = renderDashboardHtml();
  const [script] = html.match(/<script>([\s\S]*?)<\/script>/).slice(1);
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

  // 从 TOUR_STEPS 里抠出所有 target:'xxx'。target 为空串表示「居中卡片、不指位置」。
  // 这里用整段匹配而不是逐行,是因为步骤表本身就是多行的。
  const stepsBlock = script.slice(script.indexOf('var TOUR_STEPS'), script.indexOf('var tourIndex'));
  assert.ok(stepsBlock.length > 0, '没有找到 TOUR_STEPS');

  const targets = [...stepsBlock.matchAll(/target:\s*'([^']*)'/g)].map((m) => m[1]);
  assert.ok(targets.length >= 5, '教学步骤太少,覆盖不到完整流程');

  const missing = targets.filter((t) => t && !ids.has(t));
  // 写错一个 id 不会报错,只会让那一步悄悄变成「居中卡片、什么都不指」——
  // 用户看到的就是「说要点这里,但没说哪里」。
  assert.deepEqual(missing, [], `这些教学目标在页面上不存在:${missing.join(', ')}`);
});

test('教学会记住「看过了」,不会每次都拦人', () => {
  const html = renderDashboardHtml();
  const [script] = html.match(/<script>([\s\S]*?)<\/script>/).slice(1);
  assert.ok(script.includes('localStorage.setItem(TOUR_KEY'), '看完要落一个标记');
  assert.ok(script.includes('localStorage.getItem(TOUR_KEY)'), '再次打开要先查这个标记');
});

test('教学内容点到了最关键的三件事:装脚本、填三项、启动服务', () => {
  const html = renderDashboardHtml();
  const [script] = html.match(/<script>([\s\S]*?)<\/script>/).slice(1);
  const stepsBlock = script.slice(script.indexOf('var TOUR_STEPS'), script.indexOf('var tourIndex'));

  // 只检查「有没有讲到」,不校验措辞 —— 文案以后会改,但这几件事不能漏。
  for (const keyword of ['篡改猴', '安装油猴脚本', 'AI 接入', '投递规则', '知识库', '启动']) {
    assert.ok(stepsBlock.includes(keyword), `教学里应提到「${keyword}」`);
  }
  // 必须说清「问候语来源保持 AI 判定」—— 换成别的模式就不看规则了。
  assert.ok(stepsBlock.includes('AI 判定'), '要提醒保持 AI 判定模式');
});
