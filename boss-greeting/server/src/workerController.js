import http from 'node:http';

// 后台判定服务的生命周期控制器,由「控制进程」持有。
//
// 大屏默认不启动判定服务:控制进程只负责页面、配置与记录,用户点右上角
// 「启动服务」时才真正派生一个子进程去接 /evaluate。这个模块只管子进程的
// 启动、停止、状态和请求转发,不关心它是不是 exe —— 派生函数由调用方注入,
// 这样打包后的 exe 与 `node launcher/bootstrap.cjs` 共用同一套逻辑。
//
// 状态机:stopped -> starting -> running -> stopping -> stopped
// starting/running 期间子进程已经存在;stopping 期间等它退出。

export function createWorkerController(options = {}) {
  const spawnWorker = options.spawnWorker;
  const log = options.log || (() => {});
  const startTimeoutMs = options.startTimeoutMs ?? 15_000;
  // 判定最坏 42 秒(见 server.js 顶部的超时预算);脚本侧等 45 秒。
  // 转发请求的超时不能比脚本侧还长,否则脚本先断开而这里还在等。
  const forwardTimeoutMs = options.forwardTimeoutMs ?? 45_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;

  let child = null;
  let port = 0;
  let state = 'stopped';
  let startedAt = 0;
  let startPromise = null;
  let stopPromise = null;

  function status() {
    return {
      managed: true,
      running: state === 'running',
      state,
      port: state === 'running' ? port : null,
      pid: child && child.pid ? child.pid : null,
      startedAt: state === 'running' ? startedAt : null,
    };
  }

  function isRunning() {
    return state === 'running';
  }

  function start() {
    if (state === 'running') return Promise.resolve(status());
    if (startPromise) return startPromise;
    // 正在停止时直接再启动会把旧进程的 exit 回调和新进程的 child 混在一起,
    // 等停止落定后再走一次正常启动。
    if (stopPromise) return stopPromise.then(() => start());

    state = 'starting';
    startPromise = new Promise((resolve, reject) => {
      let settled = false;
      let buffer = '';
      let proc;

      try {
        proc = spawnWorker();
      } catch (error) {
        state = 'stopped';
        startPromise = null;
        reject(error);
        return;
      }
      child = proc;

      const timer = setTimeout(() => {
        fail(new Error(`判定服务启动超时(${startTimeoutMs}ms)`));
      }, startTimeoutMs);

      function settle() {
        clearTimeout(timer);
        startPromise = null;
      }

      function fail(error) {
        if (settled) return;
        settled = true;
        settle();
        state = 'stopped';
        port = 0;
        startedAt = 0;
        try { proc.kill(); } catch { /* 已经退出了 */ }
        child = null;
        reject(error);
      }

      // 端口握手依赖 stdout,日志依赖 stderr。派生方式被改坏时早点报错,
      // 别让状态永远停在 starting。
      if (!proc.stdout || !proc.stderr) {
        fail(new Error('spawnWorker 必须把 stdout/stderr 接成管道'));
        return;
      }

      // 子进程起来后把实际端口写进 stdout。用临时端口而不是固定 8788:
      // 固定端口会和别的实例/别的软件撞车,而这里除了控制进程没人需要知道它。
      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        if (settled) return;
        const match = /HELLOBOSS_WORKER_PORT=(\d+)/.exec(buffer);
        if (!match) return;

        port = Number(match[1]);
        state = 'running';
        startedAt = Date.now();
        settled = true;
        settle();
        log(`[worker] 判定服务已启动,内部端口 ${port}`);
        resolve(status());
      });

      proc.stderr.on('data', (chunk) => {
        log(`[worker] ${String(chunk).trimEnd()}`);
      });

      proc.on('error', (error) => fail(error));

      proc.on('exit', (code, signal) => {
        log(`[worker] 判定服务已退出(code=${code}, signal=${signal})`);
        if (!settled) {
          fail(new Error(`判定服务启动失败(code=${code})`));
          return;
        }
        // 运行中崩溃或被停掉:状态回到 stopped,下一次轮询会让按钮变回「启动服务」。
        if (child === proc) {
          child = null;
          port = 0;
          startedAt = 0;
          state = 'stopped';
        }
      });
    });

    return startPromise;
  }

  async function stop() {
    // 还在启动就先等它落定;启动失败的话已经没有东西可停了。
    if (startPromise) {
      try { await startPromise; } catch { return status(); }
    }
    if (state === 'stopped') return status();
    if (stopPromise) return stopPromise;

    state = 'stopping';
    stopPromise = new Promise((resolve) => {
      const proc = child;
      const finish = () => {
        child = null;
        port = 0;
        startedAt = 0;
        state = 'stopped';
        stopPromise = null;
        resolve(status());
      };

      if (!proc) {
        finish();
        return;
      }

      const timer = setTimeout(() => {
        log('[worker] 停止超时,强制结束');
        try { proc.kill('SIGKILL'); } catch { /* 已经退出了 */ }
      }, stopTimeoutMs);

      proc.once('exit', () => {
        clearTimeout(timer);
        finish();
      });

      try {
        proc.kill();
      } catch {
        // 进程可能刚好自己退了:exit 事件不会再来了,直接收尾。
        clearTimeout(timer);
        finish();
      }
    });

    return stopPromise;
  }

  // 把 /evaluate 原样转给后台服务。请求体已经在控制进程里读出来了,
  // 所以这里不再 pipe 原始 req,避免两个地方同时消费同一个流。
  function forwardEvaluate(raw, res) {
    return new Promise((resolve) => {
      if (!isRunning()) {
        const payload = JSON.stringify({ error: '判定服务未启动:请在大屏右上角点「启动服务」' });
        res.writeHead(503, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
        });
        res.end(payload);
        resolve();
        return;
      }

      const body = Buffer.from(raw);
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/evaluate',
        timeout: forwardTimeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
        },
      }, (upstream) => {
        const chunks = [];
        upstream.on('data', (chunk) => chunks.push(chunk));
        upstream.on('end', () => {
          const payload = Buffer.concat(chunks);
          res.writeHead(upstream.statusCode || 502, {
            'content-type': upstream.headers['content-type'] || 'application/json; charset=utf-8',
            'content-length': payload.length,
          });
          res.end(payload);
          resolve();
        });
      });

      req.on('timeout', () => req.destroy(new Error('判定服务超时')));
      req.on('error', (error) => {
        if (!res.headersSent) {
          const payload = JSON.stringify({ error: `判定服务无响应:${error.message}` });
          res.writeHead(502, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(payload),
          });
          res.end(payload);
        }
        resolve();
      });
      req.end(body);
    });
  }

  // 保存配置后清掉后台服务的判定缓存。失败只记日志 —— 下一次判定顶多多花一次调用,
  // 不值得让「保存配置」这个动作失败。
  function clearCache() {
    if (!isRunning()) return;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/cache/clear',
      headers: { 'content-length': 0 },
    }, (res) => res.resume());
    req.on('error', (error) => log(`[worker] 清缓存失败:${error.message}`));
    req.end();
  }

  return { status, isRunning, start, stop, forwardEvaluate, clearCache };
}
