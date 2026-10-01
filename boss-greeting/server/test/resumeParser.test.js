import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResumeFile, parseAllResumes } from '../src/resumeParser.js';

// 指向仓库自带的那份示例简历。刻意不指本机路径:这条测试要在任何人的 clone 上都跑得通,
// 而 resumes/ 是仓库的一部分(别人的真实简历则被 resumes/.gitignore 挡在版本管理之外)。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, '..', 'resumes');
const read = (name) => fs.readFileSync(path.join(SRC_DIR, `${name}.typ`), 'utf8');

test('解析出姓名与版本号', () => {
  const profile = parseResumeFile(read('example'), 'example');
  assert.equal(profile.name, '张三');
  assert.equal(profile.variant, 'example');
});

test('目录下每个 .typ 都被解析成一份简历', () => {
  const expected = fs.readdirSync(SRC_DIR).filter((name) => name.endsWith('.typ')).length;
  const profiles = parseAllResumes(SRC_DIR);

  assert.equal(profiles.length, expected, '目录里有几个 .typ 就该解析出几份');
  assert.ok(profiles.length > 0, '仓库自带的示例简历应当能解析出来');

  for (const profile of profiles) {
    assert.ok(profile.name, `${profile.variant} 应解析出姓名`);
    for (const key of ['education', 'experience', 'projects', 'skills']) {
      assert.ok(Array.isArray(profile.sections[key]), `${profile.variant}.${key} 应为数组`);
    }
    assert.ok(profile.sections.education.length > 0, `${profile.variant} 应有教育经历`);
    assert.ok(profile.sections.skills.length > 0, `${profile.variant} 应有技能条目`);
  }
});

test('目录不存在时返回空数组，而不是抛', () => {
  // 「还没放简历」是个需要在界面上提示的配置状态,不是崩溃 ——
  // 服务要照常起来,大屏才有地方显示那句提示。
  assert.deepEqual(parseAllResumes(path.join(SRC_DIR, '这个目录不存在')), []);
});

test('技能条目没有空标签或空内容', () => {
  // 简历是用户的活文档,条目数会变;但「每条都有标签和内容」是解析器该保证的,
  // 一旦某段被解析器吞掉,这里就会暴露。
  for (const profile of parseAllResumes(SRC_DIR)) {
    for (const skill of profile.sections.skills) {
      assert.ok(skill.label && skill.label.trim(), `${profile.variant} 存在空标签的技能条目`);
      assert.ok(skill.content && skill.content.trim(), `${profile.variant} 的技能「${skill.label}」内容为空`);
    }
  }
});

test('条目与技能描述都解析出了实质内容', () => {
  for (const profile of parseAllResumes(SRC_DIR)) {
    for (const key of ['education', 'experience', 'projects']) {
      for (const item of profile.sections[key]) {
        assert.ok(item.title && item.title.trim(), `${profile.variant}.${key} 存在缺标题的条目`);
        assert.ok(Array.isArray(item.descs), `${profile.variant}.${key} 的条目 descs 应为数组`);
      }
    }

    // 实践与项目类条目应当挂上技能描述;一条都挂不上说明 resume_desc 没归位,
    // 而那正是「条目与描述分离」这类解析器缺陷的表现。
    const attached = [...profile.sections.experience, ...profile.sections.projects]
      .filter((item) => item.descs.length > 0);
    assert.ok(attached.length > 0, `${profile.variant} 没有任何条目挂上 resume_desc`);
  }
});

test('技能语料包含简历里的关键词', () => {
  const profile = parseResumeFile(read('example'), 'example');
  assert.match(profile.skillCorpus, /JavaScript/);
  assert.match(profile.skillCorpus, /Docker/);
});

test('条目下的 resume_desc 挂到正确的条目', () => {
  const profile = parseResumeFile(read('example'), 'example');
  const item = profile.sections.experience[0];
  assert.equal(item.title, '示例科技有限公司');
  assert.equal(item.mid, '后端开发实习生');
  assert.equal(item.descs.length, 2, '两条 resume_desc 都应挂在它下面');
  assert.equal(item.descs[0].label, '接口开发');
});

test('文件头顶的注释块不影响解析', () => {
  // 示例简历开头有一大段以 // 开头的说明。stripComments 要能把它们剥干净 ——
  // 剥不干净的话，注释里的括号会打乱宏调用的配对。
  const profile = parseResumeFile(read('example'), 'example');
  assert.ok(profile.sections.education.length >= 2, '注释块之后的教育经历应当照常解析');
});
