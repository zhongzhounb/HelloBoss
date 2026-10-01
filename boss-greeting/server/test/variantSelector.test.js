import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { selectVariant, buildJdText, keywordMatcher } from '../src/variantSelector.js';

const KEYWORDS = JSON.parse(
  fs.readFileSync(new URL('../config/keywords.json', import.meta.url), 'utf8'),
);

// selectVariant 只拿 profile.variant 去对照关键词表,**从不读简历正文** ——
// 所以这里用骨架 profile 就够,不必真去读 .typ 文件。好处是这组测试不再依赖
// 本机上的简历目录,任何人的 clone 都能跑。
const PROFILES = ['cpp', 'cpp_rag', 'iot', 'java', 'pdd'].map((variant) => ({ variant }));

test('嵌入式岗位选 iot', () => {
  const jd = '负责嵌入式设备固件开发,熟悉 MQTT 协议与串口通讯,有 ESP8266 经验优先';
  assert.equal(selectVariant(jd, PROFILES, KEYWORDS).variant, 'iot');
});

test('Java 后端岗位选 java', () => {
  const jd = '负责后端微服务开发,熟悉 Java、Spring Cloud、MyBatis,了解 JVM 调优';
  assert.equal(selectVariant(jd, PROFILES, KEYWORDS).variant, 'java');
});

test('RAG 岗位选 cpp_rag 而不是 cpp', () => {
  const jd = 'C++ 开发,负责大模型 RAG 检索增强链路与 Function Calling 工具调用';
  assert.equal(selectVariant(jd, PROFILES, KEYWORDS).variant, 'cpp_rag');
});

test('普通 C++ 岗位在 cpp 与 cpp_rag 同分时选 cpp', () => {
  const jd = 'C++ 开发,熟悉 STL、设计模式,了解 Socket 与 TCP/IP 网络编程';
  assert.equal(selectVariant(jd, PROFILES, KEYWORDS).variant, 'cpp');
});

test('Qt 客户端岗位选 pdd', () => {
  const jd = '负责 Qt 桌面客户端开发,GUI 自绘渲染,跨平台支持';
  assert.equal(selectVariant(jd, PROFILES, KEYWORDS).variant, 'pdd');
});

test('JavaScript 不会被误判为 Java 方向', () => {
  const jd = '负责前端开发,熟悉 JavaScript、React、TypeScript';
  const result = selectVariant(jd, PROFILES, KEYWORDS);
  assert.notEqual(result.variant, 'java', 'JavaScript 不该命中 java 方向');
});

test('storage 不会让 cpp_rag 胜出', () => {
  const jd = 'C++ 开发,负责对象存储 storage 服务,熟悉 STL、设计模式';
  assert.equal(selectVariant(jd, PROFILES, KEYWORDS).variant, 'cpp');
});

test('evidence 记录命中的关键词', () => {
  const result = selectVariant('熟悉 MQTT 与串口通讯', PROFILES, KEYWORDS);
  assert.ok(result.evidence.some((e) => e.includes('MQTT')));
});

test('完全不匹配时返回 score 0 与 null variant', () => {
  const result = selectVariant('招聘餐厅服务员,包吃住', PROFILES, KEYWORDS);
  assert.equal(result.score, 0);
  assert.equal(result.variant, null);
});

test('buildJdText 汇总岗位名、技能与 JD 正文', () => {
  const text = buildJdText({
    jobName: 'C++开发工程师',
    showSkills: ['Qt', '多线程'],
    postDescription: '负责上位机开发',
    companyIndustry: '智能硬件',
  });
  assert.match(text, /C\+\+开发工程师/);
  assert.match(text, /Qt/);
  assert.match(text, /上位机/);
});

test('ASCII 关键词把数字当边界:C++11 / Qt5 仍命中', () => {
  assert.ok(keywordMatcher('C++')('c++11'), 'C++11 应命中 C++');
  assert.ok(keywordMatcher('C++')('c++17工程开发'), 'C++17 应命中 C++');
  assert.ok(keywordMatcher('C++')('c++开发'), 'C++ 应命中 C++');
  assert.ok(keywordMatcher('C++')('c++20'), 'C++20 应命中 C++');
  assert.ok(keywordMatcher('Qt')('qt5'), 'Qt5 应命中 Qt');
});

test('ASCII 关键词不命中更长的英文单词', () => {
  assert.ok(!keywordMatcher('Java')('javascript'), 'java 不该命中 javascript');
  assert.ok(!keywordMatcher('RAG')('storage'), 'rag 不该命中 storage');
  assert.ok(!keywordMatcher('GUI')('guide'), 'gui 不该命中 guide');
  assert.ok(!keywordMatcher('Select')('selection'), 'select 不该命中 selection');
  assert.ok(!keywordMatcher('Qt')('mqtt'), 'qt 不该命中 mqtt');
});

test('中文关键词仍按子串匹配', () => {
  assert.ok(keywordMatcher('嵌入式')('负责嵌入式开发'));
  assert.ok(keywordMatcher('串口')('熟悉串口通讯'));
});

test('关键词表里没有的简历版本得 0 分，不会让整个选择失败', () => {
  // 开源后的常态:别人的简历文件叫什么名字都行(resumes/ 下的文件名即版本名),
  // 而 config/keywords.json 是他自己填的。对不上的版本应当安安静静得 0 分,
  // 由调用方退回第一份简历,而不是抛错。
  const profiles = [{ variant: '我的简历' }, { variant: 'cpp' }];
  const result = selectVariant('C++ 开发,熟悉 STL 与多线程', profiles, KEYWORDS);

  assert.equal(result.variant, 'cpp', '能对上的那个版本仍应被选中');
  assert.equal(result.ranked.find((r) => r.variant === '我的简历').score, 0);
});
