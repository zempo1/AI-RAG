import 'reflect-metadata';
import { Controller, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/bootstrap';
import { currentModels, modelBinding } from '../src/modules/model-settings/model-runtime';
import { TaskQueueRuntime } from '../src/modules/tasks/task-queue.runtime';
import { Store } from '../src/persistence/store';

@Controller('api/model-probe')
class ModelProbeController {
  constructor(private readonly config: ConfigService) {}
  @Post() async get() {
    await new Promise(resolve => setTimeout(resolve, 5));
    return { userId: currentModels()?.userId, model: modelBinding(this.config, 'chat').model };
  }
}

test('authenticated settings APIs persist for the account and request subscriptions bind the right snapshot', async () => {
  process.env.STORAGE_DRIVER = 'memory'; process.env.VECTOR_DRIVER = 'memory'; process.env.QUEUE_DRIVER = 'memory';
  process.env.JWT_SECRET = 'model-settings-api-secret-32-characters';
  const { AppModule } = await import('../src/app.module');
  const module = await Test.createTestingModule({ imports: [AppModule], controllers: [ModelProbeController] })
    .overrideProvider(TaskQueueRuntime).useValue({}).compile();
  const app = module.createNestApplication(); configureApp(app); await app.init();
  try {
    const http = app.getHttpServer();
    await request(http).get('/api/model-settings').expect(401);
    const first = (await request(http).post('/api/auth/register').send({ username: 'model-user-1', password: 'secret123' }).expect(200)).body.data;
    const second = (await request(http).post('/api/auth/register').send({ username: 'model-user-2', password: 'secret123' }).expect(200)).body.data;
    const auth = (token: string) => ({ Authorization: 'Bearer ' + token });
    const input = { provider: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', apiKey: 'private-api-key', model: 'account-chat' };
    const saved = await request(http).put('/api/model-settings/chat').set(auth(first.token)).send(input).expect(200);
    expect(saved.body.data).toMatchObject({ model: 'account-chat', hasApiKey: true, source: 'custom' });
    expect(JSON.stringify(saved.body)).not.toContain('private-api-key');
    await request(http).put('/api/model-settings/chat').set(auth(second.token)).send({ ...input, model: 'second-chat' }).expect(200);
    const probes = await Promise.all([first, second].map(user => request(http).post('/api/model-probe').set(auth(user.token)).expect(200)));
    expect(probes.map(r => r.body.data.model)).toEqual(['account-chat', 'second-chat']);
    expect(probes[0].body.data.userId).not.toBe(probes[1].body.data.userId);
    const loggedIn = (await request(http).post('/api/auth/login').send({ username: 'model-user-1', password: 'secret123' }).expect(200)).body.data;
    const loaded = await request(http).get('/api/model-settings').set(auth(loggedIn.token)).expect(200);
    expect(loaded.body.data.find((r: any) => r.role === 'chat')).toMatchObject({ model: 'account-chat', hasApiKey: true });
    await request(http).put('/api/model-settings/chat').set(auth(first.token)).send({ ...input, apiKey: '', baseUrl: 'https://new.invalid/v1' }).expect(400);
    await request(http).put('/api/model-settings/unknown').set(auth(first.token)).send(input).expect(400);
    const raw = await app.get(Store).list('modelSettings');
    expect(JSON.stringify(raw)).not.toContain('private-api-key');
    const reset = await request(http).delete('/api/model-settings/chat').set(auth(first.token)).expect(200);
    expect(reset.body.data.source).toBe('system');
    expect((await request(http).post('/api/model-probe').set(auth(second.token)).expect(200)).body.data.model).toBe('second-chat');
    const [broken] = await app.get(Store).list('modelSettings');
    await app.get(Store).save('modelSettings', { id: broken.id, encryptedApiKey: 'damaged' });
    await request(http).get('/api/model-settings').set(auth(second.token)).expect(200);
    await request(http).get('/api/chats').set(auth(second.token)).expect(200);
    await request(http).put('/api/model-settings/chat').set(auth(second.token)).send({ ...input, apiKey: 'repaired-key' }).expect(200);
    await app.get(Store).save('modelSettings', { id: broken.id, encryptedApiKey: 'damaged-again' });
    await request(http).delete('/api/model-settings/chat').set(auth(second.token)).expect(200);
  } finally { await app.close(); }
}, 30000);
