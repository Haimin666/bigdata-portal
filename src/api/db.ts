// db-query 模块 API 门面:保持 `@/api/db` 导入路径与既有导出 100% 兼容。
// 实现按域拆分(2026-08,见 docs/DEVELOPMENT.md §3.1):
//   ./db/core          公共 request 封装 + getEnabledModules + 共享类型
//   ./db/mysql-oracle  MySQL/Oracle 查询 + 异步任务
//   ./db/spark         Spark 同步/异步/日志/进度/状态/解锁
//   ./db/flink         Flink 交互/异步/连接器/PreJob
//   ./db/meta          我的目录脚本 / 表目录 / Schema / EXPLAIN / 数据权限矩阵
// 新增函数请落到对应域文件;本文件只做 re-export,不再堆实现。

export * from './db/core'
export type { DbDataSource, DbQueryResult } from './db/core'
export { request } from './db/core'
export {
  queryDb,
  submitDbJob,
  getDbJob,
  cancelDbJob,
} from './db/mysql-oracle'
export type { SparkJobInfo } from './db/mysql-oracle'
export {
  querySpark,
  cancelSpark,
  submitSparkJob,
  getSparkJob,
  cancelSparkJob,
  sparkLogs,
  sparkStages,
  sparkStatus,
  setSparkExecutors,
  sparkAuth,
} from './db/spark'
export type { SparkStage, SparkStagesData } from './db/spark'
export {
  queryFlink,
  flinkConnectors,
  flinkProbeSchema,
  flinkGenerateDdl,
  flinkJobs,
  flinkJobStatus,
  flinkJobStop,
  flinkAsyncSubmit,
  flinkAsyncStatus,
  flinkAsyncCancel,
  flinkStatus,
  flinkPrejobSubmit,
  flinkPrejobJobs,
  flinkPrejobStatus,
  flinkPrejobLogs,
  flinkPrejobCancel,
  flinkPrejobDisable,
  flinkPrejobEnable,
  flinkPrejobUpdate,
  flinkPrejobConfig,
  cancelFlink,
} from './db/flink'
export type {
  FlinkConnector,
  FlinkField,
  FlinkJob,
  FlinkAsyncJob,
  FlinkPreJob,
  FlinkPreJobResources,
} from './db/flink'
export {
  listScriptTree,
  createScriptNode,
  renameScriptNode,
  deleteScriptNode,
  moveScriptNode,
  saveScriptContent,
  getScriptContent,
  listDataSources,
  listTables,
  listFields,
  getTableDDL,
  getSchema,
  explainSql,
  getDbPerms,
  saveDbPerms,
} from './db/meta'
export type {
  ScriptNode,
  ScriptTree,
  TableField,
  TableMeta,
  TableFieldDetail,
  TableDDL,
  DbSchemaTable,
  DbSchema,
  ExplainNode,
  ExplainResult,
  DbEngRule,
  DbUserRule,
  DbRoleRule,
  DbPerms,
} from './db/meta'
