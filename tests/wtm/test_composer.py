import sys
import asyncio
from pathlib import Path
import pytest
import json
import time
from unittest.mock import patch
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent.parent.parent / 'backend'))

from services import wtm_config
from services.wtm_cache import wtm_cache
from services.wtm_composer import compose_template, _compose_locks
from utils.wtm_utils import make_cache_key
from api.wtm_admin import delete_word

@pytest.fixture
def test_env(tmp_path):
    orig_templates_dir = wtm_config.WTM_TEMPLATES_DIR
    orig_cache_dir = wtm_config.WTM_CACHE_DIR

    wtm_config.WTM_TEMPLATES_DIR = tmp_path / "templates"
    wtm_config.WTM_TEMPLATES_DIR.mkdir()
    
    import services.wtm_composer as wtm_composer
    wtm_composer.WTM_TEMPLATES_DIR = wtm_config.WTM_TEMPLATES_DIR
    
    wtm_config.WTM_CACHE_DIR = tmp_path / "cache"
    wtm_config.WTM_CACHE_DIR.mkdir()
    wtm_composer.WTM_CACHE_DIR = wtm_config.WTM_CACHE_DIR

    wtm_config._configs.clear()
    wtm_cache.clear()
    _compose_locks.clear()

    yield tmp_path

    wtm_config.WTM_TEMPLATES_DIR = orig_templates_dir
    wtm_composer.WTM_TEMPLATES_DIR = orig_templates_dir
    wtm_config.WTM_CACHE_DIR = orig_cache_dir
    wtm_composer.WTM_CACHE_DIR = orig_cache_dir
    wtm_config._configs.clear()
    wtm_cache.clear()
    _compose_locks.clear()


def create_template(env_path: Path, template_id: str = "t1", num_slots: int = 6, words: list = None, bundles: list = None, dims=(500,500)):
    t_dir = wtm_config.WTM_TEMPLATES_DIR / template_id
    t_dir.mkdir(parents=True, exist_ok=True)
    
    img = Image.new('RGBA', dims, color=(255, 255, 255, 0))
    img.save(t_dir / "base.png")
    
    w_dir = t_dir / "words"
    w_dir.mkdir(exist_ok=True)
    
    if words is None:
        words = ["a", "b", "c", "d", "e", "f"]
        
    word_configs = []
    for w in words:
        svg_content = f'<svg width="100" height="100"><text x="0" y="50">{w}</text></svg>'
        with open(w_dir / f"{w}.svg", "w") as f:
            f.write(svg_content)
        word_configs.append({"id": w, "label": w.upper(), "svg_filename": f"{w}.svg"})
        
    slots = []
    for i in range(num_slots):
        slots.append({
            "id": f"slot_{i}",
            "order": i,
            "x": 0, "y": 0, "width": 50, "height": 50
        })
        
    config = {
        "template_id": template_id,
        "name": "Test Template",
        "mode": "word_template",
        "base_image": "base.png",
        "dimensions": { "width": dims[0], "height": dims[1] },
        "slots": slots,
        "words": word_configs,
        "bundles": bundles or [],
        "max_selections": 6
    }
    
    with open(t_dir / "config.json", "w") as f:
        json.dump(config, f)
        
    wtm_config.load_all_configs()
    return config

@pytest.mark.asyncio
async def test_compose_cache_miss(test_env):
    cfg = create_template(test_env)
    res = await compose_template(cfg, ["a", "b"])
    
    assert res.cache_hit is False
    assert Path(res.template_path).exists()
    assert res.compose_time_ms is not None

@pytest.mark.asyncio
async def test_compose_lru_hit(test_env):
    cfg = create_template(test_env)
    res1 = await compose_template(cfg, ["a", "b"])
    assert res1.cache_hit is False
    
    res2 = await compose_template(cfg, ["a", "b"])
    assert res2.cache_hit is True
    assert res1.template_path == res2.template_path

@pytest.mark.asyncio
async def test_compose_disk_hit_after_lru_clear(test_env):
    cfg = create_template(test_env)
    res1 = await compose_template(cfg, ["a", "b"])
    assert res1.cache_hit is False
    
    wtm_cache.clear()
    
    res2 = await compose_template(cfg, ["a", "b"])
    assert res2.cache_hit is True
    assert res1.template_path == res2.template_path

@pytest.mark.asyncio
async def test_sorted_determinism(test_env):
    cfg = create_template(test_env)
    res1 = await compose_template(cfg, ["c", "a", "b"])
    
    wtm_cache.clear()
    
    res2 = await compose_template(cfg, ["a", "b", "c"])
    assert res1.template_path == res2.template_path

@pytest.mark.asyncio
async def test_fewer_words_than_slots(test_env):
    cfg = create_template(test_env, num_slots=6)
    res = await compose_template(cfg, ["a", "b", "c"])
    assert res.cache_hit is False
    assert Path(res.template_path).exists()

@pytest.mark.asyncio
async def test_missing_svg_skips_slot(test_env):
    cfg = create_template(test_env)
    svg_path = wtm_config.WTM_TEMPLATES_DIR / cfg["template_id"] / "words" / "a.svg"
    svg_path.unlink()
    
    res = await compose_template(cfg, ["a", "b"])
    assert res.cache_hit is False
    assert Path(res.template_path).exists()

@pytest.mark.asyncio
async def test_timeout_raises(test_env):
    cfg = create_template(test_env)
    
    import services.wtm_composer as wtm_composer
    orig_sync_compose = wtm_composer._sync_compose
    
    def slow_compose(*args, **kwargs):
        time.sleep(6)
        return orig_sync_compose(*args, **kwargs)
        
    with patch('services.wtm_composer._sync_compose', side_effect=slow_compose):
        with pytest.raises(asyncio.TimeoutError):
            await compose_template(cfg, ["a"])

@pytest.mark.asyncio
async def test_concurrent_same_hash(test_env):
    cfg = create_template(test_env)
    
    import services.wtm_composer as wtm_composer
    orig_sync_compose = wtm_composer._sync_compose
    
    call_count = 0
    def tracking_compose(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        time.sleep(0.5)
        return orig_sync_compose(*args, **kwargs)
        
    with patch('services.wtm_composer._sync_compose', side_effect=tracking_compose):
        words = ["a", "b"]
        tasks = [compose_template(cfg, words) for _ in range(5)]
        results = await asyncio.gather(*tasks)
        
        assert call_count == 1
        
        hit_count = sum(1 for r in results if r.cache_hit)
        assert hit_count == 4
        
        paths = set(str(r.template_path) for r in results)
        assert len(paths) == 1

@pytest.mark.asyncio
async def test_dimension_mismatch_raises(test_env):
    cfg = create_template(test_env, dims=(400, 400)) # Img is 400x400
    cfg["dimensions"]["width"] = 500
    
    with pytest.raises(ValueError):
        await compose_template(cfg, ["a"])

@pytest.mark.asyncio
async def test_word_removed_from_bundles_on_delete(test_env):
    cfg = create_template(test_env, bundles=[
        {"id": "b1", "label": "B1", "words": ["a", "b", "c"]},
        {"id": "b2", "label": "B2", "words": ["c", "d"]}
    ])
    
    await delete_word(cfg["template_id"], "c")
    
    updated_cfg = wtm_config.get_config(cfg["template_id"])
    assert "c" not in [w["id"] for w in updated_cfg["words"]]
    assert updated_cfg["bundles"][0]["words"] == ["a", "b"]
    assert updated_cfg["bundles"][1]["words"] == ["d"]
