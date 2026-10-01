import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger, normalizeRecord, toCsv } from '../src/ledger.js';

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  return path.join(dir, name);
}

const base = {
  company: '中科飞测', companyScale: '1000-9999人', companyIndustry: '半导体设备',
  jobName: '软件测试工程师', city: '广州', address: '广州·黄埔区', salary: '20-30K',
  stage: 'skipped', verdict: false, reason: '城市:成都不在可投城市',
  greeting: '', variant: 'cpp',
};

// ---- normalizeRecord ----

test('缺失字段补空串,多余字段丢弃', () => {
  const record = normalizeRecord({ company: 'A', 未知字段: 'x' });
  assert.equal(record.company, 'A');
  assert.equal(record.jobName, '');
  assert.equal(record.未知字段, undefined);
});

test('verdict 只保留严格 true/false,其余归 null', () => {
  assert.equal(normalizeRecord({ verdict: true }).verdict, true);
  assert.equal(normalizeRecord({ verdict: false }).verdict, false);
  assert.equal(normalizeRecord({ verdict: 'true' }).verdict, null);
  assert.equal(normalizeRecord({ verdict: 1 }).verdict, null);
  assert.equal(normalizeRecord({}).verdict, null);
});

test('stage 只保留严格 sent,其余归 skipped', () => {
  assert.equal(normalizeRecord({ stage: 'sent' }).stage, 'sent');
  assert.equal(normalizeRecord({ stage: 'SENT' }).stage, 'skipped');
  assert.equal(normalizeRecord({}).stage, 'skipped');
});

// ---- append / 持久化 ----

test('追加后能从文件读回', () => {
  const file = tempFile('jobs.jsonl');
  const ledger = createLedger(file);
  ledger.append(base);

  const reopened = createLedger(file);
  assert.equal(reopened.all().length, 1);
  assert.equal(reopened.all()[0].company, '中科飞测');
});

test('seq 从 1 开始递增,重启后继续递增而不重置', () => {
  const file = tempFile('jobs.jsonl');
  const first = createLedger(file);
  assert.equal(first.append(base).record.seq, 1);
  assert.equal(first.append(base).record.seq, 2);

  // 重启:新的 ledger 实例读同一文件,seq 必须接着 3,而不是回到 1
  const second = createLedger(file);
  assert.equal(second.append(base).record.seq, 3);
});

test('损坏的行被跳过,不影响其它记录与服务启动', () => {
  const file = tempFile('jobs.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(base)}\n这不是JSON\n${JSON.stringify(base)}\n`, 'utf8');

  const ledger = createLedger(file);
  assert.equal(ledger.all().length, 2, '两条合法记录都应读回');
  // 损坏行仍占用一个 seq,故新记录从 4 开始,保证 seq 与文件位置对齐
  assert.equal(ledger.append(base).record.seq, 4);
});

test('落盘失败时仍进内存,并报告 persisted=false', () => {
  const file = tempFile('jobs.jsonl');
  const ledger = createLedger(file);   // 正常构造,目录已被 mkdirSync 建好

  // 把目标路径换成一个同名目录 —— 追加文件时必然 EISDIR。
  // 不能用「不存在的子目录」来构造失败:createLedger 会 recursive 建目录,那样反而会成功。
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);

  const result = ledger.append(base);
  assert.equal(result.persisted, false);
  assert.equal(ledger.all().length, 1, '内存里仍应能看到,页面不至于空白');
});

// ---- readSince ----

test('readSince 只返回 seq 更大的记录', () => {
  const ledger = createLedger(tempFile('jobs.jsonl'));
  ledger.append(base);
  ledger.append(base);
  ledger.append(base);

  assert.equal(ledger.readSince(0).length, 3);
  assert.equal(ledger.readSince(2).length, 1);
  assert.equal(ledger.readSince(3).length, 0);
});

test('readSince 传非法值时当作 0', () => {
  const ledger = createLedger(tempFile('jobs.jsonl'));
  ledger.append(base);
  assert.equal(ledger.readSince('abc').length, 1);
  assert.equal(ledger.readSince(undefined).length, 1);
  assert.equal(ledger.readSince(-5).length, 1);
});

// ---- stats ----

test('stats 区分本轮与累计,并统计发送异常', () => {
  const file = tempFile('jobs.jsonl');

  // 先用旧 runId 写两条,模拟"上一次运行遗留的文件"
  const previous = createLedger(file);
  previous.setRunId('run-A');
  previous.append({ ...base, runId: 'run-A', stage: 'sent', verdict: true });
  previous.append({ ...base, runId: 'run-A', stage: 'skipped', verdict: true });

  // 本轮:服务重启,读同一文件,runId 换成 run-B
  const ledger = createLedger(file);
  ledger.setRunId('run-B');
  ledger.append({ ...base, runId: 'run-B', stage: 'sent', verdict: true });
  ledger.append({ ...base, runId: 'run-B', stage: 'skipped', verdict: false });
  ledger.append({ ...base, runId: 'run-B', stage: 'skipped', verdict: true });   // 异常:判投没发
  ledger.append({ ...base, runId: 'run-B', stage: 'skipped', verdict: null });   // 未判定

  const stats = ledger.stats();

  // 本轮 4 条:judged 3(一条 null 不算)、sent 1、skipped 3、anomaly 1
  assert.deepEqual(stats.current, { judged: 3, sent: 1, skipped: 3, anomaly: 1 });

  // 累计 6 条:judged 5、sent 2、skipped 4、anomaly 2(两轮各一条)
  assert.deepEqual(stats.total, { judged: 5, sent: 2, skipped: 4, anomaly: 2 });
});

