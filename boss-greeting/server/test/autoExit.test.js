import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 起一个**真进程**来测:大屏连接断开 → 服务自己退出,这条链路包括 start()、
// releaseAll()、server.close() 能不能真的把进程收掉 —— 只有在真进程里才走得通,
// import 进来测不到(入口那段代码在 process.argv 判断里)。
//
// 宽限期用环境变量压到 300 毫秒,不然一个用例要等一分钟。

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 借一个空闲端口:先绑 0 拿到系统分配的号,再让出来给子进程用。
async function freePort() {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

async function waitForHealthy(port, output) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // 还没起来,继续等。
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等服务起来超时。子进程输出:\n${output()}`);
}

test('大屏连接断开后,服务进程自己退出', async (t) => {
  const port = await freePort();
  // 指到临时配置:本机真实的 config/server.json 一旦是 lan: true,
  // 这条用例就会随本机状态时灵时不灵(局域网模式下服务本来就不该自己退)。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoexit-'));
  const configFile = path.join(dir, 'server.json');
  fs.writeFileSync(configFile, JSON.stringify({ lan: false, token: '' }));

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      SERVER_CONFIG: configFile,
      BOSS_EXIT_WHEN_IDLE: '1',
      BOSS_IDLE_GRACE_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  await waitForHealthy(port, () => output);

  // 大屏页面挂上那条连接。
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/watch`, { signal: controller.signal });
  assert.equal(res.status, 200);
  await res.body.getReader().read();

  // 页面开着(哪怕在后台)服务就不该退 —— 等的时间远超 300 毫秒宽限。
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(child.exitCode, null, '大屏还开着,服务不该退出');

  // 关掉页面:断开这条连接。
  controller.abort();
  const code = await new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => reject(new Error(`等服务退出超时。输出:\n${output}`)), 10000);
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });

  assert.equal(code, 0, `应该是干净退出。输出:\n${output}`);
  assert.match(output, /大屏已关闭,服务退出/, `退出原因要写进日志(日志就是 data\\server.log)。输出:\n${output}`);
});
