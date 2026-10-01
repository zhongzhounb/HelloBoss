import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripComments,
  matchParen,
  extractMacroCalls,
  splitTopLevelArgs,
  parseArgs,
  parseValue,
} from '../src/typst.js';

test('剥离注释时保留字符串里的 //', () => {
  const src = 'link: "https://github.com/example-user"\n// 这是注释\nname: "a"';
  const out = stripComments(src);
  assert.match(out, /https:\/\/github\.com\/example-user/);
  assert.doesNotMatch(out, /这是注释/);
});

test('被注释掉的 #info 不会被提取', () => {
  const src = [
    '#info(',
    '    color: rgb(0, 0, 0),',
    ')',
    '// #info(',
    '//     color: rgb(1, 1, 1),',
    '// )',
  ].join('\n');
  assert.equal(extractMacroCalls(stripComments(src), 'info').length, 1);
});

test('matchParen 对嵌套括号配平', () => {
  const src = 'rgb(0, 0, 0))';
  assert.equal(matchParen(src, 3), 11);
});

test('matchParen 忽略字符串里的括号', () => {
  const src = '("a)b")';
  assert.equal(matchParen(src, 0), 6);
});

test('splitTopLevelArgs 不切分嵌套结构内的逗号', () => {
  const args = '"海信", [从0到1, 独立完成], none, mid: "实习生"';
  assert.deepEqual(splitTopLevelArgs(args), [
    '"海信"',
    '[从0到1, 独立完成]',
    'none',
    'mid: "实习生"',
  ]);
});

test('parseArgs 区分位置参数与命名参数', () => {
  const { positional, named } = parseArgs(['"海信"', 'none', 'mid: "实习生"']);
  assert.deepEqual(positional, ['"海信"', 'none']);
  assert.deepEqual(named, { mid: '"实习生"' });
});

test('命名参数的值含冒号时不会被截断', () => {
  const { named } = parseArgs(['link: "tel:+86 138 0000 0000"']);
  assert.equal(named.link, '"tel:+86 138 0000 0000"');
});

test('parseValue 去掉引号、内容块与 none', () => {
  assert.equal(parseValue('"张三"'), '张三');
  assert.equal(parseValue('[实践经历]'), '实践经历');
  assert.equal(parseValue('none'), null);
  assert.equal(parseValue('[从0到1, 独立完成]'), '从0到1, 独立完成');
});
