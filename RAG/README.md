# PathFinder RAG

独立检索模块，只修改 `RAG/`。提供处境抽取、按决策点混合检索、重排、增量入库和引用核验。人物分群、统计展示、推荐说明、判断／审查 agent 和 SSE 由 Ken 接入。本模块不新增 HTTP 服务。

## 当前验收状态

2026-10-17 已在本机实际跑通 PostgreSQL＋硅基流动全链路，完整测试 46 项通过、无跳过；实际数据与复现命令见 [ACCEPTANCE.md](ACCEPTANCE.md)。开发语料为 **30 篇纯虚构文章、31 个决策点**，测试集为 **30 题，其中 7 题为对抗／边界题**。这些数据不能冒充真实投稿或用于声称正式检索效果。尚未运行完整 30 题效果评估或校准相关性门槛；功能验收通过不等于真实文章效果评估通过。

## 环境和启动

从仓库根目录执行。项目只使用已有 Conda 环境，不创建新环境：

```bash
/Users/XXH/miniconda3/envs/internenv/bin/python -m pip install -r RAG/requirements.txt
/Users/XXH/miniconda3/envs/internenv/bin/python -m pytest RAG/tests -q
```

将 `RAG/.env.example` 中的配置填入**仓库根目录 `.env`**。支持项目现有的 `DATABASE_URL`、`SILICONFLOW_*`、`EMBEDDING_MODEL`、`RERANK_MODEL`、`LLM_*`。不打印密钥；导入模块不会连接服务。单次 HTTP 请求默认 12 秒，最多 3 次尝试；聊天 JSON 校验最多重问一次。超时是每次请求的上限，不是整条搜索的总时限。

数据库须先具备现有应用表、`vector` 扩展和 zhparser 的 `chinese` 配置。新开发库按项目环境文档准备，**不要为了 RAG 在已有库重跑 `backend/schema.sql`，它会清空应用数据**。然后：

```bash
/Users/XXH/miniconda3/envs/internenv/bin/python -m RAG migrate
```

`schema.sql` 只添加 `chunks` 和索引，绝不删除应用表。已有不兼容 chunks 表会报错，应先核对表结构；不自动覆盖。领域词典脚本 `RAG/zh_dict.sql` 与项目已有词典一致，需由有权限的数据库管理员在目标库执行一次，补齐保研／双非等词与 `x` 类型映射；重新建立连接后刷新全文索引，不用重算向量。

```bash
/Users/XXH/miniconda3/envs/internenv/bin/python -m RAG refresh-fts
```

开发样本只建议导入开发库；命令只新增 `ragdev_*` 记录，可重复执行，不清库：

```bash
/Users/XXH/miniconda3/envs/internenv/bin/python -m RAG seed-dev
/Users/XXH/miniconda3/envs/internenv/bin/python -m RAG rebuild
/Users/XXH/miniconda3/envs/internenv/bin/python -m RAG search '双非计算机保研失败转考研'
/Users/XXH/miniconda3/envs/internenv/bin/python -m RAG search '计算机考研' --filters '{"学校层级":[],"年份":["2026"]}'
```

## Python 接口

所有公共搜索／核验结果为可序列化字典或列表。非法输入抛 `ValueError`；模型失败抛经过脱敏的 `ServiceError`，入库／核验数据库错误抛 `DatabaseError`。搜索本身将数据库错误返回为 `service_error`，不能当成空结果。

```python
from RAG import parse_situation, search, verify_quotes, index, index_article

parsed = parse_situation('双非计算机 GPA3.4 大三，保研还是考研')
result = search('双非计算机考研', filters={'学校层级': []}, top_k=30,
                on_step=lambda step: print(step))
checks = verify_quotes('真实文章ID', ['原文中逐字出现的话'])
index_article('真实文章ID')
```

