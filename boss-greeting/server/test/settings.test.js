import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSettingsStore,
  normalizeSettings,
  redactSettings,
  validatePatch,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
} from '../src/settings.js';

function tempFile(name = 'settings.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  return path.join(dir, name);
}

// 「所有配置项都取默认值」的规范形态。整对象断言一律拿它比对,不逐字面量列举 ——
// 以后再加配置项时,这些断言不必跟着改一遍(改了还容易漏一处)。
const ALL_DEFAULTS = normalizeSettings({});

// ---- normalizeSettings（读取路径：宽松，绝不抛） ----

test('缺字段与非法类型一律退回默认值', () => {
  assert.deepEqual(normalizeSettings(undefined), ALL_DEFAULTS);
  assert.deepEqual(normalizeSettings(null), ALL_DEFAULTS);
  assert.deepEqual(normalizeSettings('不是对象'), ALL_DEFAULTS);
  assert.deepEqual(normalizeSettings({ decisionPrompt: 42, greetingSamples: '不是数组' }), ALL_DEFAULTS);
});

test('读取时清掉空行、非字符串项与超长项', () => {
  const result = normalizeSettings({
    decisionPrompt: '规则',
    greetingSamples: ['  985硕  ', '', '   ', 42, null, '中秋节快乐'],
  });
  assert.equal(result.decisionPrompt, '规则');
  assert.deepEqual(result.greetingSamples, ['985硕', '中秋节快乐']);
});

test('读取时超长内容被截断而不是丢弃', () => {
  const long = 'a'.repeat(300);
  assert.equal(normalizeSettings({ greetingSamples: [long] }).greetingSamples[0].length, 200);
});

// ---- validatePatch（保存路径：严格，要报错给人看） ----

test('保存时非字符串 prompt 被拒', () => {
  assert.throws(() => validatePatch({ decisionPrompt: 42 }), /必须是字符串/);
});

test('保存时非数组 samples 被拒', () => {
  assert.throws(() => validatePatch({ greetingSamples: '一条' }), /必须是字符串数组/);
});

test('保存时数组里混入非字符串被拒', () => {
  assert.throws(() => validatePatch({ greetingSamples: ['ok', 42] }), /每一项都必须是字符串/);
});

test('保存时超长 prompt 被拒而不是静默截断', () => {
  assert.throws(() => validatePatch({ decisionPrompt: 'x'.repeat(4001) }), /太长/);
});

test('保存时超长样例被拒', () => {
  assert.throws(() => validatePatch({ greetingSamples: ['y'.repeat(201)] }), /太长/);
});

test('保存时空行被清掉但不算错', () => {
  assert.deepEqual(validatePatch({ greetingSamples: ['  a  ', '', '   '] }).greetingSamples, ['a']);
});

test('只接受已知字段，多余的键被忽略', () => {
  const result = validatePatch({ decisionPrompt: 'x', 未知字段: 'y' });
  assert.deepEqual(result, { decisionPrompt: 'x' });
  assert.equal(validatePatch({ 未知字段: 'y' }).未知字段, undefined);
});

test('空 patch 合法（用于只改其中一项）', () => {
  assert.deepEqual(validatePatch({}), {});
});

// ---- createSettingsStore ----

test('文件不存在时返回默认值', () => {
  const store = createSettingsStore(tempFile());
  assert.deepEqual(store.get(), ALL_DEFAULTS);
});

test('保存后能读回，且换个实例（模拟重启）也读得回', () => {
  const file = tempFile();
  const store = createSettingsStore(file);
  store.save({ decisionPrompt: '20k 以上直接投', greetingSamples: ['985硕'] });

  const expected = { ...ALL_DEFAULTS, decisionPrompt: '20k 以上直接投', greetingSamples: ['985硕'] };
  assert.deepEqual(store.get(), expected);

  const reopened = createSettingsStore(file);
  assert.deepEqual(reopened.get(), expected);
});

test('保存是合并而不是整体替换，未提交的字段保持原值', () => {
  const store = createSettingsStore(tempFile());
  store.save({ decisionPrompt: '规则', greetingSamples: ['样例'] });
  store.save({ greetingSamples: ['新样例'] });

  assert.deepEqual(store.get(), { ...ALL_DEFAULTS, decisionPrompt: '规则', greetingSamples: ['新样例'] });
});

test('get 返回副本，外部改数组不会污染内部状态', () => {
  const store = createSettingsStore(tempFile());
  store.save({ greetingSamples: ['一条'] });
  store.get().greetingSamples.push('外部塞进来的');

  assert.deepEqual(store.get().greetingSamples, ['一条']);
});

