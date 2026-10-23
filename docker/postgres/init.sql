-- 第一次启动数据库时自动执行
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS zhparser;
CREATE TEXT SEARCH CONFIGURATION chinese (PARSER = zhparser);
-- n 名词 v 动词 a 形容词 i 成语 e 叹词 l 习用语
ALTER TEXT SEARCH CONFIGURATION chinese ADD MAPPING FOR n,v,a,i,e,l WITH simple;
