// 打包成 HelloBoss.exe 时被塞进 exe 的引导层(SEA 的 main)。
//
// 为什么是 .cjs 而不是跟着 src/ 用 ESM:Node 22 的 SEA 只能跑 CommonJS 主脚本
// (ESM 主脚本要 Node 24 才支持),所以这一层必须是 CJS;但它可以用动态 import()
// 加载磁盘上的 ESM 源码 —— 「exe 里只放引导、src/ 留在磁盘」这个结构正是靠这一点
// 成立的,好处是以后改 src/ 不用重新打包 exe。
//
// 三种身份,靠环境变量区分:
//   父(用户双击)  :exe 是控制台程序,自己跑下去就会一直挂着一个黑窗口。所以父进程
//                   只派生一个隐藏的控制进程就立刻退出,黑窗一闪而过。
//   控制(常驻)    :起大屏服务、开两个网页。判定服务默认**不启动**,由大屏右上角
//                   的按钮按需启停(见 src/supervisor.js)。
//   判定(子进程)  :真正接 /evaluate 的服务,跑在临时端口上。由控制进程拉起和杀掉。
//
// 服务本身仍然复用 src/server.js 的 createServer() —— 这里不重写任何判定逻辑。
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PORT = Number(process.env.PORT || 8787);
const DASHBOARD_URL = `http://127.0.0.1:${PORT}/dashboard`;
// 两个页面都优先开在 Edge:篡改猴装在 Edge 里,交给系统默认浏览器可能开出一个
// 没有脚本的 BOSS。先开大屏、后开 BOSS,好让活动标签停在 BOSS 上。
const BOSS_URL = 'https://www.zhipin.com/web/geek/jobs';

const CONTROL_MARKER = 'HELLOBOSS_CONTROL';
const WORKER_MARKER = 'HELLOBOSS_WORKER';

// SEA 里 __dirname 指向 exe 内部的虚拟路径,不能当安装目录用。
function isSea() {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
}

// exe 所在目录就是安装目录 —— src/、resumes/、config/、data/ 都在它下面。
// 开发时直接跑 `node launcher/bootstrap.cjs`,安装目录就是 launcher/ 的上一级。
const SEA = isSea();
const APP_DIR = SEA ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const DATA_DIR = path.join(APP_DIR, 'data');
const LOG_FILE = path.join(DATA_DIR, 'launcher.log');

function appendLog(file, line) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, file), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // 日志写不进去不该把启动本身搞砸
  }
}

function log(line) {
  appendLog('launcher.log', line);
}

// 弹窗必须绕开命令行编码:cmd 的代码页是 936,中文直接塞进 -Command 会乱码。
// 所以先把话写进 UTF-8 文件,让 PowerShell 读文件再弹。
function showError(message) {
  const file = path.join(DATA_DIR, 'last-error.txt');
  let target = file;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, message, 'utf8');
  } catch {
    target = '';
  }
  const body = target
    ? `Get-Content -Raw -Encoding UTF8 '${target.replace(/'/g, "''")}'`
    : `'启动失败,且日志目录写不进去:${APP_DIR.replace(/'/g, "''")}'`;
  const script = 'Add-Type -AssemblyName System.Windows.Forms;'
    + `$m = ${body};`
    + "[System.Windows.Forms.MessageBox]::Show($m, 'HelloBoss', 'OK', 'Warning') | Out-Null";
  spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
    detached: true, stdio: 'ignore', windowsHide: true,
  }).unref();
}

// SEA 里 exe 自己就是入口,不带参数;开发时要把 bootstrap.cjs 传给 node。
function selfArgs() {
  return SEA ? [] : [__filename];
}

