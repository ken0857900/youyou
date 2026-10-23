-- 线上旧 hero_slides 升级成「燕园四时」：加四个栏位、换成四季照片（可重复跑）
-- 用法：docker exec -i pathfinder-db-1 sh -c 'psql -U $POSTGRES_USER' < backend/migrate_hero.sql
BEGIN;
ALTER TABLE hero_slides ADD COLUMN IF NOT EXISTS season text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS alt text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS credit text NOT NULL DEFAULT '';
DELETE FROM hero_slides;  -- 旧的四张品牌照（未名湖、博雅塔、林间小路、书架），新首页不用
INSERT INTO hero_slides (image_url, season, title, caption, alt, credit, sort_order) VALUES
  ('/hero/lake-spring.jpg', '春', '柳下看塔', '柳条垂到水面，塔和云都在湖里。', '春末的未名湖，垂柳、白云和博雅塔的倒影', '摄影 維基小霸王 · CC BY-SA 4.0 · Wikimedia Commons', 1),
  ('/hero/lake-summer.jpg', '夏', '柳荫里的博雅塔', '垂柳把塔藏了一半，蝉声都在湖上。', '夏天的博雅塔，前面是一排垂柳和未名湖', '摄影 Bangyu Wang · Unsplash', 2),
  ('/hero/lake-autumn.jpg', '秋', '湖心岛的倒影', '岛上的树一夜转红，湖里又长出一座。', '秋天的未名湖湖心岛，红黄树叶倒映在平静的湖面', '摄影 星外之神 · CC0 · Wikimedia Commons', 3),
  ('/hero/lake-winter.jpg', '冬', '冰封的未名湖', '湖面结了冰，塔在冬天的光里站得更直。', '冬天结冰的未名湖，远处是博雅塔', '摄影 MChe Lee · Unsplash', 4);
COMMIT;
