import asyncio
import hashlib
import io
import json
import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from pdf_analysis.app import Settings, create_app
from pdf_analysis.manifest import MODELS, seal_manifest, verify_manifest
from pdf_analysis.worker import InferenceCancelled, InferenceTimeout, ProcessWorker, QueueFull


class FakeBackend:
    def __init__(self, model_root):
        pass

    def warmup(self):
        time.sleep(0.03)

    def infer(self, operation, image, precision):
        if image == b'hang' or image.endswith(b'slow'):
            time.sleep(10)
        if image == b'crash':
            import os
            os._exit(9)
        if operation == 'layout':
            return {'regions': [{'kind': 'table' if precision == 'high' else 'text',
                                 'bbox': [0.1, 0.2, 0.9, 0.8], 'score': 0.95}]}
        return {'blocks': [{'text': '中文测试', 'bbox': [0, 0, 1, 1], 'score': 0.9}]}


@pytest.fixture
def model_root(tmp_path):
    for model in MODELS:
        directory = tmp_path / model
        directory.mkdir()
        (directory / 'inference.json').write_text('{}')
        (directory / 'inference.pdiparams').write_bytes(b'model')
    seal_manifest(tmp_path)
    return tmp_path


def png():
    stream = io.BytesIO()
    Image.new('RGB', (10, 20), 'white').save(stream, format='PNG')
    return stream.getvalue()


def test_manifest_rejects_changed_added_missing_and_unsealed_models(model_root):
    identifier, document = verify_manifest(model_root)
    assert len(identifier) == 64
    assert document['files'][MODELS[0] + '/inference.pdiparams'] == hashlib.sha256(b'model').hexdigest()
    parameter = model_root / MODELS[0] / 'inference.pdiparams'
    parameter.write_bytes(b'tamper')
    with pytest.raises(ValueError):
        verify_manifest(model_root)
    parameter.write_bytes(b'model')
    extra = model_root / MODELS[0] / 'extra'
    extra.write_bytes(b'new')
    with pytest.raises(ValueError):
        verify_manifest(model_root)
    extra.unlink()
    parameter.unlink()
    with pytest.raises(ValueError):
        verify_manifest(model_root)
    with pytest.raises(FileExistsError):
        seal_manifest(model_root)


def test_http_contract_validation_and_no_path_or_url_inputs(model_root):
    app = create_app(Settings(model_root=model_root), backend_factory=FakeBackend)
    with TestClient(app) as client:
        health = client.get('/health').json()
        assert health['ready'] is True
        assert len(health['manifest']) == 64
        assert 'files' in health['models']
        response = client.post('/v1/layout', data={'precision': 'high'},
                               files={'file': ('page.png', png(), 'image/png')},
                               headers={'X-Request-ID': 'page-1'})
        assert response.status_code == 200
        assert response.headers['X-Request-ID'] == 'page-1'
        assert response.json() == {'regions': [{'kind': 'table', 'bbox': [0.1, 0.2, 0.9, 0.8], 'score': 0.95}],
                                   'manifest': health['manifest']}
        response = client.post('/v1/ocr', files={'file': ('page.png', png(), 'image/png')})
        assert response.json()['blocks'][0]['text'] == '中文测试'
        assert client.post('/v1/ocr', json={'url': 'https://example.com/a.png'}).status_code == 422
        assert client.post('/v1/ocr', files={'file': ('x', b'invalid', 'image/png')}).status_code == 400
        assert client.post('/v1/layout', data={'precision': 'unsafe'}, files={'file': ('x', png())}).status_code == 422


def test_body_and_pixel_limits_prevent_inference(model_root):
    app = create_app(Settings(model_root=model_root, max_body_bytes=1024, max_pixels=100), backend_factory=FakeBackend)
    with TestClient(app) as client:
        assert client.post('/v1/ocr', content=b'x' * 1025).status_code == 413
        assert client.post('/v1/ocr', files={'file': ('x', png())}).status_code == 413


def test_worker_timeout_kills_process_then_capacity_and_readiness_recover(model_root):
    async def scenario():
        worker = ProcessWorker(model_root, FakeBackend, inference_timeout=0.15, join_timeout=0.3)
        await worker.start()
        first_pid = worker.pid
        with pytest.raises(InferenceTimeout):
            await worker.submit('ocr', b'hang', 'standard')
        await worker.wait_ready(5)
        assert worker.pid != first_pid
        assert (await worker.submit('ocr', b'ok', 'standard'))['blocks'][0]['text'] == '中文测试'
        await worker.close()
        assert not worker.ready
    asyncio.run(scenario())


def test_cancel_running_request_restarts_child_and_does_not_leak_capacity(model_root):
    async def scenario():
        worker = ProcessWorker(model_root, FakeBackend, join_timeout=0.3)
        await worker.start()
        first_pid = worker.pid
        cancelled = asyncio.Event()
        task = asyncio.create_task(worker.submit('ocr', b'hang', 'standard', cancelled))
        await asyncio.sleep(0.1)
        cancelled.set()
        with pytest.raises(InferenceCancelled):
            await task
        await worker.wait_ready(5)
        assert worker.pid != first_pid
        assert 'blocks' in await worker.submit('ocr', b'ok', 'standard')
        await worker.close()
    asyncio.run(scenario())


def test_queue_is_bounded_and_waiting_cancel_does_not_kill_active_child(model_root):
    async def scenario():
        worker = ProcessWorker(model_root, FakeBackend, queue_size=1, inference_timeout=0.6)
        await worker.start()
        active = asyncio.create_task(worker.submit('ocr', b'hang', 'standard'))
        await asyncio.sleep(0.1)
        first_pid = worker.pid
        cancelled = asyncio.Event()
        queued = asyncio.create_task(worker.submit('ocr', b'ok', 'standard', cancelled))
        await asyncio.sleep(0.05)
        with pytest.raises(QueueFull):
            await worker.submit('ocr', b'ok', 'standard')
        cancelled.set()
        with pytest.raises(InferenceCancelled):
            await queued
        assert worker.pid == first_pid
        replacement = asyncio.create_task(worker.submit('ocr', b'ok', 'standard'))
        await asyncio.sleep(0.03)
        assert not replacement.done(), 'Cancelled queue entry must free admission immediately'
        with pytest.raises(InferenceTimeout):
            await active
        assert 'blocks' in await replacement
        await worker.close()
    asyncio.run(scenario())


def test_child_crash_recovers_and_unsealed_start_fails_closed(model_root, tmp_path):
    async def scenario():
        worker = ProcessWorker(model_root, FakeBackend)
        await worker.start()
        with pytest.raises(RuntimeError):
            await worker.submit('ocr', b'crash', 'standard')
        await worker.wait_ready(5)
        assert 'blocks' in await worker.submit('ocr', b'ok', 'standard')
        await worker.close()
    asyncio.run(scenario())
    with pytest.raises((ValueError, FileNotFoundError)):
        with TestClient(create_app(Settings(model_root=tmp_path / 'missing'), backend_factory=FakeBackend)):
            pass
