// 看板页面。纯原生 HTML/CSS/JS —— 不引任何外部资源,因为本项目约定零依赖,
// 而这个页面要在无外网的本地环境里也能正常打开。
export function renderDashboardHtml(options = {}) {
  const pollMs = Number(options.pollMs) > 0 ? Math.floor(Number(options.pollMs)) : 1500;
  const maxRows = Number(options.maxRows) > 0 ? Math.floor(Number(options.maxRows)) : 500;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HelloBoss</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: #0d1117; color: #e6edf3;
         font: 13px/1.5 "Microsoft YaHei", "PingFang SC", sans-serif; }

  /* 整页三段:标题栏 / 上半(三个等宽面板) / 下半(记录表)。
     用 minmax(0, 1fr) 而不是 1fr —— 默认的 min-height:auto 会让表格把行撑开,
     整页跟着长高,下半就永远不出滚动条。 */
  .screen { display: grid; grid-template-rows: auto auto minmax(0, 1fr);
            gap: 12px; padding: 12px; height: 100%; }

  /* ---- 标题栏 ---- */
  .head { display: flex; flex-direction: column; gap: 8px; }
  .topbar { display: flex; align-items: center; justify-content: space-between;
            gap: 16px; padding: 12px 16px; background: #161b22;
            border: 1px solid #30363d; border-radius: 8px; }
  .topbar h1 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: .5px; }

  /* 没配规则 / 没放简历时的警告条。刻意做成整条通栏 + 红底,而不是靠面板上的一行小字 ——
     「当前不会投递任何岗位」这件事如果只体现为一个 0,用户会去查脚本、查网络,
     而真正的原因是这里没填。 */
  #ruleWarn, #profileWarn { display: none; padding: 10px 16px; border-radius: 8px;
              background: #2d1416; border: 1px solid #6e2b28; color: #ff9b95; font-size: 12px; }
  #ruleWarn.show, #profileWarn.show { display: block; }
  #ruleWarn strong, #profileWarn strong { color: #ff7b72; }
  #profileWarn { margin-top: 6px; }

  #svcBtn { min-width: 92px; }
  /* 状态灯:启动中(灰) / 运行中(绿) / 未连接(红)。三个状态的颜色本身就是信息,
     所以用配色而不是额外的圆点图标。 */
  #svcBtn.up { border-color: #238636; color: #3fb950; background: #12261a; }
  #svcBtn.down { border-color: #6e2b28; color: #f85149; background: #2d1416; }

  /* 顶栏里那行说明:也是次要文字,但在 flex 行里要换成「把剩余空间吃掉」的左外边距,
     好让它和状态灯一起靠右,同时抵掉 .hint 自带的下外边距(否则会比按钮低一点点)。 */
  .topbar .hint { margin: 0 0 0 auto; }

  /* ---- 上半:四个面板等宽 ---- */
  .top { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
         gap: 12px; height: 300px; min-height: 0; }

  .panel { display: flex; flex-direction: column; min-height: 0;
           background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 10px 12px; }
  .panel h2 { margin: 0 0 3px; font-size: 13px; font-weight: 600; }
  .hint { margin: 0 0 7px; font-size: 11px; color: #6e7681; }
  /* 筛选倍数:这张图最该被一眼看到的数,所以单独占一行、字号明显大于正文,用「已投递」
     同款绿色。tabular-nums 让数字位数变化时不左右跳动。 */
  .ratio { margin: 0 0 6px; font-size: 20px; font-weight: 700; color: #3fb950;
           font-variant-numeric: tabular-nums; }

  textarea { flex: 1; width: 100%; min-height: 0; resize: none; background: #0d1117;
             color: #e6edf3; border: 1px solid #30363d; border-radius: 6px;
             padding: 8px; font-family: inherit; font-size: 12px; line-height: 1.6; }
  textarea:focus { outline: none; border-color: #1f6feb; }
  textarea::placeholder { color: #4d5560; }
  /* 锁定态:文本要还读得清,但一眼能看出「现在不能改」—— 只靠 readonly 的光标变化
     完全不够,用户会以为点了没反应。 */
  textarea[readonly] { background: #10151b; color: #b8c2cc; border-color: #262c33; }

  .panel-foot { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
  .status { font-size: 11px; color: #6e7681; }
  .status.ok { color: #3fb950; }
  .status.bad { color: #f85149; }

  /* ---- 样式列表 ---- */
  .samples { flex: 1; min-height: 0; overflow-y: auto; display: flex;
             flex-direction: column; gap: 4px; padding-right: 2px; }
  .sample { display: flex; align-items: center; gap: 6px; padding: 4px 6px;
            background: #0d1117; border: 1px solid #262c33; border-radius: 6px; }
  .sample-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
                 white-space: nowrap; font-size: 12px; }
  .sample.editing { border-color: #1f6feb; }
  .sample input { flex: 1; min-width: 0; background: #0d1117; color: #e6edf3;
                  border: none; outline: none; font-family: inherit; font-size: 12px; }
  /* 行内的删除/编辑按钮要小,不能和主操作按钮抢视觉重量。 */
  .sample button { padding: 2px 7px; font-size: 11px; border-radius: 4px; }
  .sample button.danger:hover { background: #6e2b28; border-color: #6e2b28; color: #ffdcd7; }
  .empty-sm { padding: 14px 4px; font-size: 11px; color: #6e7681; }

  /* ---- AI 接入 ---- */
  /* 字段装在可滚动容器里:窄屏折成单列时面板高度是固定的,纯靠 flex 会把
     最下面那个输入框挤没。 */
  .ai-fields { flex: 1; min-height: 0; overflow-y: auto; }
  .field { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
  .field label { font-size: 11px; color: #8b949e; }
  .field input { background: #0d1117; color: #e6edf3; border: 1px solid #30363d;
                 border-radius: 6px; padding: 6px 8px; font-family: inherit; font-size: 12px; }
  .field input:focus { outline: none; border-color: #1f6feb; }
  .field input::placeholder { color: #4d5560; }

  /* ---- 柱状图 ---- */
  .chart { flex: 1; display: flex; align-items: flex-end; gap: 3px;
           min-height: 0; overflow-x: auto; }
  .day { flex: 1 1 0; min-width: 26px; display: flex; flex-direction: column;
         align-items: center; gap: 5px; }
  .bars { display: flex; align-items: flex-end; gap: 2px; height: 122px; }
  /* 每根柱子包一列:数字标签在上、柱体在下,两者贴在一起。柱高按 .barcol 的
     122px 算百分比,所以这里必须是确定高度,百分比才成立。 */
  .barcol { display: flex; flex-direction: column; align-items: center;
            justify-content: flex-end; height: 100%; }
  .bar-val { flex: none; font-size: 10px; line-height: 13px;
             font-variant-numeric: tabular-nums; color: #6e7681; }
  .bar-val.ok { color: #3fb950; }
  .bar-val.no { color: #8b949e; }
  .bar { width: 9px; border-radius: 2px 2px 0 0; }
  /* 高度为 0 的柱子真会消失,而「这天跑过但一条都没成」和「这天没跑」在图上
     必须看得出来 —— 由 JS 给非零值兜一个最小高度,这里只管颜色。 */
  .bar.ok { background: #3fb950; }
  .bar.no { background: #8b949e; }
  .day-label { font-size: 10px; color: #6e7681; white-space: nowrap; }

  .legend { display: flex; align-items: center; gap: 14px; margin-top: 8px;
            font-size: 11px; color: #8b949e; }
  .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px;
              margin-right: 4px; }
  .legend i.ok { background: #3fb950; }
  .legend i.no { background: #8b949e; }
  .legend-note { margin-left: auto; color: #6e7681; }

  /* ---- 下半(记录表) ---- */
  .bottom { display: grid; grid-template-rows: auto auto minmax(0, 1fr);
            min-height: 0; overflow: hidden; }
  .bottom-bar { display: flex; align-items: center; justify-content: space-between;
                gap: 16px; padding: 10px 14px; border-bottom: 1px solid #30363d; }
  .stats { display: flex; gap: 28px; }
  .stat { display: flex; flex-direction: column; }
  .stat b { font-size: 22px; line-height: 1.1; font-weight: 600; }
  .stat span { font-size: 11px; color: #8b949e; }
  .stat small { font-size: 11px; color: #6e7681; }
  .stat.anomaly b { color: #f85149; }
  .actions { display: flex; gap: 8px; }

  button { background: #21262d; color: #e6edf3; border: 1px solid #30363d;
           border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 12px; }
  button:hover { background: #30363d; }
  button.on { background: #1f6feb; border-color: #1f6feb; }
  button:disabled { opacity: .6; cursor: default; }

  #banner { display: none; padding: 6px 14px; background: #4d2d00; color: #f0b849; font-size: 12px; }
  #banner.show { display: block; }

  .table-wrap { overflow: auto; min-height: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #21262d;
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  th { position: sticky; top: 0; background: #1c2128; color: #8b949e; font-weight: 500;
       font-size: 11px; z-index: 1; }
  tbody tr:hover { background: #1c2128; }
  td.text { color: #8b949e; }
  /* max-width 对 table-layout:auto 下的 <td> 不生效,必须套一层 div 才能截断,
     否则长招呼语会把整张表撑到横向溢出,而不是省略号收尾。 */
  td.text > div { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.num { color: #8b949e; }
  .ok { color: #3fb950; }
  .no { color: #f85149; }
  .bad { color: #f85149; font-weight: 600; }
  tr.anomaly { background: #2d1416; }
  tr.anomaly td.text { color: #ff9b95; }
  .empty { padding: 32px 16px; color: #6e7681; text-align: center; }

  /* 窄屏(手机)堆叠成单列 —— 三栏 squeezed 到手机上什么都看不清。 */
  @media (max-width: 900px) {
    .screen { height: auto; }
    .top { grid-template-columns: 1fr; height: auto; }
    .bottom { height: 70vh; }
  }
</style>
</head>
<body>
<div class="screen">
  <div class="head">
    <div class="topbar">
      <h1>HelloBoss</h1>
      <span class="hint">服务跟着本页:最小化不影响,关掉这个标签页后服务会自动停止</span>
      <button id="svcBtn" type="button" title="点一下立即重新检测服务状态">启动中</button>
    </div>
    <div id="ruleWarn">
      还没配置投递规则,当前<strong>不会投递任何岗位</strong>。
      请在下方「打招呼判定」里写下你的规则并保存 —— 规则完全由你决定,服务端不内置任何默认规则。
    </div>
    <div id="profileWarn">
      没加载到简历,当前<strong>不会投递任何岗位</strong>。
      把简历放进服务目录的 resumes/ 里(复制 example.txt、改成别的文件名就行,也可以用 .typ),然后重启服务 ——
      判定要靠简历才能对岗位做取舍。
    </div>
  </div>

  <div class="top">
    <section class="panel">
      <h2>打招呼判定</h2>
      <p class="hint">留空时不会投递任何岗位。规则里写上城市、规模、薪资这些数字 —— 服务端不内置任何一份</p>
      <textarea id="decisionPrompt" placeholder="例如:月薪 20K 以上直接投;否则公司规模 1000 人以上才投,创业小公司不投"></textarea>
      <div class="panel-foot">
        <button id="btnPrompt" type="button">编辑</button>
        <button id="btnSample" type="button">填入示例</button>
        <span class="status" id="promptStatus"></span>
      </div>
    </section>

    <section class="panel">
      <h2>打招呼样式</h2>
      <p class="hint">配了就随机挑一条<strong>原样发出</strong>;不填才由 AI 根据简历生成</p>
      <div class="samples" id="samples"></div>
      <div class="panel-foot">
        <button id="btnAddSample" type="button">添加样式</button>
        <button id="btnSampleGreeting" type="button">填入示例</button>
        <span class="status" id="sampleStatus"></span>
      </div>
    </section>

    <section class="panel">
      <h2>每日投递量</h2>
      <p class="hint">已判定 = 当天拿到 AI 判定结论的岗位(含已投递);黑名单 / 已沟通等前置跳过未走到判定,不计入</p>
      <span class="ratio" id="ratio"
            title="最近 7 天:已判定 ÷ 已投递。倍数越高 = 每投出 1 份要判掉越多份,衡量的是筛选力度,不是投递效果。窗口内已投递不足 20 份时样本太小,不显示数字"></span>
      <div class="chart" id="chart"></div>
      <div class="legend">
        <span><i class="ok"></i>已投递</span>
        <span><i class="no"></i>已判定</span>
        <span class="legend-note">最近 7 天</span>
      </div>
    </section>

    <section class="panel">
      <h2>AI 接入</h2>
      <p class="hint">判定与招呼语都用这里配的模型。密钥只留在本机 data/settings.json,不会随记录上报</p>
      <div class="ai-fields">
        <div class="field">
          <label for="aiEndpoint">端点地址</label>
          <input id="aiEndpoint" type="text" placeholder="Anthropic Messages 兼容端点">
        </div>
        <div class="field">
          <label for="aiKey">API Key</label>
          <input id="aiKey" type="password" placeholder="尚未配置" autocomplete="off">
        </div>
        <div class="field">
          <label for="aiModel">模型名</label>
          <input id="aiModel" type="text" placeholder="claude-haiku-4-5">
        </div>
      </div>
      <div class="panel-foot">
        <button id="btnAiSave" type="button">保存</button>
        <button id="btnAiTest" type="button" title="用当前填的端点 / 密钥 / 模型实际打一次上游">测试连通</button>
        <button id="btnAiClear" type="button" title="清除已保存的密钥">清除密钥</button>
        <span class="status" id="aiStatus"></span>
      </div>
    </section>
  </div>

  <div class="bottom panel">
    <div class="bottom-bar">
      <div class="stats" id="stats"></div>
      <div class="actions">
        <button id="btnScope" type="button">本轮统计</button>
        <button id="btnExport" type="button">导出 CSV</button>
      </div>
    </div>
    <div id="banner">连接中断，重试中…</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>时间</th><th>公司</th><th>规模</th><th>岗位</th><th>地点</th>
            <th>薪资</th><th>判定</th><th>实际</th><th>理由 / 话术</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
      <div class="empty" id="empty">暂无记录。启动脚本后这里会实时出现岗位。</div>
    </div>
  </div>
</div>

<script>
  var POLL_MS = ${pollMs};
  var MAX_ROWS = ${maxRows};
  // 图表窗口天数。再往前的记录仍然在表格和 CSV 里,只是不画进柱子。
  var CHART_DAYS = 7;
  // 显示筛选倍数所需的最少已投递数(窗口内累计)。样本太少时比值没有意义 ——
  // 投出 1 份、判掉 3 份也能算出 ×3.00,但那什么都说明不了,反而会被当成结论。
  var MIN_SENT_FOR_RATIO = 20;

  // 「填入示例」用的起步模板。**每一句都是编的**:城市、公司、数字全部脱敏 ——
  // 照抄不改会按一份不是你的标准投递,而招呼语发出去收不回来。
  //
  // 保留下来的是**结构**而不是内容:多条件 + 一票通过项 + 「读不出来就不放行」。
  // 这套结构才是示例的价值所在,它示范了自然语言规则能写到多细。
  var SAMPLE_RULE = [
    '【下面只是示例,请按自己的情况整段改掉】',
    '1. 岗位要和软件相关(开发、测试这类),算法岗不投。',
    '2. 月薪下限 13K 起,低于这个数不投。',
    '3. 黑名单里的公司不投。',
    '4. 满足任意一条就投:',
    '   ① 月薪下限 20K 以上;',
    '   ② 1000 人以上的互联网/软件公司(银行、车企、国企这类传统企业,只要设有成规模研发中心的也算);',
    '   ③ 10000 人以上的非互联网公司;',
    '   ④ 公司在某市(地点可以一票通过)。',
    '5. 公司规模、薪资读不出来时自己判断;判断不了就不要放行。',
    '【黑名单】某某科技、某某网络',
  ].join('\\n');

  // 「填入示例」用的招呼语模板。**这一条会被原样发出去** —— 配了样式就不经过模型
  // (见 server 侧 pickSample)。所以它不能像规则那样加一行【只是示例】的护栏:
  // 那个前缀会变成一句荒唐的开场白。护栏只能放在点击后的状态提示里。
  var SAMPLE_GREETING = '硕士毕业、大厂实习过、项目对口、拿过竞赛奖,很划算的!';

  var since = 0;
  var scope = 'current';
  var stats = null;
  var daily = [];
  // 轮询在途标记:setInterval 到点即触发,上一次 fetch 未回时再发请求会带同一个
  // since,同一批记录被插入两次 —— 表格里一行岗位看起来像跑了两个岗位。
  var inflight = false;
  // 记住服务端 runId,用来识别服务重启(runId 变)或 data/ 被清空(seq 回退)。
  var seenRunId = '';

  // 招呼样式列表。samples 是服务端返回的那份(唯一事实来源),本地只额外记一个
  // 「哪一行正在编辑」,免得两边各存一份内容后互相对不上。
  var samples = [];
  var editingIndex = -1;   // -1 无;0..length-1 改某行;length 表示新增行

  var statsEl = document.getElementById('stats');
  var rowsEl = document.getElementById('rows');
  var emptyEl = document.getElementById('empty');
  var bannerEl = document.getElementById('banner');
  var scopeBtn = document.getElementById('btnScope');
  var chartEl = document.getElementById('chart');
  var ratioEl = document.getElementById('ratio');
  var promptEl = document.getElementById('decisionPrompt');
  var promptBtn = document.getElementById('btnPrompt');
  var promptStatusEl = document.getElementById('promptStatus');
  var sampleBtn = document.getElementById('btnSample');
  var ruleWarnEl = document.getElementById('ruleWarn');
  var profileWarnEl = document.getElementById('profileWarn');
  var samplesEl = document.getElementById('samples');
  var addSampleBtn = document.getElementById('btnAddSample');
  var sampleGreetingBtn = document.getElementById('btnSampleGreeting');
  var sampleStatusEl = document.getElementById('sampleStatus');
  var svcBtn = document.getElementById('svcBtn');
  var aiEndpointEl = document.getElementById('aiEndpoint');
  var aiKeyEl = document.getElementById('aiKey');
  var aiModelEl = document.getElementById('aiModel');
  var aiSaveBtn = document.getElementById('btnAiSave');
  var aiTestBtn = document.getElementById('btnAiTest');
  var aiClearBtn = document.getElementById('btnAiClear');
  var aiStatusEl = document.getElementById('aiStatus');

  function clock(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return String(d.getHours()).padStart(2, '0') + ':' +
           String(d.getMinutes()).padStart(2, '0') + ':' +
           String(d.getSeconds()).padStart(2, '0');
  }

  function verdictCell(v) {
    if (v === true) return '<span class="ok">投</span>';
    if (v === false) return '<span class="no">不投</span>';
    return '<span class="num">—</span>';
  }

  function stageCell(s) {
    return s === 'sent' ? '<span class="ok">已发</span>' : '<span class="num">跳过</span>';
  }

  // 元素内容上下文:借 textContent→innerHTML 让浏览器转义 & < >。
  // 注意它**不转义引号** —— 所以属性上下文必须用下面的 attr(),不能用这个。
  function cell(value) {
    var div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  // 属性上下文(title="..."/value="...")要另外转义引号:一个双引号就能截断属性值,
  // 甚至注入一个新属性(如 onmouseover)。招呼语是自由文本、引号常见,
  // 不转义的话"悬停显示全文"会被静默截断 —— 这不是纯理论风险。
  function attr(value) {
    return cell(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isAnomaly(r) {
    return r.verdict === true && r.stage !== 'sent';
  }

  function rowHtml(r) {
    var detail = r.greeting || r.reason || '';
    var tone = isAnomaly(r)
      ? '<span class="bad">判定投了但没发出去</span> — ' + cell(detail)
      : cell(detail);

    return '<tr class="' + (isAnomaly(r) ? 'anomaly' : '') + '">' +
      '<td class="num">' + cell(clock(r.at)) + '</td>' +
      '<td>' + cell(r.company) + '</td>' +
      '<td class="num">' + cell(r.companyScale) + '</td>' +
      '<td>' + cell(r.jobName) + '</td>' +
      '<td class="num">' + cell(r.city) + '</td>' +
      '<td class="num">' + cell(r.salary) + '</td>' +
      '<td>' + verdictCell(r.verdict) + '</td>' +
      '<td>' + stageCell(r.stage) + '</td>' +
      '<td class="text" title="' + attr(detail) + '"><div>' + tone + '</div></td>' +
      '</tr>';
  }

  function totalFor(label) {
    if (!stats) return 0;
    if (label === '已判定') return stats.total.judged;
    if (label === '已沟通') return stats.total.sent;
    if (label === '已跳过') return stats.total.skipped;
    return stats.total.anomaly;
  }

  function block(label, value, extraClass) {
    // 本轮视图下顺带把累计数字挂在后面,省得来回切。
    var suffix = scope === 'current' ? '（累计 ' + totalFor(label) + '）' : '';
    return '<div class="stat ' + extraClass + '">' +
      '<b>' + value + '</b>' +
      '<span>' + label + '</span>' +
      '<small>' + (scope === 'current' ? '本轮' : '累计') + suffix + '</small>' +
      '</div>';
  }

  function renderStats() {
    if (!stats) return;
    var s = scope === 'current' ? stats.current : stats.total;
    statsEl.innerHTML =
      block('已判定', s.judged, '') +
      block('已沟通', s.sent, '') +
      block('已跳过', s.skipped, '') +
      block('发送异常', s.anomaly, s.anomaly > 0 ? 'anomaly' : '');
  }

  // ---- 每日柱状图 ----

  // 本地日期键。必须与服务端 dailyCounts 的口径一致:服务端按本地日期分组,
  // 这里补齐空日与截取窗口时也得用本地日期,否则两端会差一天。
  function localDateKey(date) {
    return date.getFullYear() + '-' +
      String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0');
  }

  function renderChart() {
    if (!daily.length) {
      chartEl.innerHTML = '<div class="empty">暂无数据</div>';
      ratioEl.textContent = '';
      return;
    }

    var byDate = {};
    for (var i = 0; i < daily.length; i++) byDate[daily[i].date] = daily[i];

    // 服务端只回**有记录**的日期,中间的空日要在这里补齐 —— 缺了这一步,
    // 9/20 和 9/25 会被画成相邻的两根柱子,看起来像每天都跑了。
    var anchor = new Date(daily[daily.length - 1].date + 'T00:00:00');
    var days = [];
    for (var back = CHART_DAYS - 1; back >= 0; back--) {
      var day = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - back);
      var key = localDateKey(day);
      var hit = byDate[key];
      days.push({ key: key, sent: hit ? hit.sent : 0, judged: hit ? hit.judged : 0 });
    }

    // 已投递 ⊆ 已判定,两根柱子是包含关系而不是「一部分 + 一部分」,所以不能按两者之和
    // 缩放 —— 那会让每天都只剩半截。取窗口内两根柱子里的最大值统一缩放,高度才可比。
    var max = 0;
    for (var d = 0; d < days.length; d++) {
      max = Math.max(max, days[d].sent, days[d].judged);
    }

    // 筛选倍数 = 已判定 ÷ 已投递,在窗口内先各自求和再相除。
    // 不能把每天的比值再平均 —— 投递少的那些天会被等权,把一个几乎没跑的日子算成和大日子一样重。
    // 它衡量的是「筛选力度」而不是「效果」:每日投递有上限,倍数高只说明捞进来的岗位里
    // 大部分被判掉了(规则严,或者搜索条件开太宽),不代表挑得准。
    // 分母为 0(窗口中一份都没投出去)时不能说 0 也不能说 Infinity,给个占位符。
    var sumSent = 0;
    var sumJudged = 0;
    for (var r = 0; r < days.length; r++) {
      sumSent += days[r].sent;
      sumJudged += days[r].judged;
    }
    // 已投递不足阈值就不给数字,退回占位符 —— 见 MIN_SENT_FOR_RATIO 的说明。
    // 这个条件同时兜住了分母为 0:sumSent ≥ 20 必然 > 0。
    ratioEl.textContent = sumSent >= MIN_SENT_FOR_RATIO
      ? '筛选倍数 ×' + (sumJudged / sumSent).toFixed(2)
      : '筛选倍数 --';

    // 柱子高度按各自的值相对窗口内最大值缩放。上限留 88% 而不是 100% —— 柱子顶部
    // 要压一个数字标签,占满高度的话最高的一根会把标签顶出 .bars 容器。
    // 非零值再兜一个 2% 的下限:舍入到 0 会让「跑过但只成功一条」的一整天
    // 在图上完全消失,与「没跑」看着一样。
    function heightOf(value) {
      if (!value || !max) return 0;
      return Math.max(2, Math.round(value / max * 88));
    }

    chartEl.innerHTML = days.map(function (day) {
      var label = day.key.slice(5);
      var tip = label + ' 已投递 ' + day.sent + ' / 已判定 ' + day.judged;
      return '<div class="day" title="' + attr(tip) + '">' +
        '<div class="bars">' +
          '<div class="barcol">' +
            '<span class="bar-val ok">' + day.sent + '</span>' +
            '<div class="bar ok" style="height:' + heightOf(day.sent) + '%"></div>' +
          '</div>' +
          '<div class="barcol">' +
            '<span class="bar-val no">' + day.judged + '</span>' +
            '<div class="bar no" style="height:' + heightOf(day.judged) + '%"></div>' +
          '</div>' +
        '</div>' +
        '<div class="day-label">' + cell(label) + '</div>' +
        '</div>';
    }).join('');
  }

  // ---- 记录表 ----

  function trimRows() {
    while (rowsEl.children.length > MAX_ROWS) {
      rowsEl.removeChild(rowsEl.lastChild);
    }
  }

  function appendRecords(records) {
    if (!records.length) return;
    var buffer = '';
    for (var i = 0; i < records.length; i++) {
      buffer += rowHtml(records[i]);
      if (records[i].seq > since) since = records[i].seq;
    }
    // 新记录插到顶部 —— 追加而不是整表重绘,避免每 1.5 秒闪一次。
    rowsEl.insertAdjacentHTML('afterbegin', buffer);
    trimRows();
    emptyEl.style.display = rowsEl.children.length ? 'none' : 'block';
  }

  // ---- 服务状态 ----

  // 这盏灯只有一个写入者:那条一直挂着的大屏连接(/api/watch)。
  // 连接在 = 服务在,连接断 = 服务没了;EventSource 自己会重连,重连上就又变绿。
  // 之所以要「只有一个写入者」:以前 1.5 秒一次的 poll() 失败也会把灯拨红,
  // 于是 /api/records 偶发抖动就会出现「服务好好的,灯却是红的」——
  // 多个地方各写各的,谁也说不清当前是什么状态。
  // 这个按钮只能当状态灯和手动重连用,不能真的去启动服务:页面本身就是那个服务
  // 吐出来的,浏览器也没有权限去拉起你电脑上的 node 进程。
  var watch = null;

  function setSvcState(state) {
    svcBtn.classList.toggle('up', state === 'up');
    svcBtn.classList.toggle('down', state === 'down');
    svcBtn.textContent = state === 'up' ? '服务运行中'
      : (state === 'down' ? '服务未连接' : '启动中');
  }

  // 挂上这条连接。服务端靠它判断「还有人在看大屏」——页面关掉这条连接就断了,
  // 服务会在宽限期后自己退出。重连(刷新、切回来、断线重试)由 EventSource 负责。
  function openWatch() {
    if (watch) watch.close();
    watch = new EventSource('/api/watch');
    watch.addEventListener('open', function () { setSvcState('up'); });
    // 这里不区分「服务没了」和「网络抖了一下」:连不上就是连不上,重连成功自然会回到绿色。
    watch.addEventListener('error', function () { setSvcState('down'); });
  }

  // 只为「没加载到简历」那条警告条去查 /health:一份简历都没有 = 一个岗位都投不出去,
  // 这个原因必须写在页面上,不能让人去猜岗位为什么全被跳过。
  function checkProfile() {
    fetch('/health')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (health) {
        if (!health) return;
        profileWarnEl.classList.toggle('show', health.profiles === 0);
      })
      // 查不到就维持现状,别把警告条闪一下又收回去。
      .catch(function () {});
  }

  svcBtn.addEventListener('click', function () {
    setSvcState('starting');
    openWatch();
    checkProfile();
  });

  function poll() {
    if (inflight) return;
    inflight = true;

    fetch('/api/records?since=' + since)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        bannerEl.classList.remove('show');

        // runId 变化 = 服务端重启;seq 回退到本地游标之下 = 文件被清空。
        // 两种情况本地 since 都已失效,表现为"连接正常却再也不更新"且没有 banner。
        // 清零游标并清表,下一次轮询(1.5s 内)会带 since=0 拉全量。
        // 这里不递归调用 poll,避免与在途请求打架。
        // 首次轮询时 seenRunId 还是空串,不能算"身份变化" —— 否则首屏会被误清、
        // 要等下一轮才出内容。只有见过一次之后 runId 变了,才是服务端重启。
        // 注意:seenRunId 必须每轮都更新(含正常路径),否则它永远停在空串,
        // 「见过一次之后」这个前提不成立,服务重启就再也检测不到了。
        var runIdChanged = !!seenRunId && data.runId !== seenRunId;
        seenRunId = data.runId;
        if (runIdChanged || data.seq < since) {
          since = 0;
          rowsEl.innerHTML = '';
          emptyEl.style.display = 'block';
          return;
        }

        stats = data.stats;
        daily = data.daily || [];
        appendRecords(data.records || []);
        renderStats();
        renderChart();
      })
      .catch(function () {
        // 服务可能刚重启或短暂不可达 —— 提示但不停止重试,页面也不清空。
        // 状态灯不在这里改:它的唯一依据是那条大屏连接,见 openWatch()。
        bannerEl.classList.add('show');
      })
      .finally(function () { inflight = false; });
  }

  // ---- 配置读写 ----

  // 统一的 POST JSON 入口(保存配置、测试连通都走它)。返回 Promise,调用方自己决定怎么呈现。
  function postJson(url, patch) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(function (res) {
      return res.json().then(function (data) {
        // 服务端把校验失败的原因放在 error 里,直接显示给用户 ——
        // 笼统的「保存失败」会让人不知道该改哪里。
        if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  function postSettings(patch) {
    return postJson('/api/settings', patch);
  }

  function setStatus(el, text, tone) {
    el.textContent = text;
    el.className = 'status' + (tone ? ' ' + tone : '');
  }

  // ---- 打招呼判定(锁定 / 编辑 双态) ----

  // 记的是**已保存**的规则,不是文本框里的草稿 —— 警告条必须反映"现在真正生效的是什么",
  // 否则用户刚打两个字、还没保存,红条就消失了,而实际上一个岗位都投不出去。
  var savedRule = '';

  function updateRuleWarn() {
    ruleWarnEl.classList.toggle('show', !savedRule.trim());
  }

  // 载入即锁定:能载入就说明服务上已经有一份值,把它当成"已保存"状态,
  // 免得用户改了一半没点保存就走了、下次打开看到的是没生效的草稿。
  function setPromptMode(mode) {
    var editing = mode === 'editing';
    promptEl.readOnly = !editing;
    promptBtn.textContent = editing ? '保存' : '编辑';
    promptBtn.classList.toggle('on', editing);
    if (editing) promptEl.focus();
  }

  promptBtn.addEventListener('click', function () {
    if (promptBtn.textContent === '编辑') {
      setPromptMode('editing');
      setStatus(promptStatusEl, '', '');
      return;
    }

    promptBtn.disabled = true;
    setStatus(promptStatusEl, '保存中…', '');
    postSettings({ decisionPrompt: promptEl.value })
      .then(function () {
        setStatus(promptStatusEl, '已保存,下一个岗位立即生效', 'ok');
        savedRule = promptEl.value;
        updateRuleWarn();
        // 存成空规则就等于回到「一个都不投」,这时别把框锁上 —— 用户显然还在改。
        setPromptMode(savedRule.trim() ? 'locked' : 'editing');
      })
      .catch(function (error) {
        setStatus(promptStatusEl, '保存失败:' + (error.message || error), 'bad');
      })
      .finally(function () { promptBtn.disabled = false; });
  });

  sampleBtn.addEventListener('click', function () {
    setPromptMode('editing');
    if (promptEl.value.trim()) {
      // 非空就不覆盖 —— 这个按钮是给空框起步用的,不是「重置」。
      setStatus(promptStatusEl, '文本框已有内容,没有覆盖', '');
      return;
    }
    promptEl.value = SAMPLE_RULE;
    setStatus(promptStatusEl, '已填入示例,按你的情况改完再点保存', '');
  });

  // ---- 打招呼样式(列表,增删改立即落盘) ----

  function renderSamples() {
    var html = '';

    for (var i = 0; i < samples.length; i++) {
      if (i === editingIndex) {
        html += '<div class="sample editing">' +
          '<input id="sampleInput" value="' + attr(samples[i]) + '">' +
          '<button type="button" data-act="commit" data-i="' + i + '">确定</button>' +
          '<button type="button" data-act="cancel">取消</button>' +
          '</div>';
      } else {
        html += '<div class="sample">' +
          '<span class="sample-text" title="' + attr(samples[i]) + '">' + cell(samples[i]) + '</span>' +
          '<button type="button" data-act="edit" data-i="' + i + '">编辑</button>' +
          '<button type="button" class="danger" data-act="del" data-i="' + i + '">删除</button>' +
          '</div>';
      }
    }

    // 新增行挂在列表末尾,与「添加样式」按钮的位置一致。
    if (editingIndex === samples.length) {
      html += '<div class="sample editing">' +
        '<input id="sampleInput" placeholder="例如:硕士毕业，大厂实习">' +
        '<button type="button" data-act="commit" data-i="' + samples.length + '">添加</button>' +
        '<button type="button" data-act="cancel">取消</button>' +
        '</div>';
    }

    if (!html) {
      samplesEl.innerHTML = '<div class="empty-sm">还没有样式。不填的话招呼语按原来的方式自由生成。</div>';
    } else {
      samplesEl.innerHTML = html;
    }

    // 进入编辑态就聚焦,省一次点击。放在 innerHTML 之后才拿得到元素。
    var input = document.getElementById('sampleInput');
    if (input) input.focus();
  }

  function persistSamples(next, successText) {
    setStatus(sampleStatusEl, '保存中…', '');
    return postSettings({ greetingSamples: next })
      .then(function (data) {
        // 以服务端清洗后的结果为准 —— 它会 trim、丢空行,本地照抄一份迟早会不一致。
        samples = (data.settings && data.settings.greetingSamples) || [];
        editingIndex = -1;
        // 普通保存显示「已保存」;载入示例复用同一条落盘路径时,换成提醒用户去改的那句 ——
        // 招呼语是原样发出去的,这句提示是唯一的护栏。
        setStatus(sampleStatusEl, successText || '已保存', 'ok');
        renderSamples();
      })
      .catch(function (error) {
        setStatus(sampleStatusEl, '保存失败:' + (error.message || error), 'bad');
        renderSamples();
      });
  }

  // 事件委托:列表每次重绘都会换掉所有按钮,逐个绑监听会随重绘次数泄漏。
  samplesEl.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-act]');
    if (!button) return;
    var act = button.dataset.act;
    var index = Number(button.dataset.i);

    if (act === 'edit') {
      editingIndex = index;
      setStatus(sampleStatusEl, '', '');
      renderSamples();
      return;
    }

    if (act === 'cancel') {
      editingIndex = -1;
      setStatus(sampleStatusEl, '', '');
      renderSamples();
      return;
    }

    if (act === 'del') {
      var kept = [];
      for (var i = 0; i < samples.length; i++) if (i !== index) kept.push(samples[i]);
      persistSamples(kept);
      return;
    }

    if (act === 'commit') {
      var input = document.getElementById('sampleInput');
      var value = input ? input.value.trim() : '';
      if (!value) {
        setStatus(sampleStatusEl, '样式不能为空', 'bad');
        return;
      }
      var next = samples.slice();
      if (index >= next.length) next.push(value);
      else next[index] = value;
      persistSamples(next);
    }
  });

  // 编辑行里按回车直接提交,符合"改一行小文本"的直觉。
  samplesEl.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    if (!event.target.closest('.sample.editing')) return;
    var button = samplesEl.querySelector('button[data-act="commit"]');
    if (button) button.click();
  });

  addSampleBtn.addEventListener('click', function () {
    editingIndex = samples.length;
    setStatus(sampleStatusEl, '', '');
    renderSamples();
  });

  sampleGreetingBtn.addEventListener('click', function () {
    if (samples.length) {
      // 和规则面板同一条规矩:示例只给空列表起步,不覆盖已经调好的样式。
      // 这条不能省 —— samples 是原样发出去的,覆盖等于把用户在用的招呼语悄悄换掉。
      setStatus(sampleStatusEl, '已有样式,没有覆盖', '');
      return;
    }
    persistSamples([SAMPLE_GREETING], '已填入示例,按你的情况改完再保存');
  });

  // ---- AI 接入 ----

  // 密钥框永远不回填明文(服务端也根本不回传),所以「已配置 / 未配置」只能靠提示文字
  // 表达 —— 否则用户看到空框会以为没存上,又把密钥粘一遍。
  function setKeyHint(hasKey, hint) {
    aiKeyEl.value = '';
    aiKeyEl.placeholder = hasKey ? ('已配置 ' + (hint || '') + ',留空则不修改') : '尚未配置';
  }

  function saveAi() {
    var patch = {
      aiEndpoint: aiEndpointEl.value.trim(),
      aiModel: aiModelEl.value.trim(),
    };
    // 密钥框留空 = 本次不修改。服务端按同样的约定处理(空 aiKey 不写入)——
    // 两边都守这条,用户改个模型名才不会顺手把已存的密钥清掉。
    var key = aiKeyEl.value.trim();
    if (key) patch.aiKey = key;

    aiSaveBtn.disabled = true;
    setStatus(aiStatusEl, '保存中…', '');
    postSettings(patch)
      .then(function (data) {
        var saved = (data && data.settings) || {};
        setKeyHint(saved.hasAiKey, saved.aiKeyHint);
        setStatus(aiStatusEl, '已保存,下一个岗位立即生效', 'ok');
        // 重查一次简历那条警告:清了密钥之后后果会变(判定全跳过),得让人当场看见。
        checkProfile();
      })
      .catch(function (error) {
        setStatus(aiStatusEl, error.message || String(error), 'bad');
      })
      .finally(function () { aiSaveBtn.disabled = false; });
  }

  aiSaveBtn.addEventListener('click', saveAi);

  // 「测试连通」拿页面上**当前填的**值实际打一次上游 —— 填完就能试,不必先保存。
  // 密钥框留空就回落到已存的那把(服务端按同一个约定兜底),所以想验证存着的密钥也能直接点。
  function testAi() {
    var body = {
      aiEndpoint: aiEndpointEl.value.trim(),
      aiModel: aiModelEl.value.trim(),
    };
    var key = aiKeyEl.value.trim();
    if (key) body.aiKey = key;

    aiTestBtn.disabled = true;
    setStatus(aiStatusEl, '测试中…', '');
    postJson('/api/ai/test', body)
      .then(function (data) {
        if (data.ok) {
          setStatus(aiStatusEl, '连通 · ' + (data.ms / 1000).toFixed(1) + 's · ' + (data.model || ''), 'ok');
        } else {
          // 上游给的原话(HTTP 401 / 内容为空…),照搬给用户 —— 编一句「连接失败」等于把线索扔了。
          setStatus(aiStatusEl, '测试失败:' + data.error, 'bad');
        }
      })
      .catch(function (error) {
        setStatus(aiStatusEl, '测试失败:' + (error.message || error), 'bad');
      })
      .finally(function () { aiTestBtn.disabled = false; });
  }

  aiTestBtn.addEventListener('click', testAi);

  // 回车即保存,和「改一行配置」的直觉一致。
  [aiEndpointEl, aiKeyEl, aiModelEl].forEach(function (input) {
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !aiSaveBtn.disabled) saveAi();
    });
  });

  aiClearBtn.addEventListener('click', function () {
    aiClearBtn.disabled = true;
    setStatus(aiStatusEl, '清除中…', '');
    postSettings({ clearAiKey: true })
      .then(function () {
        setKeyHint(false, '');
        setStatus(aiStatusEl, '已清除密钥,判定将全部跳过', 'ok');
        checkProfile();
      })
      .catch(function (error) {
        setStatus(aiStatusEl, error.message || String(error), 'bad');
      })
      .finally(function () { aiClearBtn.disabled = false; });
  });

  // 只在页面加载时读一次,**不进轮询循环**:进了的话用户正在输入时会被服务端的
  // 旧值覆盖,打到一半的规则突然消失。
  function loadSettings() {
    fetch('/api/settings')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        savedRule = data.decisionPrompt || '';
        promptEl.value = savedRule;
        updateRuleWarn();
        // 已经有规则就锁住(那才是「已保存」的状态);还没有就直接开放编辑 ——
        // 一个空框还锁着,只会让第一次用的人以为这个功能坏了。
        setPromptMode(savedRule.trim() ? 'locked' : 'editing');
        samples = data.greetingSamples || [];
        renderSamples();
        aiEndpointEl.value = data.aiEndpoint || '';
        aiModelEl.value = data.aiModel || '';
        // 密钥不回填 —— 服务端不回传明文,这里只用末四位提示「已配置 / 未配置」。
        setKeyHint(data.hasAiKey, data.aiKeyHint);
      })
      .catch(function (error) {
        // 读不到就别锁 —— 锁住的话这个框彻底没法用,而用户可能正是来改它的。
        setPromptMode('editing');
        setStatus(promptStatusEl, '配置读取失败:' + (error.message || error), 'bad');
        samplesEl.innerHTML = '<div class="empty-sm">配置读取失败</div>';
      });
  }

  function reloadAll() {
    since = 0;
    rowsEl.innerHTML = '';
    emptyEl.style.display = 'block';
    poll();
  }

  scopeBtn.addEventListener('click', function () {
    scope = scope === 'current' ? 'all' : 'current';
    // 文案强调"统计":这个开关只切换上方四个数字的口径,下方表格始终是全量。
    // 叫「本轮/累计」会让人以为表格也被过滤,出现"已判定 5"配 200 行的错觉。
    scopeBtn.textContent = scope === 'current' ? '本轮统计' : '累计统计';
    scopeBtn.classList.toggle('on', scope === 'all');
    reloadAll();
  });

  document.getElementById('btnExport').addEventListener('click', function () {
    location.href = '/api/export.csv';
  });

  renderSamples();
  loadSettings();
  // 首屏就把「没加载到简历」这条说清楚。光看状态灯是绿的会让人以为一切正常,
  // 而一份简历都没有时其实一个岗位都投不出去。
  checkProfile();
  // 这条连接也是「服务跟随本页」的开关,见 openWatch()。
  openWatch();
  poll();
  setInterval(poll, POLL_MS);
</script>
</body>
</html>`;
}