- `parse_situation(query)` 返回 `filters`、`situation`、`irrelevant`、`labels`、`source`、`degraded`、`api_calls`。聊天模型缺失／失败采用规则解析；未知术语不直接判为无关。规则模式不能承诺理解所有注入或复杂语义。
- `search(query, filters=None, top_k=30, on_step=None)` 支持最多 4000 字，`top_k` 为 1–30。空搜索浏览最新已索引经验，不调用模型。过滤字段为决策类型、学校层级、专业、结果、年级、年份、路径；同字段 OR，跨字段 AND。显式字段覆盖自动抽取值，空数组清除该字段；未传入的字段保留自动值。年份接受四位非零开头数字。年级默认只作背景。
- 查询先做 SQL 过滤，向量／中文全文各召回最多 30 个决策点，RRF（常数 60）去重合并至 30 个，再 rerank。中文全文使用安全分词后的 OR 查询，排序为 `ts_rank_cd`，不是 BM25。学校与专业自动过滤遵循既有产品约定。向量路默认先物化过滤子集再精确计算距离，避免 HNSW 后置过滤漏候选；建有 HNSW 索引供后续扩展，但当前查询优先确保过滤后召回完整。上万篇规模需根据实测评估性能。
- 专业归一化只包含明确同义名，例如计算机科学与技术／软件工程／CS→计算机；不会凭空将所有相似专业合并。路径按最后选择的规则归类，与旧搜索保持一致。
- 返回 `status` 为 `ok`、`irrelevant`、`no_match` 或 `service_error`。`candidates` 每项含真实 `decision_point_id`、`article_id`、`person_id`、`decision_point`、`text`、`evidence`、各路分数与 `rank`。**rerank 分数不是概率**。
- `degraded` 标明规则解析、embedding 不可用或 reranker 不可用。embedding 失败走全文；reranker 失败保留 RRF 顺序。未配置门槛时，非空召回直接展示，`relevance_calibrated=false`，不能声称已经证明“足够相似”。门槛只作用于成功 rerank 的结果。
- `counts.scope=current_index_matching_filters` 表示当前模型／版本有效索引中符合筛选的文章、人物、决策点数量；不是网站所有文章数量。`candidate_count` 是截断后的候选数，两者不可混用。
- `no_match` 返回 `relaxations`（清除某一字段整个 OR 条件组后的精确数量和可应用 filters）与独立 `closest`。建议数量只代表过滤匹配，不承诺语义相关。相近经历最多两个人，附差异／未知字段，不能当成严格匹配。
- `on_step` 接收 `{step,label,detail,ms}`，`detail` 是字符串。它用于推送进度，不包含模型推理过程。回调应快速且不抛异常。结果含总耗时和本次模型 HTTP 尝试数；调用数不是 token 或货币成本。

## 入库与事务接入（Ken）

`index_article(article_id, connection=None)` 用于已有文章或同一事务中的新文章。未提供连接时模块管理事务；提供连接时由调用方管理事务，模块不提交。文章／决策点必须有真实 ID。只处理该文章：相同检索文本＋embedding 模型＋切块版本复用原向量；变更部分重新计算。删除文章／决策点通过外键级联删块。

```python
from RAG import index_article

# c 是 psycopg 连接；先写文章与实际决策点，再索引，整体失败就回滚。
with c.transaction():
    # INSERT / UPDATE articles ...
    # 更新 decision_points（Ken 的 save_points 会删除重建，必须在同一事务索引）
    index_article(article_id, connection=c)
```

模型调用发生在写 chunks 之前；上述方式会在网络调用期间持有调用方事务。更推荐先准备向量，再一次写入。新增文章／决策点需提前分配真实 ID（serial ID 可预取序列值），prepared 内 ID 必须与实际写入一致：

```python
from RAG import prepare_index, save_index

# article 至少有 id/title/content/type/status；points 每项有 id 和 11 字段。
# content 必须与实际入库原文完全一致。
prepared = prepare_index(article, points)
with c.transaction():
    # INSERT articles ... 显式使用 article['id']
    # INSERT decision_points ... 显式使用每项 point['id']
    save_index(prepared, c)
```

`PreparedIndex` 包含向量和输入快照，只用于进程内传递。`save_index` 必须处于调用方的活动事务，内部使用保存点；写前锁定文章／决策点并核对快照，变化则抛 `StaleIndexError`，需要重新准备。某个块写失败会恢复整篇旧块。`prepare_index` 不访问数据库，因此独立调用时不会复用旧向量；已有文章优先使用 `index_article`。

