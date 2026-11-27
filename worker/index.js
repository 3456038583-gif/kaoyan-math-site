/**
 * 考研资料总库 · Cloudflare Worker 后端
 *
 * 功能：
 * - 多方式统一登录：邮箱密码（开箱即用）、邮箱验证码（Resend）、Google OAuth、GitHub OAuth、手机号验证码（Twilio / 自定义 Webhook）
 * - 多身份自动关联：同一用户可绑定邮箱、Google、GitHub、手机号，跨主站 kaoyan.feikntn111.com 与数学站 math.feikntn111.com 共享登录态
 * - 本地优先云同步：/api/sync/pull 与 /api/sync/push（按 localStorage key 增量同步，时间戳 LWW 防覆盖）
 */

const SESSION_COOKIE = 'ky_sid';
const OAUTH_STATE_COOKIE = 'ky_oauth_st';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const CODE_TTL_MS = 10 * 60 * 1000; // 10 分钟
const MAX_KEY_LEN = 128;
const MAX_VAL_LEN = 512 * 1024; // 单 key 最大 512KB
const MAX_BATCH_ITEMS = 200;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not Found', { status: 404 });
    }

    try {
      return await handleApi(request, env, url);
    } catch (err) {
      console.error('API Error:', err);
      return json({ error: '服务器内部错误，请稍后重试' }, 500);
    }
  }
};

/* ─────────────────────────── 路由分发 ─────────────────────────── */

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  // 健康检查与可用登录方式
  if (method === 'GET' && path === '/api/health') {
    return json({ ok: true, time: Date.now(), providers: getEnabledProviders(env) });
  }
  if (method === 'GET' && path === '/api/auth/providers') {
    return json({ providers: getEnabledProviders(env) });
  }

  // 当前登录态
  if (method === 'GET' && path === '/api/auth/me') {
    const user = await getSessionUser(request, env);
    return json({ user, providers: getEnabledProviders(env) });
  }
  if (method === 'POST' && path === '/api/auth/logout') {
    const sid = getCookie(request, SESSION_COOKIE);
    if (sid) {
      const sidHash = await sha256Hex(sid);
      await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sidHash).run();
    }
    return json({ ok: true }, 200, { 'Set-Cookie': buildClearCookie(request, SESSION_COOKIE) });
  }

  // 邮箱 + 密码
  if (method === 'POST' && path === '/api/auth/register') {
    return handleEmailRegister(request, env);
  }
  if (method === 'POST' && path === '/api/auth/login') {
    return handleEmailLogin(request, env);
  }

  // 邮箱验证码免密登录/注册
  if (method === 'POST' && path === '/api/auth/email/send-code') {
    return handleSendEmailCode(request, env);
  }
  if (method === 'POST' && path === '/api/auth/email/verify') {
    return handleVerifyEmailCode(request, env);
  }

  // 手机号短信验证码登录/绑定
  if (method === 'POST' && path === '/api/auth/phone/send-code') {
    return handleSendPhoneCode(request, env);
  }
  if (method === 'POST' && path === '/api/auth/phone/verify') {
    return handleVerifyPhoneCode(request, env);
  }

  // OAuth: Google & GitHub
  if (method === 'GET' && path === '/api/auth/oauth/google/start') {
    return handleOAuthStart(request, env, 'google');
  }
  if (method === 'GET' && path === '/api/auth/oauth/google/callback') {
    return handleOAuthCallback(request, env, 'google');
  }
  if (method === 'GET' && path === '/api/auth/oauth/github/start') {
    return handleOAuthStart(request, env, 'github');
  }
  if (method === 'GET' && path === '/api/auth/oauth/github/callback') {
    return handleOAuthCallback(request, env, 'github');
  }

  // 云同步
  if (method === 'GET' && path === '/api/sync/pull') {
    return handleSyncPull(request, env, url);
  }
  if (method === 'POST' && path === '/api/sync/push') {
    return handleSyncPush(request, env);
  }

  return json({ error: 'Not Found' }, 404);
}

/* ─────────────────────────── 登录方式能力探测 ─────────────────────────── */

function getEnabledProviders(env) {
  return {
    emailPassword: true,
    emailCode: Boolean(env.RESEND_API_KEY),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    phone: Boolean(
      (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM) ||
      env.SMS_WEBHOOK_URL
    )
  };
}

