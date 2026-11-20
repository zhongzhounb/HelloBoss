import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createSupervisor } from '../src/supervisor.js';

// 控制进程的端到端契约:页面常驻、判定服务默认关闭、按钮启停。
// 判定服务用真子进程(和 workerController 测试同理),但内容极简。

const WORKER_CODE = `
const http = require('node:http');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const payload = JSON.stringify({ forwarded: true, echo: body && JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  });
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('HELLOBOSS_WORKER_PORT=' + server.address().port + '\\n');
});
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;

function fakeWorker() {
  return spawn(process.execPath, ['-e', WORKER_CODE], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

test('supervisor: 默认停着,按钮启动后 /evaluate 才转发到后台服务', async (t) => {
  const port = await freePort();
  const supervisor = createSupervisor({
    port,
    exitWhenIdle: false,
    spawnWorker: fakeWorker,
    log: () => {},
    exit: () => {},
  });
  t.after(() => {
    if (typeof supervisor.server.closeAllConnections === 'function') {
      supervisor.server.closeAllConnections();
    }
    supervisor.server.close();
  });

  await supervisor.ready;
  const base = `http://127.0.0.1:${port}`;

  const before = await (await fetch(`${base}/api/service`)).json();
  assert.equal(before.managed, true);
  assert.equal(before.running, false, '默认不启动判定服务');

  const off = await postJson(`${base}/evaluate`, { job: { jobName: 'x' } });
  assert.equal(off.status, 503, '服务没起来时 /evaluate 要明确拒绝');

  const started = await (await postJson(`${base}/api/service/start`)).json();
  assert.equal(started.running, true);

  const on = await postJson(`${base}/evaluate`, { job: { jobName: '嵌入式' } });
  assert.equal(on.status, 200);
  const evaluated = await on.json();
  assert.equal(evaluated.forwarded, true, '请求要到达后台服务');
  assert.equal(evaluated.echo.job.jobName, '嵌入式');

  const stopped = await (await postJson(`${base}/api/service/stop`)).json();
  assert.equal(stopped.running, false);

  supervisor.shutdown();
});

test('supervisor: /api/shutdown 让旧实例退出,判定服务一起停掉', async (t) => {
  const port = await freePort();
  let exited = false;
  const supervisor = createSupervisor({
    port,
    exitWhenIdle: false,
    spawnWorker: fakeWorker,
    log: () => {},
    exit: () => { exited = true; },
  });
  t.after(() => {
    if (typeof supervisor.server.closeAllConnections === 'function') {
      supervisor.server.closeAllConnections();
    }
    supervisor.server.close();
  });

  await supervisor.ready;
  const base = `http://127.0.0.1:${port}`;

  const started = await (await postJson(`${base}/api/service/start`)).json();
  assert.equal(started.running, true);

  // 下一次双击 exe 走的就是这个入口:旧实例必须先收掉判定服务再退出。
  const res = await postJson(`${base}/api/shutdown`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);

  const deadline = Date.now() + 5000;
  while (!exited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(exited, true, '旧控制进程应当退出');
  assert.equal(supervisor.worker.isRunning(), false, '退出前要停掉判定服务');
});


