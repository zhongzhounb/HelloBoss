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

// 章节标题 → 内部 key。简历里标题有 "教育经历" 和 [实践经历] 两种写法,parseValue 会统一去壳;
// .txt 格式里统一写成 [教育经历]。
export const SECTION_KEYS = {
  教育经历: 'education',
  实践经历: 'experience',
  项目经历: 'projects',
  专业技能: 'skills',
};

// 兜底的版本名。目录扫描才是常态(见 parseAllResumes),这个列表只在
// 「一个简历都没解析出来」时给调用方一个不至于 undefined 的默认值。
export const VARIANTS = ['cpp', 'cpp_rag', 'iot', 'java', 'pdd'];

// 认的简历扩展名。.txt 是推荐格式(手写门槛低,见 resumes/example.txt),
// .typ 是旧的宏格式:继续兼容,已经用 .typ 写了简历的人不该因为一次格式升级就作废。
export const RESUME_EXTS = ['.txt', '.typ'];

// 仓库自带的示例简历的**基名**(大小写不敏感,不看扩展名)。它只是「怎么写简历」的模板,
// 不是任何人的真实简历,所以扫描时跳过 —— 否则 clone 下来什么都没配的人,服务也会拿
// 「张三/示例大学」当候选人去判定和发招呼语,而 fail-closed 的闸门会以为「目录里有简历」放行。
// 按基名而不是按全名判断:模板在 .typ / .txt 之间改名时,这条性质不跟着偏移。
export const EXAMPLE_RESUME_BASENAME = 'example';

function emptyProfile(variant) {
  return {
    variant,
    name: '',
    sections: { education: [], experience: [], projects: [], skills: [] },
    skillCorpus: '',
  };
}

// 描述挂到条目上、还是独立成条:item 与 desc 是两种形状,而专业技能章节只有 desc
// 没有 item,所以 desc 得能脱离条目独立存在。
function attachSkill(profile, sectionKey, skill) {
  const list = profile.sections[sectionKey];
  const last = list[list.length - 1];
  if (last && Array.isArray(last.descs)) last.descs.push(skill);
  else list.push(skill);
}

function finishProfile(profile) {
  profile.skillCorpus = profile.sections.skills
    .map((s) => `${s.label} ${s.content}`)
    .join(' ');
  return profile;
}

// 按 | 切开一行并去空白,取前 count 个字段,不足的补空串。
// 不用 split 后直接解构:少写一两个字段是最常见的输入,不该因此抛错。
function splitFields(line, count) {
  const parts = line.split('|').map((part) => part.trim());
  const fields = [];
  for (let i = 0; i < count; i += 1) fields.push(parts[i] ?? '');
  return fields;
}

// ---- 宏格式(.typ)----

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

// 解析 .typ 简历:靠 #init / #resume_section / #resume_item / #resume_desc 四类宏。
export function parseTypResume(source, variant) {
  const clean = stripComments(source);
  const profile = emptyProfile(variant);

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
    attachSkill(profile, current, toSkill(positional));
  }

  return finishProfile(profile);
}

// ---- 极简文本格式(.txt)----
//
// 一行一条,约定见 resumes/example.txt:
//   姓名: 张三             冒号(半角 / 全角)后是姓名
//   [教育经历]             章节标题,后接条目与描述,直到下一个章节
//   单位 | 时间 | 备注      条目,字段可少写(缺的补空串)
//   - 标签 | 内容          条目下的描述;在专业技能章节里就是一条技能
//
// 产出与宏格式**完全同形**,所以提示词、招呼语、版本选择那些下游都不用管简历是哪种格式。
export function parseTextResume(source, variant) {
  const profile = emptyProfile(variant);
  let current = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    // 只认整行注释:不做行尾注释 —— 技能内容里常有 "/"(如 "TCP/IP"),按行尾切会吃掉半条技能。
    if (!line || line.startsWith('//')) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      current = SECTION_KEYS[line.slice(1, -1).trim()] ?? null;
      continue;
    }

    const name = /^姓名\s*[:：]\s*(.*)$/.exec(line);
    if (name) {
      profile.name = name[1].trim();
      continue;
    }

    if (!current) continue;

    if (line.startsWith('-')) {
      const [label, content] = splitFields(line.slice(1).trim(), 2);
      attachSkill(profile, current, { label, content });
      continue;
    }

    const [title, time, note] = splitFields(line, 3);
    profile.sections[current].push({
      title,
      time,
      // 极简格式的第三个字段是备注(学历 / 角色之类),沿用宏格式里同样闲置的 position 槽位。
      position: note,
      rule: '',
      mid: '',
      descs: [],
    });
  }

  return finishProfile(profile);
}

// ---- 分派与目录扫描 ----

// 按扩展名挑解析器。版本名一律取「文件名去掉扩展名」——
// 它也是 config/keywords.json 里挑简历版本用的键。
export function parseResumeByExtension(filename, source) {
  const ext = path.extname(filename).toLowerCase();
  const variant = path.basename(filename, path.extname(filename));
  return ext === '.txt' ? parseTextResume(source, variant) : parseTypResume(source, variant);
}

// 扫描目录下所有 .txt / .typ,文件名即版本名。
//
// 刻意不写死版本清单。原先是 `['cpp','cpp_rag','iot','java','pdd'].map(读文件)`,
// 缺哪个文件就直接抛 —— 而那五个名字是作者自己的技术方向划分,别人 clone 下来
// 必然一个都不存在,服务连启动都启动不了。现在有几个解析几个。
//
// example 不计入(见 EXAMPLE_RESUME_BASENAME):模板被当成简历,会让「没配简历」
// 这个状态被闸门误判成「已配置」。想用自己的简历,复制一份模板、改成别的文件名放进来。
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
    .filter((name) => {
      const ext = path.extname(name).toLowerCase();
      if (!RESUME_EXTS.includes(ext)) return false;
      const base = path.basename(name, path.extname(name)).toLowerCase();
      return base !== EXAMPLE_RESUME_BASENAME;
    })
    .sort() // 排序让解析顺序稳定 —— 版本选择同分时取靠前的,顺序不定会让结果飘。
    .map((name) => parseResumeByExtension(name, fs.readFileSync(path.join(srcDir, name), 'utf8')));
}