/* ─────────────────────────── 邮箱 + 密码 ─────────────────────────── */

async function handleEmailRegister(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const password = String(body?.password || '');
  const name = String(body?.name || '').trim().slice(0, 40);

  if (!isValidEmail(email)) return json({ error: '请输入有效的邮箱地址' }, 400);
  if (password.length < 6 || password.length > 128) return json({ error: '密码长度需在 6 到 128 位之间' }, 400);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return json({ error: '该邮箱已注册，请直接登录' }, 409);

  const now = Date.now();
  const userId = crypto.randomUUID();
  const pwHash = await hashPassword(password);
  const displayName = name || email.split('@')[0];

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO users (id, email, name, password_hash, email_verified, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'
    ).bind(userId, email, displayName, pwHash, now, now, now),
    env.DB.prepare(
      'INSERT INTO auth_identities (id, user_id, provider, provider_user_id, provider_email, provider_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), userId, 'email', email, email, displayName, now)
  ]);

  return createSessionResponse(request, env, userId, 201);
}

async function handleEmailLogin(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const password = String(body?.password || '');

  if (!isValidEmail(email) || !password) return json({ error: '请输入邮箱和密码' }, 400);

  const row = await env.DB.prepare('SELECT id, password_hash FROM users WHERE email = ?').bind(email).first();
  if (!row || !row.password_hash) {
    return json({ error: '邮箱或密码不正确（若曾使用第三方或验证码注册，请用对应方式登录）' }, 401);
  }

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return json({ error: '邮箱或密码不正确' }, 401);

  await env.DB.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?')
    .bind(Date.now(), Date.now(), row.id).run();

  return createSessionResponse(request, env, row.id, 200);
}

/* ─────────────────────────── 邮箱验证码（Resend） ─────────────────────────── */

