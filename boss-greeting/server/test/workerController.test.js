import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWorkerController } from '../src/workerController.js';

// 用一个真子进程当「后台判定服务」:端口握手、请求转发、停止都是跨进程行为,
// 纯桩测不到 stdout 握手和 kill 之后的状态回收。

const WORKER_CODE = `
const http = require('node:http');
const server = http.createServer((req, res) => {
  if (req.url === '/evaluate') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.stringify({ echo: JSON.parse(body), forwarded: true });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
    });
    return;
  }
  if (req.url === '/api/cache/clear') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(404);
  res.end();
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

// 模仿 http.ServerResponse 里 forwardEvaluate 用到的那几个成员。
function fakeResponse() {
  return {
    headersSent: false,
    status: 0,
    payload: '',
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
    },
    end(payload) {
      this.payload = String(payload || '');
    },
  };
}

test('workerController: 启动后能转发 /evaluate,停止后状态回到 stopped', async (t) => {
  const controller = createWorkerController({ spawnWorker: fakeWorker });
  t.after(() => controller.stop());

  const started = await controller.start();
  assert.equal(started.running, true);
  assert.equal(started.state, 'running');
  assert.ok(started.port > 0, '端口要从子进程 stdout 握手里拿到');

  const res = fakeResponse();
  await controller.forwardEvaluate(JSON.stringify({ job: { jobName: '嵌入式开发' } }), res);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.forwarded, true);
  assert.equal(body.echo.job.jobName, '嵌入式开发');

  const stopped = await controller.stop();
  assert.equal(stopped.running, false);
  assert.equal(stopped.state, 'stopped');
});

test('workerController: 子进程起不来时 start 明确失败,不留 starting 状态', async () => {
  const controller = createWorkerController({
    spawnWorker: () => spawn(process.execPath, ['-e', 'process.exit(2)'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  });

  await assert.rejects(() => controller.start(), /启动失败|启动超时/);
  assert.equal(controller.status().running, false);
  assert.equal(controller.status().state, 'stopped');
});