当前一决策点一块；块包含标题、结构化字段和经原文验证的决策点引文，不拼接其他决策点的全文。无有效引文时仍可用已抽取字段检索，但 `evidence` 留空，agent 不能把这些字段当作已验证引文。块超过 6000 字显式拒绝，不静默截断。

修改标题、正文或决策点、撤回／重新发布，都必须在同一事务调用索引。查询会排除正文哈希不符的旧块；这只是兜底，不能代替同步更新（标题／决策点变更仍依赖接入）。`backend.schema` 的文章 `content_hash` 是 MD5，本模块块级哈希是 SHA-256，两者用途不同。

```bash
/Users/XXH/miniconda3/envs/internenv/bin/python -m RAG index ARTICLE_ID
/Users/XXH/miniconda3/envs/internenv/bin/python -m RAG rebuild
/Users/XXH/miniconda3/envs/internenv/bin/python -m RAG rebuild --force
```

切块版本通过 `RAG_CHUNK_VERSION` 配置。模型或切块版本更换时旧版本可并存；在维护窗口用新配置 `rebuild` 完成后再切换服务配置，避免部分索引对外提供结果。1024 维以外的模型需要单独迁移，不能仅改模型名。大规模版本切换／后台任务编排由宿主服务负责。

## 引用与前端接入（Ken）

`verify_quotes(article_id, quotes, connection=None)` 逐条返回 `valid`、`reason`、`start`、`end`。偏移为原文 Python 字符下标，`end` 不包含在片段内；JavaScript 的 UTF-16 下标与含 emoji 的原文存在差异，应在后端切出原文片段再传前端。只忽略空白，标点必须一致；只读指定文章，禁止用抽取的原话拼成证据源。

核验成功仅证明该引文存在，不能证明生成的推荐理由正确。agent 某句话的全部引用被拒绝时，接入层须删除或重新生成那句话；语义理由仍交审查 agent。

接入时必须同步处理：

1. `agents.py` 的处境抽取和关键词召回换成上述接口；保留判断／审查 agent，串流继续由 Ken 发出。
2. 现有代码有以文章 ID 代替 `decision_point_id` 的地方，需改用真实 ID，人物与文章跳转分别使用各自 ID。同一文章可能命中多个决策点，人物去重在分群／展示层处理，不丢掉决策点证据。
3. 现有搜索页会本地关键词重排和筛选，须改成使用后端顺序；筛选变更重新请求，清除自动条件必须传对应空数组。前端不要重新按 stars 或旧关键词覆盖 rerank。
4. “起点比你好”等扩展组由 Ken 明确放宽学校层级后再次调用搜索，单独标示；索引更新时清除／更新 Ken 的搜索与 agent 缓存，避免展示旧证据。

## 评估与校准

测试标签用 `article_id + point_ordinal`（该文真实决策点按 ID 排序，从 0 开始）定位，避免 seed 时 serial ID 不同。运行需先导入样本并完成索引。报告区分决策点与去重人物的 Hit@5／MRR，记录对抗通过率、平均／P95 延迟、API 尝试数及故障；服务故障不能记作通过。

```bash
mkdir -p RAG/reports
/Users/XXH/miniconda3/envs/internenv/bin/python -m RAG.evaluate --mode all --output RAG/reports/comparison.json
/Users/XXH/miniconda3/envs/internenv/bin/python -m RAG.evaluate --mode hybrid_rerank --calibrate RAG/reports/calibration.json --output RAG/reports/calibrated.json
```

四种配置为全文、向量、RRF 混合、混合加 rerank。校准只用 `split=validation` 的候选正负标签选 F1 最优门槛，另报 held-out test；校准后设置 `RAG_CALIBRATION_FILE` 并重新运行比较。校准文件会核对模型与切块版本；真实文章到位后必须重新标注校准。不配置时没有任意拍定的默认门槛。`RAG_RELEVANCE_THRESHOLD` 可显式覆盖文件，仅供调试，应自行记录来源。

给 Ken 的 multi-agent／全部文章长上下文对照组导出实际已发布语料（包含原文，文件不要公开分享未授权内容）：

```bash
/Users/XXH/miniconda3/envs/internenv/bin/python -m RAG.evaluate --export-context RAG/reports/baseline_input.json --output RAG/reports/export.json
/Users/XXH/miniconda3/envs/internenv/bin/python -m RAG.evaluate --predictions RAG/reports/agent_predictions.json --output RAG/reports/agent_metrics.json
```