async function handleSendEmailCode(request, env) {
  if (!env.RESEND_API_KEY) {
    return json({ error: '站点尚未配置邮箱发信服务（RESEND_API_KEY），请先使用邮箱密码登录' }, 503);
  }

  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!isValidEmail(email)) return json({ error: '请输入有效的邮箱地址' }, 400);

  const ip = getClientIp(request);
  const rateErr = await checkCodeRateLimit(env, 'email', email, ip);
  if (rateErr) return json({ error: rateErr }, 429);

  const code = randomDigits(6);
  const now = Date.now();
  const codeHash = await sha256Hex(`email:${email}:${code}`);

  await env.DB.prepare(
    'INSERT INTO verification_codes (id, channel, target, purpose, code_hash, expires_at, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), 'email', email, 'login', codeHash, now + CODE_TTL_MS, ip, now).run();

  const from = env.RESEND_FROM || '考研资料总库 <noreply@feikntn111.com>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `【考研资料总库】登录验证码：${code}`,
      html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1b211d;line-height:1.6">
        <h2 style="margin:0 0 12px;font-size:18px">考研资料总库 · 邮箱验证</h2>
        <p>你的登录验证码为：</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:6px;padding:14px 20px;background:#f5f4ee;border-radius:8px;display:inline-block;margin:8px 0;color:#2f5d8a">${code}</div>
        <p style="color:#6d746c;font-size:13px">验证码 10 分钟内有效，请勿泄露给他人。如非本人操作请忽略本邮件。</p>
      </div>`
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error('Resend error:', res.status, errText);
    return json({ error: '邮件发送失败，请稍后重试' }, 502);
  }

  return json({ ok: true, cooldown: 60 });
}

async function handleVerifyEmailCode(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const code = String(body?.code || '').trim();
  if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
    return json({ error: '请输入有效的邮箱和 6 位验证码' }, 400);
  }

  const verifyErr = await consumeVerificationCode(env, 'email', email, code);
  if (verifyErr) return json({ error: verifyErr }, 400);

  const now = Date.now();
  const currentUser = await getSessionUser(request, env);
  let row = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();

  if (row) {
    await env.DB.prepare('UPDATE users SET email_verified = 1, last_login_at = ?, updated_at = ? WHERE id = ?')
      .bind(now, now, row.id).run();
    return createSessionResponse(request, env, row.id, 200);
  }

  if (currentUser && !currentUser.email) {
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET email = ?, email_verified = 1, updated_at = ? WHERE id = ?')
        .bind(email, now, currentUser.id),
      env.DB.prepare(
        'INSERT OR IGNORE INTO auth_identities (id, user_id, provider, provider_user_id, provider_email, provider_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), currentUser.id, 'email', email, email, currentUser.name, now)
    ]);
    return createSessionResponse(request, env, currentUser.id, 200);
  }

  const userId = crypto.randomUUID();
  const displayName = email.split('@')[0];
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO users (id, email, name, email_verified, created_at, updated_at, last_login_at) VALUES (?, ?, ?, 1, ?, ?, ?)'
    ).bind(userId, email, displayName, now, now, now),
    env.DB.prepare(
      'INSERT INTO auth_identities (id, user_id, provider, provider_user_id, provider_email, provider_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), userId, 'email', email, email, displayName, now)
  ]);

  return createSessionResponse(request, env, userId, 200);
}

/* ─────────────────────────── 手机号短信验证码 ─────────────────────────── */

async function handleSendPhoneCode(request, env) {
  const hasTwilio = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
  const hasWebhook = Boolean(env.SMS_WEBHOOK_URL);
  if (!hasTwilio && !hasWebhook) {
    return json({ error: '站点尚未配置短信通道（Twilio 或自定义短信 Webhook），请使用邮箱或第三方登录' }, 503);
  }

  const body = await readJson(request);
  const phone = normalizePhone(body?.phone);
  if (!phone) return json({ error: '请输入有效的手机号（如 13800138000 或 +8613800138000）' }, 400);

  const ip = getClientIp(request);
  const rateErr = await checkCodeRateLimit(env, 'sms', phone, ip);
  if (rateErr) return json({ error: rateErr }, 429);

  const code = randomDigits(6);
  const now = Date.now();
  const codeHash = await sha256Hex(`sms:${phone}:${code}`);

  await env.DB.prepare(
    'INSERT INTO verification_codes (id, channel, target, purpose, code_hash, expires_at, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), 'sms', phone, 'login', codeHash, now + CODE_TTL_MS, ip, now).run();

  if (hasWebhook) {
    const headers = { 'Content-Type': 'application/json' };
    if (env.SMS_WEBHOOK_SECRET) headers['Authorization'] = `Bearer ${env.SMS_WEBHOOK_SECRET}`;
    const res = await fetch(env.SMS_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone, code, ttlMinutes: 10 })
    });
    if (!res.ok) return json({ error: '短信发送失败，请稍后重试' }, 502);
  } else {
    const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
    const form = new URLSearchParams({
      To: phone,
      From: env.TWILIO_FROM,
      Body: `【考研资料总库】你的登录验证码是 ${code}，10分钟内有效。`
    });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form.toString()
      }
    );
    if (!res.ok) return json({ error: '短信发送失败，请稍后重试' }, 502);
  }

  return json({ ok: true, cooldown: 60 });
}

async function handleVerifyPhoneCode(request, env) {
  const body = await readJson(request);
  const phone = normalizePhone(body?.phone);
  const code = String(body?.code || '').trim();
  if (!phone || !/^\d{6}$/.test(code)) {
    return json({ error: '请输入有效的手机号和 6 位验证码' }, 400);
  }

  const verifyErr = await consumeVerificationCode(env, 'sms', phone, code);
  if (verifyErr) return json({ error: verifyErr }, 400);

  const now = Date.now();
  const currentUser = await getSessionUser(request, env);
  const row = await env.DB.prepare('SELECT id FROM users WHERE phone = ?').bind(phone).first();

  if (row) {
    await env.DB.prepare('UPDATE users SET phone_verified = 1, last_login_at = ?, updated_at = ? WHERE id = ?')
      .bind(now, now, row.id).run();
    return createSessionResponse(request, env, row.id, 200);
  }

  if (currentUser && !currentUser.phone) {
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET phone = ?, phone_verified = 1, updated_at = ? WHERE id = ?')
        .bind(phone, now, currentUser.id),
      env.DB.prepare(
        'INSERT OR IGNORE INTO auth_identities (id, user_id, provider, provider_user_id, provider_name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), currentUser.id, 'phone', phone, maskPhone(phone), now)
    ]);
    return createSessionResponse(request, env, currentUser.id, 200);
  }

  const userId = crypto.randomUUID();
  const displayName = maskPhone(phone);
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO users (id, phone, name, phone_verified, created_at, updated_at, last_login_at) VALUES (?, ?, ?, 1, ?, ?, ?)'
    ).bind(userId, phone, displayName, now, now, now),
    env.DB.prepare(
      'INSERT INTO auth_identities (id, user_id, provider, provider_user_id, provider_name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), userId, 'phone', phone, displayName, now)
  ]);

  return createSessionResponse(request, env, userId, 200);
}

/* ─────────────────────────── OAuth (Google / GitHub) ─────────────────────────── */

function getOAuthCallbackOrigin(request) {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  if (host === 'feikntn111.com' || host.endsWith('.feikntn111.com')) return 'https://kaoyan.feikntn111.com';
  if (host === 'feikntn111.us.ci' || host.endsWith('.feikntn111.us.ci')) return 'https://kaoyan.feikntn111.us.ci';
  return `${url.protocol}//${url.host}`;
}

