# Task 1 Report: Spark dual-mode documentation

## Result

Documented the Spark dual execution-mode contract across the architecture guide, db-query module guide, db-proxy README, and `datasources.json.example`.

- Defined `executionMode` values as `thrift` and `session`; omitted values preserve the `thrift` default.
- Clarified that `session` is the historical YARN client PySpark `SparkSession`, not the `spark-sql` shell.
- Documented mode routing for query, async jobs, status/cancel, logs and Stage status, schema metadata, and HDFS export, with a shared response shape and the same portal permission checks.
- Explicitly documented that failures do not retry through the other mode, and that the SQL workbench does not execute user PySpark code.
- Distinguished Thrift JDBC/Beeline configuration from the legacy Spark/YARN configuration (`master`, `queue`, executor settings, and `sparkConf`).
- Updated deployment requirements: restart db-proxy after configuration/service changes and rebuild the portal image to publish the workbench selector.
- Removed or revised old documentation statements that claimed SparkSession/PySpark support was absent.

## Checks

- `python3 -m json.tool services/db-proxy/datasources.json.example`: passed.
- `git diff --check`: passed.
- Reviewed the four-file diff for the mode default, endpoint routing, no-failover behavior, SQL-only boundary, config split, and deployment notes.

No production runtime validation or local portal frontend build was performed, as required.

## Files changed

- `docs/ARCHITECTURE.md`
- `docs/modules/db-query.md`
- `services/db-proxy/README.md`
- `services/db-proxy/datasources.json.example`

## Fix round: mode on GET and job-control requests

Addressed reviewer finding **[P2] Document mode selection on GET/control requests**.

- Updated `services/db-proxy/README.md` to specify JSON body placement for POST query/job/export requests, query-string placement for GET metadata/status/logs, and query-string placement for job status and cancellation.
- Added session polling and cancellation examples using the mode from the original job submission, and clarified that a later UI selection change must not change the route used to control that job.
- Updated file: `services/db-proxy/README.md`.
- Check command: `git diff --check`.
- Output: passed (no whitespace errors).
