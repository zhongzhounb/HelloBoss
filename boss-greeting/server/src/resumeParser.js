import fs from 'node:fs';
import path from 'node:path';
import {
  stripComments,
  matchParen,
  extractMacroCalls,
  splitTopLevelArgs,
  parseArgs,
  parseValue,
} from './typst.js';

// 章节标题 → 内部 key。简历里标题有 "教育经历" 和 [实践经历] 两种写法,parseValue 会统一去壳。
export const SECTION_KEYS = {
  教育经历: 'education',
  实践经历: 'experience',
  项目经历: 'projects',
  专业技能: 'skills',
};

// 兜底的版本名。目录扫描才是常态(见 parseAllResumes),这个列表只在
// 「一个简历都没解析出来」时给调用方一个不至于 undefined 的默认值。
export const VARIANTS = ['cpp', 'cpp_rag', 'iot', 'java', 'pdd'];

// 线性扫描三个宏,按出现顺序处理,保证条目归属到正确的章节。
// 不能用 extractMacroCalls 分别取再拼 —— 那样会丢失"哪个条目属于哪个章节"的信息。
function scanBlocks(source) {
  const pattern = /#(resume_section|resume_item|resume_desc)\s*\(/g;
  const blocks = [];
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const open = match.index + match[0].length - 1;
    const end = matchParen(source, open);
    if (end === -1) break;
    blocks.push({ kind: match[1], args: source.slice(open + 1, end) });
    pattern.lastIndex = end + 1;
  }
  return blocks;
}

function toSkill(positional) {
  return {
    label: parseValue(positional[0]) ?? '',
    content: parseValue(positional[1]) ?? '',
  };
}

function toItem(positional, named) {
  return {
    title: parseValue(positional[0]) ?? '',
    time: parseValue(positional[1]) ?? '',
    position: parseValue(positional[2]) ?? '',
    rule: parseValue(positional[3]) ?? '',
    mid: parseValue(named.mid ?? '') ?? '',
    descs: [],
  };
}

export function parseResumeFile(source, variant) {
  const clean = stripComments(source);
  const profile = {
    variant,
    name: '',
    sections: { education: [], experience: [], projects: [], skills: [] },
    skillCorpus: '',
  };

  const initArgs = extractMacroCalls(clean, 'init')[0];
  if (initArgs) {
    const { named } = parseArgs(splitTopLevelArgs(initArgs));
    profile.name = parseValue(named.name ?? '') ?? '';
  }

  let current = null;

  for (const block of scanBlocks(clean)) {
    if (block.kind === 'resume_section') {
      const title = parseValue(splitTopLevelArgs(block.args)[0]);
      current = SECTION_KEYS[title] ?? null;
      continue;
    }

    if (!current) continue;

    const argList = splitTopLevelArgs(block.args);
    const { positional, named } = parseArgs(argList);

    if (block.kind === 'resume_item') {
      profile.sections[current].push(toItem(positional, named));
      continue;
    }

    // resume_item 与 resume_desc 都走 toItem/toSkill 两种形状:
    // 专业技能章节只有 desc 没有 item,所以 desc 要能独立成条。
    const skill = toSkill(positional);
    const list = profile.sections[current];
    const last = list[list.length - 1];
    if (last && Array.isArray(last.descs)) last.descs.push(skill);
    else list.push(skill);
  }

  profile.skillCorpus = profile.sections.skills
    .map((s) => `${s.label} ${s.content}`)
    .join(' ');

  return profile;
}

// 扫描目录下所有 .typ,文件名即版本名。
//
// 刻意不写死版本清单。原先是 `['cpp','cpp_rag','iot','java','pdd'].map(读文件)`,
// 缺哪个文件就直接抛 —— 而那五个名字是作者自己的技术方向划分,别人 clone 下来
// 必然一个都不存在,服务连启动都启动不了。现在有几个解析几个。
//
// 目录不存在返回空数组而不是抛:调用方(server.loadProfiles)会把它呈现为
// 「尚未加载简历,判定全部跳过」,那是个需要提示的配置状态,不是崩溃。
export function parseAllResumes(srcDir) {
  let names;
  try {
    names = fs.readdirSync(srcDir);
  } catch {
    return [];
  }

  return names
    .filter((name) => name.endsWith('.typ'))
    .sort() // 排序让解析顺序稳定 —— 版本选择同分时取靠前的,顺序不定会让结果飘。
    .map((name) => parseResumeFile(
      fs.readFileSync(path.join(srcDir, name), 'utf8'),
      path.basename(name, '.typ'),
    ));
}
