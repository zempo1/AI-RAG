"""Paddle is imported only inside the isolated model process."""
import io
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps, ImageStat

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


def detection_box(polygon, width, height):
    return _box([min(p[0] for p in polygon), min(p[1] for p in polygon),
                 max(p[0] for p in polygon), max(p[1] for p in polygon)], width, height)


def text_only_candidate(rgb, boxes):
    """Prefer visual recognition when a raster has structure beyond prose lines."""
    if not 2 <= len(boxes) <= 400:
        return False
    rgb = ImageOps.contain(rgb, (768, 768)) if max(rgb.size) > 768 else rgb
    width, height = rgb.size
    previous = None
    for box in sorted(boxes, key=lambda b: (b[1] + b[3], b[0])):
        x0, y0, x1, y1 = box
        if (x1 - x0) * width < 1.25 * (y1 - y0) * height:
            return False
        if previous:
            px0, py0, px1, py1 = previous
            overlap = min(y1, py1) - max(y0, py0)
            gap = max(x0, px0) - min(x1, px1)
            # Separate cells sharing a baseline are a table/column signal.
            if overlap >= 0.55 * min(y1 - y0, py1 - py0) and gap * width >= (y1 - y0) * height:
                return False
        previous = box

    background = Image.new('RGB', rgb.size, tuple(ImageStat.Stat(rgb).median))
    red, green, blue = ImageChops.difference(rgb, background).split()
    foreground = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    foreground = foreground.point([0] * 42 + [255] * 214)
    ink = foreground.histogram()[255]
    if ink < 24 or ink > width * height * 0.35:
        return False

    # Continuous edges in either direction can be axes, grids or connectors,
    # including an edge accidentally enclosed in a detector polygon.
    for axis in (foreground, foreground.transpose(Image.Transpose.TRANSPOSE)):
        stride = axis.width
        pixels = axis.tobytes()
        stroke = b'\xff' * max(18, round(stride * 0.18))
        if any(stroke in pixels[offset:offset + stride] for offset in range(0, len(pixels), stride)):
            return False

    non_text = foreground.copy()
    draw = ImageDraw.Draw(non_text)
    for x0, y0, x1, y1 in boxes:
        draw.rectangle((x0 * width - 2, y0 * height - 2, x1 * width + 2, y1 * height + 2), fill=0)
    return non_text.histogram()[255] <= ink * 0.055


class PaddleBackend:
    def __init__(self, model_root):
        import importlib.metadata
        import numpy as np
        from paddleocr import LayoutDetection, TextDetection, TextRecognition
        from paddlex.inference.pipelines.components.common.crop_image_regions import CropByPolys
        from paddlex.inference.pipelines.components.common.sort_boxes import SortQuadBoxes

        for name, version in VERSIONS.items():
            if importlib.metadata.version(name) != version:
                raise RuntimeError('Installed Paddle package version differs from manifest')
        verify_manifest(model_root)
        root = Path(model_root)
        # Paddle 3.3.1 oneDNN PIR has an unsupported DoubleAttribute array
        # conversion on these layout weights. Use its CPU kernels consistently.
        common = {'device': 'cpu', 'cpu_threads': 4, 'enable_mkldnn': False}
        self.np = np
        layout, detector, recognizer = MODELS
        self.layout = LayoutDetection(model_name=layout, model_dir=str(root / layout), **common)
        # Preserve the pinned OCR pipeline's sizing and thresholds when using
        # its detector directly, especially for small type on full scans.
        self.detect = TextDetection(
            model_name=detector, model_dir=str(root / detector),
            limit_side_len=64, limit_type='min', thresh=0.3, box_thresh=0.6, unclip_ratio=1.5, **common,
        )
        self.recognize = TextRecognition(model_name=recognizer, model_dir=str(root / recognizer), **common)
        self.sort_boxes = SortQuadBoxes()
        self.crop = CropByPolys(det_box_type='quad')

    def warmup(self):
        stream = io.BytesIO()
        # Layout, text detection and recognition must run before ready.
        sample = Image.new('RGB', (720, 256), 'white')
        draw = ImageDraw.Draw(sample)
        font = ImageFont.load_default(size=48)
        draw.text((24, 32), 'PDF OCR 0123456789', fill='black', font=font)
        draw.text((24, 112), 'Warmup text ABC 123', fill='black', font=font)
        sample.save(stream, format='PNG')
        image = stream.getvalue()
        self.infer('layout', image)
        if not self.infer('ocr', image)['blocks']:
            raise RuntimeError('OCR warmup did not complete text recognition')

    def infer(self, operation, image):
        with Image.open(io.BytesIO(image)) as decoded:
            rgb = decoded.convert('RGB')
            width, height = rgb.size
            # Paddle's numpy input convention is BGR.
            pixels = self.np.asarray(rgb)[:, :, ::-1].copy()
        if operation == 'layout':
            regions = []
            for result in self.layout.predict(pixels, batch_size=1):
                regions.extend(layout_regions(result, width, height))
            return {'regions': regions}

        detections = []
        for result in self.detect.predict(pixels, batch_size=1):
            for polygon in self.sort_boxes(result.get('dt_polys', [])):
                box = detection_box(polygon, width, height)
                if box:
                    detections.append((box, polygon))
        response = {'detectedBoxes': [box for box, _ in detections]}
        if operation == 'classify':
            response['textOnly'] = text_only_candidate(rgb, response['detectedBoxes'])
            if not response['textOnly']:
                return {**response, 'blocks': []}

        # Reuse the detector polygons. Recognition batches are bounded even on
        # a dense scan and retain each line's original position for quality checks.
        blocks = []
        for start in range(0, len(detections), 6):
            batch = detections[start:start + 6]
            crops = self.crop(pixels, [polygon for _, polygon in batch])
            results = self.recognize.predict(crops, batch_size=6)
            for (box, _), result in zip(batch, results, strict=True):
                text = str(result.get('rec_text', '')).strip()
                if text:
                    blocks.append({'text': text, 'bbox': box, 'score': _score(result['rec_score'])})
        return {**response, 'blocks': blocks}
