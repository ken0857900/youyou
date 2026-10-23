import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAppState } from '../context/AppState';
import { getArticle, getWishRequest, stripImages } from '../data/mock';
import ArticleBody from '../components/ArticleBody';
import DecisionPointsEditor from '../components/DecisionPointsEditor';
import * as api from '../data/api';
import PageHead from '../components/PageHead';

// 只给人物日记猜分类用（日记没有决策点）；经验文章的决策点由大模型抽、作者确认
const TYPE_KEYWORDS = [
  ['保研', ['保研', '夏令营', '推免']],
  ['考研', ['考研', '初试', '复试', '二战']],
  ['出国', ['出国', '留学', '托福', '雅思', 'GRE']],
  ['考公', ['考公', '国考', '省考', '选调']],
  ['选导师', ['导师', '读博', '课题组', '套磁']],
  ['求职', ['求职', '秋招', '春招', '实习', 'offer', '面试']],
];
const guessType = (text) => TYPE_KEYWORDS.find(([, kws]) => kws.some((k) => text.includes(k)))?.[0];


// 网址参数（edit／request）一变就整个重建：从「修改文章」切到「写新文章」时，旧的标题、正文、预览状态不会留着
export default function WritePage() {
  const [params] = useSearchParams();
  return <Writer key={params.toString()} />;
}

