import { Body, Controller, Headers, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { once } from 'node:events';
import { ChatDto } from './dto/chat.dto';
import { StreamChatDto } from './dto/stream-chat.dto';
import { ChatService } from './chat.service';
import { HistoryService } from '../history/history.service';
import { UserId } from '../auth/auth.guard';
import { ApiError, errorMessage } from '../../common/api-error';
import { Citation, normalizeCitations } from '../rag/citations';

@Controller('api')
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly history: HistoryService,
  ) {}

  @Post('chat')
  answer(@Body() body: ChatDto, @UserId() user: number, @Headers('x-api-key') apiKey?: string) {
    if (!body.question?.trim()) throw new ApiError(400, 'Question is required.');
    return this.chat.chat(body.question, user, body.knowledgeBaseId, apiKey);
  }

  @Post('stream-chat')
  async stream(
    @Body() body: StreamChatDto,
    @UserId() user: number,
    @Headers('x-api-key') apiKey: string | undefined,
    @Res() res: Response,
  ) {
    if (!body.question?.trim()) throw new ApiError(400, 'Question is required.');
    const chat =
      body.chatId == null
        ? await this.history.create(body.question.slice(0, 30), user, body.knowledgeBaseId)
        : await this.history.writable(body.chatId, user, body.knowledgeBaseId);
    const chatId = chat.id;
    res.status(200).set({
      'Content-Type': 'text/event-stream;charset=UTF-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const abort = new AbortController();
    const closed = () => abort.abort(new Error('Client disconnected'));
    res.on('close', closed);
    const send = async (data: unknown, event?: string) => {
      if (abort.signal.aborted || res.destroyed || res.writableEnded) return;
      const frame =
        (event ? 'event: ' + event + '\n' : '') + 'data: ' + JSON.stringify(data) + '\n\n';
      if (!res.write(frame)) await once(res, 'drain', { signal: abort.signal });
    };
    let answer = '',
      sources: Citation[] = [],
      settled = false;
    const timer = setTimeout(() => abort.abort(new Error('生成超时')), 180000);
    const interrupted = new Promise<never>((_, reject) =>
      abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true }),
    );
    interrupted.catch(() => undefined);
    try {
      await send(chatId, 'chatId');
      await this.history.addMessage(chatId, user, 'user', body.question);
      const consume = async () => {
        for await (const event of this.chat.stream(
          body.question!,
          user,
          chat.knowledgeBaseId,
          apiKey,
          abort.signal,
        )) {
          if (abort.signal.aborted) return;
          if (event.type === 'sources') {
            sources = event.sources;
            await send(sources, 'sources');
          } else if (event.type === 'message') {
            answer += event.text;
            await send(event.text);
          } else {
            answer = event.answer;
            await this.history.addMessage(
              chatId,
              user,
              'assistant',
              answer,
              event.citations,
              'completed',
            );
            settled = true;
            await send(event.citations, 'citations');
            await send(
              { answer, citations: event.citations, chatId, generationStatus: 'completed' },
              'done',
            );
          }
        }
      };
      await Promise.race([consume(), interrupted]);
    } catch (error) {
      const final = normalizeCitations(answer, sources);
      const interruptedAnswer = final.answer || '[生成失败: ' + errorMessage(error) + ']';
      if (!settled) {
        await this.history
          .addMessage(chatId, user, 'assistant', interruptedAnswer, final.citations, 'interrupted')
          .catch(() => undefined);
      }
      await send(
        {
          message: errorMessage(error),
          answer: interruptedAnswer,
          citations: final.citations,
          chatId,
          generationStatus: 'interrupted',
        },
        'error',
      ).catch(() => undefined);
    } finally {
      clearTimeout(timer);
      res.off('close', closed);
      if (!res.writableEnded) res.end();
    }
  }
}
