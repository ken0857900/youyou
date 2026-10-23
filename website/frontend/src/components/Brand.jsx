// 品牌：正式 Logo（透明背景）。图片读 site_images 表（key=logo），没库时用 public/logo.png
import { SITE_IMAGES } from '../data/mock';

export default function Brand() {
  return <img className="lm-logo" src={SITE_IMAGES.logo.url} alt={SITE_IMAGES.logo.alt} />;
}
