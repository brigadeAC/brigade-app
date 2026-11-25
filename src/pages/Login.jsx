import React, { useEffect, useState } from 'react';
import { BrandWordmarkImage } from "@/components/BrandMark";
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { base44 } from '@/api/base44Client';
import { createPageUrl } from '@/utils';

// One page for signing in, joining from an invite link (/Login#invite=...),
// choosing a new password (/Login#reset=...) and asking for an emailed link.
const readLink = () => {
  const m = /^#(invite|reset)=([\w-]+)$/.exec(window.location.hash || '');
  return m ? { kind: m[1], token: m[2] } : null;
};

const routeForUser = (user) => {
  if (user?.role === 'admin') return createPageUrl('Dashboard');
  if (user?.user_type === 'client') return createPageUrl('ClientDashboard');
  if (user?.user_type === 'independent') return createPageUrl('IndependentDashboard');
  return createPageUrl('Dashboard');
};

// Only ever return to a page on this site.
const safeNext = () => {
  const next = new URLSearchParams(window.location.search).get('next');
  if (!next) return null;
  try {
    const u = new URL(next, window.location.origin);
    if (u.origin !== window.location.origin || /^\/(Login|Home)?$/.test(u.pathname)) return null;
    return u.pathname + u.search;
  } catch { return null; }
};

const inputClass = "w-full rounded-lg bg-background border border-border px-3 py-2 text-foreground outline-none focus:border-primary disabled:opacity-70";

const Field = ({ id, label, ...props }) => (
  <div>
    <label htmlFor={id} className="block text-sm text-muted-foreground mb-1">{label}</label>
    <input id={id} required className={inputClass} {...props} />
  </div>
);

const TITLES = {
  login: 'Sign in to your account',
  forgot: 'Get a link by email',
  join: 'Create your account',
  invite: 'Create your Brigade account',
  reset: 'Choose a new password',
  badlink: 'This link no longer works',
};

export default function Login() {
  const { login, register, resetPassword } = useAuth();
  const navigate = useNavigate();
  const [link, setLink] = useState(readLink);
  const [info, setInfo] = useState(null);
  const [mode, setMode] = useState(() => {
    if (readLink()) return 'loading';
    return new URLSearchParams(window.location.search).get('mode') === 'signup' ? 'join' : 'login';
  });
  const [form, setForm] = useState({ email: '', password: '', confirm: '', full_name: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const go = (m) => { setMode(m); setError(''); setNotice(''); };

  // Opening a second link while this page is already showing.
  useEffect(() => {
    const onHash = () => { const l = readLink(); if (l) { setLink(l); setMode('loading'); setError(''); } };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!link) return undefined;
    let live = true;
    base44.auth.linkInfo(link.token).then((i) => {
      if (!live) return;
      setInfo(i);
      setForm({ email: i.email, password: '', confirm: '', full_name: i.full_name || '' });
      setMode(i.kind);
    }).catch((e) => {
      if (!live) return;
      setError(e?.status === 410 ? '' : (e?.message || 'Something went wrong. Please try again.'));
      setMode('badlink');
    });
    return () => { live = false; };
  }, [link]);

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setNotice('');
    if ((mode === 'invite' || mode === 'reset') && form.password !== form.confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      if (mode === 'forgot' || mode === 'join') {
        const r = await base44.auth.forgot(form.email);
        setNotice(r.email_enabled
          ? `If ${form.email.trim()} is on file, a link is on its way. Check your spam folder too.`
          : "Email isn't set up yet. Ask your coach or the front desk for a link.");
        return;
      }
      let user;
      if (mode === 'invite') user = await register({ token: link.token, full_name: form.full_name, password: form.password });
      else if (mode === 'reset') user = await resetPassword(link.token, form.password);
      else user = await login(form.email, form.password);
      navigate(safeNext() || routeForUser(user), { replace: true });
    } catch (err) {
      setError(err?.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const linkButton = (label, m) => (
    <button type="button" onClick={() => { window.history.replaceState(null, '', '/Login'); setLink(null); go(m); }} className="text-primary hover:underline font-medium">{label}</button>
  );

  const submitLabel = { login: 'Sign in', forgot: 'Email me a link', join: 'Email me a link', invite: 'Create account', reset: 'Save new password' }[mode];

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <BrandWordmarkImage className="h-16" />
          <p className="text-muted-foreground text-sm mt-5">{TITLES[mode] || 'Checking your link'}</p>
        </div>

        {mode === 'loading' ? null : mode === 'badlink' ? (
          <div className="bg-card border border-border rounded-2xl p-6 space-y-4 shadow-sm text-sm text-foreground">
            <p>{error || 'It expired or was already used. Links work once. Ask your coach or the front desk for a new one, or get one by email.'}</p>
            <p className="flex gap-6">{linkButton('Sign in', 'login')}{linkButton('Email me a link', 'forgot')}</p>
          </div>
        ) : (
          <form onSubmit={submit} className="bg-card border border-border rounded-2xl p-6 space-y-4 shadow-sm">
            {mode === 'join' && (
              <p className="text-sm text-muted-foreground">
                Brigade accounts are by invitation. Open the link your coach sent you, or enter the email the gym has for you and we'll send one.
              </p>
            )}
            {mode === 'invite' && <Field id="full_name" label="Full name" type="text" autoComplete="name" value={form.full_name} onChange={set('full_name')} />}
            <Field id="email" label="Email" type="email" autoComplete="username" value={form.email} onChange={set('email')} disabled={!!info && (mode === 'invite' || mode === 'reset')} />
            {['login', 'invite', 'reset'].includes(mode) && (
              <Field id="password" label={mode === 'login' ? 'Password' : 'New password (8 or more characters)'} type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'login' ? undefined : 8}
                value={form.password} onChange={set('password')} />
            )}
            {(mode === 'invite' || mode === 'reset') && (
              <Field id="confirm" label="Type it again" type="password" autoComplete="new-password" minLength={8} value={form.confirm} onChange={set('confirm')} />
            )}

            {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
            {notice && <p role="status" className="text-sm text-foreground bg-secondary rounded-lg p-3">{notice}</p>}

            <button type="submit" disabled={loading}
              className="w-full rounded-[6px] bg-primary py-3 text-sm font-bold uppercase tracking-[0.08em] text-primary-foreground hover:opacity-90 disabled:opacity-60 transition">
              {loading ? 'Please wait…' : submitLabel}
            </button>

            <div className="text-center text-sm text-muted-foreground space-y-2">
              {mode === 'login' && <p>{linkButton('Forgot your password?', 'forgot')}</p>}
              {mode === 'login' && <p>New here? {linkButton('Create your account', 'join')}</p>}
              {mode !== 'login' && <p>Already have an account? {linkButton('Sign in', 'login')}</p>}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