function sanitizeReturnUrl(raw, fallbackOrigin) {
  const s = String(raw || '/');
  if (s.startsWith('/') && !s.startsWith('//')) return `${fallbackOrigin}${s}`;
  try {
    const u = new URL(s);
    const h = u.hostname.toLowerCase();
    if (
      (u.protocol === 'https:' && (h === 'feikntn111.com' || h.endsWith('.feikntn111.com') || h === 'feikntn111.us.ci' || h.endsWith('.feikntn111.us.ci'))) ||
      `${u.protocol}//${u.host}` === fallbackOrigin
    ) {
      return u.toString();
    }
  } catch (_) {}
  return `${fallbackOrigin}/`;
}

async function handleOAuthStart(request, env, provider) {
  const url = new URL(request.url);
  const reqOrigin = `${url.protocol}//${url.host}`;
  const returnTo = sanitizeReturnUrl(url.searchParams.get('next') || '/', reqOrigin);
  const cbOrigin = getOAuthCallbackOrigin(request);
  const state = randomToken(18);
  const statePayload = btoa(JSON.stringify({ s: state, n: returnTo, p: provider }));

  let authUrl;
  if (provider === 'google') {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return redirectWithError(returnTo, 'Google 登录尚未配置');
    }
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    u.searchParams.set('redirect_uri', `${cbOrigin}/api/auth/oauth/google/callback`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', state);
    u.searchParams.set('prompt', 'select_account');
    authUrl = u.toString();
  } else {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      return redirectWithError(returnTo, 'GitHub 登录尚未配置');
    }
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
    u.searchParams.set('redirect_uri', `${cbOrigin}/api/auth/oauth/github/callback`);
    u.searchParams.set('scope', 'read:user user:email');
    u.searchParams.set('state', state);
    authUrl = u.toString();
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
      'Set-Cookie': buildCookie(request, OAUTH_STATE_COOKIE, statePayload, 600, true)
    }
  });
}

