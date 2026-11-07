"""One spawn child, bounded admission, hard kill/rebuild on cancellation or stall."""
import asyncio
import contextlib
from dataclasses import dataclass
import logging
import multiprocessing
import os
import tempfile
import time

from .manifest import verify_manifest


class InferenceTimeout(TimeoutError):
    pass


class InferenceCancelled(Exception):
    pass


class QueueFull(Exception):
    pass


def _child(connection, factory, model_root):
    os.environ['OMP_NUM_THREADS'] = '4'
    os.environ['MKL_NUM_THREADS'] = '4'
    os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
    logging.disable(logging.CRITICAL)
    # Paddle may print raw results or image paths; suppress third-party output.
    with tempfile.TemporaryDirectory(prefix='pdf-analysis-runtime-') as runtime_cache, \
         open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        # Keep Paddle's internal model metadata away from the user's global cache.
        # Inputs are numpy arrays, so no uploaded page is passed to a path-based cache.
        os.environ['PADDLE_PDX_CACHE_HOME'] = runtime_cache
        try:
            # Windows Paddle native loaders fail on non-ASCII absolute model paths.
            # This is a dedicated child: change only its cwd and use ASCII model names.
            os.chdir(model_root)
            backend = factory('.')
            backend.warmup()
            connection.send(('ready', None))
            while True:
                operation, image, precision = connection.recv()
                try:
                    result = backend.infer(operation, image, precision)
                    connection.send(('result', result))
                except Exception:
                    connection.send(('error', None))
                finally:
                    image = None
        except (EOFError, BrokenPipeError):
            pass
        except Exception as error:
            with contextlib.suppress(Exception):
                # Initialization sees models and synthetic warmup only, never user pages.
                connection.send(('error', f'{type(error).__name__}: {error}'[:500]))
        finally:
            connection.close()


@dataclass
class _Job:
    operation: str
    image: bytes
    precision: str
    deadline: float
    cancelled: asyncio.Event
    future: asyncio.Future


