// 打包成 HelloBoss.exe 时被塞进 exe 的引导层(SEA 的 main)。
//
// **为什么所有东西都在这一个文件里**:SEA 只把 main 那一个脚本嵌进 exe,`require('./x.cjs')`
// 这种相对引用在 exe 里会报 `ERR_UNKNOWN_BUILTIN_MODULE`。辅助模块拆出去就没法在 exe 里
// 加载,所以解包、目录解析这些全部内联 —— 而 `require.main === module` 在 SEA 里是成立的,
// 于是这些函数仍然能被单测直接 require 到,不必起一个真的 exe 来验。
//
// exe 里装着全部东西(src/ + package.json + 油猴脚本),启动时解包到
// %LOCALAPPDATA%\HelloBoss\runtime\<内容指纹>\ 再 import。用户只需要那一个 exe 文件。
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

// ---- 资源 key。构建端(launcher/build.mjs)也从这里取,免得两端字符串写歪 ----

// 油猴脚本在解包目录里的名字。引导层按它找脚本,大屏的「安装脚本」按钮也按它发出去。
const USERSCRIPT_NAME = 'zhipin-auto-greeting.user.js';
// 清单自身也是一个资源:引导层先读它,才知道该解包哪些文件、这次是哪个版本。
const MANIFEST_KEY = 'assets.json';

// 解包完成的标记。写在所有资源之后,它的存在即「这次解包是完整的」。
//
// 为什么需要它:解包过程中断电 / 被强杀会留下一个内容不全的目录,而下一步就会去
// import 它。有标记时那一步知道该重来,而不是照着半份源码启动。
const DONE_MARKER = '.extracted';

const PORT = Number(process.env.PORT || 8787);
const DASHBOARD_URL = `http://127.0.0.1:${PORT}/dashboard`;
// 两个页面都优先开在 Edge:篡改猴装在 Edge 里,交给系统默认浏览器可能开出一个
// 没有脚本的 BOSS。先开大屏、后开 BOSS,好让活动标签停在 BOSS 上。
const BOSS_URL = 'https://www.zhipin.com/web/geek/jobs';

const CONTROL_MARKER = 'HELLOBOSS_CONTROL';
const WORKER_MARKER = 'HELLOBOSS_WORKER';

// exe 模式下产品自己的目录名。放 %LOCALAPPDATA% 下而不是 exe 旁边,理由见 resolveDataDir。
const APP_FOLDER = 'HelloBoss';

// 用户在 exe 旁边可能留下的、值得我们跟着走的文件。只看这几个名字,不数别的:
// data/ 里同时还有日志,拿「目录非空」当判据会把日志也算成用户数据。
const DATA_MARKERS = ['settings.json', 'jobs.jsonl'];

// SEA 里 __dirname 指向 exe 内部的虚拟路径,不能当安装目录用。
function isSea() {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
}

// ---- 目录解析 ----

function hasUserData(dir) {
  return DATA_MARKERS.some((name) => fs.existsSync(path.join(dir, name)));
}

/**
 * 用户数据目录。
 *
 * - 开发模式(`node launcher/bootstrap.cjs` / npm start):留在源码目录的 data/ 下,
 *   和改造前一致 —— 仓库里的相对路径、文档里的说法都不用改。
 * - exe 模式:放 `%LOCALAPPDATA%\HelloBoss\data`。
 *
 * **为什么 exe 模式不继续用 exe 旁边的 data/**:单文件之后「整个文件夹一起走」这条
 * 保护就没有了。以前 exe 挨着 src/,用户把其中任何一个挪走都起不来,反而提醒了他
 * 们这堆东西是一体的;现在用户很容易把 exe 单独拖到桌面或另一个盘,而 data/ 留在原地 ——
 * 那意味着他们的规则、知识库和全部流水**静默地**被丢在了旧目录,新位置从零开始。
 * 数据没有备份,这种静默丢法不可接受,所以让数据跟着用户而不是跟着这个文件。
 *
 * @returns {string} 数据目录的绝对路径(不保证已存在)
 */
