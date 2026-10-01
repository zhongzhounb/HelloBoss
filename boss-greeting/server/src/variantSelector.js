// 简历版本选择:纯关键词加权匹配。
// 刻意不用 LLM —— 方向判定要可测、可调、可复现,而且这是免费且零延迟的。

// 全角转半角 + 转小写 + 去空白,让 JD 与关键词表可比。
function normalize(text) {
  return String(text ?? '')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/\s+/g, '');
}

// 把岗位的可判文本拼成一段。列表页拿不到 postDescription 时也能用,只是精度下降。
export function buildJdText(job) {
  const parts = [
    job.jobName,
    job.positionName,
    Array.isArray(job.showSkills) ? job.showSkills.join(' ') : '',
    job.companyIndustry,
    job.postDescription,
  ];
  return parts.filter(Boolean).join(' ');
}

// ASCII 关键词按词边界匹配。子串匹配会把 "java" 命中到 "javascript"、
// "rag"(权重 5)命中到 "storage"、"gui" 命中到 "guide" —— 这些写法在真实 JD 里很常见,
// 会直接把版本选错方向,而且调权重解决不了。中文没有词边界概念,继续用子串。
const ASCII_ONLY = /^[\x00-\x7f]+$/;

export function keywordMatcher(keyword) {
  const needle = normalize(keyword);
  if (!ASCII_ONLY.test(needle)) {
    return (haystack) => haystack.includes(needle);
  }
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // haystack 已被 normalize 去过空白。边界用「非字母」而不是「非字母数字」:
  // C++ 后面常跟版本号(C++11 / C++17),数字必须算作边界,否则 JD 里最常见的写法反而漏掉。
  // 而那些真正要挡的假阳性(javascript / storage / mqtt),挡它们的是字母,仍然挡得住。
  const pattern = new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`);
  return (haystack) => pattern.test(haystack);
}

export function selectVariant(jdText, profiles, keywordTable) {
  const haystack = normalize(jdText);

  const ranked = profiles.map((profile) => {
    const spec = keywordTable.variants[profile.variant];
    if (!spec) return { variant: profile.variant, score: 0, evidence: [] };

    let score = 0;
    const evidence = [];
    for (const [keyword, weight] of Object.entries(spec.keywords)) {
      if (keywordMatcher(keyword)(haystack)) {
        score += weight;
        evidence.push(`${keyword}(+${weight})`);
      }
    }
    return { variant: profile.variant, score, evidence };
  });

  // 同分时按 priority 顺序取前面的。cpp_rag 是 cpp 的超集,没有这条它永远赢不了平局。
  const priority = keywordTable.priority || [];
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ai = priority.indexOf(a.variant);
    const bi = priority.indexOf(b.variant);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  const best = ranked[0] ?? { variant: null, score: 0, evidence: [] };
  if (!best.score) return { variant: null, score: 0, evidence: [], ranked };

  return { variant: best.variant, score: best.score, evidence: best.evidence, ranked };
}