class ProcessWorker:
    def __init__(self, model_root, backend_factory, *, queue_size=4, inference_timeout=60,
                 total_timeout=90, startup_timeout=300, join_timeout=1):
        self.model_root = model_root
        self.factory = backend_factory
        self.inference_timeout = inference_timeout
        self.total_timeout = total_timeout
        self.startup_timeout = startup_timeout
        self.join_timeout = join_timeout
        self.queue = asyncio.Queue(maxsize=queue_size)
        self.ready = False
        self._ready = asyncio.Event()
        self._process = None
        self._pipe = None
        self._runner = None
        self._closing = False
        self._active = None
        self._fatal = False
        self.manifest = None
        self.models = None

    @property
    def pid(self):
        return self._process.pid if self._process else None

    async def start(self):
        self.manifest, self.models = verify_manifest(self.model_root)
        await self._boot()
        self._runner = asyncio.create_task(self._run())

    async def _boot(self):
        if self._closing or self._fatal:
            return
        # Revalidate on every reconstruction, never learn new hashes.
        identifier, _ = verify_manifest(self.model_root)
        if identifier != self.manifest:
            raise RuntimeError('Model manifest changed while serving')
        context = multiprocessing.get_context('spawn')
        self._pipe, child_pipe = context.Pipe()
        self._process = context.Process(target=_child, args=(child_pipe, self.factory, self.model_root), daemon=True)
        self._process.start()
        child_pipe.close()
        until = time.monotonic() + self.startup_timeout
        try:
            while time.monotonic() < until:
                if self._pipe.poll():
                    status, detail = self._pipe.recv()
                    if status != 'ready':
                        raise RuntimeError(f'Model initialization failed: {detail}')
                    self.ready = True
                    self._ready.set()
                    return
                if not self._process.is_alive():
                    raise RuntimeError('Model process exited during initialization')
                await asyncio.sleep(0.02)
            raise InferenceTimeout('Model initialization timeout')
        except BaseException:
            await self._stop_child()
            raise

    async def _stop_child(self):
        self.ready = False
        self._ready.clear()
        process, self._process = self._process, None
        pipe, self._pipe = self._pipe, None
        if pipe:
            pipe.close()
        if process:
            if process.is_alive():
                process.terminate()
            await asyncio.to_thread(process.join, self.join_timeout)
            if process.is_alive():
                process.kill()
                await asyncio.to_thread(process.join, self.join_timeout)
            if process.is_alive():
                # Never spawn extra workers if the OS cannot reap the old child.
                self._fatal = True
            else:
                process.close()

    async def wait_ready(self, timeout=300):
        await asyncio.wait_for(self._ready.wait(), timeout)

    async def submit(self, operation, image, precision, cancelled=None, deadline=None):
        if self._closing or self._fatal:
            raise RuntimeError('Model worker unavailable')
        loop = asyncio.get_running_loop()
        until = min(deadline or float('inf'), time.monotonic() + self.total_timeout)
        job = _Job(operation, image, precision, until, cancelled or asyncio.Event(), loop.create_future())
        try:
            self.queue.put_nowait(job)
        except asyncio.QueueFull as error:
            raise QueueFull('Inference queue is full') from error
        try:
            while not job.future.done():
                if job.cancelled.is_set() or time.monotonic() >= until:
                    job.cancelled.set()
                    # Queued cancellations release the caller immediately; the actor skips them.
                    if job is not self._active:
                        job.image = b''
                        if time.monotonic() >= until:
                            raise InferenceTimeout('Total request timeout')
                        raise InferenceCancelled('Request disconnected')
                await asyncio.wait({job.future}, timeout=0.02)
            return job.future.result()
        except asyncio.CancelledError:
            job.cancelled.set()
            job.future.add_done_callback(_consume_failure)
            raise
        finally:
            if job is not self._active and job.cancelled.is_set():
                job.image = b''
                if not job.future.done():
                    job.future.cancel()
                # Only use Queue's public operations; no await makes this drain/restore
                # atomic with respect to the actor and other admissions on this loop.
                retained = []
                while not self.queue.empty():
                    pending = self.queue.get_nowait()
                    self.queue.task_done()
                    if pending is not job:
                        retained.append(pending)
                for pending in retained:
                    self.queue.put_nowait(pending)

    async def _run(self):
        while not self._closing:
            job = await self.queue.get()
            self._active = job
            recover = False
            error = None
            try:
                if job.cancelled.is_set() or job.future.cancelled():
                    raise InferenceCancelled('Request disconnected')
                if time.monotonic() >= job.deadline:
                    raise InferenceTimeout('Total request timeout')
                if not self.ready:
                    raise RuntimeError('Model worker unavailable')
                until = min(job.deadline, time.monotonic() + self.inference_timeout)
                # The child is waiting on recv after ready. Offload the bounded image transfer
                # so disconnect/timeout supervision remains live even for a stuck native child.
                sender = asyncio.create_task(asyncio.to_thread(self._pipe.send, (job.operation, job.image, job.precision)))
                sender.add_done_callback(_consume_failure)
                while True:
                    if time.monotonic() >= until:
                        recover = True
                        raise InferenceTimeout('Inference timeout')
                    if job.cancelled.is_set():
                        recover = True
                        raise InferenceCancelled('Request disconnected')
                    if sender.done():
                        sender.result()
                        if self._pipe.poll():
                            status, result = self._pipe.recv()
                            if status != 'result':
                                raise RuntimeError('Model inference failed')
                            if not job.future.done():
                                job.future.set_result(result)
                            break
                    if not self._process.is_alive():
                        recover = True
                        raise RuntimeError('Model process exited')
                    await asyncio.sleep(0.02)
            except asyncio.CancelledError:
                job.cancelled.set()
                if not job.future.done():
                    job.future.cancel()
                raise
            except Exception as caught:
                error = caught
                if isinstance(caught, (EOFError, OSError)) and not isinstance(caught, InferenceTimeout):
                    recover = True
                    error = RuntimeError('Model transport failed')
            finally:
                job.image = b''
                if recover:
                    # Kill/reap before releasing capacity; next request never shares a stuck child.
                    await self._stop_child()
                if error and not job.future.done():
                    job.future.set_exception(error)
                self._active = None
                self.queue.task_done()
            if recover and not self._closing and not self._fatal:
                try:
                    await self._boot()
                except Exception:
                    self._fatal = True

    async def close(self):
        self._closing = True
        if self._runner:
            self._runner.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._runner
        await self._stop_child()
        if self._active and not self._active.future.done():
            self._active.future.set_exception(RuntimeError('Service stopping'))
        while not self.queue.empty():
            job = self.queue.get_nowait()
            job.image = b''
            if not job.future.done():
                job.future.set_exception(RuntimeError('Service stopping'))
            self.queue.task_done()


def _consume_failure(future):
    if not future.cancelled():
        future.exception()
