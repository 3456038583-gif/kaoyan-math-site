/* 考研资料总库 · 全站统一账号（多方式登录）与本地优先云端同步引擎
 * - 自动挂载到 countdown.js 注入的顶栏 .ky-tools
 * - 未登录零干扰；登录后自动监听 localStorage 变动并防抖同步至 Cloudflare D1
 * - 跨 kaoyan.feikntn111.com / k.feikntn111.com / math.feikntn111.com 自动共享登录态
 */
(function () {
  'use strict';
  if (window.__KY_SYNC_LOADED) return;
  window.__KY_SYNC_LOADED = true;

  var META_KEY = 'kaoyanSync.meta.v1';
  var DEBOUNCE_MS = 2500;

  var state = {
    available: false,
    user: null,
    providers: { emailPassword: true, emailCode: false, google: false, github: false, phone: false },
    syncStatus: 'idle', // idle | syncing | ok | error
    lastSyncAt: 0,
    dirty: {}, // { key: { deleted: bool, ts: number } }
    timer: null,
    applyingRemote: false,
    mode: 'password', // password | emailCode | phone
    pwSubMode: 'login', // login | register
    cooldown: 0,
    cooldownTimer: null
  };

  /* ── 原始 localStorage 方法备份与拦截 ── */
  var rawSetItem = Storage.prototype.setItem;
  var rawRemoveItem = Storage.prototype.removeItem;

  function isSyncKey(k) {
    if (!k || typeof k !== 'string') return false;
    if (k.indexOf('kaoyanSync.') === 0) return false;
    if (/\.sync\.banner$/.test(k)) return false;
    if (k === 'kaoyanMath.position.v1') return false;
    return /^kaoyan/i.test(k);
  }

  Storage.prototype.setItem = function (k, v) {
    rawSetItem.call(this, k, v);
    if (this === window.localStorage && !state.applyingRemote && isSyncKey(k)) {
      markDirty(k, false);
    }
  };

  Storage.prototype.removeItem = function (k) {
    rawRemoveItem.call(this, k);
    if (this === window.localStorage && !state.applyingRemote && isSyncKey(k)) {
      markDirty(k, true);
    }
  };

  function readMeta() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveMeta(m) {
    try { rawSetItem.call(localStorage, META_KEY, JSON.stringify(m)); } catch (e) {}
  }

  function markDirty(key, deleted) {
    if (!state.user) return;
    state.dirty[key] = { deleted: Boolean(deleted), ts: Date.now() };
    schedulePush();
  }

  function schedulePush() {
    if (state.timer) clearTimeout(state.timer);
    setSyncStatus('syncing');
    state.timer = setTimeout(function () {
      state.timer = null;
      flushDirty(false);
    }, DEBOUNCE_MS);
  }

  /* ── API 请求封装 ── */
  function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(path, Object.assign({ credentials: 'same-origin', headers: headers }, opts))
      .then(function (res) {
        return res.text().then(function (txt) {
          var data = {};
          try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { error: txt || ('HTTP ' + res.status) }; }
          if (!res.ok) {
            var err = new Error(data.error || ('请求失败 (' + res.status + ')'));
            err.status = res.status;
            err.data = data;
            throw err;
          }
          return data;
        });
      });
  }

  /* ── 核心同步逻辑 ── */
  function collectLocalItems() {
    var items = [];
    var now = Date.now();
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (isSyncKey(k)) {
          items.push({ key: k, value: localStorage.getItem(k), deleted: false, updatedAt: now });
        }
      }
    } catch (e) {}
    return items;
  }

  function flushDirty(keepalive) {
    if (!state.user) return Promise.resolve();
    var keys = Object.keys(state.dirty);
    if (!keys.length) return Promise.resolve();

    var batch = [];
    keys.forEach(function (k) {
      var info = state.dirty[k];
      batch.push({
        key: k,
        value: info.deleted ? null : localStorage.getItem(k),
        deleted: info.deleted,
        updatedAt: info.ts
      });
    });
    state.dirty = {};
    setSyncStatus('syncing');

    return api('/api/sync/push', {
      method: 'POST',
      keepalive: Boolean(keepalive),
      body: { items: batch }
    }).then(function (res) {
      var m = readMeta();
      m.userId = state.user.id;
      m.lastSyncAt = res.serverTime || Date.now();
      saveMeta(m);
      state.lastSyncAt = m.lastSyncAt;
      setSyncStatus('ok');
    }).catch(function () {
      // 推失败则放回脏队列
      batch.forEach(function (it) {
        if (!state.dirty[it.key]) state.dirty[it.key] = { deleted: it.deleted, ts: it.updatedAt };
      });
      setSyncStatus('error');
    });
  }

  function syncPullAndMerge(options) {
    options = options || {};
    if (!state.user) return Promise.resolve({ changed: 0, uploaded: 0 });
    var meta = readMeta();
    var sameUser = meta.userId === state.user.id;
    var since = (!options.full && sameUser && meta.lastSyncAt) ? meta.lastSyncAt : 0;

    setSyncStatus('syncing');
    return api('/api/sync/pull?since=' + encodeURIComponent(since))
      .then(function (res) {
        var remoteItems = res.items || [];
        var remoteMap = {};
        var changed = 0;

        state.applyingRemote = true;
        try {
          remoteItems.forEach(function (it) {
            remoteMap[it.key] = it;
            if (!isSyncKey(it.key)) return;
            var cur = localStorage.getItem(it.key);
            if (it.deleted) {
              if (cur !== null) {
                rawRemoveItem.call(localStorage, it.key);
                changed++;
              }
            } else if (typeof it.value === 'string' && cur !== it.value) {
              rawSetItem.call(localStorage, it.key, it.value);
              changed++;
            }
          });
        } finally {
          state.applyingRemote = false;
        }

        // 首次同步或切换账号时，把本地独有的记录上传到云端（不丢失老数据）
        var toUpload = [];
        if (since === 0 && !options.cloudOverwrite) {
          var locals = collectLocalItems();
          locals.forEach(function (loc) {
            if (!remoteMap[loc.key]) toUpload.push(loc);
          });
        }

        var finish = function (serverTime, uploaded) {
          saveMeta({ userId: state.user.id, lastSyncAt: serverTime || Date.now() });
          state.lastSyncAt = serverTime || Date.now();
          setSyncStatus('ok');
          updateAuthButton();
          if (changed > 0 && !options.silentToast) {
            showToast('已从云端同步 ' + changed + ' 项学习记录', true);
          }
          return { changed: changed, uploaded: uploaded };
        };

        if (toUpload.length) {
          return api('/api/sync/push', { method: 'POST', body: { items: toUpload } })
            .then(function (pr) { return finish(pr.serverTime || res.serverTime, toUpload.length); });
        }
        return finish(res.serverTime, 0);
      })
      .catch(function (err) {
        setSyncStatus('error');
        throw err;
      });
  }

  function forcePushAll() {
    if (!state.user) return Promise.resolve();
    var items = collectLocalItems();
    setSyncStatus('syncing');
    return api('/api/sync/push', { method: 'POST', body: { items: items, force: true } })
      .then(function (res) {
        saveMeta({ userId: state.user.id, lastSyncAt: res.serverTime || Date.now() });
        state.lastSyncAt = res.serverTime || Date.now();
        setSyncStatus('ok');
        showToast('已上传本机全部 ' + items.length + ' 项记录到云端', false);
      })
      .catch(function (err) {
        setSyncStatus('error');
        showToast(err.message || '上传失败', false);
      });
  }

  /* ── 样式注入 ── */
  function injectStyles() {
    if (document.getElementById('ky-sync-style')) return;
    var css = ''
      + '.ky-auth-dot{width:7px;height:7px;border-radius:50%;background:var(--muted,#6d746c);flex:none;display:inline-block;}'
      + '.ky-auth-dot.ok{background:#22a06b;}'
      + '.ky-auth-dot.syncing{background:#d97706;animation:kyPulse 1.1s infinite;}'
      + '.ky-auth-dot.error{background:#dc2626;}'
      + '@keyframes kyPulse{0%,100%{opacity:1}50%{opacity:.35}}'
      + '.ky-auth-mask{position:fixed;inset:0;z-index:260;background:rgba(15,20,18,.46);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px;}'
      + '.ky-auth-mask[hidden]{display:none;}'
      + '.ky-auth-card{width:100%;max-width:410px;background:var(--surface,#fffdf8);color:var(--ink,#1b211d);border:1px solid var(--line,#e0dfd4);border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.22);overflow:hidden;font-family:var(--sans,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif);}'
      + '.ky-auth-hd{display:flex;align-items:center;justify-content:space-between;padding:16px 20px 12px;border-bottom:1px solid var(--line,#e0dfd4);}'
      + '.ky-auth-hd h3{margin:0;font-size:16px;font-weight:600;font-family:var(--serif,"Noto Serif SC",serif);}'
      + '.ky-auth-x{background:none;border:0;color:var(--muted,#6d746c);font-size:20px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px;}'
      + '.ky-auth-x:hover{background:var(--surface-2,#f3f2ea);color:var(--ink,#1b211d);}'
      + '.ky-auth-bd{padding:18px 20px 20px;}'
      + '.ky-auth-tabs{display:flex;gap:6px;margin-bottom:14px;background:var(--surface-2,#f3f2ea);padding:4px;border-radius:9px;}'
      + '.ky-auth-tab{flex:1;border:0;background:transparent;color:var(--muted,#6d746c);font-size:12.5px;padding:7px 6px;border-radius:6px;cursor:pointer;font-weight:500;transition:all .15s;}'
      + '.ky-auth-tab.on{background:var(--surface,#fffdf8);color:var(--ink,#1b211d);box-shadow:0 1px 3px rgba(0,0,0,.08);}'
      + '.ky-auth-field{margin-bottom:11px;}'
      + '.ky-auth-field label{display:block;font-size:12px;color:var(--muted,#6d746c);margin-bottom:4px;}'
      + '.ky-auth-input{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:8px;border:1px solid var(--line,#d8d7cc);background:var(--surface-2,#f8f7f2);color:var(--ink,#1b211d);font-size:13.5px;outline:none;transition:border-color .15s;}'
      + '.ky-auth-input:focus{border-color:var(--accent,#2f5d8a);background:var(--surface,#fffdf8);}'
      + '.ky-auth-row{display:flex;gap:8px;}'
      + '.ky-auth-row .ky-auth-input{flex:1;min-width:0;}'
      + '.ky-auth-btn{width:100%;padding:10px 14px;border:0;border-radius:8px;background:var(--accent,#2f5d8a);color:#fff;font-size:13.5px;font-weight:600;cursor:pointer;transition:opacity .15s;}'
      + '.ky-auth-btn:hover{opacity:.92;}'
      + '.ky-auth-btn:disabled{opacity:.5;cursor:not-allowed;}'
      + '.ky-auth-btn2{padding:9px 12px;border:1px solid var(--line,#d8d7cc);border-radius:8px;background:var(--surface,#fffdf8);color:var(--ink,#1b211d);font-size:12.5px;cursor:pointer;white-space:nowrap;}'
      + '.ky-auth-btn2:hover{border-color:var(--accent,#2f5d8a);color:var(--accent,#2f5d8a);}'
      + '.ky-auth-btn2:disabled{opacity:.5;cursor:not-allowed;}'
      + '.ky-auth-switch{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted,#6d746c);margin-top:10px;}'
      + '.ky-auth-link{background:none;border:0;color:var(--accent,#2f5d8a);cursor:pointer;font-size:12px;padding:0;text-decoration:underline;}'
      + '.ky-auth-div{display:flex;align-items:center;gap:10px;margin:16px 0 12px;color:var(--muted,#6d746c);font-size:11.5px;}'
      + '.ky-auth-div::before,.ky-auth-div::after{content:"";flex:1;height:1px;background:var(--line,#e0dfd4);}'
      + '.ky-auth-oauth{display:grid;grid-template-columns:1fr 1fr;gap:8px;}'
      + '.ky-oauth-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:8px 10px;border-radius:8px;border:1px solid var(--line,#d8d7cc);background:var(--surface,#fffdf8);color:var(--ink,#1b211d);font-size:12.5px;font-weight:500;cursor:pointer;text-decoration:none;transition:all .15s;}'
      + '.ky-oauth-btn:hover{border-color:var(--accent,#2f5d8a);}'
      + '.ky-oauth-btn.off{opacity:.48;cursor:not-allowed;}'
      + '.ky-auth-msg{margin-bottom:10px;padding:8px 10px;border-radius:8px;font-size:12.5px;line-height:1.45;}'
      + '.ky-auth-msg.err{background:rgba(220,38,38,.1);color:#b91c1c;border:1px solid rgba(220,38,38,.22);}'
      + '.ky-auth-msg.ok{background:rgba(34,160,107,.1);color:#15803d;border:1px solid rgba(34,160,107,.22);}'
      + '.ky-auth-msg.info{background:var(--surface-2,#f3f2ea);color:var(--muted,#6d746c);border:1px solid var(--line,#e0dfd4);}'
      + '.ky-prof-box{background:var(--surface-2,#f3f2ea);border-radius:10px;padding:12px 14px;margin-bottom:14px;}'
      + '.ky-prof-name{font-size:15px;font-weight:600;margin-bottom:3px;}'
      + '.ky-prof-sub{font-size:12px;color:var(--muted,#6d746c);word-break:break-all;}'
      + '.ky-prof-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px;}'
      + '.ky-prof-tag{font-size:11px;padding:2px 7px;border-radius:99px;background:var(--surface,#fffdf8);border:1px solid var(--line,#d8d7cc);color:var(--muted,#6d746c);}'
      + '.ky-prof-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;}'
      + '.ky-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:280;background:var(--ink,#1b211d);color:var(--surface,#fffdf8);padding:9px 14px;border-radius:99px;font-size:12.5px;display:flex;align-items:center;gap:10px;box-shadow:0 8px 24px rgba(0,0,0,.22);}'
      + '.ky-toast button{border:0;background:var(--accent,#2f5d8a);color:#fff;font-size:12px;padding:3px 9px;border-radius:99px;cursor:pointer;}';

    var st = document.createElement('style');
    st.id = 'ky-sync-style';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ── UI 构建 ── */
  var authBtn = null;
  var modalMask = null;

  function setSyncStatus(s) {
    state.syncStatus = s;
    updateAuthButton();
  }

  function updateAuthButton() {
    if (!authBtn) return;
    if (!state.user) {
      authBtn.title = '登录账号，开启多设备与跨站云端同步';
      authBtn.innerHTML = ''
        + '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px">'
        + '<path d="M4.5 12.2h7.3a2.7 2.7 0 0 0 .3-5.4A3.8 3.8 0 0 0 4.8 5.6a2.6 2.6 0 0 0-.3 6.6Z"/></svg>'
        + '<span class="ky-lbl">登录同步</span>';
      return;
    }
    var dotCls = 'ky-auth-dot ' + (state.syncStatus === 'syncing' ? 'syncing' : state.syncStatus === 'error' ? 'error' : 'ok');
    var label = (state.user.name || state.user.email || '已登录').slice(0, 10);
    authBtn.title = '账号与云同步：' + (state.user.email || state.user.phone || state.user.name);
    authBtn.innerHTML = '<span class="' + dotCls + '"></span><span class="ky-lbl">' + esc(label) + '</span>';
  }

  function mountButton() {
    if (document.getElementById('ky-auth-btn')) {
      authBtn = document.getElementById('ky-auth-btn');
      updateAuthButton();
      return;
    }
    var tools = document.querySelector('.ky-tools');
    if (!tools) return;

    authBtn = document.createElement('button');
    authBtn.type = 'button';
    authBtn.className = 'ky-tbtn';
    authBtn.id = 'ky-auth-btn';
    authBtn.setAttribute('aria-label', '账号与云同步');
    authBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openModal();
    });
    tools.insertBefore(authBtn, tools.firstChild);
    updateAuthButton();
  }

  function ensureModal() {
    if (modalMask) return;
    modalMask = document.createElement('div');
    modalMask.className = 'ky-auth-mask';
    modalMask.id = 'ky-auth-mask';
    modalMask.hidden = true;
    modalMask.addEventListener('click', function (e) {
      if (e.target === modalMask) closeModal();
    });
    document.body.appendChild(modalMask);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modalMask && !modalMask.hidden) closeModal();
    });
  }

  function openModal(msg, msgType) {
    ensureModal();
    modalMask.hidden = false;
    renderModal(msg, msgType);
  }

  function closeModal() {
    if (modalMask) modalMask.hidden = true;
  }

  function renderModal(msg, msgType) {
    if (!modalMask) return;
    var msgHtml = msg ? '<div class="ky-auth-msg ' + (msgType || 'info') + '">' + esc(msg) + '</div>' : '';

    if (state.user) {
      var u = state.user;
      var lastTxt = state.lastSyncAt ? fmtTime(state.lastSyncAt) : '尚未同步';
      var localCount = collectLocalItems().length;
      var provLabels = { email: '邮箱', google: 'Google', github: 'GitHub', phone: '手机号' };
      var tags = (u.providers || []).map(function (p) {
        return '<span class="ky-prof-tag">' + (provLabels[p] || p) + '</span>';
      }).join('');

      var bindOauth = '';
      if (state.providers.google && u.providers.indexOf('google') < 0) {
        bindOauth += '<a class="ky-oauth-btn" href="/api/auth/oauth/google/start?next=' + encodeURIComponent(location.pathname + location.search) + '">绑定 Google</a>';
      }
      if (state.providers.github && u.providers.indexOf('github') < 0) {
        bindOauth += '<a class="ky-oauth-btn" href="/api/auth/oauth/github/start?next=' + encodeURIComponent(location.pathname + location.search) + '">绑定 GitHub</a>';
      }

      modalMask.innerHTML = ''
        + '<div class="ky-auth-card" role="dialog" aria-modal="true">'
        + '  <div class="ky-auth-hd"><h3>账号与云端同步</h3><button type="button" class="ky-auth-x" data-close>&times;</button></div>'
        + '  <div class="ky-auth-bd">' + msgHtml
        + '    <div class="ky-prof-box">'
        + '      <div class="ky-prof-name">' + esc(u.name || '考研人') + '</div>'
        + '      <div class="ky-prof-sub">' + esc(u.email || u.phone || '已登录账号') + '</div>'
        + '      <div class="ky-prof-sub" style="margin-top:6px">上次同步：' + esc(lastTxt) + ' · 本机记录 ' + localCount + ' 项</div>'
        + (tags ? '<div class="ky-prof-tags">' + tags + '</div>' : '')
        + '    </div>'
        + '    <div class="ky-prof-grid">'
        + '      <button type="button" class="ky-auth-btn" id="ky-sync-now">立即双向同步</button>'
        + '      <button type="button" class="ky-auth-btn2" id="ky-sync-push">本机覆盖云端</button>'
        + '    </div>'
        + '    <div class="ky-prof-grid">'
        + '      <button type="button" class="ky-auth-btn2" id="ky-sync-pull">云端恢复本机</button>'
        + '      <button type="button" class="ky-auth-btn2" id="ky-logout-btn">退出登录</button>'
        + '    </div>'
        + (bindOauth ? '<div class="ky-auth-div">绑定更多登录方式</div><div class="ky-auth-oauth">' + bindOauth + '</div>' : '')
        + '    <div style="font-size:11.5px;color:var(--muted);margin-top:12px;line-height:1.5">你的做题记录、错题本、计时与笔记会在修改后自动同步到服务器，并在 kaoyan.feikntn111.com 与 math.feikntn111.com 之间自动互通。</div>'
        + '  </div>'
        + '</div>';

      modalMask.querySelector('[data-close]').addEventListener('click', closeModal);
      modalMask.querySelector('#ky-sync-now').addEventListener('click', function () {
        renderModal('正在与云端双向同步…', 'info');
        flushDirty(false).then(function () {
          return syncPullAndMerge({ full: true, silentToast: true });
        }).then(function (r) {
          renderModal('同步完成：拉取更新 ' + r.changed + ' 项，上传 ' + r.uploaded + ' 项。' + (r.changed ? '刷新页面后即可看到最新记录。' : ''), 'ok');
        }).catch(function (err) {
          renderModal(err.message || '同步失败', 'err');
        });
      });
      modalMask.querySelector('#ky-sync-push').addEventListener('click', function () {
        renderModal('正在上传本机全部记录…', 'info');
        forcePushAll().then(function () { renderModal('已将本机全部学习记录覆盖上传到云端。', 'ok'); });
      });
      modalMask.querySelector('#ky-sync-pull').addEventListener('click', function () {
        renderModal('正在从云端拉取记录…', 'info');
        syncPullAndMerge({ full: true, cloudOverwrite: true, silentToast: true }).then(function (r) {
          renderModal('已从云端恢复 ' + r.changed + ' 项记录，正在刷新页面…', 'ok');
          setTimeout(function () { location.reload(); }, 900);
        }).catch(function (err) {
          renderModal(err.message || '拉取失败', 'err');
        });
      });
      modalMask.querySelector('#ky-logout-btn').addEventListener('click', function () {
        api('/api/auth/logout', { method: 'POST' }).finally(function () {
          state.user = null;
          state.dirty = {};
          setSyncStatus('idle');
          updateAuthButton();
          closeModal();
          showToast('已退出登录（本机记录已保留）', false);
        });
      });
      return;
    }

    // 未登录视图
    var p = state.providers;
    var nextUrl = encodeURIComponent(location.pathname + location.search);
    var formHtml = '';

    if (state.mode === 'password') {
      var isReg = state.pwSubMode === 'register';
      formHtml = ''
        + (isReg && !p.emailCode ? '<div class="ky-auth-msg info">邮箱注册需先验证邮箱验证码（待配置 Resend 发信密钥）。你现在可以直接使用下方的 Google / GitHub 一键登录。</div>' : '')
        + '<form id="ky-auth-form">'
        + (isReg ? '<div class="ky-auth-field"><label>昵称（选填）</label><input class="ky-auth-input" name="name" placeholder="例如：27考研必胜" maxlength="40"></div>' : '')
        + '<div class="ky-auth-field"><label>邮箱</label><input class="ky-auth-input" type="email" name="email" required autocomplete="email" placeholder="you@example.com"></div>'
        + (isReg
          ? '<div class="ky-auth-field"><label>邮箱验证码</label><div class="ky-auth-row">'
            + '  <input class="ky-auth-input" name="code" required pattern="\\d{6}" maxlength="6" placeholder="输入 6 位验证码">'
            + '  <button type="button" class="ky-auth-btn2" id="ky-send-code"' + (!p.emailCode || state.cooldown > 0 ? ' disabled' : '') + '>' + (state.cooldown > 0 ? state.cooldown + 's' : '获取验证码') + '</button>'
            + '</div></div>'
          : '')
        + '<div class="ky-auth-field"><label>密码' + (isReg ? '（至少 6 位）' : '') + '</label><input class="ky-auth-input" type="password" name="password" required minlength="6" autocomplete="' + (isReg ? 'new-password' : 'current-password') + '" placeholder="请输入密码"></div>'
        + '<button type="submit" class="ky-auth-btn"' + (isReg && !p.emailCode ? ' disabled' : '') + '>' + (isReg ? '验证邮箱并注册' : '登录并同步数据') + '</button>'
        + '<div class="ky-auth-switch">'
        + '  <span>' + (isReg ? '已有账号？' : '还没有账号？') + '</span>'
        + '  <button type="button" class="ky-auth-link" id="ky-toggle-reg">' + (isReg ? '返回登录' : '用邮箱注册新账号') + '</button>'
        + '</div>'
        + '</form>';
    } else if (state.mode === 'emailCode') {
      formHtml = ''
        + (!p.emailCode ? '<div class="ky-auth-msg info">管理员尚未配置 Resend 发信密钥，暂时请使用「邮箱密码」方式登录。</div>' : '')
        + '<form id="ky-auth-form">'
        + '<div class="ky-auth-field"><label>邮箱</label><input class="ky-auth-input" type="email" name="email" required placeholder="you@example.com"></div>'
        + '<div class="ky-auth-field"><label>6 位验证码</label><div class="ky-auth-row">'
        + '  <input class="ky-auth-input" name="code" required pattern="\\d{6}" maxlength="6" placeholder="输入 6 位验证码">'
        + '  <button type="button" class="ky-auth-btn2" id="ky-send-code"' + (!p.emailCode || state.cooldown > 0 ? ' disabled' : '') + '>' + (state.cooldown > 0 ? state.cooldown + 's' : '获取验证码') + '</button>'
        + '</div></div>'
        + '<button type="submit" class="ky-auth-btn"' + (!p.emailCode ? ' disabled' : '') + '>验证并登录 / 自动注册</button>'
        + '</form>';
    } else {
      formHtml = ''
        + (!p.phone ? '<div class="ky-auth-msg info">管理员尚未配置短信通道（Twilio / 自定义短信接口），暂时请使用「邮箱密码」方式登录。</div>' : '')
        + '<form id="ky-auth-form">'
        + '<div class="ky-auth-field"><label>手机号</label><input class="ky-auth-input" type="tel" name="phone" required placeholder="13800138000 或 +86..."></div>'
        + '<div class="ky-auth-field"><label>6 位短信验证码</label><div class="ky-auth-row">'
        + '  <input class="ky-auth-input" name="code" required pattern="\\d{6}" maxlength="6" placeholder="输入 6 位验证码">'
        + '  <button type="button" class="ky-auth-btn2" id="ky-send-code"' + (!p.phone || state.cooldown > 0 ? ' disabled' : '') + '>' + (state.cooldown > 0 ? state.cooldown + 's' : '获取验证码') + '</button>'
        + '</div></div>'
        + '<button type="submit" class="ky-auth-btn"' + (!p.phone ? ' disabled' : '') + '>验证并登录 / 自动注册</button>'
        + '</form>';
    }

    var googleHtml = p.google
      ? '<a class="ky-oauth-btn" href="/api/auth/oauth/google/start?next=' + nextUrl + '">' + googleSvg() + 'Google</a>'
      : '<button type="button" class="ky-oauth-btn off" title="需在 Cloudflare Workers 配置 GOOGLE_CLIENT_ID / SECRET">' + googleSvg() + 'Google（待配置）</button>';
    var githubHtml = p.github
      ? '<a class="ky-oauth-btn" href="/api/auth/oauth/github/start?next=' + nextUrl + '">' + githubSvg() + 'GitHub</a>'
      : '<button type="button" class="ky-oauth-btn off" title="需在 Cloudflare Workers 配置 GITHUB_CLIENT_ID / SECRET">' + githubSvg() + 'GitHub（待配置）</button>';

    modalMask.innerHTML = ''
      + '<div class="ky-auth-card" role="dialog" aria-modal="true">'
      + '  <div class="ky-auth-hd"><h3>登录 · 云端保存学习记录</h3><button type="button" class="ky-auth-x" data-close>&times;</button></div>'
      + '  <div class="ky-auth-bd">' + msgHtml
      + '    <div class="ky-auth-tabs">'
      + '      <button type="button" class="ky-auth-tab' + (state.mode === 'password' ? ' on' : '') + '" data-mode="password">邮箱密码</button>'
      + '      <button type="button" class="ky-auth-tab' + (state.mode === 'emailCode' ? ' on' : '') + '" data-mode="emailCode">邮箱验证码</button>'
      + '      <button type="button" class="ky-auth-tab' + (state.mode === 'phone' ? ' on' : '') + '" data-mode="phone">手机号</button>'
      + '    </div>'
      + formHtml
      + '    <div class="ky-auth-div">其他登录方式</div>'
      + '    <div class="ky-auth-oauth">' + googleHtml + githubHtml + '</div>'
      + '  </div>'
      + '</div>';

    modalMask.querySelector('[data-close]').addEventListener('click', closeModal);
    modalMask.querySelectorAll('.ky-auth-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        state.mode = b.getAttribute('data-mode');
        renderModal();
      });
    });

    var toggleReg = modalMask.querySelector('#ky-toggle-reg');
    if (toggleReg) {
      toggleReg.addEventListener('click', function () {
        state.pwSubMode = state.pwSubMode === 'login' ? 'register' : 'login';
        renderModal();
      });
    }

    var sendBtn = modalMask.querySelector('#ky-send-code');
    if (sendBtn) {
      sendBtn.addEventListener('click', function () {
        var form = modalMask.querySelector('#ky-auth-form');
        var isPhone = state.mode === 'phone';
        var endpoint = isPhone ? '/api/auth/phone/send-code' : '/api/auth/email/send-code';
        var payload = isPhone
          ? { phone: form.phone.value }
          : { email: form.email.value, purpose: state.mode === 'password' ? 'register' : 'login' };
        sendBtn.disabled = true;
        api(endpoint, { method: 'POST', body: payload })
          .then(function (r) {
            startCooldown(r.cooldown || 60);
            renderModal('验证码已发送，请查收（10 分钟内有效）。', 'ok');
          })
          .catch(function (err) {
            sendBtn.disabled = false;
            renderModal(err.message || '发送失败', 'err');
          });
      });
    }

    var formEl = modalMask.querySelector('#ky-auth-form');
    if (formEl) {
      formEl.addEventListener('submit', function (e) {
        e.preventDefault();
        var submitBtn = formEl.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;

        var req;
        if (state.mode === 'password') {
          var isReg = state.pwSubMode === 'register';
          req = api(isReg ? '/api/auth/register' : '/api/auth/login', {
            method: 'POST',
            body: {
              email: formEl.email.value,
              password: formEl.password.value,
              code: formEl.code ? formEl.code.value : '',
              name: formEl.name ? formEl.name.value : ''
            }
          });
        } else if (state.mode === 'emailCode') {
          req = api('/api/auth/email/verify', {
            method: 'POST',
            body: { email: formEl.email.value, code: formEl.code.value }
          });
        } else {
          req = api('/api/auth/phone/verify', {
            method: 'POST',
            body: { phone: formEl.phone.value, code: formEl.code.value }
          });
        }

        req.then(function (res) {
          state.user = res.user;
          updateAuthButton();
          renderModal('登录成功，正在同步你的学习记录…', 'ok');
          return syncPullAndMerge({ full: true, silentToast: true }).then(function (sr) {
            closeModal();
            if (sr.changed > 0) {
              showToast('登录成功，已同步云端 ' + sr.changed + ' 项记录', true);
            } else if (sr.uploaded > 0) {
              showToast('登录成功，已将本机 ' + sr.uploaded + ' 项记录备份至云端', false);
            } else {
              showToast('登录成功，云同步已开启', false);
            }
          });
        }).catch(function (err) {
          if (submitBtn) submitBtn.disabled = false;
          renderModal(err.message || '登录失败', 'err');
        });
      });
    }
  }

  function startCooldown(sec) {
    state.cooldown = sec;
    if (state.cooldownTimer) clearInterval(state.cooldownTimer);
    state.cooldownTimer = setInterval(function () {
      state.cooldown--;
      var b = document.getElementById('ky-send-code');
      if (state.cooldown <= 0) {
        clearInterval(state.cooldownTimer);
        state.cooldownTimer = null;
        if (b) { b.disabled = false; b.textContent = '获取验证码'; }
      } else if (b) {
        b.disabled = true;
        b.textContent = state.cooldown + 's';
      }
    }, 1000);
  }

  function showToast(text, withReload) {
    var old = document.getElementById('ky-sync-toast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'ky-sync-toast';
    el.className = 'ky-toast';
    el.innerHTML = '<span>' + esc(text) + '</span>' + (withReload ? '<button type="button">刷新生效</button>' : '');
    if (withReload) {
      el.querySelector('button').addEventListener('click', function () { location.reload(); });
    }
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.remove(); }, withReload ? 8000 : 3800);
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function googleSvg() {
    return '<svg width="14" height="14" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.71A5.41 5.41 0 0 1 3.69 9c0-.59.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';
  }
  function githubSvg() {
    return '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.71 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.22 2.2.82a7.65 7.65 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z"/></svg>';
  }

  /* ── 启动 ── */
  function init() {
    injectStyles();
    api('/api/auth/me').then(function (res) {
      state.available = true;
      state.providers = res.providers || state.providers;
      state.user = res.user || null;
      var meta = readMeta();
      if (state.user && meta.userId === state.user.id) {
        state.lastSyncAt = meta.lastSyncAt || 0;
      }
      mountButton();

      // 检查 OAuth 回调错误提示
      var params = new URLSearchParams(location.search);
      var authErr = params.get('auth_err');
      if (authErr) {
        params.delete('auth_err');
        var cleanUrl = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash;
        try { history.replaceState(null, '', cleanUrl); } catch (e) {}
        openModal(authErr, 'err');
      }

      if (state.user) {
        syncPullAndMerge({ full: false, silentToast: false }).catch(function () {});
      }
    }).catch(function () {
      // 本地静态预览或离线桌面端：静默不挂载云同步按钮
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) flushDirty(true);
    });
    window.addEventListener('pagehide', function () {
      flushDirty(true);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
