import pytest

from pdf_analysis.backend import PaddleBackend, layout_regions, ocr_blocks


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
    result = ocr_blocks({'rec_texts': ['中文'], 'rec_scores': [0.92],
                         'rec_polys': [[[10, 5], [30, 5], [30, 15], [10, 15]]]}, 100, 50)
    assert result == [{'text': '中文', 'score': 0.92, 'bbox': [0.1, 0.1, 0.3, 0.3]}]


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


def test_paddle_number_is_a_page_number_decoration():
    result = layout_regions({'boxes': [
        {'label': 'number', 'coordinate': [94, 94, 96, 97], 'score': 0.87},
    ]}, 100, 100)
    assert result == [{'kind': 'decoration', 'bbox': [0.94, 0.94, 0.96, 0.97], 'score': 0.87}]


def test_warmup_refuses_readiness_when_recognition_did_not_execute():
    backend = object.__new__(PaddleBackend)
    # Model boundary is replaced because native Paddle requires downloaded weights.
    backend.infer = lambda operation, image, precision: {'regions': []} if operation == 'layout' else {'blocks': []}
    with pytest.raises(RuntimeError, match='recognition'):
        backend.warmup()
