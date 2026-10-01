// 示例简历 —— 服务启动时解析本目录下**所有** .typ 文件,文件名即「简历版本名」。
// 解析出来的内容会作为候选人摘要,拼进判定与招呼语生成的提示词里。
//
// 换成你自己的:直接替换这个文件,或再放几个 .typ 进来(比如按技术方向分几个版本,
// 服务会按岗位 JD 的关键词自动挑最贴的那个 —— 关键词表见 config/keywords.json)。
//
// 只有下面这几类宏是必须的。服务只做**文本提取**,不渲染 PDF,所以不需要 typst 模板、
// 也不需要 typst 可执行文件:
//   #init(name: "...")            姓名
//   #resume_section("教育经历")    章节(教育经历 / 实践经历 / 项目经历 / 专业技能)
//   #resume_item(...)             条目
//   #resume_desc(...)             条目下的描述,或专业技能章节里的一条技能
//
// 本目录下除 example.typ 外的文件默认不纳入 git(见同目录 .gitignore)——
// 简历是个人信息,不该跟着仓库走。

#init(
  name: "张三",
)

#resume_section("教育经历")

#resume_item(
  "示例大学",
  "硕士 | 计算机技术",
  [],
  "2024.09 -- 2027.06"
)

#resume_item(
  "示例大学",
  "本科 | 软件工程",
  [],
  "2020.09 -- 2024.06"
)

#resume_section([实践经历])

#resume_item(
  "示例科技有限公司",
  "2025.06 -- 2025.09",
  "参与后端服务开发。",
  none,
  mid: "后端开发实习生"
)
#resume_desc(
  "接口开发",
  [独立完成若干 REST 接口的设计与实现,并补充了对应的单元测试。]
)
#resume_desc(
  "性能优化",
  [定位并修复了列表接口的慢查询,把响应时间从秒级降到百毫秒级。]
)

#resume_section([项目经历])

#resume_item(
  "示例项目:数据采集与看板",
  "2025.03 -- 2025.06",
  "技术栈:JavaScript、Node.js、SQLite",
  none,
  mid: "独立开发"
)
#resume_desc(
  "核心实现",
  [完成了数据采集、清洗与可视化三个模块,支持按天增量更新。]
)

#resume_section([专业技能])

#resume_desc("语言", [JavaScript、Python、C++、SQL])
#resume_desc("工具", [Linux、Git、Docker、MySQL])
