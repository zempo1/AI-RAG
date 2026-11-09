import asyncio
import contextlib
from contextlib import asynccontextmanager
from dataclasses import dataclass
import io
import os
from pathlib import Path
import re
import time
import uuid
import warnings

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError
from python_multipart import MultipartParser
from python_multipart.multipart import parse_options_header

from .backend import PaddleBackend
from .worker import InferenceCancelled, InferenceTimeout, ProcessWorker, QueueFull


@dataclass
class Settings:
    model_root: Path = Path(os.environ.get('PDF_ANALYSIS_MODEL_DIR', 'models'))
    max_body_bytes: int = 40 * 1024 * 1024
    # Node renders to 8 MP; allow rounding of each raster dimension.
    max_pixels: int = 8_020_000
    max_side: int = 4096
    queue_size: int = 4
    inference_timeout: float = 60
    total_timeout: float = 90
    startup_timeout: float = 300


class RequestLimits:
    """Count chunked bodies before multipart parsing and never spool user bytes to disk."""
    def __init__(self, app, settings):
        self.app = app
        self.settings = settings
        self.inflight = 0

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope['method'] != 'POST':
            return await self.app(scope, receive, send)
        if self.inflight >= self.settings.queue_size + 2:
            return await JSONResponse({'detail': 'Service busy'}, status_code=503)(scope, receive, send)
        self.inflight += 1
        deadline = time.monotonic() + self.settings.total_timeout
        scope.setdefault('state', {})['deadline'] = deadline
        started = False

        async def tracked_send(message):
            nonlocal started
            if message['type'] == 'http.response.start':
                started = True
            await send(message)

        try:
            headers = dict(scope['headers'])
            try:
                declared = int(headers.get(b'content-length', b'0'))
            except ValueError:
                declared = -1
            if declared < 0:
                return await JSONResponse({'detail': 'Invalid content length'}, status_code=400)(scope, receive, send)
            if declared > self.settings.max_body_bytes:
                return await JSONResponse({'detail': 'Request too large'}, status_code=413)(scope, receive, send)
            chunks = []
            size = 0
            async with asyncio.timeout_at(asyncio.get_running_loop().time() + self.settings.total_timeout):
                while True:
                    message = await receive()
                    if message['type'] == 'http.disconnect':
                        return
                    body = message.get('body', b'')
                    size += len(body)
                    if size > self.settings.max_body_bytes:
                        return await JSONResponse({'detail': 'Request too large'}, status_code=413)(scope, receive, send)
                    chunks.append(body)
                    if not message.get('more_body', False):
                        break
                buffered = b''.join(chunks)
                chunks.clear()
                delivered = False

                async def replay():
                    nonlocal delivered, buffered
                    if not delivered:
                        delivered = True
                        result, buffered = buffered, b''
                        return {'type': 'http.request', 'body': result, 'more_body': False}
                    return await receive()

                await self.app(scope, replay, tracked_send)
        except TimeoutError:
            if not started:
                await JSONResponse({'detail': 'Total request timeout'}, status_code=504)(scope, receive, send)
        finally:
            self.inflight -= 1


