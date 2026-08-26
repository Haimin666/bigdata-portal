// 数据库查询域路由挂载器:按引擎域拆分为四个子模块
//  - mysql-oracle.js:/api/db/*(透传+矩阵+jobs/explain)+ /api/dbquery/query + /api/db-perms
//  - spark.js:/api/spark/*(auth 解锁/查询/异步任务/日志/状态/进度)
//  - flink.js:/api/flink/*(交互/异步/流式任务/连接器/DDL/PreJob)
//  - shared.js:SQL 写检测/表名提取/X-Spark-Token(被上面三个模块单向引用)
import { setupMysqlOracleRoutes } from './mysql-oracle.js'
import { setupSparkRoutes } from './spark.js'
import { setupFlinkRoutes } from './flink.js'

export function setupDbRoutes(app, auth) {
  setupMysqlOracleRoutes(app, auth)
  setupSparkRoutes(app)
  setupFlinkRoutes(app)
}
