import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState } from '../context/AppState';
import EmailCodeForm from '../components/EmailCodeForm';
import PasswordInput from '../components/PasswordInput';


// 邮箱＋密码登录；失败显示后端的中文原因
function PasswordForm({ onSubmit }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await onSubmit(email.trim(), password); } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  return (
    <form onSubmit={submit} className="lm-form">
      <label className="lm-fld"><span>邮箱</span>
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
      </label>
      <label className="lm-fld"><span>密码</span>
        <PasswordInput autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="输入密码" required />
      </label>
      {err && <p className="lm-msg err" role="status">{err}</p>}
      <button type="submit" className="lm-go" disabled={busy || !password}>登录</button>
    </form>
  );
}

const ROLES = [
  { role: 'reader', label: '以示例读者登录' },
  { role: 'sharer', label: '以示例分享者登录' },
];

// 平常用邮箱＋密码登录；注册（或忘记密码）才要邮箱验证码，顺便设密码。下面保留演示模式，评审不用注册也能试
export default function LoginPage() {
  const { login, loginWithCode, loginWithPassword } = useAppState();
  const [tab, setTab] = useState('password'); // password | code
  const navigate = useNavigate();
  // react-router 在 history.state.idx 记录站内第几页；0 表示没有上一页
  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/', { replace: true }));

  return (
    <div className="lm-lg-wrap lm-bleed">
      <div className="lm-lg">
        <button type="button" className="lm-x" aria-label="关闭，回上一页" onClick={back}><i /><i /></button>
        <div className="lm-lg-h">
          <span className="lm-lg-en">LOGIN</span>
          <h1>登录 / 注册 鹿鸣</h1>
          <p>任何邮箱都能注册成读者，注册时验证一次邮箱并设密码，之后用密码登录；用其他邮箱注册的北大同学，登录后在「我的内容管理」验证北大邮箱，也能升级为分享者</p>
        </div>
        <div className="lm-lg-sec">
          <p className="lm-lg-note"><b>北大同学看这里：</b>直接用北大邮箱（<b>@pku.edu.cn</b> 或 <b>@stu.pku.edu.cn</b>）注册，就自动成为分享者，可以马上写经验，不用再验证第二次。</p>
        </div>
        <div className="lm-lg-sec">
          <div className="lm-ktab" role="tablist" aria-label="登录方式">
            <button type="button" role="tab" aria-selected={tab === 'password'} onClick={() => setTab('password')}>密码登录</button>
            <button type="button" role="tab" aria-selected={tab === 'code'} onClick={() => setTab('code')}>注册 / 忘记密码</button>
          </div>
          {tab === 'password' ? (
            <>
              <PasswordForm onSubmit={async (email, password) => { await loginWithPassword(email, password); back(); }} />
              <p className="lm-lg-alt">还没账号、忘记密码，或以前用验证码登录还没设密码？<button type="button" onClick={() => setTab('code')}>用验证码设一次</button></p>
            </>
          ) : (
            <EmailCodeForm withPassword submitLabel="验证并设密码，登录" onSubmit={async (email, code, password) => { await loginWithCode(email, code, password); back(); }} />
          )}
        </div>
        <div className="lm-lg-sec lm-lg-demo">
          <p>演示模式：不用注册，直接用示例账号看看</p>
          <div>{ROLES.map((r) => <button key={r.role} type="button" onClick={async () => { await login(r.role); back(); }}>{r.label}</button>)}</div>
        </div>
      </div>
    </div>
  );
}
