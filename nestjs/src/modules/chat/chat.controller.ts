import { Body, Controller, Headers, Post, Res, HttpCode } from '@nestjs/common';
import type { Response } from 'express';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { QaTasksService } from '../tasks/qa-tasks.service';
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
    private readonly qa: QaTasksService,
  ) {}

  private fingerprint(body: ChatDto) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          body.chatId ?? null,
          body.knowledgeBaseId ?? null,
          body.question?.trim(),
          [...(body.documentIds || [])].sort((a, b) => a - b),
          body.mode || 'auto',
        ]),
      )
      .digest('hex');
  }
  private async prepare(body: ChatDto, user: number, apiKey?: string, onProgress?: (stage: string) => void) {
    if (!body.question?.trim()) throw new ApiError(400, 'Question is required.');
    const fingerprint = this.fingerprint(body),
      requestId = body.requestId || randomUUID();
    const existing = body.requestId ? await this.qa.lookup(user, requestId, fingerprint) : null;
    if (existing) return { accepted: existing };
    const chat =
      body.chatId == null
        ? await this.history.create(body.question.slice(0, 30), user, body.knowledgeBaseId)
        : await this.history.writable(body.chatId, user, body.knowledgeBaseId);
    const retrievalContext = {
      documentIds: body.documentIds,
      mode: body.mode || 'auto',
      requestId,
    };
    const context = await this.chat.prepare(body.question, user, chat.knowledgeBaseId, {
      ...retrievalContext,
      chatId: chat.id,
      history: chat.messages,
      apiKey,
      onProgress,
    });
    if (context.requiresAsync) {
      const accepted = await this.qa.enqueue(
        user,
        chat.id,
        requestId,
        fingerprint,
        { ...context.snapshot, chatId: chat.id },
        apiKey,
        retrievalContext,
      );
      return { accepted };
    }
    await this.history.addMessage(chat.id, user, 'user', body.question, [], 'completed', {
      retrievalContext,
    });
    return { chat, context };
  }
  @Post('chat')
  @HttpCode(200)
  async answer(
    @Body() body: ChatDto,
    @UserId() user: number,
    @Headers('x-api-key') apiKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const prepared = await this.prepare(body, user, apiKey);
    if (prepared.accepted) {
      res.status(202);
      return prepared.accepted;
    }
    const final = await this.chat.answerPrepared(prepared.context, apiKey);
    await this.history.addMessage(
      prepared.chat!.id,
      user,
      'assistant',
      final.answer,
      final.citations,
      'completed',
      { retrievalRunId: final.retrievalRunId, diagnostics: final.diagnostics },
    );
    return { ...final, chatId: prepared.chat!.id, generationStatus: 'completed' };
  }

  @Post('stream-chat')
  async stream(
    @Body() body: StreamChatDto,
    @UserId() user: number,
    @Headers('x-api-key') apiKey: string | undefined,
    @Res() res: Response,
  ) {
    // Preserve HTTP authorization/validation errors before switching to SSE.
    if (!body.question?.trim()) throw new ApiError(400, 'Question is required.');
    if (body.chatId != null)
      await this.history.writable(body.chatId, user, body.knowledgeBaseId);
    const status = (stage: string) => {
      if (!res.destroyed && !res.writableEnded)
        res.write('event: status\ndata: ' + JSON.stringify({ stage }) + '\n\n');
    };
    res.status(200).set({
      'Content-Type': 'text/event-stream;charset=UTF-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    status('understanding');
    let prepared: Awaited<ReturnType<ChatController['prepare']>>;
    try {
      prepared = await this.prepare(body, user, apiKey, status);
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        res.write('event: error\ndata: ' + JSON.stringify({ message: errorMessage(error) }) + '\n\n');
        res.end();
      }
      return;
    }
    const chatId = prepared.accepted?.chatId || prepared.chat!.id;
    if (prepared.accepted) {
      res.write('event: accepted\ndata: ' + JSON.stringify(prepared.accepted) + '\n\n');
      res.end();
      return;
    }
    const abort = new AbortController();
    const closed = () => abort.abort(new Error('Client disconnected'));
    res.on('close', closed);
    const send = async (data: unknown, event?: string) => {
      if ((abort.signal.aborted && event !== 'error') || res.destroyed || res.writableEnded) return;
      const frame =
        (event ? 'event: ' + event + '\n' : '') + 'data: ' + JSON.stringify(data) + '\n\n';
      if (!res.write(frame) && !abort.signal.aborted) await once(res, 'drain', { signal: abort.signal });
    };
    let answer = '',
      sources: Citation[] = [],
      settled = false;
    // Bound silence, rather than cutting off an answer that is still progressing.
    const timer = setTimeout(() => abort.abort(new Error('模型长时间未返回正文，请稍后重试')), 60000);
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write(': heartbeat\n\n');
    }, 15000);
    const interrupted = new Promise<never>((_, reject) =>
      abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true }),
    );
    interrupted.catch(() => undefined);
    try {
      await send(chatId, 'chatId');
      status('generating');

      const consume = async () => {
        for await (const event of this.chat.streamPrepared(
          prepared.context,
          apiKey,
          abort.signal,
        )) {
          if (abort.signal.aborted) return;
          if (event.type === 'sources') {
            sources = event.sources;
            await send(sources, 'sources');
          } else if (event.type === 'message') {
            timer.refresh();
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
              { retrievalRunId: event.retrievalRunId, diagnostics: event.diagnostics },
            );
            settled = true;
            await send(event.citations, 'citations');
            await send(
              {
                answer,
                citations: event.citations,
                chatId,
                generationStatus: 'completed',
                retrievalRunId: event.retrievalRunId,
                diagnostics: event.diagnostics,
              },
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
          .addMessage(
            chatId,
            user,
            'assistant',
            interruptedAnswer,
            final.citations,
            'interrupted',
            {
              retrievalRunId: prepared.context?.diagnostics?.runId,
              diagnostics: prepared.context?.diagnostics,
            },
          )
          .catch(() => undefined);
      }
      await send(
        {
          message: errorMessage(error),
          answer: interruptedAnswer,
          citations: final.citations,
          chatId,
          generationStatus: 'interrupted',
          retrievalRunId: prepared.context?.diagnostics?.runId,
          diagnostics: prepared.context?.diagnostics,
        },
        'error',
      ).catch(() => undefined);
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      res.off('close', closed);
      if (!res.writableEnded) res.end();
    }
  }
}
