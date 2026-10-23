-- PathFinder 主资料库（Ken 负责）。重跑会清空：开发用
-- 扩展 vector / zhparser 和 'chinese' 分词配置在 docker/postgres/init.sql 已建
DROP TABLE IF EXISTS claims, rules, notices, sessions, availability, hero_slides, site_images, booking_reviews, article_helpful, search_logs, email_codes, follows, bookings, bookmarks, article_stars, article_views, notifications,
  wish_readers, wish_requests, jobs, decision_points, articles, accounts, companies, persons CASCADE;

-- 人物（分享者主页）。timeline / faqs / 其余展示字段放 profile，省得每加一栏就改表
CREATE TABLE persons (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  school_tier text,
  major       text,
  profile     jsonb NOT NULL DEFAULT '{}'   -- title, tagline, school, timeline[], faqs[], price20m ...
);

CREATE TABLE companies (
  id       serial PRIMARY KEY,
  name     text UNIQUE NOT NULL,
  approved boolean NOT NULL DEFAULT false
);

CREATE TABLE accounts (
  id           serial PRIMARY KEY,
  role         text NOT NULL CHECK (role IN ('reader', 'sharer', 'company')),
  name         text NOT NULL,
  email        text UNIQUE NOT NULL,
  password_hash text,                     -- scrypt$盐$哈希；NULL＝还没设密码（老账号用验证码设一次）
  pku_verified boolean NOT NULL DEFAULT false,
  pku_email    text UNIQUE,              -- 验证过的北大邮箱（一个北大邮箱只能升级一个账号）
  person_id    text REFERENCES persons(id),
  company_id   int REFERENCES companies(id)
);

