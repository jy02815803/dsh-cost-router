/**
 * 自动研判的离线规则集。
 *
 * 中文与英文分开维护，避免往一个正则里不断堆词导致互相误伤。
 * 每条样本都是纯文本：不依赖 DSH、不调用模型、不读写用户状态。
 *
 * @module dsh-cost-router/rules
 */

/** 各语言的能力关键词。命中只表示「出现这个线索」，是否拆由 isHeterogeneous 决定。 */
export const RULESETS = {
  zh: [
    { kind: 'vision', re: /截图|图片|照片|扫描件|识别|图中|这张图|图片里|看图|图像|视频|画面|图表/i },
    { kind: 'code', re: /代码|脚本|函数|报错|debug|python|javascript|typescript|sql|正则|爬虫|编程|重构/i },
    { kind: 'longdoc', re: /全文|整份|这份文件|通读|长文档|几十页|整本|全部章节|逐章/i },
    { kind: 'reasoning', re: /研判|评估|论证|可行性|利弊|权衡|推演|归因|决策|该不该|分析原因|诊断|排查|交叉分析|分析原因|原因/i },
    // 单独出现「纪要 / 结论 / 方案」不等于要写长文；只认明确的写作动作。
    { kind: 'writing', re: /起草|撰写|写一份|公文|通知|请示|报告|讲话稿|汇报|总结|改成正式|润色|措辞|行文|表述|稿子|写成|写报告|写稿|压缩|要点/i },
    { kind: 'bulk', re: /批量|重命名|整理文件|转换格式|逐个|遍历|归档|改名|全部/i },
  ],
  en: [
    { kind: 'vision', re: /\b(screenshot|image|photo|scan|OCR|read (this|the) (chart|graph|image)|look at (this|the) (image|picture)|video|diagram)\b/i },
    { kind: 'code', re: /\b(code|script|function|bug|debug|python|javascript|typescript|sql|regex|crawler|refactor|stack trace|compile)\b/i },
    { kind: 'longdoc', re: /\b(entire document|full text|all chapters|read the whole|hundreds of pages|long document|chapter by chapter)\b/i },
    { kind: 'reasoning', re: /\b(evaluate|assess|feasibility|trade-?off|weigh|root cause|diagnose|should we|decision|compare options|analyze why)\b/i },
    { kind: 'writing', re: /\b(draft|write (a|an|the|conclusions)|write|a memo|notice|report|speech|summary|minutes|proposal|polish|rephrase|formal|release notes|three lines|bullet points)\b/i },
    { kind: 'bulk', re: /\b(batch|rename|organize files|convert format|for each|iterate|archive|every file)\b/i },
  ],
}

/** 明显要求高准确度的措辞，命中则抬高能力门槛。 */
export const STRONG_SIGNALS = {
  zh: /最强|务必准确|不能出错|不能有误|正式上报|印发|定稿|精确|严格|一字不差|逐字/,
  en: /\b(most accurate|must be exact|cannot be wrong|final version|word for word|strict|zero error|board[- ]ready|publish-ready)\b/i,
}

/** 元问题 / 追问上轮 / 指代前文的线索。命中后不进入拆解判定。 */
export const META_SIGNALS = {
  zh: /这一轮|上一轮|刚才|上轮|这轮|那次|这次|分别用|用了哪个|用的哪个|哪个模型|为什么|是不是|有没有|真的吗|拆了吗|执行的|结果呢|复盘|解释一下/,
  en: /\b(this round|last round|last time|previous (turn|round|step|time)|just now|which model|what model|did (it|you) (actually )?(run|split|use)|why did (it|you) not|what happened|explain (the|this) (last|previous))\b/i,
}

/** 多动作计数词。 */
export const ACTION_SIGNALS = {
  zh: /提取|整理|分析|写|做成|生成|转成|对比|汇总|翻译|画|绘制|计算|统计|润色|排查|修复建议/g,
  en: /\b(extract|organize|analyze|write|create|generate|convert|compare|summarize|translate|draw|calculate|count|review|classify|read|diagnose|debug|propose|polish)\b/gi,
}