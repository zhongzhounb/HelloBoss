import { createServer } from './server.js';
import { createWorkerController } from './workerController.js';
import { createIdleExit, DEFAULT_GRACE_MS } from './idleExit.js';

const PORT = Number(process.env.PORT || 8787);

// 控制进程:exe 双击后常驻的那一层。
//
// 它自己提供大屏、配置、记录与导出,但**不判定**。判定跑在一个可随时启停的子进程里
// (workerController.js)。这样「默认不启动服务」才成立:页面一直能开,而 /evaluate
// 在服务没启动时明确回 503。
//
// 只听回环:大屏只在本机开。手机看大屏(局域网监听、令牌鉴权)已经整套移除 ——
// 一个本机工具开着局域网监听,等于把记录和写接口交给同网段,收益不值这个风险。
export function createSupervisor(options = {}) {
  const log = options.log || ((line) => console.log(line));
  const spawnWorker = options.spawnWorker;
  if (typeof spawnWorker !== 'function') {
    throw new Error('createSupervisor 需要 spawnWorker');
  }

  const port = Number(options.port || PORT);
  const exitWhenIdle = options.exitWhenIdle !== false;
  const graceMs = Number(options.graceMs || process.env.BOSS_IDLE_GRACE_MS) || DEFAULT_GRACE_MS;
  // 退出动作可注入:测试里不能让控制进程把测试进程一起 exit 掉。
  const exit = options.exit || ((code) => process.exit(code));

  const worker = createWorkerController({
    spawnWorker,
    log,
  });

  // 大屏关掉后,控制进程和判定服务一起退出。
  const idle = exitWhenIdle
    ? createIdleExit({
      graceMs,
      onIdle: () => shutdown('大屏已关闭'),
    })
    : null;

  let server = null;
  let closing = false;

  const serviceControl = {
    status: () => worker.status(),
    isRunning: () => worker.isRunning(),
    start: () => worker.start(),
    stop: () => worker.stop(),
    forwardEvaluate: (raw, res) => worker.forwardEvaluate(raw, res),
    clearCache: () => worker.clearCache(),
  };

  server = createServer({
    idle,
    serviceControl,
    // 油猴脚本在解包目录里(exe 模式),由引导层算好传进来 —— 大屏的「安装脚本」
    // 按钮要用它。不传时 createServer 退回仓库里的原文件。
    userscriptFile: options.userscriptFile,
    // 新一次双击 exe 会先让这份旧控制进程退场(判定服务一起收掉),
    // 再由新实例接管端口 —— 见 launcher/bootstrap.cjs 的 stopPreviousControl()。
    shutdownControl: () => shutdown('收到新的启动请求'),
  });

  function listen() {
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
      server.listen(port, '127.0.0.1');
    });
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

  const started = listen()
    .then(() => {
      if (idle) idle.start();
      log(`[HelloBoss] 控制台监听 http://127.0.0.1:${port}`);
      if (typeof options.onListening === 'function') {
        options.onListening({ port });
      }
    });

  return {
    server,
    worker,
    idle,
    ready: started,
    shutdown,
  };
}
