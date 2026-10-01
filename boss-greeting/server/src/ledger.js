import fs from 'node:fs';
import path from 'node:path';

// 岗位记录的追加式存储。
//
// 用 JSONL 而不是 CSV:每行一个独立 JSON,追加写不会损坏已有内容,中文和换行
// 也不需要转义 —— 而招呼语和理由里两者都会出现。
//
// seq 定义为「记录在文件里的行号」(第 1 行是 1)。服务重启后按已读行数继续递增,
// **不重置** —— 否则页面持有的 since 会失效,导致重复拉取或漏拉。

export const FIELDS = [
  'at', 'runId', 'company', 'companyScale', 'companyIndustry',
  'jobName', 'city', 'address', 'salary',
  'stage', 'verdict', 'reason', 'greeting', 'variant',
];

// 上报体来自脚本,不能假设它完整或只含约定字段 —— 一律规范化后再落盘。
export function normalizeRecord(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const record = {};

  for (const key of FIELDS) {
    if (key === 'verdict') {
      record.verdict = source.verdict === true ? true : source.verdict === false ? false : null;
    } else if (key === 'stage') {
      record.stage = source.stage === 'sent' ? 'sent' : 'skipped';
    } else {
      record[key] = source[key] == null ? '' : String(source[key]);
    }
  }

  return record;
}

// CSV 转义遵循 RFC 4180:含逗号/引号/换行时用双引号包裹,内部引号翻倍。
// 行尾用 \r\n —— Excel 对 \n 的兼容性不如 \r\n。
export function toCsv(records) {
  const escape = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const header = FIELDS.join(',');
  const rows = records.map((record) => FIELDS.map((key) => escape(record[key])).join(','));
  return [header, ...rows].join('\r\n');
}

export function createLedger(file) {
  const records = [];
  let seq = 0;
  let currentRunId = '';

  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const text = line.trim();
      if (!text) continue;

      // 行号优先于解析结果:损坏行也占一个 seq,这样 seq 始终与文件位置对齐,
      // 不会因为一条坏行就让后续所有 seq 错位。
      seq += 1;
      try {
        const record = normalizeRecord(JSON.parse(text));
        record.seq = seq;
        records.push(record);
      } catch (error) {
        console.warn(`[ledger] 跳过损坏的记录行(${file}:${seq}):${error.message}`);
      }
    }
  }

  function append(raw) {
    const record = normalizeRecord(raw);
    seq += 1;
    record.seq = seq;
    records.push(record);

    let persisted = true;
    try {
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      // 落盘失败不能让服务崩,也不能丢内存里的记录 —— 页面照常能看到,
      // 只是重启后会丢这部分。调用方拿到 persisted=false 后回 500。
      persisted = false;
      console.warn(`[ledger] 落盘失败:${error.message}`);
    }

    return { record, persisted };
  }

  function readSince(since) {
    const numeric = Number(since);
    const from = Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
    return records.filter((record) => record.seq > from);
  }

  function tally() {
    return { judged: 0, sent: 0, skipped: 0, anomaly: 0 };
  }

  function stats() {
    const current = tally();
    const total = tally();

    for (const record of records) {
      const buckets = record.runId === currentRunId ? [current, total] : [total];
      for (const bucket of buckets) {
        if (record.verdict !== null) bucket.judged += 1;
        if (record.stage === 'sent') bucket.sent += 1;
        else bucket.skipped += 1;
        // 异常 = 判定投了,实际却没发出去。这是最值得盯的一类失败。
        if (record.verdict === true && record.stage !== 'sent') bucket.anomaly += 1;
      }
    }

    return { current, total };
  }

  // 每天的处理量(已沟通 / 未沟通),给大屏柱状图用。
  //
  // 按**本地日期**分组,不是 UTC。at 是 toISOString() 的 UTC 串,而服务跑在 UTC+8:
  // 北京凌晨 00:00-08:00 的记录若按 UTC 分组会被算到前一天,柱状图整体错位一天 ——
  // 而这段时间恰恰是脚本挂机跑的高峰。
  function dailyCounts(options = {}) {
    // offsetMinutes 是「本地时间相对 UTC 的分钟数」(东八区 = 480)。做成显式参数而不是
    // 直接读时区,是为了让单测能固定 480 做纯算术断言 —— Windows 上改 TZ 环境变量并不可靠。
    const offsetMinutes = Number.isFinite(options.offsetMinutes)
      ? options.offsetMinutes
      : -new Date().getTimezoneOffset();

    const buckets = new Map();

    for (const record of records) {
      const time = Date.parse(record.at);
      // at 缺失或坏掉的记录直接跳过,不编造日期。这不是理论情况:
      // /report 的 at 兜底是后加的,在那之前落盘的记录 at 是空串。
      if (!Number.isFinite(time)) continue;

      const date = new Date(time + offsetMinutes * 60000).toISOString().slice(0, 10);
      let bucket = buckets.get(date);
      if (!bucket) {
        bucket = { date, sent: 0, skipped: 0 };
        buckets.set(date, bucket);
      }

      // 未沟通 = 当天所有非 sent 的记录(前置跳过、判定不投、发送异常都算在内),
      // 与柱状图的「已沟通 + 未沟通 = 当天处理过的岗位总数」口径对应。
      if (record.stage === 'sent') bucket.sent += 1;
      else bucket.skipped += 1;
    }

    return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  return {
    append,
    readSince,
    all: () => records.slice(),
    stats,
    dailyCounts,
    setRunId: (id) => { currentRunId = String(id || ''); },
    seq: () => seq,
  };
}
