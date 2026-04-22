import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / 'backend'))

import pytest
import threading
from services.wtm_cache import WTMCache

def test_get_miss():
    cache = WTMCache(max_size=5)
    assert cache.get("none") is None

def test_put_and_get():
    cache = WTMCache(max_size=5)
    cache.put("k1", "v1")
    assert cache.get("k1") == "v1"

def test_lru_eviction():
    cache = WTMCache(max_size=3)
    cache.put("1", "a")
    cache.put("2", "b")
    cache.put("3", "c")
    cache.put("4", "d") # Should evict oldest which is "1"
    assert cache.get("1") is None
    assert cache.get("2") == "b"

def test_lru_get_promotes():
    cache = WTMCache(max_size=3)
    cache.put("1", "a")
    cache.put("2", "b")
    cache.put("3", "c")
    cache.get("1") # Promotes "1" to most recently used
    cache.put("4", "d") # Should evict "2"
    assert cache.get("2") is None
    assert cache.get("1") == "a"

def test_clear():
    cache = WTMCache(max_size=5)
    for i in range(5):
        cache.put(str(i), str(i))
    cache.clear()
    for i in range(5):
        assert cache.get(str(i)) is None

def test_thread_safety():
    cache = WTMCache(max_size=100)
    
    def worker(worker_id):
        for i in range(100):
            key = f"k_{worker_id}_{i}"
            cache.put(key, str(i))
            val = cache.get(key)
            assert val is not None
            
    threads = []
    for i in range(50):
        t = threading.Thread(target=worker, args=(i,))
        threads.append(t)
        t.start()
        
    for t in threads:
        t.join()