function resolveDataDir(options) {
  const { appDir, sea, env } = options;

  // 覆盖项优先:冒烟测试要能把数据写到临时目录,出问题时也是唯一的自救开关。
  const override = String((env && env.HELLOBOSS_DATA_DIR) || '').trim();
  if (override) return path.resolve(override);

  if (!sea) return path.join(appDir, 'data');

  const base = String((env && env.LOCALAPPDATA) || '').trim();
  if (!base) {
    // 理论上 Windows 上一定有;真没有时退回旧行为(挨着 exe),
    // 而不是抛错 —— 一个目录解析不出来不该让整个工具起不来。
    return path.join(appDir, 'data');
  }
  return path.join(base, APP_FOLDER, 'data');
}

/**
 * 把旧版留在 exe 旁边的 data/ 搬到新位置。
 *
 * 只在「新位置还不存在」时动手 —— 两边都有时以新位置为准,绝不覆盖已经有内容的目录。
 * 优先 rename(同盘瞬时完成);跨盘失败时退回递归复制,并**保留**原目录作为兜底,
 * 让用户自己确认后再删。任何失败都不抛出去:迁移是尽力而为的附加动作,
 * 它不该让工具起不来 —— 起不来比数据暂留旧位置更糟。
 *
 * @returns {{moved: boolean, reason: string, keptLegacy?: boolean}}
 */
