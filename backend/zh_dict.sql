-- zhparser 自定义词典：领域词不被拆开（双非 → 双/非）。可重复执行。
-- 已有库：docker compose exec -T db psql -U pathfinder < backend/zh_dict.sql （新连线才生效）
INSERT INTO zhparser.zhprs_custom_word (word) VALUES
  ('保研'),('考研'),('双非'),('985'),('211'),('上岸'),('考公'),('秋招'),('春招'),('二战'),('一战'),('跨考'),
  ('推免'),('夏令营'),('预推免'),('选导师'),('软微'),('调剂'),('复试'),('初试'),('非全'),('考编'),('选调'),
  ('选调生'),('国考'),('省考'),('套磁'),('读博'),('转正'),('实习'),('留学'),('出国'),('择校'),('本科'),('硕士'),('博士')
ON CONFLICT DO NOTHING;
SELECT sync_zhprs_custom_word();
-- 自定义词 token 类型是 x（未知词），init.sql 没映射会被丢掉，这里补上
ALTER TEXT SEARCH CONFIGURATION chinese DROP MAPPING IF EXISTS FOR x;
ALTER TEXT SEARCH CONFIGURATION chinese ADD MAPPING FOR x WITH simple;
