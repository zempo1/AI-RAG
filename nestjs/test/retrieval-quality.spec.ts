import { tokenize, bm25, fuse, LexicalIndex, searchLexical } from '../src/modules/rag/retrieval-algorithms';

it('preserves identifiers and Chinese terms and restricts BM25 corpus before scoring', () => {
  expect(tokenize('错误 TS-999 在 Vue3.4 中发生')).toContain('ts-999');
  const docs = [
    { id: 1, text: '错误 TS-999 应清理缓存' },
    { id: 2, text: '登录失败' },
  ];
  expect(bm25('TS-999', docs)[0].id).toBe(1);
  expect(bm25('缺失的术语', docs)).toHaveLength(0);
});

it('uses inverted postings and excludes unauthorized postings from df and average length',()=>{
  const allowed=new LexicalIndex([{id:1,text:'TS-999 清理缓存'},{id:2,text:'缓存失效'}]);
  const privateIndex=new LexicalIndex(Array.from({length:30},(_,i)=>({id:100+i,text:'TS-999 私密内容'})));
  expect(allowed.postings.get('ts-999')?.get(1)).toBe(1);
  expect(searchLexical('TS-999',[allowed,privateIndex],new Set([1,2]))).toEqual(searchLexical('TS-999',[allowed],new Set([1,2])));
});

it('fuses ranks rather than adding incomparable raw similarity scores', () => {
  const result = fuse(
    [
      { id: 1, score: 0.9 },
      { id: 2, score: 0.5 },
    ],
    [
      { id: 2, score: 80 },
      { id: 3, score: 70 },
    ],
  );
  expect(result[0].id).toBe(2);
  expect(result).toHaveLength(3);
});
