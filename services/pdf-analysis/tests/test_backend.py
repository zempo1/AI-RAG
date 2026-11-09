import io
import json
from types import SimpleNamespace

import pytest
from PIL import Image, ImageDraw, ImageFont

from pdf_analysis.backend import PaddleBackend, detection_box, layout_regions, text_only_candidate


def test_layout_coordinates_labels_and_invalid_boxes():
    result = layout_regions({'boxes': [
        {'label': 'doc_title', 'coordinate': [10, 20, 90, 80], 'score': 0.91},
        {'label': 'figure_caption', 'coordinate': [-5, 0, 200, 100], 'score': 0.8},
        {'label': 'page_number', 'coordinate': [0, 0, 2, 2], 'score': 0.7},
        {'label': 'novel_label', 'coordinate': [0, 0, 10, 20], 'score': 0.6},
        {'label': 'footnote', 'coordinate': [0, 80, 50, 90], 'score': 0.8},
        {'label': 'formula_number', 'coordinate': [80, 50, 90, 60], 'score': 0.9},
        {'label': 'text', 'coordinate': [20, 20, 10, 10], 'score': 0.5},
    ]}, 100, 100)
    assert result == [{'kind': 'title', 'bbox': [0.1, 0.2, 0.9, 0.8], 'score': 0.91},
                      {'kind': 'caption', 'bbox': [0, 0, 1, 1], 'score': 0.8},
                      {'kind': 'decoration', 'bbox': [0, 0, 0.02, 0.02], 'score': 0.7},
                      {'kind': 'unknown', 'bbox': [0, 0, 0.1, 0.2], 'score': 0.6},
                      {'kind': 'text', 'bbox': [0, 0.8, 0.5, 0.9], 'score': 0.8},
                      {'kind': 'caption', 'bbox': [0.8, 0.5, 0.9, 0.6], 'score': 0.9}]


def test_ocr_polygon_becomes_normalized_axis_aligned_box():
    assert detection_box([[10, 5], [30, 5], [30, 15], [10, 15]], 100, 50) == [0.1, 0.1, 0.3, 0.3]


def test_raster_classification_preserves_flowchart_and_table_structure():
    sample = Image.new('RGB', (600, 240), 'white')
    font = ImageFont.load_default(size=30)
    draw = ImageDraw.Draw(sample)
    lines = [('Network connection state', (24, 28)), ('The text is readable', (24, 108))]
    boxes = []
    for text, origin in lines:
        draw.text(origin, text, font=font, fill='black')
        x0, y0, x1, y1 = draw.textbbox(origin, text, font=font)
        boxes.append([x0 / 600, y0 / 240, x1 / 600, y1 / 240])
    assert text_only_candidate(sample, boxes)

    # An unruled table has row-aligned but horizontally separated labels.
    assert not text_only_candidate(sample, [*boxes, [0.75, boxes[0][1], 0.96, boxes[0][3]]])
    # A grid or node connector still matters even with all labels detected.
    draw.line((190, 56, 190, 113), fill='black', width=2)
    draw.polygon([(184, 100), (196, 100), (190, 113)], fill='black')
    assert not text_only_candidate(sample, boxes)


