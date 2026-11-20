// 主脚本里几条「不许退化成群发」的性质。
//
// 为什么是源码级断言,而不是跑一遍:主脚本是一个 document-start 就执行的大 IIFE,
// 没有导出、也没有脱离 DOM 也能跑的入口,而仓库约定零依赖(不引 jsdom)。
// 所以这里退一步,守住**能被人手改回去的那几行**:
//
//   1. 默认问候语来源是「AI 判定」,不是「常用语」;
//   2. 源码里不存在「对每个岗位都一样的兜底话术」这种东西;
//   3. 取不到常用语时是抛错停下,而不是拿一句话顶上;
//   4. 配置校验在「开始」那一刻就拦住没有常用语的情况。
//
// 这几条的共同后果是「一字不变地连发几百遍同一句话」—— 账号被判群发的头号原因。
// 它们都是被有意删掉的兜底行为,这个文件就是防止有人顺手加回来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const USERSCRIPT = path.resolve(import.meta.dirname, '..', '..', 'zhipin-auto-greeting.user.js');
const source = fs.readFileSync(USERSCRIPT, 'utf8');

// 去掉注释后的源码。
//
// 为什么要这一步:被删掉的那些兜底行为,**注释里是写着名字的**(「以前有一个
// APP.defaultGreetingText…」)。直接对全文做「不许出现这个词」的断言,会被那段解释
// 自己绊倒 —— 而把注释一并删掉,断言就只针对真正会被执行的代码。
//
// 逐字符扫,按「是否在字符串字面量里」决定 `//` 算不算注释开头:
// 源码里满是 URL(https://…)和正则(/\wapi\/…/),用正则去注释是删不准的。
function stripComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (quote) {
      out += ch;
      // 反斜杠转义:把下一个字符一并吃掉,免得 \" 被当成字符串结尾。
      if (ch === '\\') { out += next == null ? '' : next; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

const code = stripComments(source);

test('去注释这一步没有把代码也删掉', () => {
  // 上面那个扫描器是手写的,先自证它没把整份源码吃掉 —— 否则后面所有「没有某写法」的
  // 断言都会因为「源码是空的」而假通过。
  assert.ok(code.length > source.length / 2, '去注释后代码不该缩水一半以上');
  assert.match(code, /function validateConfig\(/, '去注释后仍应看得见 validateConfig');
  assert.match(code, /const DEFAULT_CONFIG = \{/, '去注释后仍应看得见 DEFAULT_CONFIG');
});

test('主脚本默认的问候语来源是「AI 判定」,不是「常用语」', () => {
  // 默认落在「常用语」时,没配过常用语的新用户会一路退到兜底话术;
  // 而 fail-closed 闸门长在 aiGate 分支上,那时它根本不生效。
  const match = code.match(/greetingMode:\s*'([^']+)'/);
  assert.ok(match, '没有找到 greetingMode 的默认值');
  assert.equal(match[1], 'aiGate', '默认必须是 aiGate —— 换成 fastReply 会让新用户绕过全部筛选去群发');
});

test('代码里没有「默认问候语」这种常量', () => {
  // 它以前被三处当兜底用,是三条群发通道。留着一个名字里带 default 的固定话术,
  // 迟早会有人再拿它兜一次底。(只看代码:注释里解释这段历史是可以的。)
  assert.doesNotMatch(code, /defaultGreetingText/, 'APP.defaultGreetingText 已被有意删除,别再引入等价物');
});

test('取不到常用语时抛错停下,不退到任何固定话术', () => {
  // 定位 resolveFastReplyText 的函数体,只在里面找,避免误判别处的 fallback。
  const start = code.indexOf('async resolveFastReplyText');
  assert.ok(start > 0, '没有找到 resolveFastReplyText');
  const body = code.slice(start, code.indexOf('\n    },', start));

  assert.match(body, /throw new Error\(/, '取不到常用语必须抛错,不能继续往下发');
  // 关键:函数体里不能再出现「拿别的文本顶上」的写法。
  assert.doesNotMatch(body, /\|\|\s*config\.customText/, '不该退回自定义文本 —— 那是另一个模式的配置');
  assert.doesNotMatch(body, /\|\|\s*APP\./, '不该退回任何 APP 上的常量话术');
});

test('AI 判定模式下拿不到招呼语时停下,不发固定话术', () => {
  const start = code.indexOf('async sendCurrent(');
  assert.ok(start > 0, '没有找到 sendCurrent');
  const body = code.slice(start, code.indexOf('\n    },', start));

  assert.match(body, /pendingGreeting/, 'aiGate 分支要读跨页带过来的招呼语');
  assert.doesNotMatch(body, /APP\.defaultGreetingText|APP\.fallbackGreeting/, '拿不到就抛错,别拿一句话顶上');
  assert.match(body, /throw new Error\(/, '跨页状态丢了要停下并说明,而不是继续发');
});

test('配置校验会在「开始」那一刻拦住「常用语模式但一条都没有」', () => {
  const start = code.indexOf('function validateConfig(');
  assert.ok(start > 0, '没有找到 validateConfig');
  const body = code.slice(start, code.indexOf('\n  }', start));

  assert.match(body, /greetingMode === 'fastReply'/, 'fastReply 模式要有自己的前置校验');
  assert.match(body, /fastReplies/, '校验要看常用语列表是否为空');
});

test('自定义文本不再预填一句默认文案 —— 空白时由配置校验拦住', () => {
  // 预填的后果:切到「自定义文本」、什么都没写就点开始,发出去的是同一句话。
  const match = code.match(/customText:\s*'([^']*)'/);
  assert.ok(match, '没有找到 customText 的默认值');
  assert.equal(match[1], '', 'customText 默认必须为空');
});
