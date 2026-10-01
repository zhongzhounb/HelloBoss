import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdleExit } from '../src/idleExit.js';

// 用假定时器测:真等 60 秒不现实,而这里要验的就是「到点没到点」。
// 每条用例都重新建一个 tracker,免得相互影响。
function makeIdle(over = {}) {
  const fired = [];
  const idle = createIdleExit({
    graceMs: 1000,
    firstGraceMs: 5000,
    onIdle: () => fired.push('idle'),
    ...over,
  });
  return { idle, fired };
}

// 假的连接:只要有个 end() 就够 —— 模块只把它当句柄用。
function makeConnection() {
  return { ended: false, end() { this.ended = true; } };
}

test('启动后一直没人连上,过了首段宽限就退出', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { idle, fired } = makeIdle();
  idle.start();

  t.mock.timers.tick(4999);
  assert.equal(fired.length, 0, '没到点不该退出');
  t.mock.timers.tick(1);
  assert.equal(fired.length, 1, '白起的服务不该赖着不走');
});

test('页面连上之后,首段宽限不再触发退出', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { idle, fired } = makeIdle();
  idle.start();
  idle.add(makeConnection());

  t.mock.timers.tick(60_000);
  assert.equal(fired.length, 0);
  assert.equal(idle.count(), 1);
});

test('最后一个连接断掉,过了宽限才退出', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { idle, fired } = makeIdle();
  idle.start();
  const release = idle.add(makeConnection());

  release();
  t.mock.timers.tick(999);
  assert.equal(fired.length, 0, '宽限期就是用来容忍刷新和自动重连的');
  t.mock.timers.tick(1);
  assert.equal(fired.length, 1);
  assert.equal(idle.count(), 0);
});

test('还有别的页面在看时不退出', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { idle, fired } = makeIdle();
  idle.start();
  const releaseA = idle.add(makeConnection());
  idle.add(makeConnection());
  assert.equal(idle.count(), 2);

  releaseA();
  t.mock.timers.tick(60_000);
  assert.equal(fired.length, 0, '关掉其中一个标签页不代表没人看了');
  assert.equal(idle.count(), 1);
});

test('宽限期内又连回来就不退出', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { idle, fired } = makeIdle();
  idle.start();
  const release = idle.add(makeConnection());
  release();

  t.mock.timers.tick(500);
  idle.add(makeConnection()); // 刷新后页面重新连上
  t.mock.timers.tick(60_000);
  assert.equal(fired.length, 0);
});

test('同一个连接重复注销不会把计数减成负数', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { idle, fired } = makeIdle();
  idle.start();
  const release = idle.add(makeConnection());

  release();
  release();
  release();
  assert.equal(idle.count(), 0);
  // 计数被减到负数的话,这里就永远等不到退出 —— 表现为服务永久赖着不走。
  t.mock.timers.tick(1000);
  assert.equal(fired.length, 1);
});

test('releaseAll 会结束所有连接,并且之后不再触发退出', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { idle, fired } = makeIdle();
  idle.start();
  const a = makeConnection();
  const b = makeConnection();
  const releaseA = idle.add(a);
  idle.add(b);

  idle.releaseAll();
  assert.equal(a.ended, true, '不退的流会让 server.close() 收不了尾');
  assert.equal(b.ended, true);
  assert.equal(idle.count(), 0);

  // 结束连接会让浏览器那边断开,进而回调 release —— 那一下不能又把定时器装上,
  // 否则退出过程里还会再触发一次 onIdle。
  releaseA();
  t.mock.timers.tick(60_000);
  assert.equal(fired.length, 0);
});