function migrateLegacyData(options) {
  const { legacyDir, dataDir, log } = options;
  const say = typeof log === 'function' ? log : () => {};

  if (path.resolve(legacyDir) === path.resolve(dataDir)) return { moved: false, reason: 'same-dir' };
  if (fs.existsSync(dataDir)) return { moved: false, reason: 'target-exists' };
  if (!hasUserData(legacyDir)) return { moved: false, reason: 'no-legacy-data' };

  try {
    fs.mkdirSync(path.dirname(dataDir), { recursive: true });
    fs.renameSync(legacyDir, dataDir);
    say(`已把用户数据从 ${legacyDir} 迁移到 ${dataDir}`);
    return { moved: true, reason: 'renamed' };
  } catch (error) {
    say(`直接搬迁失败(${error.message}),改用复制`);
  }

  try {
    fs.cpSync(legacyDir, dataDir, { recursive: true });
    say(`已复制用户数据到 ${dataDir};原目录 ${legacyDir} 保持不动,确认无误后可自行删除`);
    return { moved: true, reason: 'copied', keptLegacy: true };
  } catch (error) {
    // 复制失败可能已经写出一个**残缺**的新目录。必须把它清掉:留着的话下次启动会
    // 看到「新位置已存在」而跳过迁移,用户拿到的是一个半份的 data —— 那正是这次
    // 迁移要防的静默丢数据。
    //
    // 删它是安全的:进到这个分支说明 cpSync 之前新位置并不存在(上面的 existsSync 挡过),
    // 里面的东西只可能来自这次失败的复制,而源目录一个字都没动。
    try {
      if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (cleanupError) {
      say(`清掉复制残骸失败:${cleanupError.message}`);
    }
    say(`数据迁移失败,继续使用原目录:${error.message}`);
    // 调用方要退回用旧目录,否则会拿着一个空的 data/ 起服务。
    return { moved: false, reason: `copy-failed: ${error.message}` };
  }
}

/**
 * 源码解包目录:按内容指纹分目录,同一份代码重复启动会复用。
 *
 * 用指纹而不是固定目录名,是为了让两个不同版本的 exe 同时跑时各写各的 ——
 * 固定目录会让后启动的那个覆盖掉前一个正在 import 的源码。
 */
function resolveRuntimeDir(options) {
  const { appDir, buildId, env } = options;
  const name = String(buildId || 'unknown').replace(/[^a-z0-9]/gi, '') || 'unknown';

  const base = String((env && env.LOCALAPPDATA) || '').trim();
  if (!base) return path.join(appDir, 'runtime', name);
  return path.join(base, APP_FOLDER, 'runtime', name);
}

// ---- 解包 ----

function readManifest(sea, manifestKey) {
  const raw = sea.getRawAsset(manifestKey);
  if (!raw) throw new Error(`exe 里没有资源清单(${manifestKey})`);
  const manifest = JSON.parse(Buffer.from(raw).toString('utf8'));
  if (!manifest || !Array.isArray(manifest.keys) || manifest.keys.length === 0) {
    throw new Error('资源清单里没有任何文件');
  }
  return manifest;
}

function sameContent(file, buffer) {
  try {
    const current = fs.readFileSync(file);
    return current.length === buffer.length && current.equals(buffer);
  } catch {
    return false;
  }
}

// 写文件的目标是「要么完整的新内容,要么完整的旧内容」,不存在中间态。
// 控制进程与判定子进程会先后跑同一条解包逻辑,读到半个文件会直接崩。
function writeAtomic(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, buffer);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * 把内嵌资源解包到 runtimeDir。
 *
 * 为什么必须落盘:src/ 内部全是 `./xxx.js` 这种相对导入,而 ESM 的 import 只认 URL;
 * `data:` URL 不支持相对导入,SEA 也没有「从内存里 import」这条路。所以解包到磁盘
 * 是唯一不用改一行源码就能让 import 正常工作的办法 —— 代价是几十毫秒的写文件。
 *
 * @returns {{srcDir: string, buildId: string, written: number, reused: boolean}}
 */
function extractAssets(options) {
  const { sea, manifestKey, runtimeDir, force, log } = options;
  const say = typeof log === 'function' ? log : () => {};

  const manifest = readManifest(sea, manifestKey);
  const doneMarker = path.join(runtimeDir, DONE_MARKER);
  if (!force && fs.existsSync(doneMarker)) {
    return { srcDir: path.join(runtimeDir, 'src'), buildId: manifest.buildId, written: 0, reused: true };
  }

  // 先清掉上次那半份,免得「新文件齐全但旧的多余文件还在」被 import 到。
  // 只删这个指纹目录内部 —— 别碰父目录(LOCALAPPDATA 下还有别的版本)。
  if (fs.existsSync(runtimeDir)) fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  let written = 0;
  for (const key of manifest.keys) {
    // key 直接当相对路径用。它来自我们自己写进 exe 的清单,但仍挡一道:
    // 将来清单若能外部生成,`../` 会让解包写到目录外面去。
    const relative = String(key).replace(/\\/g, '/');
    if (relative.startsWith('/') || relative.split('/').includes('..')) {
      throw new Error(`资源清单里有非法路径:${key}`);
    }

    const raw = sea.getRawAsset(key);
    if (!raw) throw new Error(`exe 里缺少资源:${key}`);
    const buffer = Buffer.from(raw);
    const target = path.join(runtimeDir, relative);

    if (sameContent(target, buffer)) continue;
    writeAtomic(target, buffer);
    written += 1;
  }

  const srcDir = path.join(runtimeDir, 'src');
  if (!fs.existsSync(path.join(srcDir, 'server.js'))) {
    throw new Error(`解包后找不到 src/server.js:${srcDir}`);
  }

  // 标记最后写:它一出现就代表上面每个资源都已经落盘。
  fs.writeFileSync(doneMarker, `${manifest.buildId}\n`, 'utf8');
  say(`已解包 ${written} 个文件到 ${runtimeDir}`);
  return { srcDir, buildId: manifest.buildId, written, reused: false };
}

// ---- 运行期(以下只在真正启动时用到) ----

const SEA = isSea();

// exe 所在目录就是安装目录。
// 开发时直接跑 `node launcher/bootstrap.cjs`,安装目录就是 launcher/ 的上一级。
const APP_DIR = SEA ? path.dirname(process.execPath) : path.resolve(__dirname, '..');

// 开发模式下的源码根(server/)。
//
// 注意 exe 模式下 __dirname **就是 exe 所在目录**(不是虚拟路径),所以不能再靠
// `__dirname/..` 往上推 —— 那会推到 exe 的上一级去。只有开发模式能用它。
const DEV_ROOT = path.resolve(__dirname, '..');
// 仓库里油猴脚本的位置(boss-greeting/ 下),只有开发模式有意义:exe 里那份是从
// 内嵌资源解包出来的,见 userscriptPath()。
const DEV_USERSCRIPT = path.resolve(DEV_ROOT, '..', USERSCRIPT_NAME);

// 用户数据目录:懒算 + 缓存。
//
// **不在模块加载时算**:单测 require 这个文件只为拿上面的纯函数,那时既不该定目录、
// 更不该往 process.env 里写东西 —— 写了就会漏给同一个测试进程里后面加载的
// src/server.js,让「测的是临时目录」变成「测的是仓库的 data/」。
let dataDirCache = null;
function dataDir() {
  if (!dataDirCache) {
    dataDirCache = resolveDataDir({ appDir: APP_DIR, sea: SEA, env: process.env });
    // 派生出去的子进程靠它拿到同一个目录:控制进程写哪、判定进程就读哪。
    process.env.HELLOBOSS_DATA_DIR = dataDirCache;
  }
  return dataDirCache;
}

function appendLog(file, line) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.appendFileSync(path.join(dataDir(), file), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // 日志写不进去不该把启动本身搞砸
  }
}

