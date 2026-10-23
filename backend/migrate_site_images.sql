-- 线上旧库加 site_images（Logo 等网站图片）（可重复跑）
-- 用法：docker exec -i pathfinder-db-1 sh -c 'psql -U $POSTGRES_USER' < backend/migrate_site_images.sql
-- 之后换 Logo：图放 backend/uploads/ 或 frontend public/，再
--   UPDATE site_images SET image_url = '/uploads/新logo.png' WHERE key = 'logo';
BEGIN;
CREATE TABLE IF NOT EXISTS site_images (
  key       text PRIMARY KEY,
  image_url text NOT NULL,
  alt       text NOT NULL DEFAULT ''
);
INSERT INTO site_images (key, image_url, alt) VALUES
  ('logo', '/logo.png', '鹿鸣 LUMING'),
  ('logo_light', '/logo-light.png', '')
ON CONFLICT (key) DO NOTHING;
COMMIT;