function Writer() {
  const { user } = useAppState();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const request = getWishRequest(params.get('request'));
  const editing = getArticle(params.get('edit')); // /write?edit=文章id：改自己已发布的
  const [type, setType] = useState(editing?.type ?? 'article'); // 'article' | 'diary'
  const [title, setTitle] = useState(editing?.title ?? request?.query ?? '');
  const [content, setContent] = useState(editing?.content ?? '');
  // 启动时文章没带全文：编辑旧文要先补拉正文
  useEffect(() => { if (editing && editing.content == null) api.loadArticle(editing.id).then((a) => setContent(a?.content ?? '')).catch(() => {}); }, [editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // 大模型抽出、作者确认中的决策点；null＝还没抽（改了标题／正文就作废重抽）
  // 没有 decisionPoints（例：示例资料只有单数的 decisionPoint）就用那一个，免得原本的决策点被一组「未提及」盖掉
  const [points, setPoints] = useState(() => {
    if (editing?.type !== 'article') return null;
    if (editing.decisionPoints?.length) return editing.decisionPoints;
    return editing.decisionPoint ? [editing.decisionPoint] : null;
  });
  const [extracting, setExtracting] = useState(false);
  const [aiNote, setAiNote] = useState('');
  const edit = (setter) => (v) => { setter(v); setPoints(null); };
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [preview, setPreview] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [imgNote, setImgNote] = useState('');
  const textRef = useRef(null);
  const fileRef = useRef(null);
  // 插图：上传后把 ![](url) 独立成一段插在光标处
  const insertImage = async (file) => {
    if (!file) return;
    setUploading(true); setImgNote('');
    try {
      const { url, saved } = await api.uploadImage(file, 'article');
      const at = textRef.current?.selectionStart ?? content.length;
      edit(setContent)(`${content.slice(0, at).trimEnd()}\n\n![](${url})\n\n${content.slice(at).trimStart()}`.trimStart());
      if (!saved) setImgNote('后端未连接：图片只在本页暂存，刷新后会消失');
    } catch (e) { setImgNote(e.message); }
    setUploading(false);
    fileRef.current.value = '';
  };

  if (!user) return <Navigate to="/login" replace />;
  if (!user.pkuVerified) {
    return (
      <div className="lm-gate" style={{ paddingTop: 48 }}>
        <h1>先验证北大邮箱</h1>
        <p>验证北大邮箱（@pku.edu.cn / @stu.pku.edu.cn）后升级成分享者，才能发布经验文章。</p>
        <Link to="/me" className="lm-btn-ink">去验证</Link>
      </div>
    );
  }

  if (params.get('edit') && editing?.authorId !== user.personId) {
    return <p className="lm-empty lm-gate" style={{ marginTop: 48 }}>找不到这篇，或不是你写的文章</p>;
  }

  const canPublish = title.trim() && content.trim() && !saving && !extracting;
  const needPoints = type === 'article' && !points;
  // 第一步：大模型读全文抽决策点（3–5 秒），摆出来给作者检查、修改
  const extract = async () => {
    setExtracting(true); setSaveErr(''); setAiNote('');
    try {
      const r = await api.extractPoints(title.trim(), content.trim());
      // 求经验单勾过的条件是读者明确要的，AI 没抽到就补上
      const fromRequest = Object.fromEntries(['决策类型', '学校层级', '专业', '结果'].filter((k) => request?.conditions[k]).map((k) => [k, request.conditions[k]]));
      setPoints(r.points.map((p) => ({ ...p, ...Object.fromEntries(Object.entries(fromRequest).filter(([k]) => p[k] === '未提及')) })));
      if (r.source !== 'llm') setAiNote('AI 暂时不可用，请自己填一下决策点');
    } catch (e) { setSaveErr(`整理失败：${e.message}`); }
    setExtracting(false);
  };
  // 改文章：送作者确认过的决策点，后端校验后重建索引
  const save = async () => {
    setSaving(true); setSaveErr('');
    try {
      await api.updateArticle(editing.id, title.trim(), content.trim(), type === 'article' ? points : undefined);
      navigate(`/articles/${editing.id}`);
    } catch (e) { setSaveErr(`保存失败：${e.message}`); setSaving(false); }
  };
  const publish = async () => {
    const plain = stripImages(content); // 图片标记不进分类/摘要/原话
    const text = `${title}\n${plain}`;
    const guessed = type === 'article' ? points[0]?.决策类型 : request?.conditions.决策类型 ?? guessType(text);
    const date = new Date().toLocaleDateString('sv-SE'); // 本地日期 YYYY-MM-DD（toISOString 是 UTC，会差一天）
    setSaving(true); setSaveErr('');
    let article;
    try {
      article = await api.publish({
        id: `a${Date.now()}`, authorId: user.personId, type, status: 'published', requestId: request?.id,
        category: guessed ?? '未分类', title: title.trim(), content: content.trim(),
        summary: plain.slice(0, 60) + (plain.length > 60 ? '…' : ''),
        tags: [], stars: 0, bookmarks: 0, views30d: 0, date,
        readTime: `${Math.max(3, Math.ceil(content.length / 300))} 分钟`,
        decisionPoints: type === 'article' ? points : undefined,
      });
    } catch (e) { setSaveErr(`发布失败：${e.message}`); setSaving(false); return; }
    if (request) Object.assign(request, { status: '已有人写', articleId: article.id }); // 内存里的求经验单；通知读者由后端发
    navigate(`/articles/${article.id}`);
  };

  return (
    <div className="lm-pg">
      <PageHead label={<>写<em>经验</em></>} title={editing ? '修改文章' : type === 'article' ? '写一段你的决策经历' : '写一篇人物日记'}
        sub="决策类型、学校层级、结果等信息会由 AI 从正文里提取，不用自己选分类。" />
      <div className="lm-wrap lm-wr">
        {request && <p className="lm-req">来自求经验：已有 {request.wantCount} 位读者想知道「{request.query}」</p>}
        {!editing && (
          <div className="lm-seg" role="group" aria-label="类型">
            <button type="button" aria-pressed={type === 'article'} onClick={() => edit(setType)('article')}>经验文章（决策经历）</button>
            <button type="button" aria-pressed={type === 'diary'} onClick={() => edit(setType)('diary')}>人物日记（近况/回顾）</button>
          </div>
        )}
        {preview ? (
          <div className="lm-wr-pv lm-ar">
            <h2>{title || '（未填标题）'}</h2>
            <ArticleBody text={content} />
          </div>
        ) : (
          <>
            <label className="lm-fl"><span>标题</span>
              <input className="lm-in" value={title} onChange={(e) => edit(setTitle)(e.target.value)} placeholder="例：双非金融，大三申光华金融硕士夏令营" />
            </label>
            <div className="lm-img-row">
              <button type="button" onClick={() => fileRef.current.click()} disabled={uploading}>{uploading ? '上传中…' : '插入图片'}</button>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => insertImage(e.target.files[0])} />
              <span>jpg / png / webp，5 MB 以内</span>
              {imgNote && <span className="warn">{imgNote}</span>}
            </div>
            <textarea ref={textRef} className="lm-in lm-body" aria-label="正文" rows={14} value={content} onChange={(e) => edit(setContent)(e.target.value)} placeholder="直接写…" />
            <p className="lm-tip">可以写写：当时的你、考虑过哪些路、最后怎么选、结果如何。没走成的路也很有价值，请照实写。</p>
          </>
        )}
        {type === 'article' && points && (
          <div className="lm-dps">
            <h2>AI 从文章里整理出的决策点</h2>
            <p>读者会用这些条件找到你。请检查一遍，有错直接改；改了标题或正文会重新整理。</p>
            {aiNote && <p className="warn">{aiNote}</p>}
            <DecisionPointsEditor points={points} onChange={setPoints} />
          </div>
        )}
        <div className="lm-acts">
          {saveErr && <span className="err" role="status">{saveErr}</span>}
          <button type="button" className="lm-btn-line" onClick={() => setPreview(!preview)}>{preview ? '继续编辑' : '预览'}</button>
          <button type="button" className="lm-btn-ink" onClick={needPoints ? extract : editing ? save : publish} disabled={!canPublish}>
            {extracting ? 'AI 整理中…' : needPoints ? '下一步：AI 整理决策点' : editing ? (saving ? '保存中…' : '保存修改') : (saving ? '发布中…' : '确认发布')}
          </button>
        </div>
      </div>
    </div>
  );
}
