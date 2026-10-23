// AI 生成的示例人物／文章（10/20 决定参赛版用 AI 生成）：文章 tags 含「示例」、人物 profile.sample
const isSample = (x) => !!(x?.sample || x?.tags?.includes('示例'));

export default function SampleBadge({ of, lm = false }) {
  if (!isSample(of)) return null;
  if (lm) return <span title="AI 生成的示例内容，非真实经历" className="lm-tag-s">示例</span>;  // 新设计的样式
  return (
    <span title="AI 生成的示例内容，非真实经历" className="px-2 py-0.5 rounded-full bg-stone-700 text-white text-xs font-medium flex-shrink-0">
      示例
    </span>
  );
}
