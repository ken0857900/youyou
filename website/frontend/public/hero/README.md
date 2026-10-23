# 首页「燕园四时」轮播图

轮播显示哪些图、顺序、文字，都由资料库 `hero_slides` 表决定，不用改代码。

## 栏位

| 栏位 | 管什么 |
|---|---|
| `image_url` | 图片网址 |
| `season` | 照片左边的大字（春／夏／秋／冬，一个字） |
| `title` | 照片下的标题 |
| `caption` | 照片下的一句说明 |
| `alt` | 给读屏软件的图片描述 |
| `credit` | 作者与授权（例：`摄影 MChe Lee · Unsplash`），会显示在照片下面 |
| `sort_order` | 顺序，小的排前面 |
| `active` | `false` = 先不显示 |

## 图片放哪里（`image_url` 怎么填）

- 放在本资料夹 → 填 `/hero/文件名`（上线后要重新 build 前端才会带上新文件）
- 已上传到后端的图 → 填 `/uploads/文件名`（不用重新 build）
- 外部图片 → 填完整网址

## 图片规格

- 格式：jpg / png / webp / svg
- 比例约 **8:3**，建议 1600×600；大图显示时会裁切（object-cover），主体放中间
- 左右两侧的小图只露中间一窄条，且半透明
- 文字压在左下角是白字，左下角别放太亮的画面
- 单张尽量 ≤ 500 KB，首页加载才快

## 常用指令（专案根目录）

```
# 看现况
docker compose exec db psql -U pathfinder -c "SELECT * FROM hero_slides ORDER BY sort_order"

# 换第 1 张的图和文字
docker compose exec db psql -U pathfinder -c "UPDATE hero_slides SET image_url='/hero/new.jpg', caption='新标语' WHERE id=1"

# 新增一张
docker compose exec db psql -U pathfinder -c "INSERT INTO hero_slides (image_url, caption, sort_order) VALUES ('/hero/xxx.jpg', '文字', 5)"

# 隐藏一张（不删）
docker compose exec db psql -U pathfinder -c "UPDATE hero_slides SET active=false WHERE id=2"
```

改完首页重新整理就生效。表空了首页会显示内建的 4 张图，不会空白。
重跑 `backend/schema.sql` 或 `seed.py` 会把表恢复成预设 4 张——换过的图要同步改 `schema.sql` 最下面的 INSERT。
