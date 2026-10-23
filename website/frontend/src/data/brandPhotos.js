// 首页「燕园四时」内建照片（跟 backend/schema.sql 的 hero_slides 同一份）；有库时 boot() 换成表的内容
// 作者与授权照 public/hero/README 与设计稿 hero/照片来源.md，每张照片下面都写出来
export const BRAND_PHOTOS = [
  { url: '/hero/lake-spring.jpg', season: '春', title: '柳下看塔', caption: '柳条垂到水面，塔和云都在湖里。', alt: '春末的未名湖，垂柳、白云和博雅塔的倒影', credit: '摄影 維基小霸王 · CC BY-SA 4.0 · Wikimedia Commons' },
  { url: '/hero/lake-summer.jpg', season: '夏', title: '柳荫里的博雅塔', caption: '垂柳把塔藏了一半，蝉声都在湖上。', alt: '夏天的博雅塔，前面是一排垂柳和未名湖', credit: '摄影 Bangyu Wang · Unsplash' },
  { url: '/hero/lake-autumn.jpg', season: '秋', title: '湖心岛的倒影', caption: '岛上的树一夜转红，湖里又长出一座。', alt: '秋天的未名湖湖心岛，红黄树叶倒映在平静的湖面', credit: '摄影 星外之神 · CC0 · Wikimedia Commons' },
  { url: '/hero/lake-winter.jpg', season: '冬', title: '冰封的未名湖', caption: '湖面结了冰，塔在冬天的光里站得更直。', alt: '冬天结冰的未名湖，远处是博雅塔', credit: '摄影 MChe Lee · Unsplash' },
];
