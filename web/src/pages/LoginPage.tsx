import { useState } from 'react';
import { useApp } from '../store';

export default function LoginPage() {
  const login = useApp((s) => s.login);
  const [username, setUsername] = useState('hq');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await login(username, password);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>生鲜订货决策系统</h1>
        <div className="muted small">需求还原 · 分位预测 · 门店改量 · 收市复盘</div>
        <div className="field">
          <label>账号</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>密码</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="primary" disabled={busy}>{busy ? '登录中…' : '登录'}</button>
        {err && <div className="err">{err}</div>}
        <div className="hint">
          测试账号：总部 hq / hq123456；门店 store1 / store123456（朝阳门店）、
          store2 / store123456（海淀店）、store3 / store123456（通州店）
        </div>
      </form>
    </div>
  );
}
