import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SERVICE_DIR = REPO_ROOT / "src" / "yonban" / "core" / "functions" / "memory" / "p1" / "service"
sys.path.insert(0, str(SERVICE_DIR))

import p1_server as server  # noqa: E402


class FirstBootResourceWarmupTest(unittest.TestCase):
    def test_progress_is_published_through_existing_warmup_snapshot(self):
        original = server._warmup_state
        try:
            server._warmup_state = {
                "state": "warming", "engine": "node", "progress": None,
            }
            server._set_warmup_progress("解压资源", 2, 5)
            self.assertEqual(server._warmup_state["progress"], {
                "stage": "解压资源", "completed": 2, "total": 5, "percent": 40,
            })
            server._warmup_state = {"state": "ready", "progress": {"percent": 100}}
            server._set_warmup_progress("不应覆盖", 0, 5)
            self.assertEqual(server._warmup_state["progress"], {"percent": 100})
        finally:
            server._warmup_state = original

    def test_resource_prepare_is_owned_by_warmup_not_process_boot(self):
        source = (SERVICE_DIR / "p1_server.py").read_text(encoding="utf-8")
        self.assertIn(
            "await asyncio.to_thread(_ensure_resources, _set_warmup_progress)",
            source,
        )
        main_block = source.split('if __name__ == "__main__":', 1)[1]
        self.assertNotIn("_ensure_resources()", main_block)
        self.assertIn("await asyncio.shield(task)", source)


if __name__ == "__main__":
    unittest.main()
