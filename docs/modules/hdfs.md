# 模块:HDFS 磁盘监控(hdfs)

## 1. 职责

HDFS 集群容量/节点磁盘监控、目录占比、节点明细(默认折叠)、30s 自动刷新;磁盘检测功能已回滚移除(依赖集群 hdfs 客户端,服务机无客户端,不可行)。

## 2. 涉及文件

| 层 | 文件 | 说明 |
|---|---|---|
| 视图 | `src/views/hdfs/HdfsView.vue` | 主视图:总容量卡片(小尺寸,不干扰主功能)+ 节点表格 + 目录占比 |
| 视图 | `src/views/hdfs/HdfsDiskOverview.vue` | 磁盘总览(卡片/进度条/节点明细,30s 刷新,节点常折叠) |
| API | `src/api/hdfs.ts` | 容量/节点/目录统计 |
| 网关 | `server/routes/subapps-proxy.js`:`/apps/hdfs`、`/static`、`/webhdfs` 代理(WebHDFS REST 经 /webhdfs 透传) |

## 3. 数据流

```
HdfsView → GET /api/hdfs/df(容量总览)
        → GET /api/hdfs/nodes(datanode 明细, 默认折叠)
        → GET /api/hdfs/fs/... (目录/文件统计)
网关 → hdfsUrl(RM: hadoop-nn-1:9870 WebHDFS / jmx)
```

## 4. 核心机制

- 容量数据来自 WebHDFS `fs/df` + NameNode jmx(`Hadoop:service=NameNode,name=FSNamesystemState` 等)
- 30s 自动刷新(页面可见时),刷新后保持节点折叠状态
- 卡片紧凑化,不挤压 HDFS 主浏览功能

## 5. 已知限制与历史

- **磁盘检测(大/小文件扫描)已回滚移除**:原方案基于 `/fsimage.tsv` 解析,但服务机无 hdfs 客户端、fsimage 解析不现实,已删除相关代码(commit 记录在 git 历史)
- 目录/文件 Top 统计仅限 WebHDFS 可及范围,全集群扫描需集群侧能力

## 6. 配置

- `config.local.json`: `hdfsUrl`(WebHDFS 地址)
- 网关白名单转发,需能访问 NameNode 内网
