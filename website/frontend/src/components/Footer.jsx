import { source } from '../data/api';

export default function Footer() {
  return (
    <div className="lm-wrap">
      <footer className="lm-foot">
        <span>© 2026 鹿鸣 LUMING 经验分享平台 · <span title="后端没开或数据库没起时用本地示例">数据：{source === 'db' ? '数据库' : '本地示例'}</span></span>
        <span>本站为参赛演示版：标「示例」的人物与文章均为 AI 生成的虚构内容，不代表真实个人，申请规则请以光华管理学院官方通知为准。正式上线后，分享者须经北京大学校园邮箱验证；平台只做经验分享与个人咨询，不涉及考试与商业机密。</span>
      </footer>
    </div>
  );
}
