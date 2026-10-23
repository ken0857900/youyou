import { useEffect, useState } from 'react';
import { sendCode } from '../data/api';
import PasswordInput from './PasswordInput';


// 邮箱＋验证码表单：登录页（purpose=register）跟北大邮箱升级（purpose=pku_verify）共用
// onSubmit(email, code, password) 失败要 throw Error(中文原因)；withPassword＝多一栏设密码（注册／忘记密码）
export default function EmailCodeForm({ purpose = 'register', placeholder = 'you@example.com', submitLabel, onSubmit, withPassword }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [wait, setWait] = useState(0); // 还要几秒才能重寄
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: '', ok: false });

  useEffect(() => {
    if (!wait) return undefined;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const run = async (fn) => {
    setBusy(true); setMsg({ text: '', ok: false });
    try { await fn(); } catch (e) { setMsg({ text: e.message, ok: false }); }
    setBusy(false);
  };
  const send = () => run(async () => {
    const r = await sendCode(email.trim(), purpose);
    setWait(r.resendAfter || 60);
    setMsg({ text: `验证码已寄到 ${email.trim()}，10 分钟内有效（没收到看看垃圾邮件）`, ok: true });
  });
  const submit = (e) => { e.preventDefault(); run(() => onSubmit(email.trim(), code.trim(), password)); };

  return (
    <form onSubmit={submit} className="lm-form">
      <label className="lm-fld"><span>邮箱</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={placeholder} required autoComplete="email" />
      </label>
      <div className="lm-fld"><span id="lm-code-l">验证码</span>
        <div className="lm-code-row">
          <input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="6 位验证码" aria-labelledby="lm-code-l" />
          <button type="button" onClick={send} disabled={busy || wait > 0 || !email.includes('@')}>{wait > 0 ? `${wait} 秒后重寄` : '获取验证码'}</button>
        </div>
      </div>
      {withPassword && (
        <label className="lm-fld"><span>设一个密码</span>
          <PasswordInput autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 8 位，之后用密码登录" required />
        </label>
      )}
      {msg.text && <p className={`lm-msg ${msg.ok ? 'ok' : 'err'}`} role="status">{msg.text}</p>}
      <button type="submit" className="lm-go" disabled={busy || code.length !== 6 || (withPassword && password.length < 8)}>{submitLabel}</button>
    </form>
  );
}