外部预测为 JSON 数组，每项包含 `id`（题号）、`status`、`candidates`（`article_id,point_ordinal,person_id`）、`elapsed_ms`、`api_calls`；对抗题还需提供实际 `filters`。外部工具负责真正执行 agent 或长上下文生成，本模块不复制 Ken 的 agent 层。

## 数据库／真实 API 集成测试

在环境变量设置 `RAG_TEST_DATABASE_URL`（推荐专用测试库，需建 schema 权限），然后运行同一 pytest 命令。测试创建随机 `ragtest_*` schema 和最小兼容表，结束删除该 schema；不执行主库清空脚本。未配置时明确 skip。`RAG_TEST_LIVE=1` 额外启用硅基流动真实 API 测试，会产生费用；默认不启用。

集成测试覆盖中文全文与向量 SQL、多决策点、重复索引跳过、正文变更后的旧索引排除、失败写入恢复、调用方回滚、过期快照拒绝及级联删除。未跑过这些测试前，不宣称已完成真实环境验收。


## 最小真实端到端验收

配置好根目录 `.env` 后，在仓库根目录执行：

```bash
/Users/XXH/miniconda3/envs/internenv/bin/python -m RAG.smoke --output RAG/reports/live.json
```

这会调用真实 Embedding／Reranker API（少量费用），先检查 pgvector、zhparser、中文分词，再在随机 `ragtest_*` schema 中建立兼容测试表和虚构样本。只索引 3 篇代表文章，验证向量写入、重复入库跳过 API、修改文章／决策点后的增量索引，以及问题「双非计算机保研失败转考研」的双路召回与重排。报告包含各阶段耗时、数量、真实 article_id／decision_point_id／证据片段和排名分数；完成后删除测试 schema，不修改 public 业务表。处境抽取使用规则以隔离本次检索验收，门槛关闭以免使用尚未校准的阈值。

数据库／扩展不可用或密钥未配置时返回 `blocked`，退出码 2，不计为通过；真实 API 或断言失败返回 `failed`。原始服务异常不写入报告，避免暴露 DSN 或凭证。`index(article_id, connection=None)` 是 `index_article` 的公开同义接口；入库返回本次 HTTP 调用次数和读缓存、文本处理／向量准备、事务写入的阶段耗时。

真实执行情况见 [ACCEPTANCE.md](ACCEPTANCE.md)。模型 API 可以独立于数据库检查：

```bash
/Users/XXH/miniconda3/envs/internenv/bin/python -m RAG.check_api
```

这仅验证 Embedding 和 Reranker，不代表 SQL 检索成功。报告默认写入被忽略的 `RAG/reports/`。

### 本地镜像下载缓慢时

Docker 显示 Engine running 只表示引擎可用，不表示 PostgreSQL 服务已启动。原始 Debian 源下载很慢时，可选用 RAG 内的本地覆盖配置：

```bash
/Applications/Docker.app/Contents/Resources/bin/docker compose -f docker-compose.yml -f RAG/docker-compose.dev.yml up -d
```

该配置复用原 Compose 的端口、账号和持久数据卷，只把 Debian 包源替换为清华镜像，保留 apt 签名校验；不修改原 Dockerfile 或业务后端。基础镜像初始无 CA 证书，先用有签名校验的 HTTP 传输安装 CA，再将 PostgreSQL 包源切至 HTTPS，避免上游 HTTP 下载失败。扩展源码仍来自原上游。

要保留可重复搜索的独立测试数据、索引全部开发文章：

```bash
/Users/XXH/miniconda3/envs/internenv/bin/python -m RAG.smoke --all-articles --keep-data --output RAG/reports/live.json
```

只有验收成功才保留随机测试 schema，其名称记录在报告 `test_schema`。后续搜索可以用 `PGOPTIONS='-c search_path=报告中的test_schema,public'` 指定此 schema 后调用 `python -m RAG search`；仍须使用项目规定的完整 Python 路径。不要把测试 schema 当作正式文章库。失败的测试 schema 自动清理，public 表不会被覆盖。
