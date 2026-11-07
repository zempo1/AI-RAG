"""Operator commands; serving never downloads weights or accepts new hashes."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil

from pdf_analysis.manifest import MODELS, seal_manifest, verify_manifest, _inventory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('download', 'seal', 'verify', 'warmup'))
    parser.add_argument('--models', type=Path, default=Path(os.environ.get('PDF_ANALYSIS_MODEL_DIR', 'models')))
    args = parser.parse_args()
    root = args.models.resolve()
    if args.action == 'download':
        # Explicit operation, fixed allowlist only; no request-controlled URL/path.
        if (root / 'manifest.json').exists():
            raise SystemExit('Refusing to change sealed models; use a new model directory')
        root.mkdir(parents=True, exist_ok=True)
        os.environ['PADDLE_PDX_CACHE_HOME'] = str(root / '.download-cache')
        os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
        from paddlex.inference.utils.official_models import official_models
        for name in MODELS:
            destination = root / name
            if destination.exists():
                raise SystemExit(f'Refusing to overwrite existing model: {name}')
            source = Path(official_models[name])
            shutil.copytree(source, destination)
            print(f'Downloaded {name}')
        print('Download complete. Review source and run seal explicitly to establish trust.')
        return
    if args.action == 'seal':
        reference = Path(__file__).with_name('model-manifest.lock.json')
        if reference.exists() and _inventory(root) != json.loads(reference.read_text(encoding='utf-8'))['files']:
            raise SystemExit('Downloaded model files differ from the checked-in model lock; review the new release explicitly')
        identifier, document = seal_manifest(root)
    else:
        identifier, document = verify_manifest(root)
    if args.action == 'warmup':
        from pdf_analysis.backend import PaddleBackend
        from pdf_analysis.worker import ProcessWorker
        async def warmup():
            worker = ProcessWorker(root, PaddleBackend)
            try:
                await worker.start()
            finally:
                await worker.close()
        asyncio.run(warmup())
    print(json.dumps({'manifest': identifier, 'models': document}, indent=2))


if __name__ == '__main__':
    main()
