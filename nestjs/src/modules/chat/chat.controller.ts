import { Body, Controller, Headers, Post, Res, HttpCode, Optional } from '@nestjs/common';
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
import { AgentQaTasksService } from '../tasks/agent-qa.service';

@Controller('api')
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly history: HistoryService,
    private readonly qa: QaTasksService,
    @Optional() private readonly agentTasks?: AgentQaTasksService,
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
  private async prepare(body: ChatDto, user: number, apiKey?: string, onProgress?: (stage: string) => void,
    signal?: AbortSignal, onAgentStep?: (step: any) => Promise<void> | void) {
    if (!body.question?.trim()) throw new ApiError(400, 'Question is required.');
    const fingerprint = this.fingerprint(body),
      requestId = body.requestId || randomUUID();
    signal?.throwIfAborted();
    if (this.agentTasks) {
      const started = await this.agentTasks.begin(user, { ...body, question: body.question!, apiKey, requestId, fingerprint });
      if (started.existing) return { accepted: this.agentTasks.accepted(started.task) };
      const execution = this.agentTasks.execution(started.task.id, started.token!, signal);
      try {
        const context = await this.chat.prepare(body.question!, user, started.chat.knowledgeBaseId, {
          documentIds: body.documentIds, mode: body.mode || 'auto', requestId, chatId: started.chat.id,
          history: started.chat.messages || [], apiKey, onProgress, ...execution,
          onAgentStep: async (step: any) => { await execution.onAgentStep(step); await onAgentStep?.(step); },
        });
        execution.signal.throwIfAborted();
        if (context.requiresAsync) {
          const accepted = await this.agentTasks.handoff(started.task.id, started.token!, context.snapshot);
          execution.dispose();
          return { accepted };
        }
        return { chat: started.chat, context, execution, started };
      } catch (error) {
        if (signal?.aborted) await this.agentTasks.cancel(started.task.id, user).catch(() => undefined);
        await this.agentTasks.fail(started.task.id, started.token!, error);
        execution.dispose();
        throw error;
      }
    }
    // 后台问答通过请求标识和内容指纹去重；重发请求直接返回原任务。
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
      signal,
      onAgentStep,
    });
    // 全文证据超出上下文时转为后台任务，HTTP/SSE 返回受理信息，前端随后轮询。
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
    const abort = new AbortController();
    const closed = () => { if (!res.writableEnded) abort.abort(new Error('Client disconnected')); };
    res.on?.('close', closed);
    let prepared: Awaited<ReturnType<ChatController['prepare']>> | undefined;
    try {
    prepared = await this.prepare(body, user, apiKey, undefined, abort.signal);
    if (prepared.accepted) {
      res.status(202);
      return prepared.accepted;
    }
    const final = await this.chat.answerPrepared(prepared.context, apiKey, prepared.execution?.signal || abort.signal);
    if (prepared.started) await this.agentTasks!.complete(prepared.started.task.id, prepared.started.token!, final);
    else await this.history.addMessage(
      prepared.chat!.id,
      user,
      'assistant',
      final.answer,
      final.citations,
      'completed',
      { retrievalRunId: final.retrievalRunId, diagnostics: final.diagnostics },
    );
    return { ...final, chatId: prepared.chat!.id, generationStatus: 'completed' };
    } catch (error) {
      if (prepared?.started) {
        if (abort.signal.aborted) await this.agentTasks!.cancel(prepared.started.task.id, user).catch(() => undefined);
        await this.agentTasks!.fail(prepared.started.task.id, prepared.started.token!, error);
      }
      throw error;
    } finally { prepared?.execution?.dispose(); res.off?.('close', closed); }
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
    // Cancellation and heartbeat must cover planning/retrieval, not only generation.
    const abort = new AbortController();
    const closed = () => abort.abort(new Error('Client disconnected'));
    res.on('close', closed);
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write(': heartbeat\n\n');
    }, 15000);
    heartbeat.unref();
    const preparationDone = () => { clearInterval(heartbeat); res.off('close', closed); };
    status('understanding');
    let prepared: Awaited<ReturnType<ChatController['prepare']>>;
    try {
      prepared = await this.prepare(body, user, apiKey, status, abort.signal, step => {
        if (!res.destroyed && !res.writableEnded) res.write('event: agent_step\ndata: ' + JSON.stringify(step) + '\n\n');
      });
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        res.write('event: error\ndata: ' + JSON.stringify({ message: errorMessage(error) }) + '\n\n');
        res.end();
      }
      preparationDone();
      return;
    }
    const chatId = prepared.accepted?.chatId || prepared.chat!.id;
    if (prepared.accepted) {
      res.write('event: accepted\ndata: ' + JSON.stringify(prepared.accepted) + '\n\n');
      res.end();
      preparationDone();
      return;
    }
    // 把客户端断开与模型取消信号关联，停止继续向已断开的连接生成内容。
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
          prepared.execution?.signal || abort.signal,
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
            if (prepared.started) await this.agentTasks!.complete(prepared.started.task.id, prepared.started.token!, event);
            else await this.history.addMessage(
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
      if (prepared.started) {
        const partial = { answer: interruptedAnswer, citations: final.citations, diagnostics: prepared.context?.diagnostics };
        if (abort.signal.aborted) await this.agentTasks!.cancel(prepared.started.task.id, user, partial).catch(() => undefined);
        await this.agentTasks!.fail(prepared.started.task.id, prepared.started.token!, error, 3, false, partial);
      }
      if (!settled && !prepared.started) {
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
      prepared.execution?.dispose();
      res.off('close', closed);
      if (!res.writableEnded) res.end();
    }
  }
}
