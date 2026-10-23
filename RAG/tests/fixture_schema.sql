-- Only execute inside a fresh disposable RAG test schema.
CREATE TABLE persons(id text PRIMARY KEY,name text,school_tier text,major text);
CREATE TABLE articles(
 id text PRIMARY KEY,author_id text REFERENCES persons(id),type text,status text,
 category text,title text,content text,date date DEFAULT current_date,
 content_hash text GENERATED ALWAYS AS (md5(content)) STORED
);
CREATE TABLE decision_points(
 id serial PRIMARY KEY,article_id text REFERENCES articles(id) ON DELETE CASCADE,
 "决策类型" text DEFAULT '未提及',"学校层级" text DEFAULT '未提及',
 "专业" text DEFAULT '未提及',"成绩" text DEFAULT '未提及',"年级" text DEFAULT '未提及',
 "考虑过的选项" text[] DEFAULT '{}',"最后的选择" text DEFAULT '未提及',
 "结果" text DEFAULT '未提及',"结果说明" text DEFAULT '未提及',
 "年份" text DEFAULT '未提及',"原话" text DEFAULT '未提及'
);
