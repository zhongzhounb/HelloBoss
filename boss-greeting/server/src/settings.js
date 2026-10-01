import fs from 'node:fs';
import path from 'node:path';

// 大屏上可以直接改的配置(判定规则、招呼样例、AI 接入)。
//
// 为什么不放进 config/preferences.json:那些文件是**启动时**读一次、且是用户手改的静态配置,
// 而这几项要在大屏上随时改、即时生效,并且是运行时数据。放 data/ 下还有个好处 ——
// 它已经在 .gitignore 里,个人招呼样例与 API 密钥不会被提交进仓库。
//
// 与 loadServerConfig 的错误处理**刻意相反**:服务配置(lan/token)坏掉必须拒绝启动(fail-closed),
// 因为那关系到把记录暴露给整个局域网;而这里只是个可空开关,坏掉时退回「没有规则、没有样例」
// —— 那恰好等于改造前的行为,服务照常跑,不该因为一个可选功能起不来。

// AI 接入的默认值。默认指向 Anthropic 官方端点、且**密钥留空**。
// 空密钥 = 尚未接入,判定一律走 fallback(见 evaluator.callMessagesApi 的守卫),
// 与「没有判定规则就不放行」是同一套 fail-closed 思路 —— 克隆下来不配任何东西,
// 服务能跑、大屏能看,但不会有一个岗位被自动投出去。
export const DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_MODEL = 'claude-haiku-4-5';

export const DEFAULTS = {
  decisionPrompt: '',
  greetingSamples: [],
  aiEndpoint: DEFAULT_ENDPOINT,
  aiKey: '',
  aiModel: DEFAULT_MODEL,
};
export const MAX_PROMPT_CHARS = 4000;
export const MAX_SAMPLES = 50;
export const MAX_SAMPLE_CHARS = 200;
export const MAX_ENDPOINT_CHARS = 300;
export const MAX_KEY_CHARS = 300;
export const MAX_MODEL_CHARS = 100;

// 端点必须是能解析的 http(s) 绝对地址。写错时**在保存这一刻**就报错,
// 而不是等到某次判定静默 fallback —— 后者在日志里跟"模型抽风"长得一模一样,极难查。
function assertEndpoint(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('AI 端点不是合法 URL,请填完整地址(如 https://api.anthropic.com/v1/messages)');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`AI 端点只支持 http/https,当前是 ${parsed.protocol}`);
  }
}

// 「去空白后非空的字符串,否则退回默认」—— 端点与模型名共用这条规则。
// 密钥不适用:空密钥是合法状态(表示未接入),没有"默认密钥"可退。
function textOr(value, fallback, maxChars) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxChars) : fallback;
}

// 宽松归一:读取路径用(文件可能被手改坏)。绝不抛 —— 坏值退回默认。
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  return {
    decisionPrompt:
      typeof source.decisionPrompt === 'string'
        ? source.decisionPrompt.slice(0, MAX_PROMPT_CHARS)
        : '',
    greetingSamples: Array.isArray(source.greetingSamples)
      ? source.greetingSamples
          .filter((sample) => typeof sample === 'string')
          .map((sample) => sample.trim())
          .filter(Boolean)
          .slice(0, MAX_SAMPLES)
          .map((sample) => sample.slice(0, MAX_SAMPLE_CHARS))
      : [],
    // 读取路径**不校验 URL 形态**:文件被手改坏时宁可让它跑到 fetch 那一步失败
    // (结果是 fallback),也不要因为一个可选配置读不出来就让服务起不来。
    aiEndpoint: textOr(source.aiEndpoint, DEFAULT_ENDPOINT, MAX_ENDPOINT_CHARS),
    aiModel: textOr(source.aiModel, DEFAULT_MODEL, MAX_MODEL_CHARS),
    aiKey: typeof source.aiKey === 'string' ? source.aiKey.trim().slice(0, MAX_KEY_CHARS) : '',
  };
}

// 给 HTTP 边界用的脱敏。**明文密钥绝不进 HTTP 响应体** —— 大屏是可以用令牌
// 对局域网开放的,把密钥塞进响应等于把它交给同网段的每一台设备。
//
// aiKey 恒为空串,末四位单独放在 aiKeyHint 里只作显示。刻意不把末四位放进 aiKey:
// 那样用户只改判定规则、连 key 一起提交时,存储里的真密钥会被这个截断串覆盖掉。
// 空串同时充当「本次未修改密钥」的哨兵 —— 见 validatePatch 对空 aiKey 的处理。
export function redactSettings(settings) {
  const key = String((settings && settings.aiKey) || '');
  return {
    ...settings,
    aiKey: '',
    hasAiKey: Boolean(key),
    aiKeyHint: key ? `…${key.slice(-4)}` : '',
  };
}