async function handleOAuthCallback(request, env, provider) {
  const url = new URL(request.url);
  const reqOrigin = `${url.protocol}//${url.host}`;
  const cbOrigin = getOAuthCallbackOrigin(request);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const rawState = getCookie(request, OAUTH_STATE_COOKIE);

  let saved = null;
  try { saved = rawState ? JSON.parse(atob(rawState)) : null; } catch (_) {}
  const next = sanitizeReturnUrl(saved?.n || '/', reqOrigin);

  if (!code || !state || !saved || saved.s !== state || saved.p !== provider) {
    return redirectWithError(next, '第三方登录校验失败，请重试');
  }

  let profile;

  if (provider === 'google') {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${cbOrigin}/api/auth/oauth/google/callback`,
        grant_type: 'authorization_code'
      }).toString()
    });
    if (!tokenRes.ok) return redirectWithError(next, 'Google 授权换取令牌失败');
    const tok = await tokenRes.json();
    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tok.access_token}` }
    });
    if (!infoRes.ok) return redirectWithError(next, '获取 Google 账号信息失败');
    const info = await infoRes.json();
    profile = {
      providerUserId: String(info.sub || ''),
      email: info.email_verified ? normalizeEmail(info.email) : '',
      name: String(info.name || info.email?.split('@')[0] || 'Google用户'),
      avatar: String(info.picture || '')
    };
  } else {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'kaoyan-hub-auth'
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${cbOrigin}/api/auth/oauth/github/callback`
      })
    });
    if (!tokenRes.ok) return redirectWithError(next, 'GitHub 授权换取令牌失败');
    const tok = await tokenRes.json();
    if (!tok.access_token) return redirectWithError(next, 'GitHub 授权失败');

    const ghHeaders = {
      Authorization: `Bearer ${tok.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'kaoyan-hub-auth'
    };
    const userRes = await fetch('https://api.github.com/user', { headers: ghHeaders });
    if (!userRes.ok) return redirectWithError(next, '获取 GitHub 账号信息失败');
    const uinfo = await userRes.json();

    let email = normalizeEmail(uinfo.email);
    if (!email) {
      const emRes = await fetch('https://api.github.com/user/emails', { headers: ghHeaders });
      if (emRes.ok) {
        const emails = await emRes.json();
        const primary = Array.isArray(emails) && (emails.find(e => e.primary && e.verified) || emails.find(e => e.verified));
        if (primary?.email) email = normalizeEmail(primary.email);
      }
    }
    profile = {
      providerUserId: String(uinfo.id || ''),
      email,
      name: String(uinfo.name || uinfo.login || 'GitHub用户'),
      avatar: String(uinfo.avatar_url || '')
    };
  }

  if (!profile.providerUserId) return redirectWithError(next, '未能读取第三方账号 ID');

  const userId = await resolveOrCreateOAuthUser(request, env, provider, profile);
  const sid = await issueSession(request, env, userId);

  const headers = new Headers({ Location: next });
  headers.append('Set-Cookie', buildCookie(request, SESSION_COOKIE, sid, SESSION_TTL_MS / 1000, true));
  headers.append('Set-Cookie', buildClearCookie(request, OAUTH_STATE_COOKIE, true));
  return new Response(null, { status: 302, headers });
}

async function resolveOrCreateOAuthUser(request, env, provider, profile) {
  const now = Date.now();
  const ident = await env.DB.prepare(
    'SELECT user_id FROM auth_identities WHERE provider = ? AND provider_user_id = ?'
  ).bind(provider, profile.providerUserId).first();

  if (ident) {
    await env.DB.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?')
      .bind(now, now, ident.user_id).run();
    return ident.user_id;
  }

  // 若当前已登录，直接绑定到当前账号
  const currentUser = await getSessionUser(request, env);
  if (currentUser) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO auth_identities (id, user_id, provider, provider_user_id, provider_email, provider_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), currentUser.id, provider, profile.providerUserId, profile.email || null, profile.name, now).run();
    return currentUser.id;
  }

  // 若第三方返回了已验证邮箱，且已有同邮箱账号，则自动合并关联
  if (profile.email) {
    const byEmail = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(profile.email).first();
    if (byEmail) {
      await env.DB.batch([
        env.DB.prepare(
          'INSERT OR IGNORE INTO auth_identities (id, user_id, provider, provider_user_id, provider_email, provider_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(crypto.randomUUID(), byEmail.id, provider, profile.providerUserId, profile.email, profile.name, now),
        env.DB.prepare('UPDATE users SET email_verified = 1, last_login_at = ?, updated_at = ? WHERE id = ?')
          .bind(now, now, byEmail.id)
      ]);
      return byEmail.id;
    }
  }

  // 创建新用户
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO users (id, email, name, avatar_url, email_verified, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(userId, profile.email || null, profile.name, profile.avatar, profile.email ? 1 : 0, now, now, now),
    env.DB.prepare(
      'INSERT INTO auth_identities (id, user_id, provider, provider_user_id, provider_email, provider_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), userId, provider, profile.providerUserId, profile.email || null, profile.name, now)
  ]);
  return userId;
}

/* ─────────────────────────── 云端学习数据同步 ─────────────────────────── */

async function handleSyncPull(request, env, url) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: '未登录' }, 401);

  const since = Math.max(0, Number(url.searchParams.get('since') || 0) || 0);
  const res = since > 0
    ? await env.DB.prepare(
        'SELECT storage_key, value, deleted, updated_at, version FROM user_kv WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC'
      ).bind(user.id, since).all()
    : await env.DB.prepare(
        'SELECT storage_key, value, deleted, updated_at, version FROM user_kv WHERE user_id = ? AND deleted = 0 ORDER BY updated_at ASC'
      ).bind(user.id).all();

  const items = (res.results || []).map(r => ({
    key: r.storage_key,
    value: r.value,
    deleted: Boolean(r.deleted),
    updatedAt: r.updated_at,
    version: r.version
  }));

  return json({ serverTime: Date.now(), count: items.length, items });
}

