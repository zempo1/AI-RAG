"""Explicit model sealing, separate from serving; fail closed on any drift."""
import hashlib
import json
from pathlib import Path

MODELS = ('PP-DocLayout-M', 'PP-DocLayout_plus-L', 'PP-OCRv6_small_det', 'PP-OCRv6_small_rec')
MANIFEST_FILE = 'manifest.json'
VERSIONS = {'paddleocr': '3.7.0', 'paddlepaddle': '3.3.1', 'paddlex': '3.7.0'}
PIPELINE_VERSION = 'paddle-analysis-v2-numeric-edges-bgr-cpu-no-mkldnn'


def _inventory(root: Path):
    root = Path(root).resolve()
    files = {}
    for name in MODELS:
        directory = root / name
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError('Missing model directory')
        for path in sorted(directory.rglob('*')):
            if path.is_symlink():
                raise ValueError('Model symlinks are not allowed')
            if path.is_file():
                digest = hashlib.sha256()
                with path.open('rb') as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(chunk)
                files[path.relative_to(root).as_posix()] = digest.hexdigest()
        if not (directory / 'inference.pdiparams').is_file() or not any(
            (directory / filename).is_file() for filename in ('inference.json', 'inference.pdmodel')
        ):
            raise ValueError('Incomplete inference model')
    return files


def seal_manifest(root: Path):
    """Operator-only first trust action; existing seals are never overwritten."""
    root = Path(root)
    target = root / MANIFEST_FILE
    if target.exists():
        raise FileExistsError('Existing manifest must be reviewed and removed explicitly before resealing')
    document = {'schema': 1, 'versions': VERSIONS, 'models': list(MODELS), 'files': _inventory(root)}
    with target.open('x', encoding='utf-8') as stream:
        json.dump(document, stream, sort_keys=True, indent=2)
        stream.write('\n')
    return verify_manifest(root)


def verify_manifest(root: Path):
    root = Path(root)
    target = root / MANIFEST_FILE
    if target.is_symlink():
        raise ValueError('Manifest must be a regular file')
    document = json.loads(target.read_text(encoding='utf-8'))
    if document.get('schema') != 1 or document.get('versions') != VERSIONS or document.get('models') != list(MODELS):
        raise ValueError('Unsupported model manifest')
    if document.get('files') != _inventory(root):
        raise ValueError('Model integrity verification failed')
    canonical = json.dumps({'weights': document, 'pipeline': PIPELINE_VERSION}, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(canonical).hexdigest(), document
