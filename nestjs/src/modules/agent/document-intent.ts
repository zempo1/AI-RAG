export type DocumentQuestionScope = 'whole' | 'focused' | 'unspecified';

/** Distinguish a document-wide goal from a lookup inside that document.
 * The planner still owns general/search/compare choices; explicit scope is a safety constraint.
 */
export function documentQuestionScope(question: string, filenames: string[]): DocumentQuestionScope {
  const parts = question.split(/[，,；;。\n]+|(?:并且|同时|然后|并)(?=(?:请|再|总结|概括|概览|分析|评价|评估|指出|说明|提炼|介绍|梳理))/i)
    .map(part => part.trim()).filter(Boolean);
  const scopes = parts.map(part => questionPartScope(part, filenames));
  // A local request cannot cancel another, independently requested full overview.
  if (scopes.includes('whole')) return 'whole';
  if (scopes.includes('focused')) return 'focused';
  return 'unspecified';
}

function questionPartScope(text: string, filenames: string[]): DocumentQuestionScope {
  const summary = /总结|概[览括述]|归纳|摘要|梳理|[写讲说]了什么|讲的什么|(?:有|包含)(?:什么|哪些)内容|summari[sz]e|summary|overview/i;
  const review = /技术亮点|整体(?:评价|评估|分析|能力|水平)|综合(?:评价|评估)|优缺点|改进建议/i;
  if (/(?:第\s*[\d一二三四五六七八九十百]+\s*[页章节]|前\s*[\d一二三四五六七八九十两]+\s*页|\bpages?\s+\d|\bchapter\s+\d)/i.test(text)) return 'focused';
  const named = filenames.find(name => text.toLowerCase().includes(name.toLowerCase()));
  const generic = /全文|全篇|文档|文件|资料|材料|文章|论文|报告|课件|教材|手册|制度|简历|履历|作品集|\b(?:PDF|document|file|paper|article|report|manual|resume|résumé|CV)\b/i.exec(text);
  const target = named || generic?.[0];
  if (!target) {
    // An omitted subject may refer to the sole selected document, but a topic
    // such as "总结WebSocket流程" is not a request to read every page.
    if (filenames.length === 1 &&
      /^(?:请|帮我|麻烦)?(?:总结|概览|概括|摘要)(?:一下|下)?[。？！?!\s]*$/.test(text)) return 'whole';
    return 'unspecified';
  }
  const after = text.slice(text.toLowerCase().indexOf(target.toLowerCase()) + target.length).trim();
  const local = /^(?:(?:中|里)(?:的)?|内(?!容)|关于|有关|提到|所述|的|['’]s\s+|(?:on|about|section|chapter)\b)/i.exec(after);
  if (local) {
    const aspect = after.slice(local[0].length).trim();
    // Broad document attributes still need cross-page coverage; a named project,
    // concept or chapter does not become a full overview merely because of "总结".
    if (!/^(?:主要内容|核心内容|内容|要点|大意|重点|全文|技术亮点|整体|所有|全部|各个)/.test(aspect)) return 'focused';
  }
  return summary.test(text) || review.test(text) ? 'whole' : 'unspecified';
}
