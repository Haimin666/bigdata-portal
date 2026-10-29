import os
import sys
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
from spark_engine import SparkJobManager
from spark_thrift_engine import SparkThriftEngine


class SerializedEngine:
    supports_job_cancellation = True

    def __init__(self):
        self.lock = threading.Lock()
        self.started = threading.Event()
        self.release = threading.Event()
        self.cancel_calls = 0
        self.cancelled = threading.Event()
        self.active_owner_id = None
        self.pending_cancelled_owners = set()

    def execute_sql(self, sql, write_unlocked=False, timeout_ms=600000, owner_id=None,
                    on_start=None):
        with self.lock:
            self.active_owner_id = owner_id
            try:
                if owner_id in self.pending_cancelled_owners:
                    self.pending_cancelled_owners.remove(owner_id)
                    raise RuntimeError("cancelled")
                if on_start:
                    on_start()
                if sql == "first":
                    self.started.set()
                    self.release.wait(2)
                    if self.cancelled.is_set():
                        raise RuntimeError("cancelled")
                return {"rows": []}
            finally:
                self.active_owner_id = None

    def cancel(self, owner_id):
        self.cancel_calls += 1
        if self.active_owner_id != owner_id:
            self.pending_cancelled_owners.add(owner_id)
            return True
        self.cancelled.set()
        self.release.set()
        return True

    def finish_job(self, owner_id):
        self.pending_cancelled_owners.discard(owner_id)


class SparkJobManagerCancellationTests(unittest.TestCase):
    def wait_for_state(self, manager, job_id, expected):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            job = manager.get(job_id)
            if job and job["state"] == expected:
                return job
            time.sleep(0.01)
        self.fail("job %s did not reach %s; last state=%r" % (job_id, expected, manager.get(job_id)))

    def wait_for_active_slot(self, manager, job_id):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if manager._active_job_id == job_id:
                return
            time.sleep(0.01)
        self.fail("job %s did not acquire the execution slot" % job_id)

    def test_cancelling_queued_job_does_not_cancel_active_job(self):
        engine = SerializedEngine()
        manager = SparkJobManager(engine)
        first_id = manager.submit("first")
        self.assertTrue(engine.started.wait(1))
        second_id = manager.submit("second")
        self.wait_for_state(manager, second_id, "queued")

        self.assertTrue(manager.cancel(second_id))
        self.assertEqual(engine.cancel_calls, 0)
        self.assertTrue(engine.started.is_set())
        self.assertFalse(engine.cancelled.is_set())
        self.assertEqual(manager.get(first_id)["state"], "running")
        self.assertEqual(manager.get(second_id)["state"], "cancelled")

        engine.release.set()
        self.wait_for_state(manager, first_id, "done")
        self.assertEqual(manager.get(second_id)["state"], "cancelled")

    def test_cancelling_active_job_sets_cancelled_status(self):
        engine = SerializedEngine()
        manager = SparkJobManager(engine)
        job_id = manager.submit("first")
        self.assertTrue(engine.started.wait(1))

        self.assertTrue(manager.cancel(job_id))
        self.wait_for_state(manager, job_id, "cancelled")
        self.assertEqual(engine.cancel_calls, 1)
        self.assertIsNotNone(manager.get(job_id)["finishedAt"])

    def test_default_mode_uses_thrift_and_records_mode(self):
        thrift, session = SerializedEngine(), SerializedEngine()
        manager = SparkJobManager({"thrift": thrift, "session": session})
        job_id = manager.submit("first")
        try:
            self.assertTrue(thrift.started.wait(1))
            self.assertFalse(session.started.is_set())
            self.assertEqual(manager.get(job_id)["executionMode"], "thrift")
        finally:
            thrift.release.set()
        self.wait_for_state(manager, job_id, "done")

    def test_session_job_cancellation_uses_original_adapter(self):
        thrift, session = SerializedEngine(), SerializedEngine()
        manager = SparkJobManager({"thrift": thrift, "session": session})
        job_id = manager.submit("first", execution_mode="session")
        try:
            self.assertTrue(session.started.wait(1))
            self.assertEqual(manager.get(job_id)["executionMode"], "session")
            self.assertTrue(manager.cancel(job_id))
            self.assertTrue(session.cancelled.is_set())
            self.assertFalse(thrift.cancelled.is_set())
            self.wait_for_state(manager, job_id, "cancelled")
        finally:
            session.release.set()

    def test_session_failure_is_reported_without_thrift_retry(self):
        class FailingSession(SerializedEngine):
            def execute_sql(self, *args, **kwargs):
                raise RuntimeError("session original failure")

        thrift = SerializedEngine()
        manager = SparkJobManager({"thrift": thrift, "session": FailingSession()})
        job_id = manager.submit("first", execution_mode="session")
        job = self.wait_for_state(manager, job_id, "failed")
        self.assertEqual(job["error"], "session original failure")
        self.assertEqual(job["executionMode"], "session")
        self.assertFalse(thrift.started.is_set())

    def test_invalid_mode_and_pyspark_are_rejected_before_submission(self):
        manager = SparkJobManager({"thrift": SerializedEngine(), "session": SerializedEngine()})
        with self.assertRaises(ValueError):
            manager.submit("SELECT 1", execution_mode="other")
        with self.assertRaises(ValueError):
            manager.submit("print(1)", kind="pyspark", execution_mode="session")

    def test_job_waiting_for_sync_query_lock_does_not_cancel_sync_process(self):
        class BlockingProcess:
            def __init__(self):
                self.stdout = tempfile.TemporaryFile(buffering=0)
                self.stderr = tempfile.TemporaryFile(buffering=0)
                self.pid = 712345
                self.returncode = None
                self.started = threading.Event()
                self.finished = threading.Event()
                self.terminated = False

            def wait(self, timeout=None):
                self.started.set()
                if not self.finished.wait(timeout):
                    raise subprocess.TimeoutExpired("beeline", timeout)
                return self.returncode

            def poll(self):
                return self.returncode

            def finish(self):
                self.returncode = 0
                self.finished.set()

            def terminate(self):
                self.terminated = True
                self.returncode = -15
                self.finished.set()

            def kill(self):
                self.terminated = True
                self.returncode = -9
                self.finished.set()

        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        engine = SparkThriftEngine({"enabled": True}, temp_dir.name)
        manager = SparkJobManager(engine)
        process = BlockingProcess()
        sync_errors = []

        with patch("spark_thrift_engine.subprocess.Popen", return_value=process) as popen:
            sync_thread = threading.Thread(
                target=lambda: self._run_query(engine, sync_errors), daemon=True)
            sync_thread.start()
            self.assertTrue(process.started.wait(1))
            job_id = manager.submit("SELECT 1")
            self.wait_for_state(manager, job_id, "queued")
            self.wait_for_active_slot(manager, job_id)

            self.assertTrue(manager.cancel(job_id))
            self.assertFalse(process.terminated)

            process.finish()
            sync_thread.join(2)
            self.assertFalse(sync_thread.is_alive())
            self.wait_for_state(manager, job_id, "cancelled")
            self.assertEqual(popen.call_count, 1)

        self.assertEqual(sync_errors, [])

    @staticmethod
    def _run_query(engine, errors):
        try:
            engine.execute_sql("SHOW TABLES", timeout_ms=0)
        except Exception as error:
            errors.append(str(error))


if __name__ == "__main__":
    unittest.main()