def _multipart(body, content_type):
    media, options = parse_options_header(content_type)
    boundary = options.get(b'boundary')
    if media != b'multipart/form-data' or not boundary or len(boundary) > 200:
        raise HTTPException(422, 'Expected multipart file upload')
    fields = {}
    headers = {}
    header_name = bytearray()
    header_value = bytearray()
    data = bytearray()
    complete = False
    part_count = 0

    def begin():
        nonlocal part_count
        part_count += 1
        if part_count > 4:
            raise ValueError('Too many multipart fields')
        headers.clear()
        data.clear()

    def header_field(chunk, start, end):
        header_name.extend(chunk[start:end])

    def header_value_data(chunk, start, end):
        header_value.extend(chunk[start:end])

    def header_end():
        headers[bytes(header_name).lower()] = bytes(header_value)
        header_name.clear()
        header_value.clear()

    def part_data(chunk, start, end):
        data.extend(chunk[start:end])

    def part_end():
        disposition, parameters = parse_options_header(headers.get(b'content-disposition', b''))
        name = parameters.get(b'name', b'').decode('ascii')
        if disposition != b'form-data' or name not in ('file', 'precision', 'request_id', 'classify') or name in fields:
            raise ValueError('Unexpected multipart field')
        if name == 'file' and b'filename' not in parameters:
            raise ValueError('File upload required')
        if name != 'file' and len(data) > 128:
            raise ValueError('Field too long')
        fields[name] = bytes(data)

    def end():
        nonlocal complete
        complete = True

    try:
        parser = MultipartParser(boundary, {'on_part_begin': begin, 'on_header_field': header_field,
            'on_header_value': header_value_data, 'on_header_end': header_end, 'on_part_data': part_data,
            'on_part_end': part_end, 'on_end': end})
        parser.write(body)
        parser.finalize()
        if not complete or not fields.get('file'):
            raise ValueError('Incomplete upload')
    except (ValueError, UnicodeError):
        raise HTTPException(422, 'Invalid multipart upload') from None
    return fields


def _validate_image(image, settings):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(image)) as decoded:
                width, height = decoded.size
                if width * height > settings.max_pixels or max(width, height) > settings.max_side:
                    raise HTTPException(413, 'Image dimensions too large')
                if decoded.format not in ('PNG', 'JPEG', 'WEBP') or getattr(decoded, 'n_frames', 1) != 1:
                    raise HTTPException(400, 'Expected a single PNG, JPEG or WEBP image')
                decoded.verify()
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(413, 'Image dimensions too large') from None
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(400, 'Invalid image') from None


def create_app(settings=None, *, backend_factory=PaddleBackend):
    settings = settings or Settings()
    worker = ProcessWorker(settings.model_root, backend_factory, queue_size=settings.queue_size,
        inference_timeout=settings.inference_timeout, total_timeout=settings.total_timeout,
        startup_timeout=settings.startup_timeout)

    @asynccontextmanager
    async def lifespan(app):
        try:
            await worker.start()
            yield
        finally:
            await worker.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
    app.add_middleware(RequestLimits, settings=settings)
    app.state.worker = worker

    @app.get('/health')
    async def health():
        return {'ready': worker.ready, 'manifest': worker.manifest, 'models': worker.models}

    async def analyze(request, operation):
        fields = _multipart(await request.body(), request.headers.get('content-type', ''))
        try:
            precision = fields.get('precision', b'standard').decode('ascii')
            request_id = request.headers.get('x-request-id') or fields.get('request_id', b'').decode('ascii') or uuid.uuid4().hex
        except UnicodeError:
            raise HTTPException(422, 'Invalid request fields') from None
        if (
            precision != 'standard'
            or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', request_id)
            or ('classify' in fields and (operation != 'ocr' or fields['classify'] != b'true'))
            or ('precision' in fields and operation != 'layout')
        ):
            raise HTTPException(422, 'Invalid request fields')
        _validate_image(fields['file'], settings)
        cancelled = asyncio.Event()

        async def watch_disconnect():
            while True:
                if await request.is_disconnected():
                    cancelled.set()
                    return
                await asyncio.sleep(0.03)

        watcher = asyncio.create_task(watch_disconnect())
        try:
            result = await worker.submit(
                'classify' if 'classify' in fields else operation,
                fields['file'], cancelled, request.state.deadline,
            )
            return JSONResponse({**result, 'manifest': worker.manifest}, headers={'X-Request-ID': request_id})
        except QueueFull:
            raise HTTPException(503, 'Inference queue is full', headers={'Retry-After': '1'}) from None
        except InferenceTimeout:
            raise HTTPException(504, 'Inference timeout') from None
        except InferenceCancelled:
            raise HTTPException(499, 'Request disconnected') from None
        except RuntimeError:
            raise HTTPException(503, 'Model worker unavailable') from None
        finally:
            watcher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watcher

    @app.post('/v1/layout')
    async def layout(request: Request):
        return await analyze(request, 'layout')

    @app.post('/v1/ocr')
    async def ocr(request: Request):
        return await analyze(request, 'ocr')

    return app
