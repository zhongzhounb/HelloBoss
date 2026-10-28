import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, loadServerConfig, lanAddresses } from './server.js';
import { createWorkerController } from './workerController.js';
import { createIdleExit, DEFAULT_GRACE_MS } from './idleExit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_CONFIG_FILE = path.join(ROOT, 'config', 'server.json');
const PORT = Number(process.env.PORT || 8787);

// 控制进程:exe 双击后常驻的那一层。
//
// 它自己提供大屏、配置、记录与导出,但**不判定**。判定跑在一个可随时启停的子进程里
// (workerController.js)。这样「默认不启动服务」才成立:页面一直能开,而 /evaluate
// 在服务没启动时明确回 503。
//
// 局域网开关也住在这里:改 config/server.json 后重新 listen,不需要再单独跑脚本。
export function createSupervisor(options = {}) {
  const log = options.log || ((line) => console.log(line));
  const spawnWorker = options.spawnWorker;
  if (typeof spawnWorker !== 'function') {
    throw new Error('createSupervisor 需要 spawnWorker');
  }

  const configFile = options.configFile || process.env.SERVER_CONFIG || SERVER_CONFIG_FILE;
  const port = Number(options.port || PORT);
  const exitWhenIdle = options.exitWhenIdle !== false;
  const graceMs = Number(options.graceMs || process.env.BOSS_IDLE_GRACE_MS) || DEFAULT_GRACE_MS;
  // 退出动作可注入:测试里不能让控制进程把测试进程一起 exit 掉。
  const exit = options.exit || ((code) => process.exit(code));

  // 启动时读一次;之后由大屏的局域网开关原地更新。读取失败(比如 lan: true 却没有
  // token)直接抛给 bootstrap —— 那是配置错误,不能悄悄退回「只听回环」。
  let current = loadServerConfig(configFile);

  const worker = createWorkerController({
    spawnWorker,
    log,
  });

  // 大屏关掉后,控制进程和判定服务一起退出。局域网模式下不退出:那时服务是给整个
  // 局域网用的,不该由某一台设备的标签页决定生死。
  const idle = exitWhenIdle
    ? createIdleExit({
      graceMs,
      onIdle: () => {
        if (current.lan) return;
        shutdown('大屏已关闭');
      },
    })
    : null;

  let server = null;
  let closing = false;
  let rebindTimer = null;
  let rebinding = false;

  function lanUrls() {
    if (!current.lan) return [];
    return lanAddresses().map((address) =>
      `http://${address}:${port}/dashboard?token=${current.token}`);
  }

  const lanControl = {
    status() {
      return {
        managed: true,
        enabled: current.lan,
        token: current.token,
        urls: lanUrls(),
      };
    },

    async setEnabled(enabled) {
      const next = Boolean(enabled);
      if (next === current.lan) return lanControl.status();

      const token = current.token || crypto.randomUUID().replace(/-/g, '');
      current = { lan: next, token };
      writeServerConfig(configFile, current);
      // 先把响应发出去再重新绑定:closeAllConnections() 会把当前这条请求的连接
      // 一起收掉,如果同步重绑,大屏就收不到「已开启」的回复了。
      scheduleRebind();
      return lanControl.status();
    },
  };

  const serviceControl = {
    status: () => worker.status(),
    isRunning: () => worker.isRunning(),
    start: () => worker.start(),
    stop: () => worker.stop(),
    forwardEvaluate: (raw, res) => worker.forwardEvaluate(raw, res),
    clearCache: () => worker.clearCache(),
  };

  server = createServer({
    token: () => current.token,
    idle,
    serviceControl,
    lanControl,
    // 新一次双击 exe 会先让这份旧控制进程退场(判定服务一起收掉),
    // 再由新实例接管端口 —— 见 launcher/bootstrap.cjs 的 stopPreviousControl()。
    shutdownControl: () => shutdown('收到新的启动请求'),
  });

  function writeServerConfig(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ lan: value.lan, token: value.token }, null, 2), 'utf8');
    fs.renameSync(temp, file);
  }

  function listen(host) {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  async function rebind() {
    if (rebinding) return;
    rebinding = true;
    try {
      await new Promise((resolve) => {
        server.close(() => resolve());
        // 长连接(大屏的 SSE)不主动收掉的话,close() 会一直等它们。
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
      try {
        await listen(current.lan ? '::' : '127.0.0.1');
        log(`[HelloBoss] 监听已切换为 ${current.lan ? '局域网' : '仅本机'}`);
      } catch (error) {
        // 双栈监听失败时退回本机:至少别把大屏弄丢。配置保持用户选的值,
        // 下次启动会再试一次。
        log(`[HelloBoss] 切换监听失败:${error.message},退回仅本机`);
        await listen('127.0.0.1');
      }
    } finally {
      rebinding = false;
    }
  }

  function scheduleRebind() {
    if (rebindTimer) clearTimeout(rebindTimer);
    // 200ms 足够让「已开启 / 已关闭」的响应写完并被浏览器收下。
    rebindTimer = setTimeout(() => {
      rebindTimer = null;
      rebind().catch((error) => log(`[HelloBoss] 重新监听失败:${error.message}`));
    }, 200);
  }

  function shutdown(reason) {
    if (closing) return;
    closing = true;
    log(`[HelloBoss] ${reason},控制进程退出`);

    // 先停判定服务,再收大屏连接。worker.stop() 自带超时,不会卡住退出。
    worker.stop().finally(() => {
      if (idle) idle.releaseAll();
      server.close(() => exit(0));
      setTimeout(() => {
        log('[HelloBoss] 收尾超时,强制退出');
        exit(0);
      }, 45_000).unref();
    });
  }

  const started = listen(current.lan ? '::' : '127.0.0.1')
    .then(() => {
      if (idle) idle.start();
      log(`[HelloBoss] 控制台监听 http://127.0.0.1:${port}`);
      if (current.lan) {
        for (const url of lanUrls()) log(`[HelloBoss] 手机访问 ${url}`);
      }
      if (typeof options.onListening === 'function') {
        options.onListening({ port, lan: current.lan, token: current.token });
      }
    });

  return {
    server,
    worker,
    idle,
    ready: started,
    shutdown,
    config: () => ({ ...current }),
  };
}
