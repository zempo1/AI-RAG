import { expandCitationContext } from '../src/modules/documents/citation-context';

it('restores the complete paragraph around a mid-sentence PDF citation', () => {
  const paragraph = '院内事件是患者住院期间发生的非\n预期事件。下一句补充了定义。';
  const text = '前一段。\n\n' + paragraph + '\n\n下一段。';
  const start = text.indexOf('期间');
  expect(expandCitationContext(text, start, text.indexOf('补充'))).toBe(paragraph);
});

it('uses sentence boundaries in a long paragraph and does not split decimal numbers', () => {
  const text = '此前的句子。'.repeat(300) + '结果为4.5%，仍有差异。下一句。';
  const start = text.indexOf('5%');
  expect(expandCitationContext(text, start, start + 2)).toBe('结果为4.5%，仍有差异。');
});

it('continues across a layout break when the extracted paragraph ends mid-sentence', () => {
  const text = '上一句已经说完。接下来这句分\n\n在两段里。下一句。';
  const start = text.indexOf('这句');
  expect(expandCitationContext(text, start, start + 2)).toBe('接下来这句分\n\n在两段里。');
});
