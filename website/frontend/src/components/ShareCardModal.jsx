import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import useModal from './useModal';

function QR({ text }) {
  const [src, setSrc] = useState('');
  useEffect(() => { QRCode.toDataURL(text, { margin: 1, width: 288 }).then(setSrc); }, [text]);
  return src ? <img src={src} alt="个人页二维码" /> : <div className="ph" />;
}

// 经历名片：头像 + 一句话 + 三个关键转折 + 二维码
export default function ShareCardModal({ person, onClose }) {
  const url = `${window.location.origin}/people/${person.id}`;

  const box = useModal(onClose);
  return (
    <div className="lm-modal">
      <div className="lm-modal-scrim" onClick={onClose} />
      <div ref={box} className="lm-nc" role="dialog" aria-modal="true" aria-labelledby="lm-nc-t">
        <div className="lm-nc-top">
          <button type="button" className="lm-x" onClick={onClose} aria-label="关闭"><i /><i /></button>
          <div className="lm-nc-id"><img src={person.avatar} alt="" /><div><h3 id="lm-nc-t">{person.name}</h3><p>{person.school}</p></div></div>
          <p>{person.tagline}</p>
        </div>
        <div className="lm-nc-bd">
          <div>
            <p className="lab">三个关键转折</p>
            <ol>
              {/* ponytail: 取时间线最后 3 条当关键转折；之后让作者在时间线上标 key 旗标 */}
              {person.timeline.slice(-3).map((t) => <li key={t.year + t.title}><span>{t.year}</span><div><b>{t.title}</b> · {t.desc}</div></li>)}
            </ol>
          </div>
          <div className="lm-nc-qr">
            <QR text={url} />
            <p>{url}</p>
            <p>扫码查看完整经历 · 鹿鸣 LUMING</p>
          </div>
        </div>
      </div>
    </div>
  );
}
