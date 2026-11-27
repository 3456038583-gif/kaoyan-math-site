/* 27 考研初试倒计时 + 全站多主题引擎 + 专注番茄钟 + 快捷命令面板 (Cmd/Ctrl+K)
 * 全站 336 个页面共用：零外部依赖，所有偏好存 localStorage，不改动原有做题数据。
 */
(function () {
  var TARGET = new Date('2026-12-19T08:30:00+08:00');
  var LABEL = '27 考研初试';
  var DATE_TEXT = '2026.12.19';

  var THEME_KEY = 'kaoyan.theme.v1';
  var FS_KEY = 'kaoyan.fontsize.v1';
  var FOCUS_KEY = 'kaoyan.focus.v1';

  var THEMES = [
    { id: 'classic',    name: '经典纸感',   dot: 'linear-gradient(135deg,#f5f4ee 50%,#2f5d8a 50%)' },
    { id: 'glass',      name: '液态玻璃',   dot: 'linear-gradient(135deg,#bae6fd,#e9d5ff,#a7f3d0)' },
    { id: 'glass-dark', name: '暗夜玻璃',   dot: 'linear-gradient(135deg,#0f172a,#1e3a8a,#4c1d95)' },
    { id: 'dark',       name: '静谧深色',   dot: 'linear-gradient(135deg,#121614 50%,#7ab0df 50%)' },
    { id: 'sage',       name: '护眼青笺',   dot: 'linear-gradient(135deg,#e6efe8 50%,#22664b 50%)' },
    { id: 'eink',       name: '水墨宣纸',   dot: 'linear-gradient(135deg,#ffffff 50%,#111111 50%)' }
  ];

  /* ── 1. 立即应用主题与字号（减少首屏闪烁） ── */
  function getTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'classic'; } catch (e) { return 'classic'; }
  }
  function applyTheme(id) {
    var root = document.documentElement;
    if (!id || id === 'classic') {
      root.removeAttribute('data-style');
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-style', id);
      if (id === 'glass' || id === 'sage' || id === 'eink') {
        root.setAttribute('data-theme', 'light');
      } else {
        root.setAttribute('data-theme', 'dark');
      }
    }
    try { localStorage.setItem(THEME_KEY, id || 'classic'); } catch (e) {}
    document.querySelectorAll('.ky-th').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-t') === (id || 'classic'));
    });
  }
  function getFS() {
    try { return localStorage.getItem(FS_KEY) || 'md'; } catch (e) { return 'md'; }
  }
  function applyFS(sz) {
    var root = document.documentElement;
    if (!sz || sz === 'md') root.removeAttribute('data-fontsize');
    else root.setAttribute('data-fontsize', sz);
    try { localStorage.setItem(FS_KEY, sz || 'md'); } catch (e) {}
    document.querySelectorAll('.ky-fs button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-fs') === (sz || 'md'));
    });
  }
  function ensureThemeCSS() {
    if (document.getElementById('ky-theme-css')) return;
    if (document.querySelector('link[href*="/theme.css"],link[href^="theme.css"]')) return;
    var lk = document.createElement('link');
    lk.id = 'ky-theme-css';
    lk.rel = 'stylesheet';
    lk.href = '/theme.css?v=20261127a';
    (document.head || document.documentElement).appendChild(lk);
  }

  ensureThemeCSS();
  applyTheme(getTheme());
  applyFS(getFS());

  /* ── 2. 倒计时栏样式与构建 ── */
  function injectStyle() {
    if (document.getElementById('cd-style')) return;
    var css = ''
      + '.cd-bar{position:relative;z-index:60;background:var(--surface,#fffdf8);'
      + 'border-bottom:1px solid var(--line,#e0dfd4);'
      + 'font-family:var(--sans,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif);'
      + 'color:var(--muted,#6d746c);font-size:12.5px;line-height:1.5;'
      + '-webkit-font-smoothing:antialiased;}'
      + '.cd-in{max-width:1200px;margin:0 auto;padding:7px 15px;'
      + 'display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;}'
      + '.cd-tag{display:inline-flex;align-items:center;gap:6px;'
      + 'font-family:var(--serif,"Noto Serif SC","Songti SC",serif);'
      + 'font-size:12.5px;letter-spacing:.06em;color:var(--ink,#1b211d);}'
      + '.cd-tag::before{content:"";width:5px;height:5px;border-radius:50%;'
      + 'background:var(--red,#a33a2c);display:inline-block;}'
      + '.cd-nums{display:inline-flex;align-items:baseline;gap:2px;'
      + 'font-family:var(--mono,"IBM Plex Mono",ui-monospace,Menlo,monospace);'
      + 'font-variant-numeric:tabular-nums;color:var(--red,#a33a2c);font-weight:600;}'
      + '.cd-d{font-size:16px;letter-spacing:.02em;}'
      + '.cd-unit{font-size:11.5px;color:var(--muted,#6d746c);font-weight:400;}'
      + '.cd-date{font-family:var(--mono,"IBM Plex Mono",ui-monospace,Menlo,monospace);'
      + 'font-size:11.5px;letter-spacing:.04em;color:var(--muted,#6d746c);}'
      + '.cd-sep{color:var(--line-strong,#bcbcae);}'
      + '.cd-done{color:var(--accent,#2f5d8a);font-family:var(--mono,monospace);font-weight:400;}'
      + '@media (max-width:640px){'
      + '.cd-in{padding:6px 12px;gap:7px;font-size:12px;}'
      + '.cd-date{display:none;}.cd-sep{display:none;}'
      + '.cd-d{font-size:15px;}'
      + '}'
      + '@media print{.cd-bar{display:none;}}';
    var st = document.createElement('style');
    st.id = 'cd-style';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  function buildCountdown() {
    var bar = document.createElement('div');
    bar.className = 'cd-bar';
    bar.setAttribute('role', 'status');
    bar.innerHTML = ''
      + '<div class="cd-in">'
      + '<span class="cd-tag">' + LABEL + '倒计时</span>'
      + '<span class="cd-nums" id="cd-nums">'
      + '<span class="cd-d" id="cd-d">--</span><span class="cd-unit">天</span>'
      + '</span>'
      + '<span class="cd-sep">·</span>'
      + '<span class="cd-date">' + DATE_TEXT + ' 08:30 开考</span>'
      + '<span class="cd-focus-wrap">'
      + '<button type="button" class="cd-focus-btn" id="ky-fbtn" title="专注番茄钟 / 模考计时器">⏱ 专注</button>'
      + '</span>'
      + '</div>';
    return bar;
  }

  function tickCountdown(numsRoot) {
    var diff = TARGET.getTime() - Date.now();
    if (diff <= 0) {
      numsRoot.innerHTML = '<span class="cd-done">已开考，稳住，能赢</span>';
      return false;
    }
    var day = Math.ceil(diff / 86400000);
    var dEl = document.getElementById('cd-d');
    if (dEl) dEl.textContent = day;
    return true;
  }

  /* ── 3. 专注番茄钟（跨页保持运行状态） ── */
  function chime() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      [523.25, 659.25, 783.99].forEach(function (freq, idx) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.001, ctx.currentTime + idx * 0.16);
        g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + idx * 0.16 + 0.04);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.16 + 0.45);
        o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + idx * 0.16);
        o.stop(ctx.currentTime + idx * 0.16 + 0.48);
      });
    } catch (e) {}
  }

  function loadFocus() {
    try {
      var d = JSON.parse(localStorage.getItem(FOCUS_KEY) || 'null');
      if (d && typeof d === 'object') return d;
    } catch (e) {}
    return { mins: 25, rem: 1500, running: false, endAt: 0 };
  }
  function saveFocus(f) {
    try { localStorage.setItem(FOCUS_KEY, JSON.stringify(f)); } catch (e) {}
  }
  function fmtSec(s) {
    s = Math.max(0, Math.round(s));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return h > 0 ? (h + ':' + p(m) + ':' + p(sec)) : (p(m) + ':' + p(sec));
  }

  function initFocus() {
    var fbtn = document.getElementById('ky-fbtn');
    if (!fbtn) return;
    var pop = document.createElement('div');
    pop.className = 'ky-fpop';
    pop.hidden = true;
    pop.innerHTML = ''
      + '<div class="ky-pop-h"><span>专注计时器</span><span style="font-weight:400">跨页同步</span></div>'
      + '<div class="ky-ftime" id="ky-ftime">25:00</div>'
      + '<div class="ky-fpresets">'
      + '<button type="button" data-m="25">25分</button>'
      + '<button type="button" data-m="45">45分</button>'
      + '<button type="button" data-m="60">60分</button>'
      + '<button type="button" data-m="180">180模考</button>'
      + '</div>'
      + '<div class="ky-factions">'
      + '<button type="button" class="primary" id="ky-ftoggle">开始专注</button>'
      + '<button type="button" id="ky-freset">重置</button>'
      + '</div>';
    document.body.appendChild(pop);

    var state = loadFocus();
    var timeEl = document.getElementById('ky-ftime');
    var togBtn = document.getElementById('ky-ftoggle');
    var rstBtn = document.getElementById('ky-freset');

    function getRem() {
      if (state.running && state.endAt) {
        return Math.max(0, Math.ceil((state.endAt - Date.now()) / 1000));
      }
      return state.rem;
    }
    function renderFocus() {
      var r = getRem();
      if (state.running && r <= 0) {
        state.running = false;
        state.rem = 0;
        state.endAt = 0;
        saveFocus(state);
        chime();
      }
      timeEl.textContent = fmtSec(r);
      togBtn.textContent = state.running ? '暂停' : (r < state.mins * 60 && r > 0 ? '继续' : '开始专注');
      fbtn.classList.toggle('running', state.running);
      fbtn.textContent = state.running ? ('⏱ ' + fmtSec(r)) : '⏱ 专注';
      pop.querySelectorAll('.ky-fpresets button').forEach(function (b) {
        b.classList.toggle('on', Number(b.getAttribute('data-m')) === state.mins);
      });
    }

    pop.querySelectorAll('.ky-fpresets button').forEach(function (b) {
      b.addEventListener('click', function () {
        var m = Number(b.getAttribute('data-m'));
        state = { mins: m, rem: m * 60, running: false, endAt: 0 };
        saveFocus(state);
        renderFocus();
      });
    });
    togBtn.addEventListener('click', function () {
      if (state.running) {
        state.rem = getRem();
        state.running = false;
        state.endAt = 0;
      } else {
        if (state.rem <= 0) state.rem = state.mins * 60;
        state.running = true;
        state.endAt = Date.now() + state.rem * 1000;
      }
      saveFocus(state);
      renderFocus();
    });
    rstBtn.addEventListener('click', function () {
      state = { mins: state.mins, rem: state.mins * 60, running: false, endAt: 0 };
      saveFocus(state);
      renderFocus();
    });
    fbtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var tp = document.getElementById('ky-pop');
      if (tp) tp.hidden = true;
      pop.hidden = !pop.hidden;
    });
    document.addEventListener('click', function (e) {
      if (!pop.hidden && !pop.contains(e.target) && e.target !== fbtn) pop.hidden = true;
    });
    renderFocus();
    setInterval(renderFocus, 1000);
  }

  /* ── 4. 顶栏注入外观切换 + 快捷命令面板按钮 ── */
  function initToolbarAndPalette() {
    var isStandalone = location.hostname.indexOf('math.') === 0 || (!document.querySelector('a[href="/exam/"]') && !document.querySelector('a[href="/politics/"]'));

    // 外观弹层
    var pop = document.createElement('div');
    pop.id = 'ky-pop';
    pop.className = 'ky-pop';
    pop.hidden = true;
    var thHtml = THEMES.map(function (t) {
      return '<button type="button" class="ky-th" data-t="' + t.id + '">'
        + '<span class="ky-dot" style="background:' + t.dot + '"></span>'
        + '<span>' + t.name + '</span></button>';
    }).join('');
    pop.innerHTML = ''
      + '<div class="ky-pop-h"><span>界面主题风格</span><span style="font-weight:400">全站同步</span></div>'
      + '<div class="ky-themes">' + thHtml + '</div>'
      + '<div class="ky-pop-h" style="margin-top:4px"><span>阅读字号</span></div>'
      + '<div class="ky-fs">'
      + '<button type="button" data-fs="md">标准</button>'
      + '<button type="button" data-fs="lg">舒适</button>'
      + '<button type="button" data-fs="xl">大字</button>'
      + '</div>';
    document.body.appendChild(pop);

    pop.querySelectorAll('.ky-th').forEach(function (b) {
      b.addEventListener('click', function () { applyTheme(b.getAttribute('data-t')); });
    });
    pop.querySelectorAll('.ky-fs button').forEach(function (b) {
      b.addEventListener('click', function () { applyFS(b.getAttribute('data-fs')); });
    });
    applyTheme(getTheme());
    applyFS(getFS());

    // 工具按钮组
    var tools = document.createElement('div');
    tools.className = 'ky-tools';
    tools.innerHTML = ''
      + '<button type="button" class="ky-tbtn" id="ky-cmd-btn" title="快捷跳转与命令 (⌘K / Ctrl+K)" aria-label="快捷搜索">'
      + '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.8"/><path d="M10.8 10.8 14 14"/></svg>'
      + '<kbd>⌘K</kbd></button>'
      + '<button type="button" class="ky-tbtn" id="ky-theme-btn" title="切换界面主题与字号" aria-label="切换主题">'
      + '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"/></svg>'
      + '<span class="ky-lbl">外观</span></button>';

    var bar = document.querySelector('.sitebar, .topbar');
    if (bar) {
      bar.appendChild(tools);
    } else {
      tools.style.cssText = 'position:fixed;top:12px;right:14px;z-index:90;';
      document.body.appendChild(tools);
    }

    var themeBtn = document.getElementById('ky-theme-btn');
    themeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var r = themeBtn.getBoundingClientRect();
      pop.style.top = Math.min(window.innerHeight - 280, Math.max(48, r.bottom + 8)) + 'px';
      pop.hidden = !pop.hidden;
    });
    document.addEventListener('click', function (e) {
      if (!pop.hidden && !pop.contains(e.target) && !themeBtn.contains(e.target)) pop.hidden = true;
    });

    // 命令面板 (Cmd/Ctrl + K)
    var mathBase = isStandalone ? '/' : '/math/';
    var ITEMS = [
      { label: '数学一 · 历年真题', sub: '2010–2026', url: mathBase + '?view=m1' },
      { label: '数学二 · 历年真题', sub: '2010–2026', url: mathBase + '?view=m2' },
      { label: '数学三 · 历年真题', sub: '2010–2026', url: mathBase + '?view=m3' },
      { label: '数学 · 61 套成套模拟卷', sub: '李林 / 张宇 / 崔命', url: mathBase + '?view=mock' },
      { label: '数学 · 错题本', sub: 'Wrong Book', url: mathBase + '?view=wrong' },
      { label: '数学 · 重点题与补充真题', sub: 'Key & Supp', url: mathBase + '?view=key' },
      { label: '数学 · 成绩趋势统计', sub: 'Stats', url: mathBase + '?view=stats' }
    ];
    if (!isStandalone) {
      ITEMS = [
        { label: '首页 · 考研资料总库', sub: 'Home', url: '/' }
      ].concat(ITEMS, [
        { label: '英语真题（英语一 / 英语二）', sub: '38 套逐题', url: '/exam/' },
        { label: '英语一 · 答案速查（一刷 / 二刷）', sub: 'Quick Check', url: '/english/' },
        { label: '政治真题 & 27 肖八', sub: '17年 + 8套', url: '/politics/' },
        { label: '英语词汇 · 27 红宝书', sub: '6,529 词', url: '/vocab/' },
        { label: '考研知识库（高数 / 线代 / 概率 / 政治一页纸）', sub: '259 篇笔记', url: '/library/' },
        { label: '数据备份导出与桌面版', sub: 'JSON Backup', url: '/export/' },
        { label: '使用指南与常见问题', sub: 'Guide & Shortcuts', url: '/guide/' },
        { label: '意见反馈（复制邮箱 feikntn111@gmail.com）', sub: 'Feedback', act: function () {
          var em = 'feikntn111@gmail.com';
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(em).then(function () { alert('已复制反馈邮箱：' + em); }).catch(function () { window.prompt('反馈邮箱：', em); });
          } else { window.prompt('反馈邮箱：', em); }
        } }
      ]);
    } else {
      ITEMS.push(
        { label: '使用指南与常见问题（主站）', sub: 'Guide', url: 'https://kaoyan.feikntn111.com/guide/' },
        { label: '意见反馈（复制邮箱 feikntn111@gmail.com）', sub: 'Feedback', act: function () {
          var em = 'feikntn111@gmail.com';
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(em).then(function () { alert('已复制反馈邮箱：' + em); }).catch(function () { window.prompt('反馈邮箱：', em); });
          } else { window.prompt('反馈邮箱：', em); }
        } }
      );
    }
    THEMES.forEach(function (t) {
      ITEMS.push({ label: '切换主题：' + t.name, sub: 'Theme · ' + t.id, act: function () { applyTheme(t.id); } });
    });

    var mask = document.createElement('div');
    mask.className = 'ky-cmd-mask';
    mask.hidden = true;
    mask.innerHTML = ''
      + '<div class="ky-cmd" role="dialog" aria-label="快捷导航">'
      + '<div class="ky-cmd-in">'
      + '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.8"/><path d="M10.8 10.8 14 14"/></svg>'
      + '<input type="text" id="ky-cmd-q" placeholder="搜索模块、模拟卷、错题本或切换主题（如：液态玻璃、数二、肖八）…" autocomplete="off">'
      + '</div>'
      + '<div class="ky-cmd-list" id="ky-cmd-list"></div>'
      + '<div class="ky-cmd-foot"><span>↑↓ 选择 · Enter 确认</span><span>Esc 关闭</span></div>'
      + '</div>';
    document.body.appendChild(mask);

    var qIn = document.getElementById('ky-cmd-q');
    var listEl = document.getElementById('ky-cmd-list');
    var curIdx = 0;
    var curItems = ITEMS;

    function renderList() {
      var kw = (qIn.value || '').trim().toLowerCase();
      curItems = kw ? ITEMS.filter(function (it) {
        return (it.label + ' ' + it.sub).toLowerCase().indexOf(kw) >= 0;
      }) : ITEMS;
      if (curIdx >= curItems.length) curIdx = 0;
      listEl.innerHTML = curItems.length ? curItems.map(function (it, i) {
        return '<button type="button" class="ky-cmd-item' + (i === curIdx ? ' sel' : '') + '" data-i="' + i + '">'
          + '<span>' + it.label + '</span><small>' + it.sub + '</small></button>';
      }).join('') : '<div style="padding:18px;text-align:center;color:var(--muted);font-size:13px">没有匹配项</div>';
    }
    function execItem(it) {
      if (!it) return;
      mask.hidden = true;
      if (it.act) it.act();
      else if (it.url) location.href = it.url;
    }
    function openCmd() {
      pop.hidden = true;
      mask.hidden = false;
      qIn.value = '';
      curIdx = 0;
      renderList();
      setTimeout(function () { qIn.focus(); }, 20);
    }

    document.getElementById('ky-cmd-btn').addEventListener('click', openCmd);
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.hidden = true; });
    qIn.addEventListener('input', function () { curIdx = 0; renderList(); });
    listEl.addEventListener('click', function (e) {
      var b = e.target.closest('.ky-cmd-item');
      if (b) execItem(curItems[Number(b.getAttribute('data-i'))]);
    });
    qIn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); curIdx = (curIdx + 1) % Math.max(1, curItems.length); renderList(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); curIdx = (curIdx - 1 + curItems.length) % Math.max(1, curItems.length); renderList(); }
      else if (e.key === 'Enter') { e.preventDefault(); execItem(curItems[curIdx]); }
      else if (e.key === 'Escape') { mask.hidden = true; }
    });
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (mask.hidden) openCmd(); else mask.hidden = true;
      } else if (e.key === 'Escape' && !mask.hidden) {
        mask.hidden = true;
      }
    });
  }

  /* ── 5. 阅读进度条 + 回到顶部按钮 ── */
  function initScrollHelpers() {
    var prog = document.createElement('div');
    prog.className = 'ky-prog';
    document.body.appendChild(prog);

    var topBtn = document.createElement('button');
    topBtn.type = 'button';
    topBtn.className = 'ky-top';
    topBtn.title = '回到顶部';
    topBtn.setAttribute('aria-label', '回到顶部');
    topBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.5V3.5"/><path d="M4 7.5 8 3.5l4 4"/></svg>';
    topBtn.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
    document.body.appendChild(topBtn);

    var raf = 0;
    function onScroll() {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        var st = window.scrollY || document.documentElement.scrollTop || 0;
        var dh = document.documentElement.scrollHeight - window.innerHeight;
        prog.style.width = (dh > 20 ? Math.min(100, Math.max(0, (st / dh) * 100)) : 0) + '%';
        topBtn.classList.toggle('show', st > 420);
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ── 6. 启动 ── */
  function start() {
    injectStyle();
    var bar = buildCountdown();
    document.body.insertBefore(bar, document.body.firstChild);
    var nums = document.getElementById('cd-nums');
    if (nums) {
      tickCountdown(nums);
      setInterval(function () { tickCountdown(nums); }, 60000);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) tickCountdown(nums);
      });
    }
    initFocus();
    initToolbarAndPalette();
    initScrollHelpers();
    if (!document.getElementById('ky-sync-js')) {
      var sc = document.createElement('script');
      sc.id = 'ky-sync-js';
      sc.src = '/sync.js?v=20261127a';
      sc.defer = true;
      (document.body || document.documentElement).appendChild(sc);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
