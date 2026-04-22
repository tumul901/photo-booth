from collections import OrderedDict
from threading import Lock


class WTMCache:
    def __init__(self, max_size: int = 200):
        self._cache: OrderedDict[str, str] = OrderedDict()
        self._max = max_size
        self._lock = Lock()

    def get(self, key: str) -> str | None:
        with self._lock:
            if key not in self._cache:
                return None
            self._cache.move_to_end(key)
            return self._cache[key]

    def put(self, key: str, value: str) -> None:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
            self._cache[key] = value
            if len(self._cache) > self._max:
                self._cache.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()


# Module-level singleton — import this everywhere
wtm_cache = WTMCache(max_size=200)