function spawnSelf(args, extraEnv, stdio, detached) {
  return spawn(process.execPath, args, {
    cwd: APP_DIR,
    // 判定服务跟着控制进程走:不脱离,控制进程退出时更容易一起收掉。
    // 常驻的控制进程自己则要 detached,父进程退出后它才活得下去。
    detached: detached !== false,
    stdio,
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
}

// 只认三个常见安装位置:够用,而且不用碰注册表。找不到就退回系统默认浏览器 ——
// 开错浏览器总比什么都不开强。
function findEdge() {
  const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA];
  for (const base of bases) {
    if (!base) continue;
    const file = path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function openUrl(url, edge) {
  // 没有 Edge 时走 cmd 的 start:spawn 会把空标题补成 "",URL 才不会被当成标题吃掉。
  const [command, args] = edge ? [edge, [url]] : ['cmd.exe', ['/c', 'start', '', url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (error) => log(`打开 ${url} 失败:${error.message}`));
  child.unref();
}

function openPages() {
  // 开发/冒烟测试用:不想每次起控制进程都弹两个浏览器窗口。
  if (process.env.HELLOBOSS_NO_BROWSER === '1') {
    log('HELLOBOSS_NO_BROWSER=1,跳过打开浏览器');
    return;
  }
  const edge = findEdge();
  log(edge ? '用 Edge 打开网页' : '没找到 Edge,交给系统默认浏览器');
  openUrl(DASHBOARD_URL, edge);
  openUrl(BOSS_URL, edge);
}

// 端口被占时,问一下占着它的服务是谁。新版控制进程会在 /api/service 回
// { managed: true };旧版的单进程服务没有这个接口,要么 404、要么回 managed: false。
// 两种情况处理方式完全不同:前者只需把网页开出来,后者必须让用户先关掉它。
async function probeExistingService() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/service`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// 每次双击都从一份干净的控制进程开始:上一份可能已经跑了一整夜(判定服务还开着,
// 磁盘上的规则/简历又改过),直接复用它看起来像「双击没生效」。
//
// 先请它优雅退出 —— 它会顺手收掉判定服务 —— 再由本实例接管端口。
// 返回 false 表示「没有旧实例」或「旧实例没有退出接口 / 没退成」;后者由调用方
// 退回原来的「只开网页」行为,兼容没有 /api/shutdown 的旧版本。
async function stopPreviousControl() {
  const existing = await probeExistingService();
  if (!existing || existing.managed !== true) return false;

  log(`发现上一份控制进程(state=${existing.state || 'running'}),请它退出`);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      log(`旧控制进程拒绝退出:HTTP ${res.status}`);
      return false;
    }
  } catch (error) {
    log(`请求旧控制进程退出失败:${error.message}`);
    return false;
  }

  // 退出流程先停判定服务(最多 5 秒)再收连接,给足 15 秒观察窗口。
  for (let i = 0; i < 75; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!(await probeExistingService())) return true;
  }
  log('旧控制进程 15 秒内没有退出');
  return false;
}

// 判定服务:复用同一份 src/server.js,监听临时端口,把端口号写回 stdout 给控制进程。
async function runWorker() {
  const entry = path.join(APP_DIR, 'src', 'server.js');
  let server;
  try {
    const { createServer } = await import(pathToFileURL(entry).href);
    server = createServer();
  } catch (error) {
    log(`判定服务启动失败:${error.stack || error.message}`);
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  }

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    // 控制进程靠这一行拿到端口,别改动格式。
    process.stdout.write(`HELLOBOSS_WORKER_PORT=${port}\n`);
  });

  server.on('error', (error) => {
    log(`判定服务监听失败:${error.message}`);
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });

  const close = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  // 控制进程死掉时它的 stdin 管道会关闭 —— 用它兜底,避免判定服务变成孤儿进程。
  // Windows 上 taskkill /f 不会给子进程收尾的机会,这条比信号可靠。
  process.stdin.on('end', close);
  process.stdin.on('close', close);
  process.stdin.resume();
}

// 控制进程:常驻,提供大屏;判定服务由大屏按钮启停。
// attempt 只用于「端口刚好被上一份控制进程占着」时重试一次,避免连点两下变成
// 两个实例同时抢端口。
async function runControl(attempt = 0) {
  const entry = path.join(APP_DIR, 'src', 'supervisor.js');
  if (!fs.existsSync(entry)) {
    log(`找不到 ${entry}`);
    showError(`找不到 src\\supervisor.js。\n\nHelloBoss.exe 必须和 src\\ 文件夹待在一起,`
      + `也就是说整个文件夹要一起解压、一起移动。\n\n当前目录:${APP_DIR}`);
    return;
  }

  // 先让上一份退场,再起自己的 —— 用户双击的意图是「现在打开 HelloBoss」。
  await stopPreviousControl();

  let supervisor;
  try {
    const { createSupervisor } = await import(pathToFileURL(entry).href);
    supervisor = createSupervisor({
      spawnWorker: () => {
        // 把控制进程的标记摘掉:worker 只看 WORKER_MARKER,但环境干净一点更不容易出错。
        const env = { ...process.env, [WORKER_MARKER]: '1' };
        delete env[CONTROL_MARKER];
        return spawnSelf(selfArgs(), env, ['pipe', 'pipe', 'pipe'], false);
      },
      onListening: openPages,
      // 控制进程自己的 stdout/stderr 已被父进程重定向到 data/server.log,
      // console.log 就是日志文件,不必再 append 一遍。
      log: (line) => console.log(line),
    });
  } catch (error) {
    log(`控制进程启动失败:${error.stack || error.message}`);
    showError(`${error.message}\n\n详细日志:${LOG_FILE}`);
    return;
  }

  supervisor.ready.catch(async (error) => {
    // 端口已经被占:可能只是用户连点两下,启动期的竞态让刚才的探测没看到旧实例;
    // 也可能是旧版单进程服务还开着。
    if (error.code === 'EADDRINUSE') {
      const existing = await probeExistingService();
      if (existing && existing.managed === true && attempt < 1) {
        // 再请一次、等它退干净,然后重建一份控制进程 —— 刚才那份的监听已经失败,
        // 不能复用同一个 server 对象。
        if (await stopPreviousControl()) {
          log('上一份控制进程已退出,重新启动控制进程');
          runControl(attempt + 1);
          return;
        }
      }
      if (existing && existing.managed === true) {
        log(`端口 ${PORT} 已有控制进程在运行,只开网页`);
        openPages();
        process.exit(0);
        return;
      }

      log(`端口 ${PORT} 被不是控制进程的服务占用:${JSON.stringify(existing)}`);
      showError(
        `端口 ${PORT} 已被另一个服务占用。\n\n`
        + (existing && existing.managed === false
          ? '那是一个单进程服务(npm start / node src/server.js),它不由大屏的按钮管理,'
            + '所以页面会一直显示「服务运行中」。\n\n'
          : '')
        + '请先关掉它,再重新双击 HelloBoss.exe。\n\n'
        + '不知道是哪个程序的话:打开任务管理器,按「详细信息」找到占用 8787 端口的进程并结束它。',
      );
      process.exit(1);
      return;
    }
    log(`监听失败:${error.stack || error.message}`);
    showError(`${error.message}\n\n详细日志:${LOG_FILE}`);
    process.exit(1);
  });
}

if (process.env[WORKER_MARKER] === '1') {
  runWorker();
} else if (process.env[CONTROL_MARKER] === '1') {
  runControl();
} else {
  // 父进程:派生隐藏的控制进程后立刻退出,黑窗跟着消失。
  // 控制进程的 stdout/stderr 落到 data/server.log —— 否则 src/ 里的 console.warn
  // (比如「没读到简历」)会随隐藏窗口一起消失,出了问题无从查起。
  let out = 'ignore';
  let err = 'ignore';
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    out = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
    err = fs.openSync(path.join(DATA_DIR, 'server.error.log'), 'a');
  } catch {
    // 日志目录不可写时仍然启动,只是没有日志。
  }

  const child = spawnSelf(selfArgs(), { [CONTROL_MARKER]: '1' }, ['ignore', out, err]);
  // 子进程已经继承了这两个句柄,父进程的副本要关掉,否则文件会一直被占着。
  for (const fd of [out, err]) {
    if (typeof fd === 'number') {
      try { fs.closeSync(fd); } catch { /* 已经关了 */ }
    }
  }
  child.on('error', (error) => log(`派生控制进程失败:${error.message}`));
  child.unref();
}
