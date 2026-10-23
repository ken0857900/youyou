# RAG 实际验收记录（2026-10-17）

**真实数据库 + 硅基流动 Embedding + 中文全文 + 混合召回 + Reranker 已通过。** 测试文章全部为虚构开发数据，不代表真实投稿或正式检索效果评估。

## 数据库与数据隔离

- 项目容器 `pathfinder-db-1` 已启动，PostgreSQL 17，端口 5432。
- pgvector 0.8.7、zhparser 2.4 均真实可用。分词结果包含「双非、计算机、保研、失败、考研」。
- 检查原始库发现 **public.articles 表不存在**，因此没有业务文章；没有运行会清库的 backend/schema.sql。
- 已建立并保留独立测试 schema：`ragtest_1b64c3949cfa4711923bb55e5797d451`。
- 该 schema 中实际有 **30 篇假文章、31 个决策点、31 条索引向量**。public 业务表未被创建、覆盖或清空。
- 每次完整 smoke 采用新的随机 schema；默认清理，传 `--keep-data` 时只保留成功测试的数据区域。

## 实际问题与结果

通过公开 `from RAG import search` 接口执行：

> 双非计算机保研失败转考研

本次自动过滤为学校层级=双非、专业=计算机、决策类型=保研 OR 考研；不把描述中的「失败」误设为结果过滤。处境解析本次使用规则；向量与重排均使用真实 API，SQL 检索为真实 PostgreSQL 执行。

| 排名 | article_id | decision_point_id | 实际命中原文 | Reranker 分数 |
|---|---|---|---|---|
| 1 | ragdev_a13 | 14 | 保研失败后，我重新安排复习计划，考研进入了理想学校。 | 0.997225 |
| 2 | ragdev_a13 | 13 | 我的本科是双非，大三保研名额落空，当时非常失落。 | 0.993964 |
| 3 | ragdev_a01 | 1 | 家庭希望早点工作，但我坚持用一年备考，最终考上北大软微。 | 0.973935 |

同一篇文章的两次不同决定分别命中，因此共 3 个决策点、2 篇文章；向前端跳转应使用 article_id，推理与引用关联使用 decision_point_id。分数不是概率。

检索总耗时 **517 ms**；处境解析 1 ms、向量＋全文召回 288 ms、重排 228 ms。两路各召回 3 条，融合去重后 3 条。此次搜索调用真实模型 API 2 次。

## 全链路及增量测试

- 30 篇文章共 31 块真实向量成功写入 pgvector，索引阶段约 8.6 秒。
- 重复索引不变文章：0 次新增模型请求，约 26 ms。
- 同时修改测试文章正文和其中一个决策点成绩后：只对变化块调用一次 Embedding，保留该文章 2 个块，约 283 ms。
- 全部 smoke 阶段约 9.5 秒，包含初次全量建索引，共 33 次真实 HTTP 模型调用。
- PostgreSQL 事务回滚、错误写入恢复、过期快照拒绝、级联删除、中文与向量 SQL、真实 API 的完整 pytest：**46 passed，0 skipped，0 failed**。
- 集成测试首次暴露测试夹具使用了不存在的 to_regconfig()，已改为 PostgreSQL 支持的 regconfig 类型转换；修复后全部通过。
- 原始脱敏报告：[live.json](reports/live.json)；公开接口实际搜索结果：[example_search.json](reports/example_search.json)。报告文件只保留本地，Git 忽略 reports/。

## 重复演示

数据库原始构建受到 Debian 慢源和 PostgreSQL HTTP 下载失败影响。已新增 RAG 内的可选本地构建覆盖配置：Debian 使用清华镜像并保留包签名验证；先安装 CA，再通过 HTTPS 下载 PostgreSQL 开发包。扩展代码仍来自原上游，原 docker-compose.yml／docker/postgres／业务代码均未改动。

从仓库根目录启动相同服务及原有数据卷：

```bash
/Applications/Docker.app/Contents/Resources/bin/docker compose -f docker-compose.yml -f RAG/docker-compose.dev.yml up -d
```

直接搜索已保留的数据：

```bash
PGOPTIONS='-c search_path=ragtest_1b64c3949cfa4711923bb55e5797d451,public' /Users/XXH/miniconda3/envs/internenv/bin/python -m RAG search '双非计算机保研失败转考研'
```

重新建立另一套独立样本并验收（少量 API 费用）：

```bash
/Users/XXH/miniconda3/envs/internenv/bin/python -m RAG.smoke --all-articles --keep-data --output RAG/reports/live.json
```

## 仍需业务接入／效果验收

- 后端在发布／更新事务中调用 index()，在搜索路由调用 search()；人物分群、判断／审查 agent、SSE 和缓存失效由 Ken 接入。
- 前端保留后端名次，筛选变更重新请求；引用使用对应决策点与文章 ID。
- 当前检索没有启用未经校准的相关性门槛。30 题完整效果评估、门槛校准、真实文章质量验收尚未执行；本次通过的是功能与数据库链路验收。
- 密钥仅从被 Git 忽略的根目录 .env 读取，未输出密钥或数据库密码，未提交 .env。