async function handleSyncPush(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: '未登录' }, 401);

  const body = await readJson(request);
  const rawItems = Array.isArray(body?.items) ? body.items : [];
  if (!rawItems.length) return json({ ok: true, serverTime: Date.now(), saved: 0 });
  if (rawItems.length > MAX_BATCH_ITEMS) {
    return json({ error: `单次最多同步 ${MAX_BATCH_ITEMS} 项` }, 400);
  }

  const now = Date.now();
  const stmts = [];
  const force = Boolean(body?.force);

  for (const it of rawItems) {
    const key = String(it?.key || '');
    if (!isAllowedStorageKey(key)) continue;

    const deleted = it?.deleted ? 1 : 0;
    const val = deleted ? null : (typeof it?.value === 'string' ? it.value : JSON.stringify(it?.value ?? ''));
    if (val !== null && val.length > MAX_VAL_LEN) {
      return json({ error: `数据项 ${key} 体积超过限制` }, 413);
    }
    const ts = Number(it?.updatedAt) > 1e12 ? Math.min(Number(it.updatedAt), now + 60000) : now;

    if (force) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO user_kv (user_id, storage_key, value, deleted, updated_at, version)
           VALUES (?, ?, ?, ?, ?, 1)
           ON CONFLICT(user_id, storage_key) DO UPDATE SET
             value = excluded.value,
             deleted = excluded.deleted,
             updated_at = excluded.updated_at,
             version = user_kv.version + 1`
        ).bind(user.id, key, val, deleted, now)
      );
    } else {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO user_kv (user_id, storage_key, value, deleted, updated_at, version)
           VALUES (?, ?, ?, ?, ?, 1)
           ON CONFLICT(user_id, storage_key) DO UPDATE SET
             value = excluded.value,
             deleted = excluded.deleted,
             updated_at = excluded.updated_at,
             version = user_kv.version + 1
           WHERE excluded.updated_at >= user_kv.updated_at`
        ).bind(user.id, key, val, deleted, ts)
      );
    }
  }

  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, serverTime: now, saved: stmts.length });
}

function isAllowedStorageKey(key) {
  if (!key || key.length > MAX_KEY_LEN) return false;
  return /^kaoyan/i.test(key);
}

/* ─────────────────────────── 会话与验证码公共工具 ─────────────────────────── */

async function issueSession(request, env, userId) {
  const sid = randomToken(32);
  const sidHash = await sha256Hex(sid);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, user_agent, ip, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    sidHash,
    userId,
    (request.headers.get('User-Agent') || '').slice(0, 200),
    getClientIp(request),
    now + SESSION_TTL_MS,
    now,
    now
  ).run();
  return sid;
}

async function createSessionResponse(request, env, userId, status = 200) {
  const sid = await issueSession(request, env, userId);
  const user = await loadUserProfile(env, userId);
  return json({ ok: true, user }, status, {
    'Set-Cookie': buildCookie(request, SESSION_COOKIE, sid, SESSION_TTL_MS / 1000, true)
  });
}

async function getSessionUser(request, env) {
  const sid = getCookie(request, SESSION_COOKIE);
  if (!sid) return null;
  const sidHash = await sha256Hex(sid);
  const now = Date.now();
  const sess = await env.DB.prepare(
    'SELECT user_id, expires_at FROM sessions WHERE id = ?'
  ).bind(sidHash).first();
  if (!sess || sess.expires_at < now) return null;
  return loadUserProfile(env, sess.user_id);
}

async function loadUserProfile(env, userId) {
  const u = await env.DB.prepare(
    'SELECT id, email, phone, name, avatar_url, email_verified, phone_verified, created_at FROM users WHERE id = ?'
  ).bind(userId).first();
  if (!u) return null;
  const idents = await env.DB.prepare(
    'SELECT provider, provider_email, provider_name FROM auth_identities WHERE user_id = ?'
  ).bind(userId).all();
  return {
    id: u.id,
    email: u.email || '',
    phone: u.phone ? maskPhone(u.phone) : '',
    name: u.name || u.email?.split('@')[0] || '考研人',
    avatarUrl: u.avatar_url || '',
    emailVerified: Boolean(u.email_verified),
    phoneVerified: Boolean(u.phone_verified),
    providers: (idents.results || []).map(r => r.provider)
  };
}

