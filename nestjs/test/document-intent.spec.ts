import { documentQuestionScope } from '../src/modules/agent/document-intent';

it.each([
  '假如你是资深前端面试官，总结这份简历写了什么，有什么技术亮点',
  '总结前端简历.pdf，并评价候选人的整体能力',
  '这份简历写了什么',
  '这份简历有哪些技术亮点',
  '请概括这份简历的主要内容，并指出优缺点',
  '总结这篇论文内容',
  '总结这篇论文，说明研究方法和主要贡献',
  'Summarize this CV and identify its technical strengths',
  '分析这份简历中的RAG项目，并总结整份简历',
  '分析这份简历中的RAG项目并总结整份简历',
  '总结简历第2页，另外总结整份简历',
])('recognizes a document-wide request: %s', question => {
  expect(documentQuestionScope(question, ['前端简历.pdf'])).toBe('whole');
});

it.each([
  '总结这份简历中的WebSocket实现方案',
  '这份简历的RAG项目用了什么技术栈',
  '总结前端简历.pdf中的教育背景',
  '总结这份简历第2页的内容',
  '总结这份文档中的CSMA/CD协议工作流程',
  'Summarize this CV\'s RAG project',
  '总结第2页的简历内容',
  '概括前两页的文档内容',
])('recognizes a focused request: %s', question => {
  expect(documentQuestionScope(question, ['前端简历.pdf'])).toBe('focused');
});

it('does not turn a named technical topic into a whole-document review', () => {
  expect(documentQuestionScope('WebSocket方案有什么技术亮点', ['前端简历.pdf'])).not.toBe('whole');
});
