import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTypResume, parseTextResume, parseAllResumes } from '../src/resumeParser.js';

// 两种格式的样本都内联在这里,不读仓库里的 resumes/ —— 那是用户的工作目录:
// 作者本机会躺着真实简历,示例文件本身也会随格式调整而变动。夹具自带,
// 这几个用例在任何 clone、任何机器上跑出来的结果都一样。
const TXT_SAMPLE = `// 头顶这段注释不该影响解析
姓名: 张三

[教育经历]
示例大学 | 2024.09 -- 2027.06 | 硕士 · 计算机技术
示例大学 | 2020.09 -- 2024.06 | 本科 · 软件工程

[实践经历]
示例科技有限公司 | 2025.06 -- 2025.09 | 后端开发实习生
- 接口开发 | 独立完成若干 REST 接口的设计与实现。
- 性能优化 | 把列表接口的慢查询从秒级降到百毫秒级。

[专业技能]
- 语言 | JavaScript、Python、C++、SQL
- 工具 | Linux、Git、Docker、MySQL
`;

const TYP_SAMPLE = `// 头顶这段注释不该影响解析
#init(name: "张三")

#resume_section("教育经历")
#resume_item("示例大学", "2024.09 -- 2027.06", [], "硕士 · 计算机技术")
#resume_item("示例大学", "2020.09 -- 2024.06", [], "本科 · 软件工程")

#resume_section([实践经历])
#resume_item("示例科技有限公司", "2025.06 -- 2025.09", "参与后端服务开发。", none, mid: "后端开发实习生")
#resume_desc("接口开发", [独立完成若干 REST 接口的设计与实现。])

#resume_section([专业技能])
#resume_desc("语言", [JavaScript、Python、C++、SQL])
#resume_desc("工具", [Linux、Git、Docker、MySQL])
`;

const HERE = path.dirname(fileURLToPath(import.meta.url));

function tempResumeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resumes-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

// 两种格式必须产出同一种 profile —— 下游(提示词、招呼语、版本选择)不分格式,
// 只要有一条不成立,就等于多出了一套只在某一种格式下才对的解析结果。
function assertProfileShape(profile, variant) {
  assert.equal(profile.variant, variant);
  assert.equal(profile.name, '张三');
  for (const key of ['education', 'experience', 'projects', 'skills']) {
    assert.ok(Array.isArray(profile.sections[key]), `${key} 应为数组`);
  }
  assert.ok(profile.sections.education.length >= 2, '应有两条教育经历');

  for (const key of ['education', 'experience', 'projects']) {
    for (const item of profile.sections[key]) {
      assert.ok(item.title && item.title.trim(), `${key} 存在缺标题的条目`);
      assert.ok(Array.isArray(item.descs), `${key} 的条目 descs 应为数组`);
    }
  }

  // 描述要挂在条目下面,而不是散成一片 —— 「条目与描述分离」是解析器最典型的缺陷。
  const attached = [...profile.sections.experience, ...profile.sections.projects]
    .filter((item) => item.descs.length > 0);
  assert.ok(attached.length > 0, '没有任何条目挂上描述');

  for (const skill of profile.sections.skills) {
    assert.ok(skill.label && skill.label.trim(), '存在空标签的技能条目');
    assert.ok(skill.content && skill.content.trim(), `技能「${skill.label}」内容为空`);
  }
  assert.match(profile.skillCorpus, /JavaScript/);
  assert.match(profile.skillCorpus, /Docker/);
}

test('.txt 极简格式解析出姓名、章节、条目与技能', () => {
  const profile = parseTextResume(TXT_SAMPLE, 'example');
  assertProfileShape(profile, 'example');

  const item = profile.sections.experience[0];
  assert.equal(item.title, '示例科技有限公司');
  assert.equal(item.time, '2025.06 -- 2025.09');
  assert.equal(item.position, '后端开发实习生', '第三个字段是备注');
  assert.equal(item.descs.length, 2, '两条描述都应挂在它下面');
  assert.equal(item.descs[0].label, '接口开发');
});

test('.typ 宏格式仍然解析成同样的形状(兼容性)', () => {
  const profile = parseTypResume(TYP_SAMPLE, 'example');
  assertProfileShape(profile, 'example');
  assert.equal(profile.sections.experience[0].descs[0].label, '接口开发');
});

test('.txt 少写字段不抛错,缺的补空串', () => {
  // 「只写了单位和时间」是最常见的写法,不能因此解析失败或让字段变成 undefined。
  const profile = parseTextResume('姓名: 李四\n\n[项目经历]\n某某系统 | 2025.01 -- 2025.06\n', 'p');
  const item = profile.sections.projects[0];
  assert.equal(item.title, '某某系统');
  assert.equal(item.time, '2025.01 -- 2025.06');
  assert.equal(item.position, '');
  assert.equal(item.descs.length, 0);
});

test('.txt 只剥整行注释,行尾的 // 属于内容', () => {
  // 技能内容里常有 "/"(TCP/IP、C/C++),按行尾切注释会吃掉半条技能。
  const profile = parseTextResume('姓名: 王五\n\n[专业技能]\n- 网络 | TCP/IP 协议、HTTP/2\n', 'p');
  assert.equal(profile.sections.skills[0].label, '网络');
  assert.equal(profile.sections.skills[0].content, 'TCP/IP 协议、HTTP/2');
});

test('两种扩展名都被解析,文件名即版本名且稳定排序', () => {
  const dir = tempResumeDir({ 'cpp.typ': TYP_SAMPLE, 'java.txt': TXT_SAMPLE, 'note.md': '不算简历' });
  const profiles = parseAllResumes(dir);

  assert.deepEqual(profiles.map((p) => p.variant), ['cpp', 'java'], '非简历扩展名要被忽略');
  for (const profile of profiles) assert.equal(profile.name, '张三');
});

test('扫描跳过示例简历,只有它时解析结果为空', () => {
  // 这是 fail-closed 的前置:模板若被当成简历,「没配简历」这个状态就会被闸门
  // 误判成「已配置」,于是没配任何东西的人拿「张三/示例大学」去投递。
  // 两种扩展名都要挡 —— 模板从 .typ 换成 .txt 之后,这条性质不能跟着漏。
  assert.deepEqual(parseAllResumes(tempResumeDir({ 'example.txt': TXT_SAMPLE })), []);
  assert.deepEqual(parseAllResumes(tempResumeDir({ 'example.typ': TYP_SAMPLE })), []);
});

test('仓库自带的示例目录里,example 不会被当成简历', () => {
  // 上面那条用的是临时目录。这条直接扫仓库真实的 resumes/:守着的是同一个性质,
  // 但连着真实的模板文件一起验 —— 模板换了名字或格式,这里就会暴露。
  const profiles = parseAllResumes(path.resolve(HERE, '..', 'resumes'));
  assert.ok(
    !profiles.some((p) => p.variant.toLowerCase() === 'example'),
    'example 是模板,任何扩展名下都不该被当成候选人',
  );
});

test('目录不存在时返回空数组，而不是抛', () => {
  // 「还没放简历」是个需要在界面上提示的配置状态,不是崩溃 ——
  // 服务要照常起来,大屏才有地方显示那句提示。
  assert.deepEqual(parseAllResumes(path.join(HERE, '这个目录不存在')), []);
});
