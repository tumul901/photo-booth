import json
import os
from datetime import datetime
from typing import Dict, Any, Optional

class StatsService:
    def __init__(self, data_dir: str = "data"):
        self.data_dir = data_dir
        self.stats_file = os.path.join(data_dir, "stats.json")
        self._ensure_data_dir()
        self._load_stats()

    def _ensure_data_dir(self):
        """Ensure data directory exists."""
        if not os.path.exists(self.data_dir):
            os.makedirs(self.data_dir)

    def _load_stats(self):
        """Load stats from JSON or initialize defaults."""
        if os.path.exists(self.stats_file):
            try:
                with open(self.stats_file, 'r') as f:
                    self.stats = json.load(f)
            except json.JSONDecodeError:
                self._init_defaults()
        else:
            self._init_defaults()

    def _init_defaults(self):
        """Initialize default stats structure."""
        self.stats = {
            "total_generated": 0,
            "by_mode": {"frame": 0, "sticker": 0},
            "by_template": {},
            "last_updated": None
        }
        self._save_stats()

    def _save_stats(self):
        """Save current stats to disk."""
        self.stats["last_updated"] = datetime.now().isoformat()
        with open(self.stats_file, 'w') as f:
            json.dump(self.stats, f, indent=2)

    def increment_generation(self, mode: str, template_id: str):
        """Increment generation counts."""
        self.stats["total_generated"] += 1
        
        # Mode stats
        if mode not in self.stats["by_mode"]:
            self.stats["by_mode"][mode] = 0
        self.stats["by_mode"][mode] += 1
        
        # Template stats
        if template_id not in self.stats["by_template"]:
            self.stats["by_template"][template_id] = 0
        self.stats["by_template"][template_id] += 1
        
        self._save_stats()

    def get_stats(self) -> Dict[str, Any]:
        """Return current stats."""
        # Reload to ensure freshness if multiple workers (simplified)
        self._load_stats()
        return self.stats

# Singleton instance
stats_service = StatsService(data_dir=os.path.join(os.path.dirname(os.path.dirname(__file__)), "data"))