// 严格校验:保存路径用。用户在大屏上直接改,打错要看到原因,
// 不能像读取路径那样静默丢弃 —— 那会让「保存成功但没生效」变成难查的 bug。
// 空行不算错(前端 textarea 按行拆,末尾常留空行),会被清掉。
export function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('请求体必须是一个 JSON 对象');
  }

  const result = {};

  if ('decisionPrompt' in patch) {
    if (typeof patch.decisionPrompt !== 'string') {
      throw new Error('decisionPrompt 必须是字符串');
    }
    if (patch.decisionPrompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`判定规则太长:${patch.decisionPrompt.length} 字,上限 ${MAX_PROMPT_CHARS} 字`);
    }
    result.decisionPrompt = patch.decisionPrompt;
  }

  if ('greetingSamples' in patch) {
    if (!Array.isArray(patch.greetingSamples)) {
      throw new Error('greetingSamples 必须是字符串数组');
    }
    const cleaned = patch.greetingSamples
      .map((sample) => {
        if (typeof sample !== 'string') throw new Error('greetingSamples 里每一项都必须是字符串');
        return sample.trim();
      })
      .filter(Boolean);

    if (cleaned.length > MAX_SAMPLES) {
      throw new Error(`招呼样例太多:${cleaned.length} 条,上限 ${MAX_SAMPLES} 条`);
    }
    const tooLong = cleaned.find((sample) => sample.length > MAX_SAMPLE_CHARS);
    if (tooLong) {
      throw new Error(`招呼样例太长(${tooLong.length} 字,上限 ${MAX_SAMPLE_CHARS} 字):${tooLong.slice(0, 30)}…`);
    }

    result.greetingSamples = cleaned;
  }

  if ('aiEndpoint' in patch) {
    if (typeof patch.aiEndpoint !== 'string') throw new Error('aiEndpoint 必须是字符串');
    const endpoint = patch.aiEndpoint.trim();
    if (!endpoint) throw new Error('AI 端点不能为空');
    if (endpoint.length > MAX_ENDPOINT_CHARS) {
      throw new Error(`AI 端点太长:${endpoint.length} 字,上限 ${MAX_ENDPOINT_CHARS} 字`);
    }
    assertEndpoint(endpoint);
    result.aiEndpoint = endpoint;
  }

  if ('aiModel' in patch) {
    if (typeof patch.aiModel !== 'string') throw new Error('aiModel 必须是字符串');
    const model = patch.aiModel.trim();
    if (!model) throw new Error('模型名不能为空');
    if (model.length > MAX_MODEL_CHARS) {
      throw new Error(`模型名太长:${model.length} 字,上限 ${MAX_MODEL_CHARS} 字`);
    }
    result.aiModel = model;
  }

  // 空的 aiKey = 「本次不动密钥」,不是「清空」。大屏的密钥框不回填(见 redactSettings),
  // 所以用户改完判定规则顺手点保存时那一栏必然是空的 —— 若当成清空,保存规则就会
  // 悄悄废掉密钥,而界面看起来一切正常。真要清空走 clearAiKey。
  if ('aiKey' in patch) {
    if (typeof patch.aiKey !== 'string') throw new Error('aiKey 必须是字符串');
    const key = patch.aiKey.trim();
    if (key.length > MAX_KEY_CHARS) {
      throw new Error(`API Key 太长:${key.length} 字,上限 ${MAX_KEY_CHARS} 字`);
    }
    if (key) result.aiKey = key;
  }

  // 显式清空优先于同一请求里带的 aiKey —— 「清除」是明确意图,不该被旧值盖掉。
  if (patch.clearAiKey) result.aiKey = '';

  // 多余的键静默忽略 —— 前端只发这几项,多出来的多半是历史遗留字段,
  // 为它报错只会让老页面在新服务上保存失败。
  return result;
}

export function createSettingsStore(file) {
  let current = { ...DEFAULTS };

  if (fs.existsSync(file)) {
    try {
      current = normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      console.warn(`[settings] 配置读取失败,已退回默认值(${file}):${error.message}`);
      current = { ...DEFAULTS };
    }
  }

  function get() {
    // 返回副本:调用方(如招呼语生成)会随手改数组,slices 一份免得把内部状态改掉。
    // 用展开而不是逐字段列举 —— 否则以后再加配置项,漏补这里就会变成
    // 「存进去了但读不出来」,而且两边都不报错。
    return { ...current, greetingSamples: current.greetingSamples.slice() };
  }

  function save(patch) {
    const merged = normalizeSettings({ ...current, ...validatePatch(patch) });

    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 临时文件 + rename:这里是**整体覆盖**写,不像 ledger 的追加写。
    // 直接覆写时若中途断电/写满,留下的半截 JSON 会让下次启动读不回来。
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(merged, null, 2), 'utf8');
    fs.renameSync(temp, file);

    current = merged;
    return get();
  }

  return { get, save };
}
