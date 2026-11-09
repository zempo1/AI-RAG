import asyncio
import time

from pdf_analysis.app import Settings, create_app
from pdf_analysis.worker import InferenceTimeout, ProcessWorker
from test_service import FakeBackend, model_root, png


def test_queue_wait_counts_toward_total_request_deadline(model_root):
    async def scenario():
        worker = ProcessWorker(model_root, FakeBackend, total_timeout=0.25, inference_timeout=1)
        await worker.start()
        active = asyncio.create_task(worker.submit('ocr', b'hang'))
        await asyncio.sleep(0.05)
        started = time.monotonic()
        try:
            await worker.submit('ocr', b'ok', deadline=started + 0.1)
            assert False, 'Queued request must expire'
        except InferenceTimeout:
            assert time.monotonic() - started < 0.5
        try:
            await active
        except InferenceTimeout:
            pass
        await worker.close()
    asyncio.run(scenario())


def test_chunked_body_without_content_length_is_limited(model_root):
    async def scenario():
        app = create_app(Settings(model_root=model_root, max_body_bytes=100), backend_factory=FakeBackend)
        received = iter([{'type': 'http.request', 'body': b'x' * 60, 'more_body': True},
                         {'type': 'http.request', 'body': b'x' * 60, 'more_body': False}])
        messages = []
        async def receive():
            return next(received)
        async def send(message):
            messages.append(message)
        scope = {'type': 'http', 'method': 'POST', 'path': '/v1/ocr', 'headers': [], 'state': {}}
        await app(scope, receive, send)
        assert messages[0]['status'] == 413
    asyncio.run(scenario())


def test_http_disconnect_rebuilds_running_model_process(model_root):
    async def scenario():
        app = create_app(Settings(model_root=model_root), backend_factory=FakeBackend)
        image = png() + b'slow'
        body = b'--page\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n\r\n' + image + b'\r\n--page--\r\n'
        first = True
        disconnected = asyncio.Event()
        messages = []
        async def receive():
            nonlocal first
            if first:
                first = False
                return {'type': 'http.request', 'body': body, 'more_body': False}
            await disconnected.wait()
            return {'type': 'http.disconnect'}
        async def send(message):
            messages.append(message)
        scope = {'type': 'http', 'method': 'POST', 'path': '/v1/ocr', 'query_string': b'',
                 'headers': [(b'content-type', b'multipart/form-data; boundary=page')],
                 'state': {}, 'server': ('127.0.0.1', 8091), 'client': ('127.0.0.1', 1234),
                 'scheme': 'http', 'http_version': '1.1'}
        async with app.router.lifespan_context(app):
            first_pid = app.state.worker.pid
            pending = asyncio.create_task(app(scope, receive, send))
            await asyncio.sleep(0.15)
            disconnected.set()
            await asyncio.wait_for(pending, 3)
            await app.state.worker.wait_ready(5)
            assert app.state.worker.pid != first_pid
            assert messages[0]['status'] == 499
    asyncio.run(scenario())
