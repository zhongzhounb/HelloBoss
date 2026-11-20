import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { collectAssets, computeBuildId, buildManifest, MANIFEST_KEY, USERSCRIPT_NAME } from '../launcher/assets.mjs';

// 引导层是 CJS(SEA 只嵌 main,相对 require 在 exe 里会失败),所以它导出的纯函数
// 用 createRequire 拿 —— require 它不会启动服务,那条路有 `require.main === module` 守着。
const require = createRequire(import.meta.url);
const {
  DONE_MARKER,
  extractAssets,
  migrateLegacyData,
  readManifest,
  resolveDataDir,
  resolveRuntimeDir,
} = require('../launcher/bootstrap.cjs');

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hb-${label}-`));
}

// 假 sea:把一组内存文件当成 exe 内嵌资源。这样解包逻辑不用真造一个 exe 就能测。
function fakeSea(files) {
  const map = new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
  return {
    getRawAsset: (key) => map.get(key),
    has: (key) => map.has(key),
  };
}

function manifestFor(keys, buildId = 'abc123') {
  return JSON.stringify({ buildId, keys });
}

test('资源清单里带上 src 全部文件、package.json 与油猴脚本', () => {
  const assets = collectAssets({
    srcDir: path.resolve(import.meta.dirname, '..', 'src'),
    serverDir: path.resolve(import.meta.dirname, '..'),
    userscriptFile: path.resolve(import.meta.dirname, '..', '..', USERSCRIPT_NAME),
  });

  // src 下的每个 .js 都要在清单里 —— 漏一个的表现是「exe 启动即崩」,不是构建报错,
  // 所以这条用目录扫描来比,而不是手写一份期望列表。
  const srcJs = fs.readdirSync(path.resolve(import.meta.dirname, '..', 'src'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `src/${name}`);
  for (const key of srcJs) assert.ok(assets[key], `清单缺少 ${key}`);

  assert.ok(assets['package.json'], 'package.json 必须在包里(type: module 靠它生效)');
  assert.ok(assets[USERSCRIPT_NAME], '油猴脚本必须在包里');
});

test('src 目录为空时收集资源直接报错,而不是打出一个残缺的包', () => {
  const dir = tmpdir('empty-src');
  assert.throws(() => collectAssets({
    srcDir: dir,
    serverDir: path.resolve(import.meta.dirname, '..'),
    userscriptFile: path.resolve(import.meta.dirname, '..', '..', USERSCRIPT_NAME),
  }), /没有可打包的/);
});

test('构建 id 只看内容:同样的资源给同一个 id,改一个字就换一个', () => {
  const dir = tmpdir('buildid');
  const a = path.join(dir, 'a.js');
  fs.writeFileSync(a, 'const x = 1;\n');
  const one = { 'src/a.js': a };

  // id 每次都从磁盘现读,所以「先取一次再改文件」才是这条 test 想验的顺序。
  const before = computeBuildId(one);
  assert.equal(computeBuildId({ 'src/a.js': a }), before, '同样内容应得到同一个 id');

  fs.writeFileSync(a, 'const x = 2;\n');
  assert.notEqual(computeBuildId(one), before, '内容变了 id 就该变');

  // key 也参与指纹:同样内容放在不同 key 下不该算出同一个 id。
  const b = path.join(dir, 'b.js');
  fs.writeFileSync(b, 'const x = 1;\n');
  assert.notEqual(computeBuildId({ 'src/b.js': b }), before);
  assert.equal(computeBuildId({ 'src/a.js': b }), before, '内容是原来的内容 → id 回到原来的值');
});

test('清单列出全部 key,解包端不必依赖 sea.getAssetKeys', () => {
  const dir = tmpdir('manifest');
  const file = path.join(dir, 'x.js');
  fs.writeFileSync(file, 'export default 1;\n');
  const manifest = buildManifest({ 'src/x.js': file, 'package.json': file }, 'id-1');
  assert.equal(manifest.buildId, 'id-1');
  assert.deepEqual(manifest.keys, ['package.json', 'src/x.js']);
});

test('解包把资源写到目标目录,并能重复执行', () => {
  const dir = tmpdir('extract');
  const runtime = path.join(dir, 'runtime');
  const sea = fakeSea({
    [MANIFEST_KEY]: manifestFor(['src/server.js', 'src/dashboard.js', 'package.json'], 'build-1'),
    'src/server.js': 'export const createServer = () => {};\n',
    'src/dashboard.js': 'export const renderDashboardHtml = () => "";\n',
    'package.json': '{"type":"module"}\n',
  });

  const first = extractAssets({ sea, manifestKey: MANIFEST_KEY, runtimeDir: runtime });
  assert.equal(first.reused, false);
  assert.equal(first.written, 3);
  assert.equal(first.buildId, 'build-1');
  assert.equal(
    fs.readFileSync(path.join(runtime, 'src', 'server.js'), 'utf8'),
    'export const createServer = () => {};\n',
  );

  // 第二次必须复用:解包目录里的文件会被删掉重建的话,正在跑的进程会读到半个文件。
  const second = extractAssets({ sea, manifestKey: MANIFEST_KEY, runtimeDir: runtime });
  assert.equal(second.reused, true);
  assert.equal(second.written, 0);
});

test('解包目录里残留的旧文件会被清掉,不会跟着新版本一起被 import', () => {
  const dir = tmpdir('extract-stale');
  const runtime = path.join(dir, 'runtime');
  const sea = fakeSea({
    [MANIFEST_KEY]: manifestFor(['src/server.js'], 'build-1'),
    'src/server.js': 'export const createServer = () => {};\n',
  });

  fs.mkdirSync(path.join(runtime, 'src'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'src', 'removed-long-ago.js'), 'stale\n');

  extractAssets({ sea, manifestKey: MANIFEST_KEY, runtimeDir: runtime, force: true });
  assert.equal(fs.existsSync(path.join(runtime, 'src', 'removed-long-ago.js')), false);
  assert.equal(fs.existsSync(path.join(runtime, 'src', 'server.js')), true);
});

test('解包后找不到 src/server.js 就报错 —— 宁可起不来,也别跑一份半残的源码', () => {
  const dir = tmpdir('extract-broken');
  const sea = fakeSea({
    [MANIFEST_KEY]: manifestFor(['src/util.js'], 'build-1'),
    'src/util.js': 'export const a = 1;\n',
  });
  assert.throws(
    () => extractAssets({ sea, manifestKey: MANIFEST_KEY, runtimeDir: path.join(dir, 'runtime') }),
    /找不到 src\/server\.js/,
  );
});

test('清单里的相对路径逃逸被拒绝', () => {
  const dir = tmpdir('extract-escape');
  const sea = fakeSea({
    [MANIFEST_KEY]: manifestFor(['../evil.js'], 'build-1'),
    '../evil.js': 'boom\n',
  });
  assert.throws(
    () => extractAssets({ sea, manifestKey: MANIFEST_KEY, runtimeDir: path.join(dir, 'runtime') }),
    /非法路径/,
  );
});

test('exe 里没有清单时报错,而不是当成「零个资源」静默通过', () => {
  const sea = fakeSea({});
  assert.throws(() => readManifest(sea, MANIFEST_KEY), /没有资源清单/);
});

test('数据目录:开发模式留在源码目录,exe 模式放 LOCALAPPDATA', () => {
  const appDir = 'C:\\app';

  assert.equal(
    resolveDataDir({ appDir, sea: false, env: {} }),
    path.join(appDir, 'data'),
    '开发模式沿用原来的 data/ —— 仓库文档与相对路径都不用改',
  );

  assert.equal(
    resolveDataDir({ appDir, sea: true, env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' } }),
    path.join('C:\\Users\\x\\AppData\\Local', 'HelloBoss', 'data'),
    'exe 模式放到用户目录,跟着用户走而不是跟着 exe 走',
  );

  // 环境变量覆盖优先:冒烟测试与出问题时的自救开关。
  assert.equal(
    resolveDataDir({ appDir, sea: true, env: { LOCALAPPDATA: 'C:\\L', HELLOBOSS_DATA_DIR: 'D:\\mine' } }),
    path.resolve('D:\\mine'),
  );

  // 没有 LOCALAPPDATA 的怪环境退回旧行为,而不是抛错。
  assert.equal(resolveDataDir({ appDir, sea: true, env: {} }), path.join(appDir, 'data'));
});

test('运行目录按构建 id 分目录,非法字符不会跑到路径里', () => {
  const dir = resolveRuntimeDir({
    appDir: 'C:\\app',
    buildId: 'ab/../../cd',
    env: { LOCALAPPDATA: 'C:\\L' },
  });
  assert.equal(dir, path.join('C:\\L', 'HelloBoss', 'runtime', 'abcd'));
  assert.ok(!dir.includes('..'), '带 .. 的 id 不能拼进路径');
});

test('旧目录有用户数据时搬到新位置,并清掉旧目录', () => {
  const dir = tmpdir('migrate');
  const legacy = path.join(dir, 'app', 'data');
  const target = path.join(dir, 'local', 'HelloBoss', 'data');

  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'settings.json'), '{"knowledge":"我的简历"}\n');
  fs.writeFileSync(path.join(legacy, 'jobs.jsonl'), '{"company":"某公司"}\n');

  const result = migrateLegacyData({ legacyDir: legacy, dataDir: target });
  assert.equal(result.moved, true);
  assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), '{"knowledge":"我的简历"}\n');
  assert.equal(fs.existsSync(legacy), false, '同盘搬迁用 rename,旧目录应已消失');
});

test('新位置已经有数据时绝不被旧目录覆盖', () => {
  const dir = tmpdir('migrate-keep');
  const legacy = path.join(dir, 'legacy');
  const target = path.join(dir, 'target');
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'settings.json'), '{"knowledge":"旧的"}\n');
  fs.writeFileSync(path.join(target, 'settings.json'), '{"knowledge":"新的"}\n');

  const result = migrateLegacyData({ legacyDir: legacy, dataDir: target });
  assert.equal(result.moved, false);
  assert.equal(result.reason, 'target-exists');
  assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), '{"knowledge":"新的"}\n');
});

test('旧目录里只有日志时不搬 —— 那不算用户数据', () => {
  const dir = tmpdir('migrate-logs');
  const legacy = path.join(dir, 'legacy');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'launcher.log'), 'something\n');

  const result = migrateLegacyData({ legacyDir: legacy, dataDir: path.join(dir, 'target') });
  assert.equal(result.moved, false);
  assert.equal(result.reason, 'no-legacy-data');
  assert.equal(fs.existsSync(path.join(dir, 'target')), false, '不该凭空建出一个空数据目录');
});

test('没有旧目录时什么都不做', () => {
  const dir = tmpdir('migrate-none');
  const result = migrateLegacyData({
    legacyDir: path.join(dir, 'nope'),
    dataDir: path.join(dir, 'target'),
  });
  assert.equal(result.moved, false);
  assert.equal(result.reason, 'no-legacy-data');
});

test('跨盘复制失败时清掉残骸并退回旧目录 —— 别留下一个半份的 data 顶替真数据', () => {
  const dir = tmpdir('migrate-partial');
  const legacy = path.join(dir, 'legacy');
  const target = path.join(dir, 'local', 'HelloBoss', 'data');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'settings.json'), '{"knowledge":"我的简历"}\n');

  // 让 rename 失败(模拟跨盘),再让 cpSync 失败(模拟复制中途出错)。
  // 直接改 fs 上的函数即可 —— 这段逻辑就是靠这两个调用推进的,没有别的分支。
  const realRename = fs.renameSync;
  const realCp = fs.cpSync;
  fs.renameSync = () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); };
  fs.cpSync = (from, to) => {
    // 先写一个半成品出来,再抛错 —— 真实的中途失败就是这个形状。
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, 'settings.json.partial'), 'half\n');
    throw new Error('磁盘满了');
  };
  let result;
  try {
    result = migrateLegacyData({ legacyDir: legacy, dataDir: target });
  } finally {
    fs.renameSync = realRename;
    fs.cpSync = realCp;
  }

  assert.equal(result.moved, false);
  assert.match(result.reason, /^copy-failed/);
  assert.equal(fs.existsSync(target), false, '残骸必须清掉,否则下次会误判成「新位置已有数据」');
  assert.equal(fs.readFileSync(path.join(legacy, 'settings.json'), 'utf8'), '{"knowledge":"我的简历"}\n', '源数据一个字都不能动');
  // 残骸清掉之后重试一次,应该能正常搬过去。
  const retry = migrateLegacyData({ legacyDir: legacy, dataDir: target });
  assert.equal(retry.moved, true);
  assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), '{"knowledge":"我的简历"}\n');
});
