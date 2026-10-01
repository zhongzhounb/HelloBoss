// 打包成 HelloBoss.exe 时被塞进 exe 的引导层(SEA 的 main)。
//
// 为什么是 .cjs 而不是跟着 src/ 用 ESM:Node 22 的 SEA 只能跑 CommonJS 主脚本
// (ESM 主脚本要 Node 24 才支持),所以这一层必须是 CJS;但它可以用动态 import()
// 加载磁盘上的 ESM 源码 —— 「exe 里只放引导、src/ 留在磁盘」这个结构正是靠这一点
// 成立的,好处是以后改 src/ 不用重新打包 exe。
//
// 两种身份,靠环境变量区分:
//   父(用户双击):exe 是控制台程序,自己跑下去就会一直挂着一个黑窗口。所以父进程
//                 只派生一个隐藏的自己就立刻退出,黑窗一闪而过。
//   子(真干活)  :起服务、开两个网页。
//
// 服务本身仍然落在 src/server.js 的 startServer() 里 —— 这里不重写任何启动逻辑。
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// 端口跟 server.js 用同一个来源,不然换了端口这里会去开一个错误的地址。
const PORT = Number(process.env.PORT || 8787);
const DASHBOARD_URL = `http://127.0.0.1:${PORT}/dashboard`;
// 两个页面都优先开在 Edge:篡改猴装在 Edge 里,交给系统默认浏览器可能开出一个
// 没有脚本的 BOSS。先开大屏、后开 BOSS,好让活动标签停在 BOSS 上。
const BOSS_URL = 'https://www.zhipin.com/web/geek/jobs';

const CHILD_MARKER = 'BOSS_GREETING_LAUNCHED';

// exe 所在目录就是安装目录 —— src/、resumes/、config/、data/ 都在它下面。
// 不能用 __dirname:在 SEA 里那指向 exe 内部的虚拟路径,不是磁盘上的位置。
const APP_DIR = path.dirname(process.execPath);
const DATA_DIR = path.join(APP_DIR, 'data');
const LOG_FILE = path.join(DATA_DIR, 'launcher.log');

function log(line) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // 日志写不进去不该把启动本身搞砸
  }
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
  const edge = findEdge();
  log(edge ? `用 Edge 打开网页` : '没找到 Edge,交给系统默认浏览器');
  openUrl(DASHBOARD_URL, edge);
  openUrl(BOSS_URL, edge);
}

async function runServer() {
  const entry = path.join(APP_DIR, 'src', 'server.js');
  if (!fs.existsSync(entry)) {
    log(`找不到 ${entry}`);
    showError(`找不到 src\\server.js。\n\nHelloBoss.exe 必须和 src\\ 文件夹待在一起,`
      + `也就是说整个文件夹要一起解压、一起移动。\n\n当前目录:${APP_DIR}`);
    return;
  }

  let server;
  try {
    const { startServer } = await import(pathToFileURL(entry).href);
    server = startServer({ exitWhenIdle: true });
  } catch (error) {
    // 配置错误(比如 lan 开了却没令牌)在这里,给人话而不是静默死掉。
    log(`启动失败:${error.stack || error.message}`);
    showError(`${error.message}\n\n详细日志:${LOG_FILE}`);
    return;
  }

  server.once('error', (error) => {
    // 端口已经被占:多半是服务本来就在跑(用户又双击了一次),那就只把网页开出来。
    if (error.code === 'EADDRINUSE') {
      log(`端口 ${PORT} 已在监听,判定为服务已在运行,只开网页`);
      openPages();
      return;
    }
    log(`监听失败:${error.stack || error.message}`);
    showError(`${error.message}\n\n详细日志:${LOG_FILE}`);
  });

  server.once('listening', () => {
    log(`已监听 http://127.0.0.1:${PORT}`);
    openPages();
  });
}

function spawnHiddenSelf() {
  const child = spawn(process.execPath, [], {
    cwd: APP_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, [CHILD_MARKER]: '1' },
  });
  child.on('error', (error) => log(`派生自身失败:${error.message}`));
  child.unref();
  // 父进程到此结束,黑窗跟着消失;服务由上面那个隐藏的子进程接管。
}

if (process.env[CHILD_MARKER] === '1') {
  runServer();
} else {
  spawnHiddenSelf();
}
