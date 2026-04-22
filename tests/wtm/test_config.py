import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / 'backend'))

import pytest
import json
from services import wtm_config
from fastapi import HTTPException
from PIL import Image

@pytest.fixture
def tmp_templates_dir(tmp_path):
    orig = wtm_config.WTM_TEMPLATES_DIR
    wtm_config.WTM_TEMPLATES_DIR = tmp_path
    wtm_config._configs.clear()
    
    yield tmp_path
    
    wtm_config.WTM_TEMPLATES_DIR = orig
    wtm_config._configs.clear()

def create_valid_template(tmp_dir: Path, template_id: str = "valid1"):
    t_dir = tmp_dir / template_id
    t_dir.mkdir(parents=True)
    
    # create base image (500x500 PNG)
    img = Image.new('RGBA', (500, 500), color=(255, 255, 255, 0))
    img.save(t_dir / "base.png")
    
    # create word svgs
    w_dir = t_dir / "words"
    w_dir.mkdir()
    (w_dir / "test.svg").touch()
    
    config = {
        "template_id": template_id,
        "name": "Test Template",
        "mode": "word_template",
        "base_image": "base.png",
        "dimensions": { "width": 500, "height": 500 },
        "slots": [
            { "id": "slot_0", "order": 0, "x": 0, "y": 0, "width": 100, "height": 100 }
        ],
        "words": [
            { "id": "test", "label": "Test", "svg_filename": "test.svg" }
        ],
        "bundles": []
    }
    
    write_config(t_dir, config)
    
    return t_dir, config

def write_config(t_dir: Path, config: dict):
    with open(t_dir / "config.json", "w") as f:
        json.dump(config, f)

def test_valid_config_loads(tmp_templates_dir):
    create_valid_template(tmp_templates_dir, "t1")
    wtm_config.load_all_configs()
    assert "t1" in wtm_config._configs

def test_slot_x_out_of_bounds(tmp_templates_dir):
    t_dir, cfg = create_valid_template(tmp_templates_dir, "t1")
    cfg["slots"][0]["x"] = 450
    cfg["slots"][0]["width"] = 100 # 450+100 > 500
    write_config(t_dir, cfg)
    wtm_config.load_all_configs()
    assert "t1" not in wtm_config._configs

def test_slot_y_out_of_bounds(tmp_templates_dir):
    t_dir, cfg = create_valid_template(tmp_templates_dir, "t1")
    cfg["slots"][0]["y"] = 450
    cfg["slots"][0]["height"] = 100 # 450+100 > 500
    write_config(t_dir, cfg)
    wtm_config.load_all_configs()
    assert "t1" not in wtm_config._configs

def test_duplicate_slot_order(tmp_templates_dir):
    t_dir, cfg = create_valid_template(tmp_templates_dir, "t1")
    cfg["slots"].append({"id": "slot_1", "order": 0, "x": 100, "y": 100, "width": 100, "height": 100})
    write_config(t_dir, cfg)
    wtm_config.load_all_configs()
    assert "t1" not in wtm_config._configs

def test_gap_in_slot_order(tmp_templates_dir):
    t_dir, cfg = create_valid_template(tmp_templates_dir, "t1")
    cfg["slots"].append({"id": "slot_1", "order": 2, "x": 100, "y": 100, "width": 100, "height": 100})
    write_config(t_dir, cfg)
    wtm_config.load_all_configs()
    assert "t1" not in wtm_config._configs

def test_zero_slots(tmp_templates_dir):
    t_dir, cfg = create_valid_template(tmp_templates_dir, "t1")
    cfg["slots"] = []
    write_config(t_dir, cfg)
    wtm_config.load_all_configs()
    assert "t1" not in wtm_config._configs

def test_seven_slots(tmp_templates_dir):
    t_dir, cfg = create_valid_template(tmp_templates_dir, "t1")
    cfg["slots"] = [{"id": f"s{i}", "order": i, "x": 0, "y":0, "width":50, "height":50} for i in range(7)]
    write_config(t_dir, cfg)
    wtm_config.load_all_configs()
    assert "t1" not in wtm_config._configs

def test_missing_base_image(tmp_templates_dir):
    t_dir, cfg = create_valid_template(tmp_templates_dir, "t1")
    (t_dir / "base.png").unlink()
    wtm_config.load_all_configs()
    assert "t1" not in wtm_config._configs

def test_missing_svg(tmp_templates_dir):
    t_dir, cfg = create_valid_template(tmp_templates_dir, "t1")
    (t_dir / "words" / "test.svg").unlink()
    wtm_config.load_all_configs()
    assert "t1" not in wtm_config._configs

def test_invalid_word_id(tmp_templates_dir):
    t_dir, cfg = create_valid_template(tmp_templates_dir, "t1")
    cfg["words"][0]["id"] = "Invalid_ID"
    write_config(t_dir, cfg)
    wtm_config.load_all_configs()
    assert "t1" not in wtm_config._configs

def test_slot_too_small(tmp_templates_dir):
    t_dir, cfg = create_valid_template(tmp_templates_dir, "t1")
    cfg["slots"][0]["width"] = 49
    write_config(t_dir, cfg)
    wtm_config.load_all_configs()
    assert "t1" not in wtm_config._configs

def test_bundle_unknown_word(tmp_templates_dir):
    t_dir, cfg = create_valid_template(tmp_templates_dir, "t1")
    cfg["bundles"] = [{"id": "b1", "label": "B1", "words": ["unknown"]}]
    write_config(t_dir, cfg)
    wtm_config.load_all_configs()
    assert "t1" not in wtm_config._configs

def test_dimension_mismatch(tmp_templates_dir):
    t_dir, cfg = create_valid_template(tmp_templates_dir, "t1")
    cfg["dimensions"]["width"] = 600
    write_config(t_dir, cfg)
    wtm_config.load_all_configs()
    assert "t1" not in wtm_config._configs

def test_reload_config(tmp_templates_dir):
    t_dir, cfg = create_valid_template(tmp_templates_dir, "t1")
    wtm_config.load_all_configs()
    assert wtm_config.get_config("t1")["name"] == "Test Template"
    
    cfg["name"] = "Updated Name"
    write_config(t_dir, cfg)
    wtm_config.reload_config("t1")
    assert wtm_config.get_config("t1")["name"] == "Updated Name"

def test_get_config_missing_raises_400():
    wtm_config._configs.clear()
    with pytest.raises(HTTPException) as exc:
        wtm_config.get_config("nonexistent")
    assert exc.value.status_code == 400

def test_load_survives_zero_valid_templates(tmp_templates_dir):
    # Setup one invalid template folder
    t_dir = tmp_templates_dir / "invalid1"
    t_dir.mkdir()
    with open(t_dir / "config.json", "w") as f:
        f.write("{invalid json")
        
    # Setup empty dict folder
    t_dir2 = tmp_templates_dir / "invalid2"
    t_dir2.mkdir()
    with open(t_dir2 / "config.json", "w") as f:
        f.write("{}")

    wtm_config.load_all_configs()  # Should not raise exception
    assert len(wtm_config._configs) == 0
