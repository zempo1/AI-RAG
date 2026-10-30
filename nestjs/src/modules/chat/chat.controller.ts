import { ChatDto } from './dto/chat.dto';
import { StreamChatDto } from './dto/stream-chat.dto';
import { Body, Controller, Headers, Post, Res } from '@nestjs/common';

import type { Response } from 'express';
import { once } from 'node:events';

import { ChatService } from './chat.service';
import { HistoryService } from '../history/history.service';
import { UserId } from '../auth/auth.guard';
import { ApiError, errorMessage } from '../../common/api-error';

@Controller('api')
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly history: HistoryService,
  ) {}

  @Post('chat')
  answer(@Body() body: ChatDto, @UserId() user: number) {
    if (!body.question?.trim()) throw new ApiError(400, 'Question is required.');
    return this.chat.chat(body.question, user);
  }

  @Post('stream-chat')
  async stream(
    @Body() body: StreamChatDto,
    @UserId() user: number,
    @Headers('x-api-key') apiKey: string | undefined,
    @Res() res: Response,
  ) {
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
    const send = async (text: string, event?: string) => {
      if (res.destroyed || res.writableEnded) return;
      const frame = event
        ? `event: ${event}\ndata: ${text}\n\n`
        : `data: ${JSON.stringify(text)}\n\n`;
      if (!res.write(frame)) await once(res, 'drain', { signal: abort.signal });
    };
    let chatId: number | undefined;
    let answer = '';
    let settled = false;
    const timer = setTimeout(() => abort.abort(new Error('生成超时')), 180000);
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true });
    });
    // The iterator may be waiting for embeddings; cancellation still closes HTTP promptly.
    interrupted.catch(() => undefined);
    try {
      if (!body.question?.trim()) {
        await send('Question is required.');
        return;
      }
      if (body.chatId == null) {
        const title =
          body.question.length > 30 ? body.question.slice(0, 30) + '...' : body.question;
        chatId = (await this.history.create(title, user)).id;
        await send(String(chatId), 'chatId');
      } else {
        try {
          await this.history.get(body.chatId, user);
          chatId = body.chatId;
        } catch {
          await send('[Chat not found]');
          return;
        }
      }
      await this.history.addMessage(chatId, user, 'user', body.question);
      const consume = async () => {
        for await (const token of this.chat.stream(body.question!, user, apiKey, abort.signal)) {
          if (abort.signal.aborted) break;
          answer += token;
          await send(token);
        }
      };
      await Promise.race([consume(), interrupted]);
      await this.history.addMessage(chatId, user, 'assistant', answer);
      settled = true;
    } catch (error) {
      if (chatId && !settled) {
        await this.history
          .addMessage(
            chatId,
            user,
            'assistant',
            answer ? answer + '\n[生成中断]' : '[生成失败: ' + errorMessage(error) + ']',
          )
          .catch(() => undefined);
      }
      if (!res.destroyed) await send('[Error: ' + errorMessage(error) + ']').catch(() => undefined);
    } finally {
      clearTimeout(timer);
      res.off('close', closed);
      if (!res.writableEnded) res.end();
    }
  }
}
