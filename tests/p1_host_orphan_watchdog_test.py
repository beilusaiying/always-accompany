import asyncio
import os
import subprocess
import sys
import time
import unittest
from pathlib import Path


SERVICE_DIR = (
    Path(__file__).resolve().parents[1]
    / "src" / "yonban" / "core" / "functions" / "memory" / "p1" / "service"
)
sys.path.insert(0, str(SERVICE_DIR))

import p1_server as server  # noqa: E402


class HostOrphanWatchdogTest(unittest.TestCase):
    def test_host_pid_is_injected_on_both_spawn_paths(self):
        runtime_source = (
            Path(__file__).resolve().parents[1]
            / "src" / "yonban" / "core" / "functions" / "memory" / "p1" / "serviceRuntime.mjs"
        ).read_text(encoding="utf-8")
        self.assertGreaterEqual(runtime_source.count("P1_HOST_PID: String(globalThis.Deno.pid)"), 2)
        self.assertIn("P1_HOST_ORPHAN_GRACE_SEC', 120", runtime_source)

    def test_process_probe_is_non_destructive(self):
        self.assertTrue(server._host_process_alive(os.getpid()))
        self.assertFalse(server._host_process_alive(2_000_000_000))

    @unittest.skipUnless(os.name == "nt", "Windows retained-handle behavior")
    def test_exited_windows_process_is_not_alive_while_handle_is_retained(self):
        child = subprocess.Popen([sys.executable, "-c", "pass"])
        child.wait(timeout=10)
        self.assertFalse(server._host_process_alive(child.pid))

    def test_dead_host_stops_once_only_after_grace(self):
        original = {
            "sleep": server.asyncio.sleep,
            "alive": server._host_process_alive,
            "finish": server._finish_lifecycle_stop,
            "config": server.get_config,
            "pid": server._host_pid,
            "missing": server._host_missing_since,
            "grace": server._host_orphan_grace_sec,
            "stopping": server._lifecycle_stopping,
            "task": server._lifecycle_task,
        }
        stopped = []
        started = time.monotonic()
        grace = 0.01

        async def no_wait(_seconds):
            await original["sleep"](0.001)

        async def finish_once():
            stopped.append(time.monotonic() - started)

        try:
            server.asyncio.sleep = no_wait
            server._host_process_alive = lambda _pid: False
            server._finish_lifecycle_stop = finish_once
            server.get_config = lambda: {"idleShutdownSec": 0}
            server._host_pid = 424242
            server._host_missing_since = None
            server._host_orphan_grace_sec = grace
            server._lifecycle_stopping = False
            server._lifecycle_task = None

            asyncio.run(server._idle_shutdown_monitor())

            self.assertEqual(len(stopped), 1)
            self.assertGreaterEqual(stopped[0], grace)
            self.assertTrue(server._lifecycle_stopping)
            self.assertIsNotNone(server._host_missing_since)
        finally:
            server.asyncio.sleep = original["sleep"]
            server._host_process_alive = original["alive"]
            server._finish_lifecycle_stop = original["finish"]
            server.get_config = original["config"]
            server._host_pid = original["pid"]
            server._host_missing_since = original["missing"]
            server._host_orphan_grace_sec = original["grace"]
            server._lifecycle_stopping = original["stopping"]
            server._lifecycle_task = original["task"]

    def test_live_host_cancels_pending_orphan_deadline(self):
        original = {
            "sleep": server.asyncio.sleep,
            "alive": server._host_process_alive,
            "finish": server._finish_lifecycle_stop,
            "config": server.get_config,
            "pid": server._host_pid,
            "missing": server._host_missing_since,
            "stopping": server._lifecycle_stopping,
        }
        sleep_calls = 0
        stopped = []

        async def one_iteration(_seconds):
            nonlocal sleep_calls
            sleep_calls += 1
            if sleep_calls > 1:
                raise RuntimeError("stop test monitor")

        async def unexpected_stop():
            stopped.append(True)

        try:
            server.asyncio.sleep = one_iteration
            server._host_process_alive = lambda _pid: True
            server._finish_lifecycle_stop = unexpected_stop
            server.get_config = lambda: {"idleShutdownSec": 0}
            server._host_pid = os.getpid()
            server._host_missing_since = time.monotonic() - 1000
            server._lifecycle_stopping = False

            with self.assertRaisesRegex(RuntimeError, "stop test monitor"):
                asyncio.run(server._idle_shutdown_monitor())

            self.assertIsNone(server._host_missing_since)
            self.assertEqual(stopped, [])
        finally:
            server.asyncio.sleep = original["sleep"]
            server._host_process_alive = original["alive"]
            server._finish_lifecycle_stop = original["finish"]
            server.get_config = original["config"]
            server._host_pid = original["pid"]
            server._host_missing_since = original["missing"]
            server._lifecycle_stopping = original["stopping"]

    def test_existing_shutdown_wins_while_monitor_is_sleeping(self):
        original = {
            "sleep": server.asyncio.sleep,
            "finish": server._finish_lifecycle_stop,
            "stopping": server._lifecycle_stopping,
            "task": server._lifecycle_task,
        }
        cleanup_calls = []
        existing_task = object()

        async def shutdown_during_sleep(_seconds):
            server._lifecycle_stopping = True
            server._lifecycle_task = existing_task

        async def unexpected_cleanup():
            cleanup_calls.append(True)

        try:
            server.asyncio.sleep = shutdown_during_sleep
            server._finish_lifecycle_stop = unexpected_cleanup
            server._lifecycle_stopping = False
            server._lifecycle_task = None

            asyncio.run(server._idle_shutdown_monitor())

            self.assertEqual(cleanup_calls, [])
            self.assertIs(server._lifecycle_task, existing_task)
        finally:
            server.asyncio.sleep = original["sleep"]
            server._finish_lifecycle_stop = original["finish"]
            server._lifecycle_stopping = original["stopping"]
            server._lifecycle_task = original["task"]


if __name__ == "__main__":
    unittest.main()
