import os
import sys
import tempfile
import threading
import types
import unittest
from decimal import Decimal
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(__file__))
try:
    from spark_session_engine import SparkSessionEngine
except ModuleNotFoundError:
    SparkSessionEngine = None


class SparkSessionEngineTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(SparkSessionEngine, 'SparkSession SQL adapter is missing')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def engine(self, **cfg):
        return SparkSessionEngine({'enabled': True, 'keepaliveInterval': 0, **cfg}, self.temp.name)

    def attach(self, engine, rows=None):
        spark = MagicMock()
        spark.sparkContext._jsc.sc().isStopped.return_value = False
        spark.sparkContext.applicationId = 'application_42'
        tracker = spark.sparkContext.statusTracker.return_value
        tracker.getActiveJobIds.return_value = []
        tracker.getJobIdsForGroup.return_value = []
        df = spark.sql.return_value
        df.columns = ['value']
        df.limit.return_value.collect.return_value = rows or []
        df.toLocalIterator.return_value = iter(rows or [])
        engine._engine._spark = spark
        return spark, df

    def test_lazy_yarn_configuration_and_sql_only_interface(self):
        engine = self.engine(master='yarn', queue='analytics', executorInstances=3,
                             executorMemory='4g', sparkConf={'spark.sql.shuffle.partitions': 8})
        self.assertIsNone(engine._engine._spark)
        self.assertFalse(hasattr(engine, 'execute_code'))
        conf = MagicMock()
        session = MagicMock()
        session.sparkContext._jsc.sc().isStopped.return_value = False
        session.sparkContext.statusTracker().getJobIdsForGroup.return_value = []
        builder = MagicMock()
        builder.config().enableHiveSupport().getOrCreate.return_value = session
        modules = {'pyspark': types.SimpleNamespace(SparkConf=lambda: conf),
                   'pyspark.sql': types.SimpleNamespace(SparkSession=types.SimpleNamespace(builder=builder))}
        conf.setAppName.return_value = conf
        with patch.dict(sys.modules, modules):
            engine.execute_sql('SELECT 1', timeout_ms=0)
        conf.setMaster.assert_called_once_with('yarn')
        for pair in [('spark.yarn.queue', 'analytics'), ('spark.executor.instances', '3'),
                     ('spark.executor.memory', '4g'), ('spark.sql.shuffle.partitions', '8')]:
            self.assertIn(unittest.mock.call(*pair), conf.set.call_args_list)
        self.assertEqual(engine.status()['appId'], session.sparkContext.applicationId)

    def test_preserves_comments_literals_and_bounds_results(self):
        engine = self.engine(defaultLimit=2)
        spark, df = self.attach(engine, [(Decimal('1.2'),), ('--literal',), (3,)])
        sql = "/* lead; */ SELECT /*+ REPARTITION(1) */ '--literal' -- tail"
        result = engine.execute_sql(sql, timeout_ms=0)
        self.assertEqual(spark.sql.call_args.args[0],
                         "/* lead; */ SELECT /*+ REPARTITION(1) */ '--literal' LIMIT 2 -- tail")
        df.limit.assert_called_once_with(3)
        self.assertEqual(result['rows'], [{'value': 1.2}, {'value': '--literal'}])
        self.assertTrue(result['truncated'])
        self.assertEqual(set(result), {'columns', 'rows', 'costMs', 'truncated'})

    def test_explicit_limit_and_command_results_are_bounded(self):
        engine = self.engine(defaultLimit=2, maxLimit=4)
        spark, df = self.attach(engine, [(1,), (2,), (3,), (4,), (5,)])
        result = engine.execute_sql('SELECT * FROM t LIMIT 99;', timeout_ms=0)
        self.assertEqual(spark.sql.call_args.args[0], 'SELECT * FROM t LIMIT 4')
        self.assertTrue(result['truncated'])
        df.limit.reset_mock()
        df.toLocalIterator.return_value = iter([(1,), (2,), (3,), (4,)])
        result = engine.execute_sql('SHOW TABLES -- keep', timeout_ms=0)
        df.limit.assert_not_called()
        self.assertEqual(result['rows'], [{'value': 1}, {'value': 2}])
        self.assertTrue(result['truncated'])

    def test_rejects_empty_multiple_and_oversized_statements_before_initializing(self):
        engine = self.engine(maxSqlLen=30)
        for sql in ['-- comment only', '; -- comment only', 'SELECT 1; SELECT 2', 'SELECT ' + 'x' * 40]:
            with self.subTest(sql=sql), self.assertRaises(ValueError):
                engine.execute_sql(sql)
        self.assertIsNone(engine._engine._spark)

    def test_error_is_reported_once_and_releases_query_state(self):
        engine = self.engine()
        spark, _ = self.attach(engine)
        spark.sql.side_effect = RuntimeError('SparkFileNotFoundException: original diagnostic')
        with self.assertRaisesRegex(RuntimeError, 'original diagnostic'):
            engine.execute_sql('INSERT INTO t SELECT * FROM s', timeout_ms=0)
        self.assertEqual(spark.sql.call_count, 1)
        self.assertFalse(engine.cancel())
        spark.sql.side_effect = None
        engine.execute_sql('SELECT 1', timeout_ms=0)

    def test_initialization_failure_updates_status_and_allows_next_query(self):
        engine = self.engine()
        with patch.object(engine._engine, '_build_session', side_effect=RuntimeError('YARN denied')):
            with self.assertRaisesRegex(RuntimeError, 'YARN denied'):
                engine.execute_sql('SELECT 1', timeout_ms=0)
        self.assertEqual(engine.status()['state'], 'error')
        self.assertIn('YARN denied', engine.read_logs()['content'])
        self.assertFalse(engine.cancel())

    def test_owner_cancellation_during_initialization_prevents_sql(self):
        engine = self.engine()
        spark, _ = self.attach(engine)
        engine._engine._spark = None
        started, release = threading.Event(), threading.Event()
        def build():
            started.set()
            self.assertTrue(release.wait(2))
            return spark
        errors = []
        def run():
            try:
                engine.execute_sql('INSERT INTO t SELECT 1', timeout_ms=0, owner_id='job1')
            except Exception as exc:
                errors.append(str(exc))
        with patch.object(engine._engine, '_build_session', side_effect=build):
            worker = threading.Thread(target=run)
            worker.start()
            self.assertTrue(started.wait(2))
            self.assertTrue(engine.cancel('other'))
            spark.sparkContext.cancelJobGroup.assert_not_called()
            self.assertTrue(engine.cancel('job1'))
            release.set()
            worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertIn('停止', errors[0])
        spark.sql.assert_not_called()
        engine.finish_job('job1')

    def test_cancel_active_query_and_preserve_stage_and_incremental_logs(self):
        engine = self.engine()
        spark, df = self.attach(engine)
        def collect():
            self.assertTrue(engine.cancel('job1'))
            return [(1,)]
        df.limit.return_value.collect.side_effect = collect
        with self.assertRaisesRegex(RuntimeError, '停止'):
            engine.execute_sql('SELECT 1', timeout_ms=0, owner_id='job1')
        spark.sparkContext.cancelJobGroup.assert_called_once()
        logs = engine.read_logs()
        self.assertIn('SELECT 1', logs['content'])
        self.assertEqual(engine.read_logs(logs['offsets'])['content'], '')
        self.assertEqual(engine.stages_status()['numActiveStages'], 0)
        self.assertFalse(engine.cancel())

    def test_hdfs_export_preserves_sql_and_publishes_staging_without_collect(self):
        engine = self.engine(exportPath='hdfs:///exports')
        spark, df = self.attach(engine)
        path = spark._jvm.org.apache.hadoop.fs.Path
        fs = path.return_value.getFileSystem.return_value
        fs.exists.return_value = False
        fs.rename.return_value = True
        result = engine.export_sql("/* keep */ SELECT '--x' -- end\n;", 'job1', timeout_ms=0)
        self.assertEqual(spark.sql.call_args.args[0], "/* keep */ SELECT '--x' -- end\n")
        self.assertTrue(result['hdfsPath'].startswith('hdfs:///exports/spark_export_job1_'))
        df.write.mode.assert_called_once_with('errorifexists')
        fs.rename.assert_called_once()
        df.collect.assert_not_called()
        df.limit.assert_not_called()

    def test_export_failure_cleans_staging_and_invalid_export_does_not_execute(self):
        engine = self.engine()
        spark, df = self.attach(engine)
        fs = spark._jvm.org.apache.hadoop.fs.Path.return_value.getFileSystem.return_value
        fs.exists.side_effect = [False, False, True]
        df.write.mode().option().option().csv.side_effect = RuntimeError('disk full')
        with self.assertRaisesRegex(RuntimeError, 'disk full'):
            engine.export_sql('SELECT 1', 'job1', timeout_ms=0)
        fs.delete.assert_called_once()
        spark.sql.reset_mock()
        for sql in ['INSERT INTO t SELECT 1', 'SELECT 1; DROP TABLE t',
                    'WITH s AS (SELECT 1) INSERT INTO t SELECT * FROM s']:
            with self.assertRaises(ValueError):
                engine.export_sql(sql, 'job2')
        spark.sql.assert_not_called()

    def test_pre_execution_owner_cancel_does_not_cancel_another_job(self):
        engine = self.engine()
        spark, _ = self.attach(engine)
        self.assertTrue(engine.cancel('queued'))
        engine.execute_sql('SELECT 1', timeout_ms=0, owner_id='other')
        spark.sql.reset_mock()
        with self.assertRaisesRegex(RuntimeError, '停止'):
            engine.execute_sql('INSERT INTO t SELECT 1', timeout_ms=0, owner_id='queued')
        spark.sql.assert_not_called()
        engine.finish_job('queued')
        engine.execute_sql('SELECT 2', timeout_ms=0, owner_id='queued')

    def test_stage_snapshot_is_available_after_query_completion(self):
        engine = self.engine()
        spark, _ = self.attach(engine)
        tracker = spark.sparkContext.statusTracker.return_value
        tracker.getJobIdsForGroup.return_value = [4]
        tracker.getJobInfo.return_value = types.SimpleNamespace(status='SUCCEEDED', stageIds=[7])
        tracker.getStageInfo.return_value = types.SimpleNamespace(
            name='scan', numTasks=2, numCompletedTasks=2, numFailedTasks=0, numActiveTasks=0)
        engine.execute_sql('SELECT 1', timeout_ms=0)
        stages = engine.stages_status()
        self.assertEqual(stages['stages'][0]['status'], 'SUCCEEDED')
        self.assertEqual(stages['stages'][0]['completedTasks'], 2)
        spark.sparkContext._jsc.sc().isStopped.return_value = True
        self.assertEqual(engine.stages_status(), stages)

    def test_timeout_cancels_running_query_and_timer_is_stopped(self):
        engine = self.engine()
        spark, df = self.attach(engine)
        timer = MagicMock()
        def make_timer(interval, callback):
            self.assertEqual(interval, 0.01)
            def collect():
                callback()
                return []
            df.limit.return_value.collect.side_effect = collect
            return timer
        with patch('spark_session_engine.threading.Timer', side_effect=make_timer):
            with self.assertRaisesRegex(RuntimeError, '停止'):
                engine.execute_sql('SELECT 1', timeout_ms=10)
        spark.sparkContext.cancelJobGroup.assert_called_once()
        timer.cancel.assert_called_once()


    def test_export_cancellation_cleans_staging_and_does_not_publish(self):
        engine = self.engine()
        spark, df = self.attach(engine)
        fs = spark._jvm.org.apache.hadoop.fs.Path.return_value.getFileSystem.return_value
        fs.exists.side_effect = [False, False, True]
        def write_csv(path):
            engine.cancel('export1')
        df.write.mode().option().option().csv.side_effect = write_csv
        with self.assertRaisesRegex(RuntimeError, '停止'):
            engine.export_sql('SELECT 1', 'export1', timeout_ms=0, owner_id='export1')
        fs.delete.assert_called_once()
        fs.rename.assert_not_called()
        self.assertFalse(engine.cancel())

    def test_disabled_engine_and_invalid_hdfs_uri_do_not_start_session(self):
        engine = self.engine(enabled=False)
        with self.assertRaisesRegex(RuntimeError, 'not enabled'):
            engine.execute_sql('SELECT 1')
        for path in ['file:///tmp/exports', 'hdfs:///exports/../outside',
                     'hdfs:///exports?query=1']:
            engine = self.engine(exportPath=path)
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'HDFS URI'):
                engine.export_sql('SELECT 1', 'job1')
        self.assertIsNone(engine._engine._spark)

    def test_executor_configuration_and_metadata_use_session_adapter(self):
        engine = self.engine(executorInstances=2)
        spark, _ = self.attach(engine)
        engine.execute_schema_sql('SHOW DATABASES', timeout_ms=0)
        spark.sql.assert_called_once_with('SHOW DATABASES')
        engine.set_executors(4)
        self.assertEqual(engine.status()['config']['executorInstances'], 4)
        spark.stop.assert_called_once()
        self.assertIsNone(engine._engine._spark)



if __name__ == '__main__':
    unittest.main()