// ---- CSV ----

test('CSV 含表头,并按 RFC 4180 转义', () => {
  const csv = toCsv([
    normalizeRecord({ company: 'A, Inc', reason: '他说"你好"\n换行', verdict: true }),
  ]);
  const lines = csv.split('\r\n');

  assert.match(lines[0], /^at,runId,company,/);
  assert.match(csv, /"A, Inc"/, '含逗号的值应加引号');
  assert.match(csv, /"他说""你好""/, '内部引号应翻倍');
});

test('CSV 对空记录也不产生多余列', () => {
  const csv = toCsv([normalizeRecord({})]);
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1].split(',').length, lines[0].split(',').length);
});

// ---- dailyCounts ----

// 东八区。固定它而不是读本机时区,断言才是纯算术的、跨机器成立。
const CST = { offsetMinutes: 480 };

test('dailyCounts 把同一天的记录合并,并区分已投递 / 已判定', () => {
  const ledger = createLedger(tempFile('jobs.jsonl'));
  ledger.append({ ...base, at: '2026-09-24T02:00:00.000Z', stage: 'sent', verdict: true });
  ledger.append({ ...base, at: '2026-09-24T06:00:00.000Z', stage: 'skipped', verdict: false });
  // verdict 为 null = 没走到判定(黑名单 / 已沟通等前置跳过),不计入「已判定」。
  ledger.append({ ...base, at: '2026-09-24T14:00:00.000Z', stage: 'skipped', verdict: null });

  assert.deepEqual(ledger.dailyCounts(CST), [{ date: '2026-09-24', sent: 1, judged: 2 }]);
});

test('dailyCounts 跨天分离并按日期升序', () => {
  const ledger = createLedger(tempFile('jobs.jsonl'));
  // 故意乱序写入:排序必须是函数保证的,不能靠写入顺序。
  ledger.append({ ...base, at: '2026-09-26T02:00:00.000Z', stage: 'sent' });
  ledger.append({ ...base, at: '2026-09-24T02:00:00.000Z', stage: 'skipped' });
  ledger.append({ ...base, at: '2026-09-25T02:00:00.000Z', stage: 'sent' });

  assert.deepEqual(ledger.dailyCounts(CST).map((d) => d.date), [
    '2026-09-24', '2026-09-25', '2026-09-26',
  ]);
});

test('dailyCounts 按本地日期分组,凌晨的记录不会算到前一天', () => {
  // 这是分组的承重断言:16:30Z 在北京是次日 00:30。按 UTC 分组会落到 24 号,
  // 按本地日期才落到 25 号 —— 而凌晨正是脚本挂机跑的高峰时段。
  const ledger = createLedger(tempFile('jobs.jsonl'));
  ledger.append({ ...base, at: '2026-09-24T16:30:00.000Z', stage: 'sent' });
  ledger.append({ ...base, at: '2026-09-24T15:59:00.000Z', stage: 'skipped' }); // 北京 23:59,仍在 24 号

  assert.deepEqual(ledger.dailyCounts(CST), [
    { date: '2026-09-24', sent: 0, judged: 1 },
    { date: '2026-09-25', sent: 1, judged: 1 },
  ]);
});

test('dailyCounts 跳过 at 缺失或损坏的记录,不编造日期', () => {
  // 不是理论情况:/report 的 at 兜底是后加的,之前落盘的记录 at 就是空串
  // (data/jobs.jsonl 里现存的第一条就是)。
  const ledger = createLedger(tempFile('jobs.jsonl'));
  ledger.append({ ...base, at: '', stage: 'sent' });
  ledger.append({ ...base, at: '不是时间', stage: 'sent' });
  ledger.append({ ...base, at: '2026-09-24T02:00:00.000Z', stage: 'sent' });

  assert.deepEqual(ledger.dailyCounts(CST), [{ date: '2026-09-24', sent: 1, judged: 1 }]);
});

test('dailyCounts 无记录时返回空数组', () => {
  assert.deepEqual(createLedger(tempFile('jobs.jsonl')).dailyCounts(CST), []);
});

test('dailyCounts 不传时区参数时按本机时区分组', () => {
  const ledger = createLedger(tempFile('jobs.jsonl'));
  ledger.append({ ...base, at: '2026-09-24T02:00:00.000Z', stage: 'sent' });

  const [bucket] = ledger.dailyCounts();
  // 不写死具体日期 —— 那会依赖运行机器。只验证它确实按本机时区算出了同一个日期。
  assert.equal(bucket.date, new Date('2026-09-24T02:00:00.000Z').toLocaleDateString('sv-SE'));
  assert.equal(bucket.sent, 1);
});