def test_detector_polygons_are_reused_and_unrecognized_lines_keep_expected_boxes():
    class Pixels:
        def __getitem__(self, key):
            return self

        def copy(self):
            return self

    sample = Image.new('RGB', (600, 240), 'white')
    font = ImageFont.load_default(size=30)
    draw = ImageDraw.Draw(sample)
    polygons = []
    for text, origin in [('First line', (24, 28)), ('The next line', (24, 108))]:
        draw.text(origin, text, font=font, fill='black')
        x0, y0, x1, y1 = draw.textbbox(origin, text, font=font)
        polygons.append([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])

    backend = object.__new__(PaddleBackend)
    calls = []

    def detect(image, batch_size):
        calls.append('detect')
        return [{'dt_polys': polygons[::-1]}]

    def crop(image, boxes):
        assert boxes == polygons
        return boxes

    def recognize(crops, batch_size):
        calls.append('recognize')
        return [{'rec_text': 'First line', 'rec_score': 0.98}, {'rec_text': '', 'rec_score': 0.1}]

    def png_bytes():
        buffer = io.BytesIO()
        sample.save(buffer, format='PNG')
        return buffer.getvalue()

    backend.np = SimpleNamespace(asarray=lambda _: Pixels())
    backend.detect = SimpleNamespace(predict=detect)
    backend.sort_boxes = lambda boxes: sorted(boxes, key=lambda polygon: polygon[0][1])
    backend.crop = crop
    backend.recognize = SimpleNamespace(predict=recognize)
    result = backend.infer('classify', png_bytes())
    assert calls == ['detect', 'recognize']
    assert result['textOnly'] is True
    assert result['blocks'] == [{'text': 'First line', 'bbox': result['detectedBoxes'][0], 'score': 0.98}]
    assert len(result['detectedBoxes']) == 2

    calls.clear()
    draw.line((190, 56, 190, 113), fill='black', width=2)
    result = backend.infer('classify', png_bytes())
    assert calls == ['detect']
    assert result['textOnly'] is False
    assert result['blocks'] == []


def test_numeric_region_in_page_body_is_content_not_a_page_counter():
    result = layout_regions({'boxes': [
        {'label': 'number', 'coordinate': [25, 40, 75, 60], 'score': 0.95},
    ]}, 100, 100)
    assert result[0]['kind'] == 'text'


def test_service_algorithm_version_invalidates_model_result_fingerprint(tmp_path, monkeypatch):
    from pdf_analysis import manifest
    for name in manifest.MODELS:
        directory = tmp_path / name
        directory.mkdir()
        (directory / 'inference.json').write_text('{}')
        (directory / 'inference.pdiparams').write_bytes(b'weights')
    first, _ = manifest.seal_manifest(tmp_path)
    monkeypatch.setattr(manifest, 'PIPELINE_VERSION', 'future-algorithm', raising=False)
    second, _ = manifest.verify_manifest(tmp_path)
    assert first != second


def test_existing_seal_keeps_active_model_hashes_and_excludes_retired_layout(tmp_path):
    from pdf_analysis import manifest
    for name in manifest.MODELS:
        directory = tmp_path / name
        directory.mkdir()
        (directory / 'inference.json').write_text('{}')
        (directory / 'inference.pdiparams').write_bytes(b'weights')
    initial, active = manifest.seal_manifest(tmp_path)
    path = tmp_path / manifest.MANIFEST_FILE
    legacy = {**active, 'models': [active['models'][0], 'PP-DocLayout_plus-L', *active['models'][1:]],
              'files': {**active['files'], 'PP-DocLayout_plus-L/inference.json': 'discarded'}}
    path.write_text(json.dumps(legacy), encoding='utf8')
    assert manifest.verify_manifest(tmp_path) == (initial, active)
    assert json.loads(path.read_text(encoding='utf8')) == legacy
    (tmp_path / manifest.MODELS[0] / 'inference.json').write_text('changed')
    with pytest.raises(ValueError, match='integrity'):
        manifest.verify_manifest(tmp_path)


def test_paddle_number_is_a_page_number_decoration():
    result = layout_regions({'boxes': [
        {'label': 'number', 'coordinate': [94, 94, 96, 97], 'score': 0.87},
    ]}, 100, 100)
    assert result == [{'kind': 'decoration', 'bbox': [0.94, 0.94, 0.96, 0.97], 'score': 0.87}]


def test_warmup_refuses_readiness_when_recognition_did_not_execute():
    backend = object.__new__(PaddleBackend)
    # Model boundary is replaced because native Paddle requires downloaded weights.
    backend.infer = lambda operation, image: {'regions': []} if operation == 'layout' else {'blocks': []}
    with pytest.raises(RuntimeError, match='recognition'):
        backend.warmup()
