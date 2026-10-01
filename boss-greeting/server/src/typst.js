// Typst 源码的轻量词法工具。只处理这份简历模板实际用到的语法,不做完整 Typst 解析。
//
// 两个必须守住的边界:
// 1. 注释剥离要对字符串免疫 —— 简历里的 link: "https://..." 含 //,按行切会砍掉 URL。
// 2. 参数切分要按括号深度 —— 内容块里含逗号(如 [从0到1, 独立完成])。

// 剥离 // 行注释,字符串字面量内部的内容原样保留。
export function stripComments(source) {
  let out = '';
  let inString = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') {
        out += ch + (source[i + 1] ?? '');
        i += 1;
        continue;
      }
      out += ch;
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

// 从 openIndex 处的左括号出发找配对的右括号,忽略字符串与嵌套括号。
export function matchParen(source, openIndex) {
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 按出现顺序提取所有 #name(...) 调用的原始参数字符串。
export function extractMacroCalls(source, name) {
  const calls = [];
  const needle = `#${name}(`;
  let from = 0;
  for (;;) {
    const start = source.indexOf(needle, from);
    if (start === -1) break;
    const open = start + needle.length - 1;
    const end = matchParen(source, open);
    if (end === -1) break;
    calls.push(source.slice(open + 1, end));
    from = end + 1;
  }
  return calls;
}

// 按顶层逗号切分参数,字符串与 () [] {} 内部的逗号不切。
export function splitTopLevelArgs(argsStr) {
  const args = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (let i = 0; i < argsStr.length; i += 1) {
    const ch = argsStr[i];
    if (inString) {
      if (ch === '\\') {
        current += ch + (argsStr[i + 1] ?? '');
        i += 1;
        continue;
      }
      current += ch;
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

// 把参数列表拆成位置参数和命名参数。形如 key: value 的算命名参数,
// 但以引号开头的字符串参数即使含冒号也算位置参数(如 "硕士 | 计算机技术")。
export function parseArgs(argList) {
  const positional = [];
  const named = {};
  for (const raw of argList) {
    const text = String(raw).trim();
    const match = text.match(/^([A-Za-z_][\w-]*)\s*:\s*([\s\S]*)$/);
    if (match && !text.startsWith('"')) {
      named[match[1]] = match[2].trim();
    } else {
      positional.push(text);
    }
  }
  return { positional, named };
}

// 参数原文 → JS 值:字符串去引号,内容块去方括号,none → null。
export function parseValue(raw) {
  const text = String(raw ?? '').trim();
  if (text === 'none' || text === '') return null;
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text.slice(1, -1);
  }
  if (text.startsWith('[') && text.endsWith(']') && text.length >= 2) {
    return text.slice(1, -1).trim().replace(/\s+/g, ' ');
  }
  return text;
}
