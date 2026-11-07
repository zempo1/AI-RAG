"""Paddle is imported only inside the isolated model process."""
import io
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .manifest import MODELS, VERSIONS, verify_manifest

LABELS = {
    'text': 'text', 'abstract': 'text', 'reference': 'text', 'references': 'text',
    'content': 'text', 'paragraph': 'text', 'sidebar_text': 'text',
    'doc_title': 'title', 'document_title': 'title', 'paragraph_title': 'title',
    'section_title': 'title', 'title': 'title', 'table': 'table',
    'image': 'figure', 'figure': 'figure', 'chart': 'figure', 'formula': 'figure',
    'algorithm': 'figure', 'seal': 'figure',
    'figure_caption': 'caption', 'table_caption': 'caption', 'chart_caption': 'caption',
    'figure_title': 'caption',
    'header': 'text', 'footer': 'text', 'page_number': 'decoration', 'number': 'decoration',
    'footnote': 'text', 'header_image': 'figure', 'footer_image': 'figure',
    'formula_number': 'caption',
}


def _box(coordinates, width, height):
    values = [float(value) for value in coordinates]
    if len(values) != 4 or not all(math.isfinite(value) for value in values):
        return None
    box = [max(0.0, min(1.0, value / size)) for value, size in zip(values, (width, height, width, height))]
    return box if box[2] > box[0] and box[3] > box[1] else None


def _score(value):
    value = float(value)
    return max(0.0, min(1.0, value)) if math.isfinite(value) else 0.0


def layout_regions(result, width, height):
    regions = []
    for item in result.get('boxes', []):
        box = _box(item['coordinate'], width, height)
        if box:
            label = str(item.get('label', '')).lower().replace(' ', '_')
            kind = LABELS.get(label, 'unknown')
            if label in ('number', 'page_number') and not (
                (box[1] >= 0.88 or box[3] <= 0.12) and box[2] - box[0] <= 0.25
            ):
                kind = 'text'
            regions.append({'kind': kind, 'bbox': box, 'score': _score(item['score'])})
    return regions


def ocr_blocks(result, width, height):
    blocks = []
    polygons = result.get('rec_polys')
    if polygons is None:
        polygons = result.get('rec_boxes', [])
    for text, score, polygon in zip(result.get('rec_texts', []), result.get('rec_scores', []), polygons):
        if not str(text).strip():
            continue
        if len(polygon) == 4 and isinstance(polygon[0], (int, float)):
            coordinates = polygon
        elif getattr(polygon, 'ndim', 0) == 1:
            coordinates = polygon
        else:
            coordinates = [min(point[0] for point in polygon), min(point[1] for point in polygon),
                           max(point[0] for point in polygon), max(point[1] for point in polygon)]
        box = _box(coordinates, width, height)
        if box:
            blocks.append({'text': str(text), 'score': _score(score), 'bbox': box})
    return blocks


class PaddleBackend:
    def __init__(self, model_root):
        import importlib.metadata
        import numpy as np
        from paddleocr import LayoutDetection, PaddleOCR

        for name, version in VERSIONS.items():
            if importlib.metadata.version(name) != version:
                raise RuntimeError('Installed Paddle package version differs from manifest')
        verify_manifest(model_root)
        root = Path(model_root)
        # Paddle 3.3.1 oneDNN PIR has an unsupported DoubleAttribute array
        # conversion on these layout weights. Use its CPU kernels consistently.
        common = {'device': 'cpu', 'cpu_threads': 4, 'enable_mkldnn': False}
        self.np = np
        self.layouts = {
            precision: LayoutDetection(model_name=name, model_dir=str(root / name), **common)
            for precision, name in zip(('standard', 'high'), MODELS[:2])
        }
        self.ocr = PaddleOCR(
            text_detection_model_name=MODELS[2], text_detection_model_dir=str(root / MODELS[2]),
            text_recognition_model_name=MODELS[3], text_recognition_model_dir=str(root / MODELS[3]),
            use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False,
            **common,
        )

    def warmup(self):
        stream = io.BytesIO()
        # Both layout precisions and OCR must execute before ready becomes true.
        sample = Image.new('RGB', (720, 256), 'white')
        draw = ImageDraw.Draw(sample)
        font = ImageFont.load_default(size=48)
        draw.text((24, 32), 'PDF OCR 0123456789', fill='black', font=font)
        draw.text((24, 112), 'Warmup text ABC 123', fill='black', font=font)
        sample.save(stream, format='PNG')
        image = stream.getvalue()
        self.infer('layout', image, 'standard')
        self.infer('layout', image, 'high')
        if not self.infer('ocr', image, 'standard')['blocks']:
            raise RuntimeError('OCR warmup did not complete text recognition')

    def infer(self, operation, image, precision):
        with Image.open(io.BytesIO(image)) as decoded:
            rgb = decoded.convert('RGB')
            width, height = rgb.size
            # Paddle's numpy input convention is BGR.
            pixels = self.np.asarray(rgb)[:, :, ::-1].copy()
        if operation == 'layout':
            regions = []
            for result in self.layouts[precision].predict(pixels, batch_size=1):
                regions.extend(layout_regions(result, width, height))
            return {'regions': regions}
        blocks = []
        for result in self.ocr.predict(pixels):
            blocks.extend(ocr_blocks(result, width, height))
        return {'blocks': blocks}