function log(line) {
  appendLog('launcher.log', line);
}

function logFile() {
  return path.join(dataDir(), 'launcher.log');
}

// 弹窗必须绕开命令行编码:cmd 的代码页是 936,中文直接塞进 -Command 会乱码。
// 所以先把话写进 UTF-8 文件,让 PowerShell 读文件再弹。
function showError(message) {
  const file = path.join(dataDir(), 'last-error.txt');
  let target = file;
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
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
    // HELLOBOSS_DATA_DIR 已经在 process.env 里,子进程跟着继承,不必再传一次。
    env: { ...process.env, ...extraEnv },
  });
}

// 源码目录:exe 模式解包到 LOCALAPPDATA,开发模式直接用磁盘上的 src/。
//
// 解包失败时退回「exe 旁边的 src/」:老的分发方式(带上 src 文件夹)仍然能跑,
// 而且万一解包这一步在别人机器上被拦(杀软、权限),还有一条活路 ——
// 那种情况下「能跑但用的是旧源码」远好过「完全起不来」。
let ROOT = null;
function appRoot() {
  if (ROOT) return ROOT;

  if (!SEA) {
    ROOT = DEV_ROOT;
    return ROOT;
  }

  try {
    const sea = require('node:sea');
    const manifest = readManifest(sea, MANIFEST_KEY);
    const runtimeDir = resolveRuntimeDir({ appDir: APP_DIR, buildId: manifest.buildId, env: process.env });
    const { srcDir, written, reused } = extractAssets({
      sea, manifestKey: MANIFEST_KEY, runtimeDir, log,
    });
    log(`源码就绪:build=${manifest.buildId} ${reused ? '复用已解包副本' : `本次写入 ${written} 个文件`}`);
    // 返回 src 的上级 —— 后面统一按 `<root>/src/xxx.js` 拼。
    ROOT = path.dirname(srcDir);
    return ROOT;
  } catch (error) {
    log(`解包内嵌源码失败:${error.stack || error.message}`);
    // 退回「exe 旁边的 src/」。setRoot 只有这一步会用到 exe 目录本身 ——
    // 正常路径读的是解包出来的那份,exe 旁边有没有 src/ 都无所谓。
    if (fs.existsSync(path.join(APP_DIR, 'src', 'server.js'))) {
      log('回退到 exe 旁边的 src/');
      ROOT = APP_DIR;
      return ROOT;
    }
    throw error;
  }
}

