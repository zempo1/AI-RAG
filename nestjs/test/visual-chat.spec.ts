import { ChatService } from '../src/modules/chat/chat.service';

it('uses the same authorized image context for normal and streaming answers', async () => {
  const images = [{ dataUrl: 'data:image/png;base64,aA==', label: '[1] 第1页' }];
  const source: any = {
    number: 1,
    versionId: 1,
    location: { page: 1, pageImage: { versionId: 1, page: 1, profile: 'a'.repeat(64) } },
  };
  const llm: any = {
    complete: async (_: string, _key: any, actual: any) =>
      actual?.[0]?.dataUrl ? '原图已核对[1]' : '仅文字[1]',
    stream: async function* (_: string, _key: any, _signal: any, actual: any) {
      yield actual?.[0]?.dataUrl ? '原图已核对[1]' : '仅文字[1]';
    },
  };
  const assets: any = {
    forSources: async (userId: number) => {
      if (userId !== 7) throw new Error('无权限');
      return images;
    },
  };
  const chat = new (ChatService as any)(
    { prepare: async () => ({ prompt: '图中顺序？', sources: [source] }) },
    llm,
    assets,
  );
  const context = await chat.prepare('图中顺序？', 7);
  expect((await chat.answerPrepared(context)).answer).toBe('原图已核对[1]');
  const events: any[] = [];
  for await (const event of chat.streamPrepared(context)) events.push(event);
  expect(events.find((e) => e.type === 'done').answer).toBe('原图已核对[1]');
});