CREATE TABLE articles (
  id           text PRIMARY KEY DEFAULT 'a' || (extract(epoch FROM clock_timestamp()) * 1000000)::bigint,  -- 微秒：毫秒在批量汇入时会撞号
  author_id    text NOT NULL REFERENCES persons(id),
  type         text NOT NULL CHECK (type IN ('article', 'diary')),
  status       text NOT NULL DEFAULT 'published',
  category     text NOT NULL,             -- 经验文章 = 决策类型；日记作者自选
  title        text NOT NULL,
  summary      text NOT NULL DEFAULT '',
  content      text NOT NULL,
  tags         text[] NOT NULL DEFAULT '{}',
  date         date NOT NULL DEFAULT current_date,
  stars        int NOT NULL DEFAULT 0,    -- 快取，article_stars 增删时同步
  bookmarks    int NOT NULL DEFAULT 0,    -- 快取，bookmarks 增删时同步
  views_seed   int NOT NULL DEFAULT 0,    -- 只给开发假数据用，真数据恒为 0
  content_hash text GENERATED ALWAYS AS (md5(content)) STORED,  -- 增量更新：hash 变了 RAG 才重算这篇
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON articles (author_id);
CREATE INDEX ON articles (type, category);
-- TODO 全文检索：RAG 同学在 chunks 上建 tsv（to_tsvector('chinese', ...)），这里先不建

-- 决策点：一篇文章可有多个，字段名直接用中文，回传 JSON 跟前端 decisionPoint 一致
CREATE TABLE decision_points (
  id           serial PRIMARY KEY,
  article_id   text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  "决策类型"    text NOT NULL DEFAULT '未提及',
  "学校层级"    text NOT NULL DEFAULT '未提及',
  "专业"        text NOT NULL DEFAULT '未提及',
  "成绩"        text NOT NULL DEFAULT '未提及',
  "年级"        text NOT NULL DEFAULT '未提及',
  "考虑过的选项" text[] NOT NULL DEFAULT '{}',
  "最后的选择"   text NOT NULL DEFAULT '未提及',
  "结果"        text NOT NULL DEFAULT '未提及',
  "结果说明"     text NOT NULL DEFAULT '未提及',
  "年份"        text NOT NULL DEFAULT '未提及',
  "原话"        text NOT NULL DEFAULT '未提及',
  confidence   jsonb NOT NULL DEFAULT '{}',   -- 每栏把握度（07 提示词 #1），低的才问作者
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON decision_points (article_id);
-- RAG 的 chunks 表挂在这里：chunks.decision_point_id → decision_points(id)
-- （向量 1024 维 + tsv + embedding_model + content_hash，由 RAG/ 建，不在本文件）

-- 公司官方职位
CREATE TABLE jobs (
  id             text PRIMARY KEY DEFAULT 'j' || (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
  company_id     int REFERENCES companies(id),
  company        text NOT NULL,
  official       boolean NOT NULL DEFAULT true,
  title          text NOT NULL,
  city           text,
  salary         text,
  majors         text[] NOT NULL DEFAULT '{}',
  decision_types text[] NOT NULL DEFAULT '{}',
  description    text NOT NULL DEFAULT '',
  date           date NOT NULL DEFAULT current_date,
  deadline       date
);

-- 求经验单：同一搜索字合并计数
CREATE TABLE wish_requests (
  id         text PRIMARY KEY DEFAULT 'w' || (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
  query      text UNIQUE NOT NULL,
  conditions jsonb NOT NULL DEFAULT '{}',
  want_count int NOT NULL DEFAULT 1,
  status     text NOT NULL DEFAULT '等待中',
  article_id text REFERENCES articles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE wish_readers (
  wish_id    text REFERENCES wish_requests(id) ON DELETE CASCADE,
  account_id int REFERENCES accounts(id),
  PRIMARY KEY (wish_id, account_id)
);

CREATE TABLE notifications (
  id         serial PRIMARY KEY,
  account_id int REFERENCES accounts(id),
  person_id  text REFERENCES persons(id), -- 发给分享者本人（还没注册账号也先记着）；跟 account_id 二选一
  type       text NOT NULL,              -- invited / written / paid
  request_id text REFERENCES wish_requests(id),
  text       text NOT NULL,
  link       text,
  date       date NOT NULL DEFAULT current_date,
  read       boolean NOT NULL DEFAULT false
);

-- 点击：同一人同一天只算一次；没登入用 cookie 随机 id，所以 viewer 是 text
CREATE TABLE article_views (
  article_id text REFERENCES articles(id) ON DELETE CASCADE,
  viewer     text NOT NULL,
  day        date NOT NULL DEFAULT current_date,
  PRIMARY KEY (article_id, viewer, day)
);
CREATE TABLE article_stars (
  article_id text REFERENCES articles(id) ON DELETE CASCADE,
  account_id int REFERENCES accounts(id),
  PRIMARY KEY (article_id, account_id)
);
CREATE TABLE bookmarks (
  article_id text REFERENCES articles(id) ON DELETE CASCADE,
  account_id int REFERENCES accounts(id),
  PRIMARY KEY (article_id, account_id)
);

CREATE TABLE bookings (
  id         serial PRIMARY KEY,
  person_id  text REFERENCES persons(id),
  account_id int REFERENCES accounts(id),
  minutes    int NOT NULL CHECK (minutes IN (20, 40)),
  price      int,                         -- 下单当时的价格（人物改价不影响旧单）
  slot       text,                        -- 前端时段字串，如「2026-10-20（周一）20:00」
  question   text NOT NULL DEFAULT '',    -- 想问的问题
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  paid_at    timestamptz,                 -- 读者按「我已付款」的时间；平台不经手钱，分享者自己去微信核对
  starts_at  timestamp,                   -- 约的时段（北京时间整点，对应 availability）；旧单是 NULL 只有 slot 字串
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bookings_person_slot ON bookings (person_id, starts_at);  -- 同一时段只能被约一次

-- 关注人物
CREATE TABLE follows (
  account_id int REFERENCES accounts(id) ON DELETE CASCADE,
  person_id  text REFERENCES persons(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, person_id)
);

-- 邮箱验证码：读者注册、北大邮箱升级分享者共用
CREATE TABLE email_codes (
  email      text NOT NULL,
  code       text NOT NULL,
  purpose    text NOT NULL CHECK (purpose IN ('register', 'pku_verify')),
  expires_at timestamptz NOT NULL,
  used       boolean NOT NULL DEFAULT false,
  attempts   int NOT NULL DEFAULT 0,      -- 输错次数，5 次作废
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON email_codes (email);

-- 检索过程面板＋评估用：每次搜索的 agent 步骤
CREATE TABLE search_logs (
  id           serial PRIMARY KEY,
  query        text NOT NULL,
  viewer       text,                       -- account id 或 cookie 随机 id
  steps        jsonb NOT NULL DEFAULT '[]', -- ①处境抽取…⑧完成，每步耗时
  result_count int NOT NULL DEFAULT 0,
  fallback     boolean NOT NULL DEFAULT false,  -- agent 超时退回 rerank
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 评价：评的是「有没有帮到我」，不是评人（05 评价机制）
CREATE TABLE article_helpful (
  article_id text REFERENCES articles(id) ON DELETE CASCADE,
  account_id int REFERENCES accounts(id) ON DELETE CASCADE,
  comment    text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, account_id)
);

-- 咨询评分：每笔预约一次
CREATE TABLE booking_reviews (
  booking_id int PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  account_id int REFERENCES accounts(id) ON DELETE CASCADE,
  person_id  text REFERENCES persons(id) ON DELETE CASCADE,
  stars      int NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment    text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 首页「燕园四时」轮播：换图改这张表，前端重新整理就生效（不用改代码）
-- image_url：/hero/xxx 放 website/frontend/public/hero/；/uploads/xxx 放 backend/uploads/；也可填完整网址
-- season 是照片左边的大字（一个字），title／caption 是照片下的标题与说明，credit 写作者与授权（照片下面一定要写）
CREATE TABLE hero_slides (
  id         serial PRIMARY KEY,
  image_url  text NOT NULL,
  caption    text NOT NULL DEFAULT '',
  sort_order int NOT NULL DEFAULT 0,   -- 小的排前面
  active     boolean NOT NULL DEFAULT true,  -- false = 先不显示
  season     text NOT NULL DEFAULT '',
  title      text NOT NULL DEFAULT '',
  alt        text NOT NULL DEFAULT '',
  credit     text NOT NULL DEFAULT ''
);
-- 不是假数据，seed.py 清空重建时也保留；线上旧表升级跑 migrate_hero.sql
INSERT INTO hero_slides (image_url, season, title, caption, alt, credit, sort_order) VALUES
  ('/hero/lake-spring.jpg', '春', '柳下看塔', '柳条垂到水面，塔和云都在湖里。', '春末的未名湖，垂柳、白云和博雅塔的倒影', '摄影 維基小霸王 · CC BY-SA 4.0 · Wikimedia Commons', 1),
  ('/hero/lake-summer.jpg', '夏', '柳荫里的博雅塔', '垂柳把塔藏了一半，蝉声都在湖上。', '夏天的博雅塔，前面是一排垂柳和未名湖', '摄影 Bangyu Wang · Unsplash', 2),
  ('/hero/lake-autumn.jpg', '秋', '湖心岛的倒影', '岛上的树一夜转红，湖里又长出一座。', '秋天的未名湖湖心岛，红黄树叶倒映在平静的湖面', '摄影 星外之神 · CC0 · Wikimedia Commons', 3),
  ('/hero/lake-winter.jpg', '冬', '冰封的未名湖', '湖面结了冰，塔在冬天的光里站得更直。', '冬天结冰的未名湖，远处是博雅塔', '摄影 MChe Lee · Unsplash', 4);

-- 网站图片（Logo 等）：换图改这张表，前端重新整理就生效（不用改代码）
-- key：logo＝页头，logo_light＝手机选单深色直条（浅色版）；image_url 规则同 hero_slides
CREATE TABLE site_images (
  key       text PRIMARY KEY,
  image_url text NOT NULL,
  alt       text NOT NULL DEFAULT ''
);
-- 不是假数据，seed.py 清空重建时也保留；线上旧库加表跑 migrate_site_images.sql
INSERT INTO site_images (key, image_url, alt) VALUES
  ('logo', '/logo.png', '鹿鸣 LUMING'),
  ('logo_light', '/logo-light.png', '');

-- 分享者可预约时段：一列一个整点（北京时间，不带时区），在「咨询设定」的月历上勾
CREATE TABLE availability (
  person_id text REFERENCES persons(id) ON DELETE CASCADE,
  starts_at timestamp NOT NULL,
  PRIMARY KEY (person_id, starts_at)
);

-- 登录凭证：登录后发随机 token，前端每次带在 X-Account-Id 头；后端只认 token，不认前端传的账号 ID
CREATE TABLE sessions (
  token      text PRIMARY KEY,
  account_id int NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 经验保鲜度（流程 D，只做光华）：爬到的官方通知 → 抽成规则 → 文章里的主张按 (program, rule_type) 挂到最新规则
-- 线上加表：只跑这三段（加了 IF NOT EXISTS），不要重跑整份
CREATE TABLE IF NOT EXISTS notices (
  id         serial PRIMARY KEY,
  url        text UNIQUE NOT NULL,         -- 通知页网址；只存新的，爬到旧的跳过
  title      text NOT NULL,
  program    text NOT NULL,                -- 专硕夏令营／学术夏令营
  year       int NOT NULL,
  pdf_url    text,
  text       text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rules (
  id        serial PRIMARY KEY,
  program   text NOT NULL,
  rule_type text NOT NULL,
  year      int NOT NULL,
  content   text NOT NULL,
  quote     text NOT NULL,                 -- 逐字摘自 notices.text
  notice_id int NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  UNIQUE (program, rule_type, year)
);
CREATE TABLE IF NOT EXISTS claims (
  id         serial PRIMARY KEY,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  sentence   text NOT NULL,                -- 逐字摘自文章
  program    text NOT NULL,
  rule_type  text NOT NULL,
  status     text NOT NULL DEFAULT 'unknown' CHECK (status IN ('valid', 'changed', 'unknown')),  -- 待更新（pending）读的时候按年份算
  reason     text NOT NULL DEFAULT '',
  quote      text NOT NULL DEFAULT '',     -- 逐字摘自依据的通知
  rule_id    int REFERENCES rules(id) ON DELETE SET NULL,
  checked_at timestamptz
);
CREATE INDEX IF NOT EXISTS claims_key ON claims (program, rule_type);
CREATE INDEX IF NOT EXISTS claims_article ON claims (article_id);