async function checkCodeRateLimit(env, channel, target, ip) {
  const now = Date.now();
  const recentTarget = await env.DB.prepare(
    'SELECT created_at FROM verification_codes WHERE channel = ? AND target = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(channel, target).first();
  if (recentTarget && now - recentTarget.created_at < 60 * 1000) {
    return '发送过于频繁，请 60 秒后再试';
  }
  const ipCount = await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM verification_codes WHERE ip = ? AND created_at > ?'
  ).bind(ip, now - 3600 * 1000).first();
  if (ipCount && Number(ipCount.cnt) >= 12) {
    return '当前网络发送次数过多，请一小时后再试';
  }
  return null;
}

async function consumeVerificationCode(env, channel, target, code) {
  const now = Date.now();
  const row = await env.DB.prepare(
    'SELECT id, code_hash, expires_at, attempts, used_at FROM verification_codes WHERE channel = ? AND target = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1'
  ).bind(channel, target).first();
  if (!row) return '请先获取验证码';
  if (row.expires_at < now) return '验证码已过期，请重新获取';
  if (row.attempts >= 5) return '验证码输错次数过多，请重新获取';

  const expected = await sha256Hex(`${channel}:${target}:${code}`);
  if (expected !== row.code_hash) {
    await env.DB.prepare('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
    return '验证码不正确';
  }
  await env.DB.prepare('UPDATE verification_codes SET used_at = ? WHERE id = ?').bind(now, row.id).run();
  return null;
}

/* ─────────────────────────── 加密与通用工具 ─────────────────────────── */

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$${toHex(salt)}$${toHex(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
  const salt = fromHex(parts[1]);
  const expected = parts[2];
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  const actual = toHex(new Uint8Array(bits));
  return timingSafeEqual(actual, expected);
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return toHex(new Uint8Array(buf));
}

function randomToken(bytes = 24) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function randomDigits(len = 6) {
  const arr = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (let i = 0; i < len; i++) s += String(arr[i] % 10);
  return s;
}

function toHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

function fromHex(hex) {
  const u8 = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u8.length; i++) u8[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return u8;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 160;
}

function normalizePhone(v) {
  const s = String(v || '').replace(/[\s\-()]/g, '');
  if (/^1[3-9]\d{9}$/.test(s)) return `+86${s}`;
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  return '';
}

function maskPhone(p) {
  return p.length > 7 ? `${p.slice(0, p.length - 8)}****${p.slice(-4)}` : p;
}

function sanitizeNext(next) {
  const s = String(next || '/');
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  return '/';
}

function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
}

function getCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

function getCookieDomain(request) {
  const host = new URL(request.url).hostname.toLowerCase();
  if (host === 'feikntn111.com' || host.endsWith('.feikntn111.com')) return '.feikntn111.com';
  if (host === 'feikntn111.us.ci' || host.endsWith('.feikntn111.us.ci')) return '.feikntn111.us.ci';
  return '';
}

function buildCookie(request, name, value, maxAgeSec, shareSubdomain = true) {
  const isHttps = new URL(request.url).protocol === 'https:';
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `Max-Age=${Math.floor(maxAgeSec)}`, 'HttpOnly', 'SameSite=Lax'];
  if (isHttps) parts.push('Secure');
  if (shareSubdomain) {
    const dom = getCookieDomain(request);
    if (dom) parts.push(`Domain=${dom}`);
  }
  return parts.join('; ');
}

function buildClearCookie(request, name, shareSubdomain = true) {
  const isHttps = new URL(request.url).protocol === 'https:';
  const parts = [`${name}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (isHttps) parts.push('Secure');
  if (shareSubdomain) {
    const dom = getCookieDomain(request);
    if (dom) parts.push(`Domain=${dom}`);
  }
  return parts.join('; ');
}

function redirectWithError(next, msg) {
  const sep = next.includes('?') ? '&' : '?';
  return new Response(null, { status: 302, headers: { Location: `${next}${sep}auth_err=${encodeURIComponent(msg)}` } });
}

async function readJson(request) {
  try { return await request.json(); } catch (_) { return null; }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}
