"""Opt-in native regression; normal fake suite never imports Paddle."""
import asyncio
import os
from pathlib import Path

import pytest

from pdf_analysis.backend import PaddleBackend
from pdf_analysis.worker import ProcessWorker


@pytest.mark.skipif(not os.environ.get('PDF_ANALYSIS_REAL_MODELS'), reason='Explicit local weights required')
def test_preload_and_text_recognition_warmup_from_absolute_model_directory():
    async def scenario():
        worker = ProcessWorker(Path(os.environ['PDF_ANALYSIS_REAL_MODELS']).resolve(), PaddleBackend)
        try:
            await worker.start()
            assert worker.ready is True
        finally:
            await worker.close()
    asyncio.run(scenario())