test('文件损坏时退回默认值且不抛，服务照常可用', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{坏掉的 JSON', 'utf8');

  const store = createSettingsStore(file);
  assert.deepEqual(store.get(), ALL_DEFAULTS);
  // 坏文件不能把存储变成只读 —— 保存要能把它覆盖成合法内容。
  assert.doesNotThrow(() => store.save({ decisionPrompt: '新规则' }));
  assert.equal(store.get().decisionPrompt, '新规则');
});

test('保存非法输入时抛错，且不留下半截文件', () => {
  const file = tempFile();
  const store = createSettingsStore(file);
  store.save({ decisionPrompt: '原值' });

  assert.throws(() => store.save({ decisionPrompt: 'x'.repeat(4001) }), /太长/);
  assert.equal(store.get().decisionPrompt, '原值', '失败的保存不应改动已有配置');
  assert.deepEqual(createSettingsStore(file).get().decisionPrompt, '原值', '磁盘上也不该被写坏');

  // 临时文件必须被清掉,不能留在 data/ 里堆着。
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

// ---- AI 接入配置 ----

test('AI 接入的默认值：官方端点、默认模型、密钥留空', () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.aiEndpoint, DEFAULT_ENDPOINT);
  assert.equal(defaults.aiModel, DEFAULT_MODEL);
  assert.equal(defaults.aiKey, '', '默认密钥必须是空 —— 空即「未接入」,判定走 fail-closed');
});

test('读取时端点/模型为空串退回默认，密钥为空串保持为空', () => {
  const result = normalizeSettings({ aiEndpoint: '   ', aiModel: '', aiKey: '   ' });
  assert.equal(result.aiEndpoint, DEFAULT_ENDPOINT);
  assert.equal(result.aiModel, DEFAULT_MODEL);
  assert.equal(result.aiKey, '');
});

test('保存时非 http(s) 的端点被拒', () => {
  assert.throws(() => validatePatch({ aiEndpoint: '不是URL' }), /不是合法 URL/);
  assert.throws(() => validatePatch({ aiEndpoint: 'ftp://example.com/v1/messages' }), /只支持 http\/https/);
});

test('保存时合法端点与模型被接受，两端空白被去掉', () => {
  const result = validatePatch({ aiEndpoint: '  https://api.anthropic.com/v1/messages  ', aiModel: ' claude-haiku-4-5 ' });
  assert.equal(result.aiEndpoint, 'https://api.anthropic.com/v1/messages');
  assert.equal(result.aiModel, 'claude-haiku-4-5');
});

test('保存时空 aiKey 不写入 —— 表示「本次不动密钥」而非清空', () => {
  assert.deepEqual(validatePatch({ aiKey: '' }), {});
  assert.deepEqual(validatePatch({ aiKey: '   ' }), {});
  assert.equal(validatePatch({ aiKey: 'sk-ant-abc' }).aiKey, 'sk-ant-abc');
});

test('只改判定规则时，已存的密钥不被清掉', () => {
  const store = createSettingsStore(tempFile());
  store.save({ aiKey: 'sk-ant-real-key' });
  // 大屏的密钥框不回填，用户改完规则提交时那一栏是空的 —— 正是这条路径。
  store.save({ decisionPrompt: '新规则', aiKey: '' });

  assert.equal(store.get().aiKey, 'sk-ant-real-key');
  assert.equal(store.get().decisionPrompt, '新规则');
});

test('clearAiKey 能显式清空密钥，且优先于同一请求里的 aiKey', () => {
  const store = createSettingsStore(tempFile());
  store.save({ aiKey: 'sk-ant-real-key' });
  store.save({ clearAiKey: true });
  assert.equal(store.get().aiKey, '');

  store.save({ aiKey: 'sk-ant-new', clearAiKey: true });
  assert.equal(store.get().aiKey, '', '「清除」是明确意图，不该被同一请求里的旧值盖掉');
});

test('redactSettings 不含明文密钥，只给末四位提示', () => {
  const redacted = redactSettings({ aiEndpoint: DEFAULT_ENDPOINT, aiKey: 'sk-ant-secret-1234', aiModel: DEFAULT_MODEL });

  assert.equal(redacted.aiKey, '');
  assert.equal(redacted.hasAiKey, true);
  assert.equal(redacted.aiKeyHint, '…1234');
  // 关键断言：整个序列化结果里不能出现明文密钥。
  assert.equal(JSON.stringify(redacted).includes('sk-ant-secret-1234'), false);
  // 其余字段原样透出，大屏才能回填。
  assert.equal(redacted.aiEndpoint, DEFAULT_ENDPOINT);
  assert.equal(redacted.aiModel, DEFAULT_MODEL);
});

test('redactSettings 在未配置密钥时不给出提示', () => {
  const redacted = redactSettings({ aiKey: '' });
  assert.equal(redacted.hasAiKey, false);
  assert.equal(redacted.aiKeyHint, '');
});
