// 看板页面。纯原生 HTML/CSS/JS —— 不引任何外部资源,因为本项目约定零依赖,
// 而这个页面要在无外网的本地环境里也能正常打开。
//
// 整页分两页(设置 / 投递记录),用两组 DOM 互斥显示,不是两条路由 ——
// 理由见内联脚本「两个页面」那一节。
export function renderDashboardHtml(options = {}) {
  const pollMs = Number(options.pollMs) > 0 ? Math.floor(Number(options.pollMs)) : 1500;
  const maxRows = Number(options.maxRows) > 0 ? Math.floor(Number(options.maxRows)) : 100;

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

  /* 整页两段:标题栏(含分页标签) / 视图区。
     视图区里两个页面互斥:一页放配置,一页放柱状图和记录表。
     用 minmax(0, 1fr) 而不是 1fr —— 默认的 min-height:auto 会让表格把行撑开,
     整页跟着长高,下半就永远不出滚动条。 */
  .screen { display: flex; flex-direction: column; gap: 12px;
            padding: 12px; height: 100%; }

  /* ---- 标题栏 ---- */
  .head { display: flex; flex-direction: column; gap: 8px; }
  .topbar { display: flex; align-items: center; justify-content: space-between;
            flex-wrap: wrap; gap: 16px; padding: 12px 16px; background: #161b22;
            border: 1px solid #30363d; border-radius: 8px; }
  .topbar h1 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: .5px; }

  /* ---- 分页标签 ---- */
  /* 两页的分工要写在这里:一进来就能看出「先去左边配,配完去右边看」。 */
  .tabs { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .tabs .hint { margin: 0 0 0 auto; }
  .tab { background: transparent; color: #8b949e; padding: 7px 16px; font-size: 13px; }
  .tab:hover { background: #21262d; color: #e6edf3; }
  .tab.active { background: #1f6feb; border-color: #1f6feb; color: #fff; }

  /* 没配规则 / 没填知识库时的警告条。刻意做成整条通栏 + 红底,而不是靠面板上的一行小字 ——
     「当前不会投递任何岗位」这件事如果只体现为一个 0,用户会去查脚本、查网络,
     而真正的原因是这里没填。两条放在标题栏里,两页都能看到:投递页看到「没投」时,
     不该只有切回设置页才知道为什么。 */
  #ruleWarn, #knowledgeWarn { display: none; padding: 10px 16px; border-radius: 8px;
              background: #2d1416; border: 1px solid #6e2b28; color: #ff9b95; font-size: 12px; }
  #ruleWarn.show, #knowledgeWarn.show { display: block; }
  #ruleWarn strong, #knowledgeWarn strong { color: #ff7b72; }

  #svcBtn { min-width: 92px; }
  /* 状态灯:启动中(灰) / 运行中(绿) / 未连接(红)。三个状态的颜色本身就是信息,
     所以用配色而不是额外的圆点图标。 */
  #svcBtn.up { border-color: #238636; color: #3fb950; background: #12261a; }
  #svcBtn.down { border-color: #6e2b28; color: #f85149; background: #2d1416; }

  /* 「安装油猴脚本」做成链接而不是按钮:篡改猴只认「导航到一个 .user.js 地址」这一种
     安装触发方式,所以必须是 <a href> 而不是 fetch 完再拼 blob。
     样式上跟旁边的按钮齐平,免得看起来像个不起眼的脚注。 */
  #installScript { display: inline-block; padding: 6px 12px; border: 1px solid #30363d;
                   border-radius: 6px; background: #21262d; color: #e6edf3;
                   font-size: 12px; text-decoration: none; white-space: nowrap; }
  #installScript:hover { background: #30363d; }

  /* 顶栏里那行说明:也是次要文字,但在 flex 行里要换成「把剩余空间吃掉」的左外边距,
     好让它和状态灯一起靠右,同时抵掉 .hint 自带的下外边距(否则会比按钮低一点点)。 */
  .topbar .hint { margin: 0 0 0 auto; }
  /* 启停失败的报错可能很长,别让它把顶栏撑开。 */
  #ctrlStatus { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ---- 视图区:两个页面互斥 ---- */
  .view { display: none; flex: 1; min-height: 0; }
  .view.active { display: grid; gap: 12px; }
  /* 设置页:三栏等宽,规则 / (样式 + 知识库) / AI 接入。
     行必须写成 minmax(0, 1fr) 而不是默认的 auto:auto 行的高度由内容撑,
     而 textarea 是 flex:1、内容为空时几乎没有自然高度,三块面板会缩成一条。
     让这一行吃掉视图区的全部高度,再靠面板内部的 flex 把文本框拉开。 */
  #viewSettings { grid-template-columns: repeat(3, minmax(0, 1fr));
                  grid-template-rows: minmax(0, 1fr); }
  /* 中间栏上下两块:打招呼样式在上,它下面的知识库在下。
     两块都要 flex 撑满整栏:只按内容高度排的话,下面会空出一大截白,
     而知识库这个最需要空间的文本框反而最短。知识库给得比样式更宽裕 ——
     它才是每投一次都要被读的那份资料。 */
  .col { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
  .col > .panel { flex: 1 1 0; min-height: 0; }
  .col > .panel:last-child { flex-grow: 1.6; }
  /* 投递页:左边柱状图、右边记录表。
     两列的比例按「记录表要能放下九列」来定 —— 表可以横向滚动,但图一旦窄到
     柱子挤在一起就彻底没法看,所以图那一栏给三分之一多一点的固定份额。 */
  #viewDelivery { grid-template-columns: minmax(280px, 5fr) minmax(0, 8fr);
                  grid-template-rows: minmax(0, 1fr); }

  .panel { display: flex; flex-direction: column; min-height: 0;
           background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 10px 12px; }
  .panel h2 { margin: 0 0 3px; font-size: 13px; font-weight: 600; }
  .hint { margin: 0 0 7px; font-size: 11px; color: #6e7681; }
  /* 筛选倍数:这张图最该被一眼看到的数,所以单独占一行、字号明显大于正文,用「已投递」
     同款绿色。tabular-nums 让数字位数变化时不左右跳动。 */
  .ratio { margin: 0; font-size: 22px; font-weight: 700; color: #3fb950;
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

  /* ---- AI 接入 ---- */
  /* 字段装在可滚动容器里:窄屏折成单列时,固定高度的面板会靠 flex 把
     最下面那个输入框挤没,所以它自己滚。 */
  .ai-fields { flex: 1; min-height: 0; overflow-y: auto; }
  .field { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
  .field label { font-size: 11px; color: #8b949e; }
  .field input { background: #0d1117; color: #e6edf3; border: 1px solid #30363d;
                 border-radius: 6px; padding: 6px 8px; font-family: inherit; font-size: 12px; }
  .field input:focus { outline: none; border-color: #1f6feb; }
  .field input::placeholder { color: #4d5560; }

  /* ---- 柱状图 ---- */
  /* 左右布局下这一栏有整列的高度可用,图就跟着长高 —— 固定 170px 会在面板里
     留一大片空白。柱高按 .bars 的百分比算,所以 .bars 也一起吃掉剩余高度。 */
  .chart-panel { gap: 0; }
  .chart-head { display: flex; align-items: baseline; gap: 18px; flex-wrap: wrap;
                margin-bottom: 10px; }
  .chart { display: flex; flex: 1; align-items: flex-end; gap: 8px; min-height: 140px;
           overflow-x: auto; }
  /* 每天一列,用 grid 而不是 flex 竖排:柱高是按 .bars 的百分比算的,
     而百分比只在父元素高度确定时才成立。grid 的 1fr 行会给出确定高度,
     flex 纵向布局里 .bars 的高度只是「内容撑出来的」,柱高会全部塌成 0。 */
  .day { flex: 1 1 0; min-width: 52px; max-width: 130px; height: 100%;
         display: grid; grid-template-rows: minmax(0, 1fr) auto;
         justify-items: center; align-items: end; gap: 5px; }
  .bars { display: flex; align-items: flex-end; justify-content: center; gap: 4px;
          width: 100%; height: 100%; min-height: 0; }
  /* 每根柱子包一列:数字标签在上、柱体在下,两者贴在一起。柱高按 .bars 的
     132px 算百分比,所以这里必须是确定高度,百分比才成立。 */
  .barcol { display: flex; flex-direction: column; align-items: center;
            justify-content: flex-end; height: 100%; }
  .bar-val { flex: none; font-size: 10px; line-height: 13px;
             font-variant-numeric: tabular-nums; color: #6e7681; }
  .bar-val.ok { color: #3fb950; }
  .bar-val.no { color: #8b949e; }
  .bar { width: 16px; border-radius: 2px 2px 0 0; }
  /* 高度为 0 的柱子真会消失,而「这天跑过但一条都没成」和「这天没跑」在图上
     必须看得出来 —— 由 JS 给非零值兜一个最小高度,这里只管颜色。 */
  .bar.ok { background: #3fb950; }
  .bar.no { background: #8b949e; }
  .day-label { font-size: 10px; color: #6e7681; white-space: nowrap; }

  .legend { display: flex; align-items: center; gap: 14px; margin-left: auto;
            font-size: 11px; color: #8b949e; }
  .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px;
              margin-right: 4px; }
  .legend i.ok { background: #3fb950; }
  .legend i.no { background: #8b949e; }
  .legend-note { margin-left: auto; color: #6e7681; }

  /* ---- 记录表 ---- */
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
    .screen { height: auto; min-height: 100%; }
    /* 手机上把中间栏拆开:col 用 display:contents 后,它里面那两块直接参与
       外层单列网格。不拆的话这一栏只分到一份行高,样式和知识库各挤成一条。 */
    #viewSettings { grid-template-columns: 1fr; grid-template-rows: none;
                    grid-auto-rows: minmax(220px, auto); }
    .col { display: contents; }
    #viewDelivery { grid-template-columns: 1fr; grid-template-rows: auto 70vh; }
    .tab { padding: 6px 12px; }
    .tabs .hint { display: none; }
    /* 手机上统计数字和「本轮统计 / 导出 CSV」挤不进一行:横着排会把按钮压成
       一条窄条、文字竖着折行。改成上下两段,按钮靠右,各自都完整。 */
    .bottom-bar { flex-direction: column; align-items: stretch; gap: 10px; }
    .stats { gap: 18px; flex-wrap: wrap; justify-content: space-between; }
    .stat b { font-size: 18px; }
    .actions { justify-content: flex-end; }
    /* 7 组柱子挤不进 390px:收窄柱宽与间隙,目标是整周一眼看全,而不是左右拖。 */
    .chart { gap: 2px; }
    .day { min-width: 40px; }
    .bars { gap: 3px; }
    .bar { width: 11px; }
    .ratio { font-size: 19px; }
  }
  /* ---- 首次使用教学 ----
     两层:一个问「要不要教」的对话框,和一层「走到哪一步」的引导。

     引导层用 pointer-events:none,高亮块靠 box-shadow 拉出一大片暗色 —— 这样
     被指到的控件仍然可以点、可以打字,用户边看边操作,而不是先看完再自己找。
     整个教学只是 DOM 和 class,不引入任何外部资源。 */
  .tour-ask { position: fixed; inset: 0; z-index: 60; display: flex;
              align-items: center; justify-content: center; padding: 16px;
              background: rgba(1, 4, 9, .72); }
  .tour-ask[hidden] { display: none; }
  .tour-ask-card { width: min(400px, calc(100vw - 32px)); background: #161b22;
                   border: 1px solid #1f6feb; border-radius: 10px; padding: 18px 20px;
                   box-shadow: 0 18px 48px rgba(0, 0, 0, .55); }
  .tour-ask-card h3 { margin: 0 0 8px; font-size: 15px; }
  .tour-ask-card p { margin: 0 0 16px; font-size: 12px; line-height: 1.7; color: #8b949e; }

  .tour-layer { position: fixed; inset: 0; z-index: 55; pointer-events: none; }
  .tour-layer[hidden] { display: none; }
  .tour-layer.dim { background: rgba(1, 4, 9, .68); }
  .tour-spot { position: absolute; border-radius: 8px;
               box-shadow: 0 0 0 9999px rgba(1, 4, 9, .68);
               border: 2px solid #1f6feb; pointer-events: none;
               transition: left .18s ease, top .18s ease, width .18s ease, height .18s ease; }
  .tour-spot[hidden] { display: none; }
  .tour-card { position: fixed; z-index: 56; width: min(380px, calc(100vw - 24px));
               background: #161b22; border: 1px solid #1f6feb; border-radius: 10px;
               padding: 14px 16px; pointer-events: auto;
               box-shadow: 0 18px 48px rgba(0, 0, 0, .55); }
  .tour-step { font-size: 11px; color: #6e7681; margin-bottom: 4px; }
  .tour-card h3 { margin: 0 0 6px; font-size: 14px; }
  .tour-card p { margin: 0 0 14px; font-size: 12px; line-height: 1.7; color: #c9d1d9; }
  .tour-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }

</style>
</head>
<body>
<div class="screen">
  <div class="head">
    <div class="topbar">
      <h1>HelloBoss</h1>
      <span class="hint">控制台跟着本页:最小化不影响;关掉这个标签页后控制台和正在运行的服务都会停止</span>
      <span class="status" id="ctrlStatus"></span>
      <button id="btnTour" type="button" title="重新看一遍使用教学">使用教学</button>
      <a id="installScript" href="/install.user.js" title="把油猴脚本装进这个浏览器(需要先装篡改猴 / Tampermonkey)">安装油猴脚本</a>
      <button id="svcBtn" type="button" title="启动或停止后台判定服务">启动服务</button>
    </div>

    <nav class="tabs">
      <button class="tab active" type="button" data-view="settings">① 设置</button>
      <button class="tab" type="button" data-view="delivery">② 投递记录</button>
      <span class="hint">先在「设置」里配好,再到「投递记录」看结果 —— 改完保存立即生效,不用重启服务</span>
    </nav>

    <div id="ruleWarn">
      还没配置投递规则,当前<strong>不会投递任何岗位</strong>。
      请在「① 设置」页的「打招呼判定」里写下你的规则并保存 —— 规则完全由你决定,服务端不内置任何默认规则。
    </div>
    <div id="knowledgeWarn">
      知识库还是空的,当前<strong>不会投递任何岗位</strong>。
      请在「① 设置」页的「打招呼样式」下面,把你的简历内容直接粘进「知识库」里并保存 ——
      判定和招呼语都只按这里的文字写,没有它就只能一个都不投。
    </div>
  </div>

  <!-- 第一页:设置。三块配置一屏放完,不用滚动去找。 -->
  <section class="view active" id="viewSettings">
    <section class="panel" id="panelRule">
      <h2>打招呼判定</h2>
      <p class="hint">留空时不会投递任何岗位。规则里写上城市、规模、薪资这些数字 —— 服务端不内置任何一份</p>
      <textarea id="decisionPrompt" placeholder="例如:月薪 20K 以上直接投;否则公司规模 1000 人以上才投,创业小公司不投"></textarea>
      <div class="panel-foot">
        <button id="btnPrompt" type="button">编辑</button>
        <button id="btnSample" type="button">填入示例</button>
        <span class="status" id="promptStatus"></span>
      </div>
    </section>

    <!-- 中间栏:上面是「怎么写」,下面是「写什么」—— 两块挨着放,改完样式顺手就能改知识库。 -->
    <div class="col">
      <section class="panel" id="panelGreeting">
        <h2>打招呼样式</h2>
        <p class="hint">这里写的是<strong>对 AI 的要求</strong>,不逐字发出 —— 所以可以随便写多写细,也不会出现「同一句话连发几百遍」。留空则只按知识库和 JD 写</p>
        <textarea id="greetingPrompt" placeholder="例如：&#10;对照 JD 提到的方向，说你确实做过的那部分。&#10;结尾落到「感觉非常适合这份工作」。&#10;不要点公司名，也不要说具体技术名词。"></textarea>
        <div class="panel-foot">
          <button id="btnGreetingSave" type="button">保存</button>
          <button id="btnGreetingSample" type="button">填入示例</button>
          <span class="status" id="greetingStatus"></span>
        </div>
      </section>

      <section class="panel" id="panelKnowledge">
        <h2>知识库</h2>
        <p class="hint">把你的简历内容<strong>直接粘进来</strong>,不用管格式 —— 判定与招呼语都只按这里的文字写。留空时不会投递任何岗位</p>
        <textarea id="knowledge" placeholder="把简历全文粘在这里即可,例如:&#10;姓名、学校与专业&#10;实习 / 工作经历:公司、岗位、做了什么&#10;项目经历:项目名、你负责的部分&#10;技能与获奖(可选)"></textarea>
        <div class="panel-foot">
          <button id="btnKnowledgeSave" type="button">保存</button>
          <span class="status" id="knowledgeStatus"></span>
        </div>
      </section>
    </div>

    <section class="panel" id="panelAi">
      <h2>AI 接入</h2>
      <p class="hint">判定与招呼语都用这里配的模型。密钥只留在本机 data/settings.json,不会随记录上报</p>
      <p class="hint">接口格式按端点地址自动识别:以 /chat/completions 结尾走 OpenAI 格式,否则走 Anthropic Messages 格式 —— 不用另配</p>
      <div class="ai-fields">
        <div class="field">
          <label for="aiEndpoint">端点地址</label>
          <input id="aiEndpoint" type="text" placeholder="Anthropic Messages 或 OpenAI Chat Completions 兼容端点">
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
  </section>

  <!-- 第二页:投递记录。上面柱状图,下面流水。 -->
  <section class="view" id="viewDelivery">
    <section class="panel chart-panel">
      <h2>每日投递量</h2>
      <p class="hint">已判定 = 当天拿到 AI 判定结论的岗位(含已投递);黑名单 / 已沟通等前置跳过未走到判定,不计入</p>
      <div class="chart-head">
        <span class="ratio" id="ratio"
              title="最近 7 天:已判定 ÷ 已投递。倍数越高 = 每投出 1 份要判掉越多份,衡量的是筛选力度,不是投递效果。窗口内已投递不足 20 份时样本太小,不显示数字"></span>
        <div class="legend">
          <span><i class="ok"></i>已投递</span>
          <span><i class="no"></i>已判定</span>
          <span class="legend-note">最近 7 天</span>
        </div>
      </div>
      <div class="chart" id="chart"></div>
    </section>

    <div class="bottom panel">
      <div class="bottom-bar">
        <div class="stats" id="stats"></div>
        <div class="actions">
          <button id="btnScope" type="button">本轮统计</button>
          <button id="btnExport" type="button">导出 CSV</button>
        </div>
      </div>
      <div id="banner">连接中断，重试中…</div>
      <div class="table-wrap" id="tableWrap">
        <table>
          <thead>
            <tr>
              <th>时间</th><th>公司</th><th>规模</th><th>岗位</th><th>地点</th>
              <th>薪资</th><th>判定</th><th>实际</th><th>理由 / 话术</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
        <div class="empty" id="empty">暂无记录。到「① 设置」页配好规则、再启动油猴脚本后,这里会实时出现岗位。</div>
      </div>
    </div>
  </section>
</div>

<!-- 首次使用:先问一句要不要教。 -->
<div class="tour-ask" id="tourAsk" hidden>
  <div class="tour-ask-card">
    <h3>要开启使用教学吗?</h3>
    <p>大约一分钟,按顺序带你走一遍:装脚本、填三项配置、启动服务。每一步都会直接指到对应的位置。
       选「不用」也能用,以后想再看可以从右上角「使用教学」重新打开。</p>
    <div class="tour-actions">
      <button id="tourDecline" type="button">不用,我自己看</button>
      <button id="tourAccept" type="button">开启教学</button>
    </div>
  </div>
</div>

<!-- 引导层:一个跟着目标走的暗色遮罩 + 一张说明卡片。 -->
<div class="tour-layer" id="tourLayer" hidden>
  <div class="tour-spot" id="tourSpot"></div>
  <div class="tour-card" id="tourCard">
    <div class="tour-step" id="tourStep"></div>
    <h3 id="tourTitle"></h3>
    <p id="tourBody"></p>
    <div class="tour-actions">
      <button id="tourExit" type="button">退出教学</button>
      <button id="tourPrev" type="button">上一步</button>
      <button id="tourNext" type="button">下一步</button>
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

  // 「填入示例」用的招呼样式。**它是给模型的要求,不会被原样发出去** ——
  // 所以可以像这样把两种情形都写进去,比原来那种「一句固定文案」自由得多,
  // 也不会有「同一句话连发几百遍」的问题。
  //
  // 写成单行是有意的:整页住在一个模板字符串里,字符串里的换行转义会被外层先
  // 解析一遍把字面量切断(见 AGENTS.md「大屏的内联 JS 住在外层模板字符串里」)。
  var SAMPLE_GREETING_PROMPT = '对照 JD 里提到的方向,说你确实做过的那部分,结尾落到「感觉非常适合这份工作」。不要点公司名,也不要说具体技术名词 —— 看这句的是 HR,不是工程师。';

  var since = 0;
  var scope = 'current';
  var stats = null;
  var daily = [];
  // 轮询在途标记:setInterval 到点即触发,上一次 fetch 未回时再发请求会带同一个
  // since,同一批记录被插入两次 —— 表格里一行岗位看起来像跑了两个岗位。
  var inflight = false;
  // 记住服务端 runId,用来识别服务重启(runId 变)或 data/ 被清空(seq 回退)。
  var seenRunId = '';

  var statsEl = document.getElementById('stats');
  var rowsEl = document.getElementById('rows');
  var tableWrapEl = document.getElementById('tableWrap');
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
  var knowledgeWarnEl = document.getElementById('knowledgeWarn');
  var greetingPromptEl = document.getElementById('greetingPrompt');
  var greetingSaveBtn = document.getElementById('btnGreetingSave');
  var greetingSampleBtn = document.getElementById('btnGreetingSample');
  var greetingStatusEl = document.getElementById('greetingStatus');
  var knowledgeEl = document.getElementById('knowledge');
  var knowledgeSaveBtn = document.getElementById('btnKnowledgeSave');
  var knowledgeStatusEl = document.getElementById('knowledgeStatus');
  var svcBtn = document.getElementById('svcBtn');
  var ctrlStatusEl = document.getElementById('ctrlStatus');
  var aiEndpointEl = document.getElementById('aiEndpoint');
  var aiKeyEl = document.getElementById('aiKey');
  var aiModelEl = document.getElementById('aiModel');
  var aiSaveBtn = document.getElementById('btnAiSave');
  var aiTestBtn = document.getElementById('btnAiTest');
  var aiClearBtn = document.getElementById('btnAiClear');
  var aiStatusEl = document.getElementById('aiStatus');
  var tabBtns = document.querySelectorAll('.tab');
  var settingsViewEl = document.getElementById('viewSettings');
  var deliveryViewEl = document.getElementById('viewDelivery');

  // ---- 两个页面:设置 / 投递记录 ----
  //
  // 两页共用一份轮询、一条 watch 长连接和同一个本地游标 —— 拆成两条路由的话
  // 这些状态都要各自维护,而且「关掉页面就停」那条连接还得两个页面都挂。
  // 所以这里是同一份文档里的两个视图,只多一个「当前在看哪页」的状态。
  //
  // 默认回到设置页:一页只放按钮和提示的大屏没人用;两个页面各自的默认内容
  // 都要靠设置页配出来,新用户从那里开始才对。上次停在投递页的人由 localStorage
  // 记住 —— 大屏常常是开着看一眼记录的,每次都从设置页开始就多余了。
  var VIEW_KEY = 'helloboss.view';

  function initialView() {
    try {
      return localStorage.getItem(VIEW_KEY) === 'delivery' ? 'delivery' : 'settings';
    } catch (e) {
      // 某些浏览器策略下 localStorage 会直接抛,记住偏好不是必需功能,退回设置页即可。
      return 'settings';
    }
  }

  function switchView(name) {
    var delivery = name === 'delivery';
    settingsViewEl.classList.toggle('active', !delivery);
    deliveryViewEl.classList.toggle('active', delivery);

    for (var i = 0; i < tabBtns.length; i++) {
      var btn = tabBtns[i];
      btn.classList.toggle('active', btn.getAttribute('data-view') === (delivery ? 'delivery' : 'settings'));
    }

    try { localStorage.setItem(VIEW_KEY, delivery ? 'delivery' : 'settings'); } catch (e) {}

    // 切回投递页时贴底:记录表是从早到晚、最新一条在表尾,而隐藏期间新记录
    // 已经追加进来了(scrollHeight 在 display:none 时算不出来,只能等切回来再滚)。
    if (delivery) tableWrapEl.scrollTop = tableWrapEl.scrollHeight;
  }

  for (var t = 0; t < tabBtns.length; t++) {
    tabBtns[t].addEventListener('click', function () {
      switchView(this.getAttribute('data-view'));
    });
  }

  switchView(initialView());

  // 记录跨天是常态(脚本挂着跑),只有时分秒会让昨天的记录和今天的长得一样。
  // 用本地时间显示「月/日 时:分:秒」:at 存的是 UTC 串,直接切字符串会差 8 小时。
  function clock(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    function pad(n) { return String(n).padStart(2, '0'); }
    return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' +
           pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
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

    // data-at / data-seq 供插入时定位用:上报是「发了就不等」(见脚本侧 Ledger),
    // 落盘顺序不一定等于 at 的先后,所以不能只按到达顺序往表头插。
    return '<tr class="' + (isAnomaly(r) ? 'anomaly' : '') + '"' +
      ' data-at="' + attr(r.at) + '" data-seq="' + cell(r.seq) + '">' +
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
    // 它衡量的是「筛选力度」而不是「效果」:每天投出去的数量有限,倍数高只说明捞进来的岗位里
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
  //
  // 表格始终按「日期+时间」从早到晚排列,并且只留最近 MAX_ROWS 条。
  // 排序不能依赖到达顺序:/report 是发了就不等的,同一批岗位的判定先后与上报
  // 落盘顺序可能错开;跨天重放全量时更是直接按文件顺序回来。
  // 所以每条记录都按自己的 at 找位置插入,而不是一股脑插到表头。

  function trimRows() {
    // 从早到晚排列,最旧的就在表头 —— 超过上限时从表头裁。
    while (rowsEl.children.length > MAX_ROWS) {
      rowsEl.removeChild(rowsEl.firstChild);
    }
  }

  // 排序键:时间戳(毫秒) + seq。at 缺失或坏掉按最旧处理(-Infinity),
  // 它们会在超过上限时最先被裁掉。同一毫秒内的多条记录用 seq 保证稳定顺序。
  function sortKey(at, seq) {
    var t = Date.parse(at);
    return { t: Number.isFinite(t) ? t : -Infinity, seq: Number(seq) || 0 };
  }

  function compareKeys(a, b) {
    if (a.t !== b.t) return a.t < b.t ? -1 : 1;
    if (a.seq === b.seq) return 0;
    return a.seq < b.seq ? -1 : 1;
  }

  function insertRecord(record) {
    var tmp = document.createElement('tbody');
    tmp.innerHTML = rowHtml(record);
    var row = tmp.firstChild;
    if (!row) return;

    // 从早到晚:找到第一条比自己新的记录,插在它前面;没有就接到表尾。
    var key = sortKey(record.at, record.seq);
    var ref = null;
    for (var node = rowsEl.firstChild; node; node = node.nextSibling) {
      if (node.nodeType !== 1) continue;
      var other = sortKey(node.getAttribute('data-at'), node.getAttribute('data-seq'));
      if (compareKeys(other, key) > 0) { ref = node; break; }
    }
    rowsEl.insertBefore(row, ref);
    trimRows();
  }

  // 是否已经贴在底部。留 24px 容差:浏览器缩放、行高取整都会让 scrollTop 差一两像素,
  // 严格相等会导致「明明在最底下却不跟随」。
  function isAtBottom() {
    return tableWrapEl.scrollHeight - tableWrapEl.scrollTop - tableWrapEl.clientHeight <= 24;
  }

  function appendRecords(records) {
    if (!records.length) return;
    // 从早到晚排列,最新的一条在表尾 —— 追新增记录时自动滚到底。
    // 但要先记下追加前的位置:用户主动往上翻看旧记录时,不能每 1.5 秒把他拽回来;
    // 等他自己滚回底部,跟随自然恢复。
    var follow = isAtBottom();
    for (var i = 0; i < records.length; i++) {
      insertRecord(records[i]);
      if (records[i].seq > since) since = records[i].seq;
    }
    emptyEl.style.display = rowsEl.children.length ? 'none' : 'block';
    if (follow) tableWrapEl.scrollTop = tableWrapEl.scrollHeight;
  }

  // ---- 服务状态 ----

  // 大屏由常驻的控制进程提供;右上角按钮启停的是后台判定服务。
  // 状态跟着 /api/records 的轮询一起回来,不再由 SSE 连接推断 —— 连接在只说明
  // 控制台还活着,并不说明判定服务开着。
  var watch = null;
  var service = { managed: false, running: true, state: 'running' };

  function setCtrlStatus(message, tone) {
    ctrlStatusEl.textContent = message || '';
    ctrlStatusEl.className = 'status' + (tone ? ' ' + tone : '');
  }

  function applyService(data) {
    if (!data) return;
    service = data;

    var managed = data.managed !== false;
    var busy = data.state === 'starting' || data.state === 'stopping';
    svcBtn.classList.toggle('up', data.running === true);
    svcBtn.classList.toggle('down', managed && data.running !== true && !busy);

    if (!managed) {
      svcBtn.disabled = true;
      svcBtn.textContent = '服务运行中';
      svcBtn.title = '当前是命令行启动,判定服务不由大屏管理';
      return;
    }

    svcBtn.disabled = false;
    if (data.state === 'starting') {
      svcBtn.textContent = '启动中…';
      svcBtn.title = '正在启动判定服务';
    } else if (data.state === 'stopping') {
      svcBtn.textContent = '停止中…';
      svcBtn.title = '正在停止判定服务';
    } else if (data.running) {
      svcBtn.textContent = '停止服务';
      svcBtn.title = '点击停止后台判定服务';
    } else {
      svcBtn.textContent = '启动服务';
      svcBtn.title = '点击启动后台判定服务';
    }
  }

  // 挂上这条连接。控制进程靠它判断「还有人在看大屏」——页面关掉这条连接就断了,
  // 控制进程会在宽限期后退出。重连(刷新、切回来、断线重试)由 EventSource 负责。
  function openWatch() {
    if (watch) watch.close();
    watch = new EventSource('/api/watch');
  }

  // 只为「知识库是空的」那条警告条去查 /health:没有知识库 = 一个岗位都投不出去,
  // 这个原因必须写在页面上,不能让人去猜岗位为什么全被跳过。
  function checkKnowledge() {
    fetch('/health')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (health) {
        if (!health) return;
        knowledgeWarnEl.classList.toggle('show', health.hasKnowledge === false);
      })
      // 查不到就维持现状,别把警告条闪一下又收回去。
      .catch(function () {});
  }

  svcBtn.addEventListener('click', function () {
    if (!service || service.managed === false) return;

    var action = service.running ? 'stop' : 'start';
    svcBtn.disabled = true;
    svcBtn.textContent = action === 'start' ? '启动中…' : '停止中…';
    setCtrlStatus('', '');

    postJson('/api/service/' + action, {})
      .then(function (data) {
        applyService(data);
        // 服务刚启动时配置才算真正生效,顺手刷新一下警告条。
        if (action === 'start') checkKnowledge();
      })
      .catch(function (error) {
        setCtrlStatus(error.message || String(error), 'bad');
        applyService(service);
      });
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
        applyService(data.service);
        daily = data.daily || [];
        appendRecords(data.records || []);
        renderStats();
        renderChart();
      })
      .catch(function () {
        // 服务可能刚重启或短暂不可达 —— 提示但不停止重试,页面也不清空。
        // 按钮状态不在这里改:它跟着 /api/records 里的 service 字段走。
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

  // ---- 打招呼样式(prompt,不逐字发出) ----

  // 这一段是**给模型的要求**,不是要发出去的文本 —— 所以可以写多写细,
  // 不用担心被原样发出去,也不用担心「同一句话连发几百遍」。
  function applyGreetingPrompt(data) {
    greetingPromptEl.value = (data && data.greetingPrompt) || '';
  }

  function saveGreetingPrompt() {
    greetingSaveBtn.disabled = true;
    setStatus(greetingStatusEl, '保存中…', '');
    postSettings({ greetingPrompt: greetingPromptEl.value })
      .then(function (data) {
        applyGreetingPrompt(data.settings || {});
        setStatus(greetingStatusEl, '已保存，下一个岗位立即生效', 'ok');
      })
      .catch(function (error) {
        // 服务端的报错很具体(超了多少字)，原样显示才有用。
        setStatus(greetingStatusEl, error.message || String(error), 'bad');
      })
      .finally(function () { greetingSaveBtn.disabled = false; });
  }

  greetingSaveBtn.addEventListener('click', saveGreetingPrompt);

  greetingSampleBtn.addEventListener('click', function () {
    if (greetingPromptEl.value.trim()) {
      // 和规则面板同一条规矩:示例只给空框起步,不覆盖已经调好的内容。
      setStatus(greetingStatusEl, '文本框已有内容，没有覆盖', '');
      return;
    }
    greetingPromptEl.value = SAMPLE_GREETING_PROMPT;
    setStatus(greetingStatusEl, '已填入示例，按你的情况改完再点保存', '');
  });

  // ---- 知识库(简历全文,直接粘) ----

  // 取代了原来的 resumes/ 目录:判定与招呼语都只按这里的文字写。
  // 空着就是没简历 —— 服务端据此一个岗位都不投(见 evaluateJob 的 fail-closed 闸门),
  // 所以保存后面要顺手刷新那条警告条。
  function applyKnowledge(data) {
    knowledgeEl.value = (data && data.knowledge) || '';
  }

  function saveKnowledge() {
    knowledgeSaveBtn.disabled = true;
    setStatus(knowledgeStatusEl, '保存中…', '');
    postSettings({ knowledge: knowledgeEl.value })
      .then(function (data) {
        applyKnowledge(data.settings || {});
        setStatus(knowledgeStatusEl, '已保存,下一个岗位立即生效', 'ok');
        checkKnowledge();
      })
      .catch(function (error) {
        // 服务端的报错很具体(超了多少字),原样显示才有用。
        setStatus(knowledgeStatusEl, error.message || String(error), 'bad');
      })
      .finally(function () { knowledgeSaveBtn.disabled = false; });
  }

  knowledgeSaveBtn.addEventListener('click', saveKnowledge);

  // ---- AI 接入 ----

  // 服务端 detectApiFormat 的两个返回值 → 给人看的名字。
  var FORMAT_NAMES = {
    anthropic: 'Anthropic Messages',
    openai: 'OpenAI chat/completions',
  };

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
        // 格式是按端点地址自动识别的,服务端把判成了哪一种回过来。填了个看不出格式的
        // 中转时,这是唯一能确认「它到底按哪种打的」的地方 —— 所以成功失败都要显示。
        var format = FORMAT_NAMES[data.format] || data.format || '';
        if (data.ok) {
          setStatus(aiStatusEl, '连通 · ' + (data.ms / 1000).toFixed(1) + 's · ' + (data.model || '')
            + (format ? ' · ' + format + '格式' : ''), 'ok');
        } else {
          // 上游给的原话(HTTP 401 / 内容为空…),照搬给用户 —— 编一句「连接失败」等于把线索扔了。
          setStatus(aiStatusEl, '测试失败:' + data.error + (format ? '(按 ' + format + ' 格式请求)' : ''), 'bad');
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
      })
      .catch(function (error) {
        setStatus(aiStatusEl, error.message || String(error), 'bad');
      })
      .finally(function () { aiClearBtn.disabled = false; });
  });

  // 只在页面加载时读一次,**不进轮询循环**:进了的话用户正在输入时会被服务端的
  // 旧值覆盖,打到一半的规则突然消失。
  function loadSettings() {
    // 返回这个 Promise:首屏教学要等它读完,才知道这次是不是一个还没配过的用户。
    return fetch('/api/settings')
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
        applyGreetingPrompt(data);
        applyKnowledge(data);
        aiEndpointEl.value = data.aiEndpoint || '';
        aiModelEl.value = data.aiModel || '';
        // 密钥不回填 —— 服务端不回传明文,这里只用末四位提示「已配置 / 未配置」。
        setKeyHint(data.hasAiKey, data.aiKeyHint);
        return data;
      })
      .catch(function (error) {
        // 读不到就别锁 —— 锁住的话这个框彻底没法用,而用户可能正是来改它的。
        setPromptMode('editing');
        setStatus(promptStatusEl, '配置读取失败:' + (error.message || error), 'bad');
        // 返回 null 而不是抛出去:教学那边据此判断「读不到就别弹」——
        // 一个连配置都读不出来的大屏,弹教学只是噪声。
        return null;
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

  // ---- 首次使用教学 ----
  //
  // 为什么放在大屏而不是用户脚本面板里:新用户第一眼看到的是大屏,而「脚本要装进
  // 浏览器」这件事大屏本身看不出来 —— 他不知道该去哪装、装完有没有生效。所以这里
  // 按顺序把人带到每一块该填的地方,并顺带说清「判定服务还要单独点一下启动」。
  //
  // 记住「看过了」用 localStorage:大屏始终是同一个端口,同一台机器上够用;
  // 浏览器禁用 localStorage 时退回内存标记,至少同一次会话里不再重复问。
  var TOUR_KEY = 'helloboss.tour.seen';
  var tourSeenInMemory = false;

  function tourSeen() {
    if (tourSeenInMemory) return true;
    try { return localStorage.getItem(TOUR_KEY) === '1'; } catch (e) { return false; }
  }

  function markTourSeen() {
    tourSeenInMemory = true;
    try { localStorage.setItem(TOUR_KEY, '1'); } catch (e) {}
  }

  // 每一步:指到哪个元素、说什么。target 为空表示「没有具体位置」,卡片居中。
  // view 是这一步之前要先切到哪一页 —— 面板只在设置页存在。
  //
  // 文案只讲「现在该做什么」,不复述文档。教程的价值在于**定位**,不在信息量。
  var TOUR_STEPS = [
    {
      target: 'installScript',
      title: '第一步:把脚本装进浏览器',
      body: '先在浏览器的扩展商店装「篡改猴 / Tampermonkey」。装好后回到这一页,点右上角这个「安装油猴脚本」,篡改猴会弹出安装框,点「安装」。装完刷新 BOSS 直聘页面,右侧就会多出一个脚本面板。',
    },
    {
      target: 'panelAi',
      view: 'settings',
      title: '第二步:填 AI 接入',
      body: '端点、密钥、模型名。填完先点「测试连通」—— 当场验证能不能通,比跑起来之后猜「为什么一个都不投」省事得多。密钥只留在本机。',
    },
    {
      target: 'panelRule',
      view: 'settings',
      title: '第三步:写投递规则',
      body: '用大白话写你想投什么样的岗位,比如薪资、城市、公司规模。不会写就点「填入示例」再改成自己的。这一项空着,一个岗位都不会投 —— 这是故意的。',
    },
    {
      target: 'panelKnowledge',
      view: 'settings',
      title: '第四步:粘知识库',
      body: '把简历内容整段粘进来,不用管格式。判定和招呼语都只按这段文字写;空着同样一个岗位都不投。',
    },
    {
      target: 'svcBtn',
      title: '第五步:启动判定服务',
      body: '点右上角这个按钮。按钮变成「停止服务」、颜色变绿,就说明服务起来了。服务停着时大屏照样能看记录、改配置,但不会有任何岗位被判定。(如果你是用 npm start 起的,判定本来就在跑,按钮会显示「服务运行中」—— 这步跳过即可。)',
    },
    {
      target: '',
      title: '最后一步:回到 BOSS 直聘开始',
      body: '切到 BOSS 直聘页面,在右侧脚本面板上把「问候语来源」保持为「AI 判定」(默认就是),然后点「开始」。之后这里会实时出现每个岗位的判定结果。做完了,点下面的「完成」。',
    },
  ];

  var tourIndex = 0;
  var tourAskEl = document.getElementById('tourAsk');
  var tourLayerEl = document.getElementById('tourLayer');
  var tourSpotEl = document.getElementById('tourSpot');
  var tourCardEl = document.getElementById('tourCard');
  var tourStepEl = document.getElementById('tourStep');
  var tourTitleEl = document.getElementById('tourTitle');
  var tourBodyEl = document.getElementById('tourBody');
  var tourPrevBtn = document.getElementById('tourPrev');
  var tourNextBtn = document.getElementById('tourNext');
  var tourExitBtn = document.getElementById('tourExit');

  // 把卡片放在目标下方;下方放不下就放上方;再放不下就贴着底边。
  // 左右夹在视口内,免得宽屏上的 AI 面板把卡片推到屏幕外。
  function placeTourCard(rect) {
    var gap = 12;
    var cardW = tourCardEl.offsetWidth;
    var cardH = tourCardEl.offsetHeight;
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    if (!rect) {
      tourCardEl.style.left = Math.max(gap, (vw - cardW) / 2) + 'px';
      tourCardEl.style.top = Math.max(gap, (vh - cardH) / 2) + 'px';
      return;
    }

    var left = Math.min(Math.max(gap, rect.left), vw - cardW - gap);
    var top = rect.bottom + gap;
    if (top + cardH > vh - gap) top = rect.top - cardH - gap;
    if (top < gap) top = vh - cardH - gap;

    tourCardEl.style.left = Math.max(gap, left) + 'px';
    tourCardEl.style.top = Math.max(gap, top) + 'px';
  }

  function renderTourStep() {
    var step = TOUR_STEPS[tourIndex];
    var target = step.target ? document.getElementById(step.target) : null;

    tourStepEl.textContent = '第 ' + (tourIndex + 1) + ' / ' + TOUR_STEPS.length + ' 步';
    tourTitleEl.textContent = step.title;
    tourBodyEl.textContent = step.body;
    tourPrevBtn.disabled = tourIndex === 0;
    tourNextBtn.textContent = tourIndex === TOUR_STEPS.length - 1 ? '完成' : '下一步';

    if (step.view) switchView(step.view);

    if (!target) {
      // 没有具体目标:整层压暗、卡片居中,不画高亮框。
      tourLayerEl.classList.add('dim');
      tourSpotEl.hidden = true;
      placeTourCard(null);
      return;
    }

    tourLayerEl.classList.remove('dim');
    tourSpotEl.hidden = false;

    // 目标可能在可视区之外(窗口小的时候)。先滚过去,再量位置。
    if (target.scrollIntoView) target.scrollIntoView({ block: 'center', inline: 'nearest' });

    var rect = target.getBoundingClientRect();
    var pad = 6;
    tourSpotEl.style.left = (rect.left - pad) + 'px';
    tourSpotEl.style.top = (rect.top - pad) + 'px';
    tourSpotEl.style.width = (rect.width + pad * 2) + 'px';
    tourSpotEl.style.height = (rect.height + pad * 2) + 'px';
    placeTourCard(rect);
  }

  function openTour() {
    tourIndex = 0;
    tourAskEl.hidden = true;
    tourLayerEl.hidden = false;
    renderTourStep();
  }

  function closeTour() {
    tourLayerEl.hidden = true;
    tourAskEl.hidden = true;
    markTourSeen();
  }

  tourNextBtn.addEventListener('click', function () {
    if (tourIndex >= TOUR_STEPS.length - 1) { closeTour(); return; }
    tourIndex += 1;
    renderTourStep();
  });

  tourPrevBtn.addEventListener('click', function () {
    if (tourIndex === 0) return;
    tourIndex -= 1;
    renderTourStep();
  });

  tourExitBtn.addEventListener('click', closeTour);
  document.getElementById('tourAccept').addEventListener('click', openTour);
  document.getElementById('tourDecline').addEventListener('click', closeTour);
  // 顶栏那个入口:用户主动点的,直接进教学,不再问一遍。
  document.getElementById('btnTour').addEventListener('click', openTour);

  // 窗口尺寸变化后高亮框和卡片都要重新量 —— 否则拖动窗口会把框留在原位。
  window.addEventListener('resize', function () {
    if (!tourLayerEl.hidden) renderTourStep();
  });

  // 只在「看起来还没配过」时主动问。
  // 已经配好的人(升级上来的老用户)不该每次打开都被拦一下;
  // 而三项里任何一项为空,都意味着一投不出去,正是最需要人带的时刻。
  function maybeAskTour(settings) {
    // 配置读不出来(settings 为 null)时不弹:那种情况下大屏自己都在报错,
    // 再叠一层教学只会挡住用户看错误信息。
    if (!settings) return;
    if (tourSeen()) return;
    var rule = String(settings.decisionPrompt || '').trim();
    var knowledge = String(settings.knowledge || '').trim();
    if (rule && knowledge && settings.hasAiKey) return;
    tourAskEl.hidden = false;
  }

  loadSettings().then(maybeAskTour).catch(function () {});
  // 首屏就把「知识库是空的」这条说清楚。光看状态灯是绿的会让人以为一切正常,
  // 而知识库空着时其实一个岗位都投不出去。
  checkKnowledge();
  // 这条连接也是「控制台跟随本页」的开关,见 openWatch()。
  openWatch();
  // 轮询与当前在看哪一页无关:顶栏的服务灯、两页的红条都靠它,
  // 而且切到投递页时记录和柱状图要已经是新的。
  poll();
  setInterval(poll, POLL_MS);
</script>
</body>
</html>`;
}