// 油猴脚本:exe 里那份解包出来之后就在 runtime 目录下;找不到时退回 exe 旁边的副本。
function userscriptPath() {
  const candidates = [path.join(appRoot(), USERSCRIPT_NAME)];
  if (SEA) {
    // 老的分发方式会把脚本放在 exe 旁边,留着这条路。
    candidates.push(path.join(APP_DIR, USERSCRIPT_NAME));
  } else {
    candidates.push(DEV_USERSCRIPT);
  }
  return candidates.find((file) => fs.existsSync(file)) || '';
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
// 磁盘上的规则/知识库又改过),直接复用它看起来像「双击没生效」。
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
  const entry = path.join(appRoot(), 'src', 'server.js');
  let server;
  try {
    const { createServer } = await import(pathToFileURL(entry).href);
    // 判定服务只接 /evaluate,不提供大屏,也就不需要脚本路径。
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
  let root;
  try {
    root = appRoot();
  } catch (error) {
    log(`源码不可用:${error.stack || error.message}`);
    showError(`解包内嵌源码失败。\n\n${error.message}\n\n详细日志:${logFile()}`);
    return;
  }

  const entry = path.join(root, 'src', 'supervisor.js');
  if (!fs.existsSync(entry)) {
    log(`找不到 ${entry}`);
    showError(`找不到 src\\supervisor.js(已在 ${root} 下找过)。\n\n`
      + `如果这个 exe 是解压出来的,请重新解压一次;若仍失败,请把 ${logFile()} 发出来。`);
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
      // 大屏的「安装脚本」按钮要用它。取不到时那一步会明确报 404 并说明找过哪里。
      userscriptFile: userscriptPath(),
    });
  } catch (error) {
    log(`控制进程启动失败:${error.stack || error.message}`);
    showError(`${error.message}\n\n详细日志:${logFile()}`);
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
    showError(`${error.message}\n\n详细日志:${logFile()}`);
    process.exit(1);
  });
}

// 用户数据搬家。必须发生在任何子进程之前 —— 它们都按 HELLOBOSS_DATA_DIR 落盘,
// 搬一半就派生会让两个进程写两个目录。
//
// 迁移失败(跨盘复制也失败)时**退回旧目录**,而不是硬用那个空的新目录:
// 用户看到「规则和知识库全没了」比看到「数据还在老地方」糟糕得多。
function ensureDataDir() {
  try {
    const legacy = path.join(APP_DIR, 'data');
    const target = dataDir();
    const result = migrateLegacyData({ legacyDir: legacy, dataDir: target, log });

    if (!result.moved && String(result.reason).startsWith('copy-failed')) {
      dataDirCache = legacy;
      process.env.HELLOBOSS_DATA_DIR = legacy;
      log(`数据目录退回 ${legacy}`);
    }
    fs.mkdirSync(dataDir(), { recursive: true });
  } catch (error) {
    log(`准备数据目录失败:${error.message}`);
  }
}

function main() {
  if (process.env[WORKER_MARKER] === '1') {
    runWorker();
  } else if (process.env[CONTROL_MARKER] === '1') {
    runControl();
  } else {
    // 父进程:派生隐藏的控制进程后立刻退出,黑窗跟着消失。
    // 控制进程的 stdout/stderr 落到 data/server.log —— 否则 src/ 里的 console.warn
    // (比如「知识库为空」)会随隐藏窗口一起消失,出了问题无从查起。
    ensureDataDir();
    const dir = dataDir();

    let out = 'ignore';
    let err = 'ignore';
    try {
      fs.mkdirSync(dir, { recursive: true });
      out = fs.openSync(path.join(dir, 'server.log'), 'a');
      err = fs.openSync(path.join(dir, 'server.error.log'), 'a');
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
}

// 只有作为入口时才真的启动。单测 require 这个文件是为了拿上面的纯函数,
// 它们不该顺手把服务拉起来 —— 而 `require.main === module` 在 SEA 里同样成立。
if (require.main === module) main();

module.exports = {
  APP_FOLDER,
  DATA_MARKERS,
  DONE_MARKER,
  MANIFEST_KEY,
  USERSCRIPT_NAME,
  extractAssets,
  hasUserData,
  migrateLegacyData,
  readManifest,
  resolveDataDir,
  resolveRuntimeDir,
};
