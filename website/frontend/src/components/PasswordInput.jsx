import { useState } from 'react';

// 密码框＋眼睛切换显示；其余 props 照传给 <input>
const EYE = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>;
const EYE_OFF = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>;

export default function PasswordInput({ className, ...props }) {
  const [show, setShow] = useState(false);
  return (
    <div className="lm-pw">
      <input {...props} type={show ? 'text' : 'password'} className={className} />
      <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? '隐藏密码' : '显示密码'}>{show ? EYE_OFF : EYE}</button>
    </div>
  );
}
