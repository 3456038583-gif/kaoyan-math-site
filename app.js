/* 渲染与交互 */
(function () {
  'use strict';

  const appEl = document.getElementById('app');
  const yearsEl = document.getElementById('years');
  const yprogBtn = document.getElementById('yprogBtn');
  const modulesEl = document.getElementById('modules');
  const sheetEl = document.getElementById('pdfsheet');
  const frameEl = document.getElementById('pdfFrame');
  const pdfTitleEl = document.getElementById('pdfTitle');
  const pdfOpenEl = document.getElementById('pdfOpen');

  const SUBJ_VIEW = { m1: 1, m2: 2, m3: 3 };
  const LV_CLASS = { '常规': 'e', '中档': 'm', '难题': 'h' };

  /* ── 内置成套模拟卷（数据在 mockdata.js，用 3200—3499 的伪年份挂进 PAPERS）── */
  // 3201—3216 李林 6+6、3301—3308 张宇 8、3411—3423 崔命 1+2 卷；真题年份都 ≤ 2100，不会冲突
  const MOCK_YEAR_MIN = 3000;
  const MOCK_YEAR_MAX = 3999;
  const isMockYear = y => y >= MOCK_YEAR_MIN && y <= MOCK_YEAR_MAX;
  const mockPaperMeta = (year, subject) => {
    const m = typeof MOCK_PAPERS !== 'undefined' ? MOCK_PAPERS[year] : null;
    return m && (!m.subject || m.subject === subject) ? m : null;
  };
  // 错题本 / 成绩页里给「伪年份」显示套卷名，而不是「3211 年」
  const paperLabel = (year, subject) => {
    const m = mockPaperMeta(year, subject);
    return m ? `${m.name} · ${SUBJ[subject]}` : `${year} 年 · ${SUBJ[subject]}`;
  };
  // 卷名本身已带科目时（模拟卷）不再追加「数二」，用于「我的成绩 · …」这类标题
  const paperTitle = (year, subject) => {
    const m = mockPaperMeta(year, subject);
    return m ? m.name : `${year} ${SUBJ[subject]}`;
  };

  // 模拟卷题库体积不小（26 套卷），只在进「模拟卷」或错题本里确实有模拟卷题时才拉
  let mockDataPromise = null;
  function ensureMockData() {
    if (typeof MOCK_PAPERS !== 'undefined') return Promise.resolve();
    if (mockDataPromise) return mockDataPromise;
    mockDataPromise = loadScriptOnce('/mockdata.js').catch(err => {
      mockDataPromise = null;
      throw err;
    });
    return mockDataPromise;
  }
  const needMockData = () => state.view === 'mock'
    || (state.view === 'wrong' && [...WRONG].some(k => isMockYear(Number(k.split('-')[0]))));
  // 2021 年起题型改革：10 选择 + 6 填空 + 6 解答，共 22 题
  const groupsFor = year => year >= 2021
    ? [
        { title: '一、选择题', from: 1, to: 10, meta: '10 题 · 每题 5 分 · 共 50 分' },
        { title: '二、填空题', from: 11, to: 16, meta: '6 题 · 每题 5 分 · 共 30 分' },
        { title: '三、解答题', from: 17, to: 22, meta: '6 题 · 共 70 分' }
      ]
    : [
        { title: '一、选择题', from: 1, to: 8, meta: '8 题 · 每题 4 分 · 共 32 分' },
        { title: '二、填空题', from: 9, to: 14, meta: '6 题 · 每题 4 分 · 共 24 分' },
        { title: '三、解答题', from: 15, to: 23, meta: '9 题 · 共 94 分' }
      ];

  /* ── 成绩记录：题型分值、存储与统计 ── */
  // 2021 年改革前：选 8×4、填 6×4、解答 15—19 各 10 分、20—23 各 11 分
  // 2021 年起：选 10×5、填 6×5、解答 17 题 10 分、18—22 各 12 分
  const qKind = (year, n) => {
    if (year >= 2021) return n <= 10 ? 'choice' : n <= 16 ? 'fill' : 'big';
    return n <= 8 ? 'choice' : n <= 14 ? 'fill' : 'big';
  };
  const qMax = (year, n) => {
    if (year >= 2021) return n <= 16 ? 5 : n === 17 ? 10 : 12;
    return n <= 14 ? 4 : n <= 19 ? 10 : 11;
  };
  const paperKey = (year, subject) => `${year}-${subject}`;

  const SCORE_STORE_KEY = 'kaoyanMath.scores.v1';
  // 选填题只记对错：1 = 做对（照满分计），0 = 做错。
  // v4：之前短暂试过「选填按分数记」，读到分数时统一折回对/错。
  const SCORE_VER_KEY = 'kaoyanMath.scoreVer';
  let LEGACY_SEL = true;
  try { LEGACY_SEL = localStorage.getItem(SCORE_VER_KEY) !== '4'; } catch (e) { LEGACY_SEL = false; }
  const selScore = (year, n, v) => {
    const num = Number(v);
    if (!Number.isFinite(num)) return undefined;
    return num > 0 ? 1 : 0;
  };
  const SCORES = {};
  (function loadScores() {
    let failed = false;
    let RAW_SCORES = {};
    try {
      const raw = JSON.parse(localStorage.getItem(SCORE_STORE_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return;
      RAW_SCORES = raw;
      for (const [k, rec] of Object.entries(raw)) {
        const m = /^(\d{4})-([123])$/.exec(k);
        if (!m || !rec || typeof rec !== 'object') continue;
        const year = Number(m[1]);
        const subject = Number(m[2]);
        // 3000+ 是内置成套模拟卷的伪年份（见 mockdata.js），与真题共用同一套成绩结构
        if (!ALL_YEARS.includes(year) && !isMockYear(year)) continue;
        const qCount = year >= 2021 ? 22 : 23;
        // touched=false 表示这份卷子的分数只是同题自动同步过来的，用户还没在这里记录过
        const clean = { sel: {}, big: {}, touched: rec.touched !== false };
        if (rec.sel && typeof rec.sel === 'object') {
          for (const [n, v] of Object.entries(rec.sel)) {
            const qn = Number(n);
            if (qn >= 1 && qn <= qCount && qKind(year, qn) !== 'big') {
              const sv = selScore(year, qn, v);
              if (sv !== undefined) clean.sel[qn] = sv;
            }
          }
        }
        if (rec.big && typeof rec.big === 'object') {
          for (const [n, v] of Object.entries(rec.big)) {
            const qn = Number(n);
            if (qn >= 1 && qn <= qCount && qKind(year, qn) === 'big' && Number.isFinite(v)) {
              clean.big[qn] = Math.min(qMax(year, qn), Math.max(0, Number(v)));
            }
          }
        }
        if (Object.keys(clean.sel).length || Object.keys(clean.big).length) SCORES[k] = clean;
      }
    } catch (e) {
      failed = true;   // 读坏了就别回写，免得把原有记录冲掉
    } finally {
      if (!failed && LEGACY_SEL) {
        try {
          // 换算结果必须落盘：只改内存的话，下次打开会把 1 当成 1 分
          const out = Object.assign({}, RAW_SCORES, SCORES);
          if (Object.keys(out).length) localStorage.setItem(SCORE_STORE_KEY, JSON.stringify(out));
          localStorage.setItem(SCORE_VER_KEY, '4');
        } catch (e) { /* 隐私模式忽略 */ }
      }
    }
  })();

  const scoreRec = (year, subject) => SCORES[paperKey(year, subject)] || null;
  // touched 默认 true：用户在这份卷子上直接改分；同题自动同步写入时传 false
  const ensureScoreRec = (year, subject, touched = true) => {
    const k = paperKey(year, subject);
    if (!SCORES[k]) SCORES[k] = { sel: {}, big: {}, touched: touched !== false };
    else if (touched !== false) SCORES[k].touched = true;
    return SCORES[k];
  };
  const pruneScoreRec = (year, subject) => {
    const rec = SCORES[paperKey(year, subject)];
    if (rec && !Object.keys(rec.sel).length && !Object.keys(rec.big).length) {
      delete SCORES[paperKey(year, subject)];
    }
  };
  const saveScores = () => {
    try {
      localStorage.setItem(SCORE_STORE_KEY, JSON.stringify(SCORES));
    } catch (e) {
      // 隐私模式或存储已满时忽略，页面仍可继续使用
    }
    VIEW_CACHE.clear();
    renderYearProgress();   // 分数一变，「做完没」的提示跟着变
  };
  const fmtScore = v => {
    if (!Number.isFinite(v)) return '—';
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  };

  /* ── 模拟卷：2021 年后的题型结构，名称和分数都由用户填写 ── */
  const MOCK_KEY = 'kaoyanMath.mocks.v1';
  const MOCK_KIND = n => n <= 10 ? 'choice' : n <= 16 ? 'fill' : 'big';
  const MOCK_MAX = n => n <= 16 ? 5 : n === 17 ? 10 : 12;
  // 题位与 2021 年后的真题一致：数一/数三 1—4 高数、5—7 线代、8—10 概率；
  // 数二不考概率，1—7 高数、8—10 线代。填空和解答题沿用同样的模块顺序。
  function mockModule(subject, n) {
    if (subject === 2) {
      return n <= 7 || (n >= 11 && n <= 15) || (n >= 17 && n <= 21) ? '高数' : '线代';
    }
    if (n <= 4 || (n >= 11 && n <= 14) || (n >= 17 && n <= 20)) return '高数';
    if (n === 5 || n === 6 || n === 7 || n === 15 || n === 21) return '线代';
    return '概率';
  }
  const mockId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const MOCKS = [];
  (function loadMocks() {
    try {
      const raw = JSON.parse(localStorage.getItem(MOCK_KEY) || 'null');
      if (!Array.isArray(raw)) return;
      for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const subject = Number(r.subject);
        const name = String(r.name || '').trim().slice(0, 40);
        const id = String(r.id || '');
        if (![1, 2, 3].includes(subject) || !name || !id) continue;
        const clean = { id, name, subject, sel: {}, big: {}, created: Number(r.created) || Date.now() };
        if (r.sel && typeof r.sel === 'object') {
          for (const [n, v] of Object.entries(r.sel)) {
            const qn = Number(n);
            if (qn >= 1 && qn <= 16 && (v === 0 || v === 1)) clean.sel[qn] = v;
          }
        }
        if (r.big && typeof r.big === 'object') {
          for (const [n, v] of Object.entries(r.big)) {
            const qn = Number(n);
            if (qn >= 17 && qn <= 22 && Number.isFinite(v)) {
              clean.big[qn] = Math.min(MOCK_MAX(qn), Math.max(0, Number(v)));
            }
          }
        }
        MOCKS.push(clean);
      }
    } catch (e) { /* 隐私模式或存储损坏时忽略 */ }
  })();
  const saveMocks = () => {
    try {
      localStorage.setItem(MOCK_KEY, JSON.stringify(MOCKS));
    } catch (e) { /* 隐私模式或存储已满时忽略 */ }
    VIEW_CACHE.clear();
  };

  const state = { view: 'm1', year: 2010, level: 'all', keyOnly: false, statsSubject: 1, mockSubject: 1, paper: 0 };
  const POSITION_KEY = 'kaoyanMath.position.v1';
  const VALID_VIEWS = ['m1', 'm2', 'm3', 'key', 'supp', 'wrong', 'stats', 'mock'];
  // 从英语/政治等板块切回数学时，恢复上次使用的科目与年份。
  function savePosition() {
    try {
      localStorage.setItem(POSITION_KEY, JSON.stringify({
        view: state.view,
        year: state.year,
        statsSubject: state.statsSubject,
        mockSubject: state.mockSubject
      }));
    } catch (e) { /* 禁用存储时仅本次会话有效 */ }
  }
  function loadPosition() {
    try {
      const p = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
      return p && typeof p === 'object' ? p : null;
    } catch (e) {
      return null;
    }
  }
  // 已渲染页面的 DOM 缓存（按视图 + 年份）；成绩改动后由 saveScores 统一清空
  const VIEW_CACHE = new Map();
  const VIEW_CACHE_MAX = 5;

  // 已上线年份由 data.js 的清单给出，不必先把各年数据都载进来
  const liveYears = () => LIVE_YEARS;

  /* ── 错题本（localStorage，file:// 下同样可用） ── */
  const WRONG_KEY = 'kaoyanMath.wrong.v1';
  const wrongKey = (year, subject, n) => `${year}-${subject}-${n}`;
  const loadWrong = () => {
    try {
      const list = JSON.parse(localStorage.getItem(WRONG_KEY) || '[]');
      return new Set(Array.isArray(list) ? list.filter(k => /^\d{4}-[123]-\d+$/.test(k)) : []);
    } catch (e) {
      return new Set();
    }
  };
  const WRONG = loadWrong();
  const saveWrong = () => {
    try {
      localStorage.setItem(WRONG_KEY, JSON.stringify([...WRONG]));
    } catch (e) {
      // 隐私模式或禁用存储时，仅本次会话有效
    }
  };
  const updateWrongBadge = () => {
    const el = document.getElementById('wcount');
    if (!el) return;
    el.textContent = String(WRONG.size);
    el.hidden = WRONG.size === 0;
  };
  // 同一道题可能同时出现在真题页、重点题页和补充题页，统一刷新按钮状态
  const syncWrongBtns = () => {
    document.querySelectorAll('[data-wrong]').forEach(b => {
      const on = WRONG.has(b.dataset.wrong);
      b.setAttribute('aria-pressed', String(on));
      b.textContent = on ? '已加入错题本' : '加入错题本';
    });
    updateWrongBadge();
  };

  /* ── 数据工具 ── */
  const getQ = (year, subject, n) => {
    const arr = PAPERS[`${year}-${subject}`];
    return arr ? arr.find(q => q.n === n) : null;
  };

  const levelOf = (year, subject, n) => {
    const d = DIST[year] && DIST[year][subject];
    if (d) {
      if (d.easy.qs.split(',').map(Number).includes(n)) return '常规';
      if (d.mid.qs.split(',').map(Number).includes(n)) return '中档';
      if (d.hard.qs.split(',').map(Number).includes(n)) return '难题';
    }
    const q = getQ(year, subject, n);
    return q ? q.lv : '常规';
  };

  const isKeyQ = (year, subject, n) => {
    const k = KP_KEY[year] && KP_KEY[year][subject];
    return !!(k && k.includes(n));
  };

  const shortSubj = s => SUBJ[s].replace('数学', '数');

  // 把一年的记录折算成各题型 / 各模块的得分；未标记的题按 0 分计
  function computePaperScore(year, subject) {
    const paper = PAPERS[paperKey(year, subject)] || [];
    const rec = scoreRec(year, subject);
    const mk = () => ({ score: 0, max: 0, any: false, set: 0, count: 0, correct: 0 });
    const cats = { choice: mk(), fill: mk(), big: mk(), '高数': mk(), '线代': mk(), '概率': mk() };
    for (const q of paper) {
      const kind = qKind(year, q.n);
      const max = qMax(year, q.n);
      const isBig = kind === 'big';
      const raw = rec ? (isBig ? rec.big[q.n] : rec.sel[q.n]) : undefined;
      const has = raw !== undefined;
      const got = !has ? 0 : isBig ? Math.min(max, Math.max(0, raw)) : (raw ? max : 0);
      for (const key of [kind, q.m]) {
        const c = cats[key];
        if (!c) continue;
        c.max += max;
        c.score += got;
        c.count++;
        if (has) { c.any = true; c.set++; }
        if (!isBig && raw === 1) c.correct++;
      }
    }
    const merge = (a, b) => ({
      score: a.score + b.score,
      max: a.max + b.max,
      any: a.any || b.any,
      set: a.set + b.set,
      count: a.count + b.count,
      correct: a.correct + b.correct
    });
    const sel = merge(cats.choice, cats.fill);
    const total = merge(sel, cats.big);
    const out = Object.assign({}, cats, { sel, total, year, subject });
    for (const key of ['choice', 'fill', 'sel', 'big', 'total', '高数', '线代', '概率']) {
      const c = out[key];
      c.pct = c.max ? c.score / c.max * 100 : null;
      c.complete = c.count > 0 && c.set === c.count;
    }
    out.hasAny = total.any;
    return out;
  }

  /* ── 整卷「做完了」标记 ──
     判据：这一卷的每一题都记过（选填标了对错、大题填了分）就自动算做完，直接打勾，
     不用再手动确认。有些年份是在纸上做的、没在这页记分，可以手动补勾一个「已做完」。 */
  const YEAR_DONE_KEY = 'kaoyanMath.yearDone.v1';
  // 只存手动补勾的年份（true）；题都记过分的年份由自动判据给出，不占存储
  const YEAR_DONE = {};
  (function loadYearDone() {
    try {
      const raw = JSON.parse(localStorage.getItem(YEAR_DONE_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return;
      for (const [k, v] of Object.entries(raw)) {
        if (/^\d{4}-[123]$/.test(k) && v === true) YEAR_DONE[k] = true;
      }
    } catch (e) { /* 读坏了当作没手动标记过 */ }
  })();
  const saveYearDone = () => {
    try { localStorage.setItem(YEAR_DONE_KEY, JSON.stringify(YEAR_DONE)); } catch (e) {}
  };
  // 题数按年份的卷面结构算，不必先载入那一年的题库（题库是按年懒加载的）
  const yearQCount = year => (year >= 2021 ? 22 : 23);
  const yearUnmarked = (year, subject) => {
    const rec = scoreRec(year, subject);
    const total = yearQCount(year);
    if (!rec) return total;
    let set = 0;
    for (let n = 1; n <= total; n++) {
      const v = qKind(year, n) === 'big' ? rec.big[n] : rec.sel[n];
      if (v !== undefined) set++;
    }
    return total - set;
  };
  const autoYearDone = (year, subject) => yearUnmarked(year, subject) === 0;
  // 题目都记过分就一定打勾；手动补勾只做「加法」，不会把已做完的卷子退回未完成
  const yearDone = (year, subject) => YEAR_DONE[paperKey(year, subject)] === true || autoYearDone(year, subject);

  // 模拟卷没有题干，只按固定的 2021 年题位和模块折算分数
  function computeMockScore(mock) {
    const mk = () => ({ score: 0, max: 0, any: false, set: 0, count: 0, correct: 0 });
    const cats = { choice: mk(), fill: mk(), big: mk(), '高数': mk(), '线代': mk(), '概率': mk() };
    for (let n = 1; n <= 22; n++) {
      const kind = MOCK_KIND(n);
      const max = MOCK_MAX(n);
      const isBig = kind === 'big';
      const raw = isBig ? mock.big[n] : mock.sel[n];
      const has = raw !== undefined;
      const got = !has ? 0 : isBig ? Math.min(max, Math.max(0, raw)) : (raw ? max : 0);
      for (const key of [kind, mockModule(mock.subject, n)]) {
        const c = cats[key];
        if (!c) continue;
        c.max += max;
        c.score += got;
        c.count++;
        if (has) { c.any = true; c.set++; }
        if (!isBig && raw === 1) c.correct++;
      }
    }
    const merge = (a, b) => ({
      score: a.score + b.score,
      max: a.max + b.max,
      any: a.any || b.any,
      set: a.set + b.set,
      count: a.count + b.count,
      correct: a.correct + b.correct
    });
    const sel = merge(cats.choice, cats.fill);
    const total = merge(sel, cats.big);
    const out = Object.assign({}, cats, { sel, total, mock, subject: mock.subject });
    for (const key of ['choice', 'fill', 'sel', 'big', 'total', '高数', '线代', '概率']) {
      const c = out[key];
      c.pct = c.max ? c.score / c.max * 100 : null;
      c.complete = c.count > 0 && c.set === c.count;
    }
    out.hasAny = total.any;
    return out;
  }

  // 题干归一化：忽略公式排版、空格、标点、配图路径等差异
  const NORM_CACHE = new Map();
  const normText = s => {
    const raw = String(s);
    let v = NORM_CACHE.get(raw);
    if (v !== undefined) return v;
    v = raw
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<fig>[\s\S]*?<\/fig>/gi, ' FIG ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\\[a-zA-Z]+\*?/g, ' ')
      .replace(/[{}$\\^_&%#~]/g, ' ')
      .replace(/[，。；：、？！“”‘’（）()【】\[\],.;:!?<>|=\-+]/g, ' ')
      .replace(/\s+/g, '')
      .toLowerCase();
    NORM_CACHE.set(raw, v);
    return v;
  };
  const bigramDice = (a, b) => {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    const grams = s => {
      const m = new Map();
      for (let i = 0; i < s.length - 1; i++) {
        const g = s.slice(i, i + 2);
        m.set(g, (m.get(g) || 0) + 1);
      }
      return m;
    };
    const A = grams(a), B = grams(b);
    let inter = 0, total = 0;
    for (const [g, n] of A) {
      total += n;
      if (B.has(g)) inter += Math.min(n, B.get(g));
    }
    for (const n of B.values()) total += n;
    return total ? 2 * inter / total : 0;
  };

  // 同一道题在不同卷子里常有“该方程的”“设函数”之类的细微措辞差异，
  // 因此先做归一化精确匹配，再对选择题要求选项一致、对填空/解答要求高度相似。
  function stemsMatch(a, b) {
    if (!!a.o !== !!b.o) return false;
    const na = normText(a.x), nb = normText(b.x);
    if (na === nb) return true;
    if (a.o && b.o) {
      if (a.o.length !== b.o.length) return false;
      for (let i = 0; i < a.o.length; i++) {
        if (normText(a.o[i]) !== normText(b.o[i])) return false;
      }
      return bigramDice(na, nb) >= 0.82;
    }
    return bigramDice(na, nb) >= 0.90;
  }

  // 同一年另一科目里的同一道题（数一/数二/数三经常共用题目）
  function otherSameQuestions(year, subject, q) {
    const kind = qKind(year, q.n);
    const out = [];
    const seen = new Set();
    for (const s of [1, 2, 3]) {
      if (s === subject) continue;
      for (const o of (PAPERS[paperKey(year, s)] || [])) {
        if (qKind(year, o.n) !== kind || !stemsMatch(q, o)) continue;
        const k = `${s}-${o.n}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ subject: s, q: o });
      }
    }
    return out;
  }

  function sameQuestionHint(year, subject, q) {
    const kind = qKind(year, q.n);
    const parts = otherSameQuestions(year, subject, q).map(o => {
      const rec = scoreRec(year, o.subject);
      const val = rec ? (kind === 'big' ? rec.big[o.q.n] : rec.sel[o.q.n]) : undefined;
      if (val === undefined) return `${shortSubj(o.subject)} ${o.q.n}`;
      if (kind === 'big') return `${shortSubj(o.subject)} ${o.q.n}（${fmtScore(val)} 分）`;
      return `${shortSubj(o.subject)} ${o.q.n}（${val === 1 ? '对' : '错'}）`;
    });
    return parts.length ? ` · 同题 ${parts.join('、')}` : '';
  }

  // 同题成绩始终共用一个值：任何一科改了，其他科目的同一道题跟着改
  function sameQuestionTargets(year, subject, n) {
    const q = getQ(year, subject, n);
    if (!q) return [];
    const isBig = qKind(year, n) === 'big';
    return otherSameQuestions(year, subject, q)
      .filter(o => (qKind(year, o.q.n) === 'big') === isBig)
      .map(o => ({ subject: o.subject, n: o.q.n }));
  }

  // value 为 undefined 表示取消标记 / 清空该题
  function propagateScore(year, subject, n, value, onlyMissing) {
    let changed = 0;
    for (const t of sameQuestionTargets(year, subject, n)) {
      const rec = scoreRec(year, t.subject);
      const isBig = qKind(year, n) === 'big';
      const cur = rec ? (isBig ? rec.big[t.n] : rec.sel[t.n]) : undefined;
      if (cur === value) continue;
      if (onlyMissing && cur !== undefined) continue;
      if (value === undefined) {
        if (cur === undefined) continue;
        if (isBig) delete rec.big[t.n]; else delete rec.sel[t.n];
      } else {
        const target = ensureScoreRec(year, t.subject, false);
        if (isBig) target.big[t.n] = Math.min(qMax(year, t.n), Math.max(0, value));
        else target.sel[t.n] = value;
      }
      pruneScoreRec(year, t.subject);
      changed++;
    }
    return changed;
  }

  // 打开页面时补全旧记录里只在一科记过、另一科还空着的同题
  function reconcileLoadedScores() {
    let changed = 0;
    for (const year of LOADED_YEARS) {
      for (const subject of [1, 2, 3]) {
        const rec = scoreRec(year, subject);
        if (!rec) continue;
        for (const [n, val] of Object.entries(rec.sel)) {
          changed += propagateScore(year, subject, Number(n), val, true);
        }
        for (const [n, val] of Object.entries(rec.big)) {
          changed += propagateScore(year, subject, Number(n), val, true);
        }
      }
    }
    if (changed) saveScores();
    return changed;
  }

  function syncSameScores(year, subject) {
    let count = 0;
    const bySource = { 1: 0, 2: 0, 3: 0 };
    for (const q of (PAPERS[paperKey(year, subject)] || [])) {
      const kind = qKind(year, q.n);
      for (const o of otherSameQuestions(year, subject, q)) {
        const src = scoreRec(year, o.subject);
        if (!src) continue;
        const val = kind === 'big' ? src.big[o.q.n] : src.sel[o.q.n];
        if (val === undefined) continue;
        const rec = ensureScoreRec(year, subject);
        if (kind === 'big') rec.big[q.n] = Math.min(qMax(year, q.n), Math.max(0, val));
        else rec.sel[q.n] = val;
        count++;
        bySource[o.subject]++;
        break; // 数二、数三都有同题时取先找到的一条
      }
    }
    if (count) {
      pruneScoreRec(year, subject);
      saveScores();
    }
    return { count, bySource };
  }

  const paperPath = (year, subject, kind) => `/pdfs/${year}/${year}-m${subject}-${kind}.pdf`;
  const reviewPath = year => `/pdfs/${year}/${year}-review.pdf`;

  /* ── B 站视频讲解：小崔说数《考研数学历年真题逐题精讲》合集 ──
     一套卷一个视频，P1 是「真题点评 & 重点题」，第 n 题在第 n+1 P。
     2010—2026 数一/数二/数三 共 51 套逐套核对过，规律没有例外；
     以后合集里补了新年份，只要往这张表加一行。 */
  const BILI = {
    '2026-1': 'BV1L7ev67ERp', '2026-2': 'BV1j7ev67EMz', '2026-3': 'BV1j7ev67EPM',
    '2025-1': 'BV1jxJrzLEt4', '2025-2': 'BV1qxJrzLEYm', '2025-3': 'BV17xJrzLEVz',
    '2024-1': 'BV1RamgYmEZM', '2024-2': 'BV1damgYmE3g', '2024-3': 'BV1fsmgYpEzY',
    '2023-1': 'BV1U2mgYMEee', '2023-2': 'BV1U2mgYMECH', '2023-3': 'BV1U2mgYMEvt',
    '2022-1': 'BV18bmVY7ERz', '2022-2': 'BV18bmVY7EJj', '2022-3': 'BV18bmVY7Egs',
    '2021-1': 'BV1b8mVY2E4E', '2021-2': 'BV188mVY2EGL', '2021-3': 'BV1b8mVY2EZZ',
    '2020-1': 'BV1yFmVYTEHg', '2020-2': 'BV1PFmVYMEFz', '2020-3': 'BV1yFmVYTEjS',
    '2019-1': 'BV1fgmVY8E4o', '2019-2': 'BV1BgmVY8ESM', '2019-3': 'BV1zgmVY8ELn',
    '2018-1': 'BV1zgmVY8EeN', '2018-2': 'BV1fgmVY8EyJ', '2018-3': 'BV1BgmVY8Eoe',
    '2017-1': 'BV1NPCmYZErZ', '2017-2': 'BV1KPCmYZEiy', '2017-3': 'BV1NPCmYZEtq',
    '2016-1': 'BV1nX1AYPEWJ', '2016-2': 'BV1rX1AYPEkR', '2016-3': 'BV1nX1AYPEqh',
    '2015-1': 'BV1ZvS4YqE4R', '2015-2': 'BV1ZvS4YqEjN', '2015-3': 'BV1BvS4YBE5Z',
    '2014-1': 'BV1DymyYqEtB', '2014-2': 'BV1DymyYqEcP', '2014-3': 'BV1KXmyYAEXc',
    '2013-1': 'BV13QmtYfECV', '2013-2': 'BV1u2myYTEzY', '2013-3': 'BV1S2myYKEkY',
    '2012-1': 'BV1U4UKYbEny', '2012-2': 'BV1u4UKY8E7A', '2012-3': 'BV1m4UKYbEU1',
    '2011-1': 'BV1SQUnYBEke', '2011-2': 'BV1SQUnYBEmu', '2011-3': 'BV1SQUnYBEsF',
    '2010-1': 'BV1UQUnYBEob', '2010-2': 'BV1SQUnYBEQt', '2010-3': 'BV1SQUnYBEWX',
  };
  const biliVideo = (year, subject) => BILI[`${year}-${subject}`] || '';
  /* 难度评价 / 真题点评 = 该卷视频的 P1 */
  const biliReviewURL = (year, subject) => {
    const bv = biliVideo(year, subject);
    return bv ? `https://www.bilibili.com/video/${bv}/?p=1` : '';
  };
  /* 第 n 题的讲解 = 该卷视频的 P(n+1)；没有对应视频时返回空串，入口自动隐藏 */
  const biliQURL = (year, subject, n) => {
    const bv = biliVideo(year, subject);
    return bv ? `https://www.bilibili.com/video/${bv}/?p=${n + 1}` : '';
  };
  const BILI_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.3" y="4.3" width="11.4" height="8.8" rx="2.2"/><path d="M5.2 1.9 8 4.3l2.8-2.4"/><path d="M6.6 7.1 10.2 8.7 6.6 10.3z" fill="currentColor" stroke="none"/></svg>';
  const videoLinkHTML = (href, label, tip, cls) => !href ? ''
    : `<a class="qvlink${cls ? ' ' + cls : ''}" href="${href}" target="_blank" rel="noopener noreferrer" title="${tip}">${BILI_ICON}<span>${label}</span></a>`;

  // 试卷排版里 lim/∑ 的上下标写在正下方；定积分、重积分的上下限写在积分号右侧
  const LIMIT_OPS = /\\(lim|limsup|liminf|varlimsup|varliminf|max|min|sup|inf|sum|prod|coprod|bigcup|bigcap)_/g;
  // KaTeX 在 \displaystyle 下会把 \int 的上下限堆到正上/正下（\nolimits 也压不住），
  // 把紧跟在 \displaystyle 后面的积分号换成 textstyle 版本，上下限就回到右上方/右下方
  // \limits / \nolimits 必须跟着积分号一起进花括号，否则会报
  // “Limit controls must follow a math operator”
  const DISPLAY_INT = /\\displaystyle\s*\\(int|iint|iiint|oint)((?:\s*\\(?:limits|nolimits))?)(?![A-Za-z])/g;

  // 试卷里的表格（联合分布表等）按原样画出来，改写成 "P{X=…}=…" 罗列会改变题面。
  // 写法：<tbl>X\Y|$0$|$1$|$2$;$0$|$\frac14$|$0$|…</tbl>
  // 行用 ; 分隔、单元格用 | 分隔（\｜、\; 表示字面量）；首行首格写 行变量\列变量，由 CSS 画斜线。
  const TBL_RE = /<tbl>([\s\S]*?)<\/tbl>/gi;
  const esc = c => String(c).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
  const buildTable = body => {
    const PIPE = '\u0002', SEMI = '\u0003';
    const rows = body.replace(/\\\|/g, PIPE).replace(/\\;/g, SEMI).split(';')
      .map(r => r.split('|').map(c => c.replace(new RegExp(PIPE, 'g'), '|').replace(new RegExp(SEMI, 'g'), ';')))
      .filter(r => r.some(c => c.trim()));
    if (!rows.length) return '';
    const head = rows[0];
    // 首格写 "行变量\列变量" 画斜线；只写一个变量（如分布律表的 "X"）则画普通表头格，与试卷一致
    const corner = (head[0] || '').split('\\');
    const cornerCell = corner.length > 1
      ? `<td class="corner"><span class="cx">${esc(corner[0] || 'X')}</span><span class="cy">${esc(corner[1] || 'Y')}</span></td>`
      : `<td class="corner plain"><span class="cx">${esc(corner[0] || '')}</span></td>`;
    const html = [`<table class="tbl"><tr>${cornerCell}`];
    for (let i = 1; i < head.length; i++) html.push(`<th>${esc(head[i])}</th>`);
    html.push('</tr>');
    for (let r = 1; r < rows.length; r++) {
      html.push(`<tr><th>${esc(rows[r][0] || '')}</th>`);
      for (let i = 1; i < rows[r].length; i++) html.push(`<td>${esc(rows[r][i] || '')}</td>`);
      html.push('</tr>');
    }
    html.push('</table>');
    return html.join('');
  };

  // 试卷原图（函数图像、区域图等）用 <fig>figs/2015/m1-q1.png</fig> 引用，图片直接从试卷截图
  const FIG_RE = /<fig>([^<]*)<\/fig>/gi;

  // 题干里的 "<" 会被浏览器当成标签开头（如 $I<K$），只保留 <br>/<b>/<tbl>/<fig> 等少量排版标签
  const safe = s => {
    const tags = [];
    return String(s)
      .replace(DISPLAY_INT, '\\displaystyle{\\textstyle\\$1$2}')
      .replace(LIMIT_OPS, '\\$1\\limits_')
      .replace(FIG_RE, (_, src) => {
        tags.push(`<img class="qfig" src="/${src.trim().replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" alt="题图">`);
        return '\u0000' + (tags.length - 1) + '\u0001';
      })
      .replace(TBL_RE, (_, body) => { tags.push(buildTable(body)); return '\u0000' + (tags.length - 1) + '\u0001'; })
      .replace(/<\/?(?:br|b|i|em|strong)\s*\/?>/gi, m => { tags.push(m); return '\u0000' + (tags.length - 1) + '\u0001'; })
      .replace(/</g, '&lt;')
      .replace(/\u0000(\d+)\u0001/g, (_, i) => tags[+i]);
  };

  const stars = st => {
    let s = '';
    for (let i = 0; i < 5; i++) s += i < st ? '★' : '<span class="off">★</span>';
    return `<span class="stars" title="难度 ${st}/5">${s}<span class="num">${st}/5</span></span>`;
  };

  // 整段都是积分/求和这类带上下限的式子时，嵌套的上下限会很小，整体放大一点才接近试卷排版
  const bigOpt = t => !/[一-鿿]/.test(t) && /\\(?:i{1,3}nt|oint|sum|prod|lim)/.test(t);

  /* ── 计时器：整卷 / 选填 / 大题合计 / 大题每题，模拟卷同理 ── */
  // 每项存累计毫秒 acc 和本轮起点 at（null = 暂停中）。页面关掉再打开按时间戳接着走。
  const TIMER_KEY = 'kaoyanMath.timers.v1';
  const TIMERS = {};
  (function loadTimers() {
    try {
      const raw = JSON.parse(localStorage.getItem(TIMER_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return;
      for (const [k, t] of Object.entries(raw)) {
        if (!t || typeof t !== 'object') continue;
        const acc = Number(t.acc);
        if (!Number.isFinite(acc) || acc < 0) continue;
        const at = Number(t.at) || null;
        const beat = Number(t.savedAt) || at;
        const item = { acc: acc, at: at };
        // 关掉页面很久才回来：没有心跳的那段时间不算进用时
        if (item.at && Date.now() - beat > 120000) {
          item.acc += Math.max(0, beat - item.at);
          item.at = null;
        }
        TIMERS[k] = item;
      }
    } catch (e) { /* 隐私模式忽略 */ }
  })();
  function saveTimers() {
    try {
      const out = {};
      for (const [k, t] of Object.entries(TIMERS)) {
        if (!t.acc && !t.at) continue;
        out[k] = { acc: Math.round(t.acc), at: t.at, savedAt: Date.now() };
      }
      localStorage.setItem(TIMER_KEY, JSON.stringify(out));
    } catch (e) { /* 忽略 */ }
  }
  const timerElapsed = t => (t ? t.acc + (t.at ? Date.now() - t.at : 0) : 0);
  const timerScope = key => String(key).split('|')[0];
  const mockScope = mock => `mock:${mock.id}`;
  const timerSum = scope => Object.entries(TIMERS)
    .filter(([k]) => timerScope(k) === scope)
    .reduce((sum, [, t]) => sum + timerElapsed(t), 0);
  const fmtClock = ms => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor(total % 3600 / 60);
    const sec = total % 60;
    const p = v => String(v).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
  };

  /* ── 同题计时：同一道题在数一/数二/数三里出现时，用时也共用一个值 ── */
  // 跟同题得分一个道理：任何一科按了开始/暂停/重置，其他科目的同一道题跟着变。
  // 只对「每题一个计时器」的大题生效；选填是整段一个计时单位，跟题号对不上，不参与。
  function timerPeerKeys(key) {
    const k = String(key);
    const bar = k.indexOf('|');
    if (bar < 0) return [];
    const scope = k.slice(0, bar), part = k.slice(bar + 1);
    if (!/^\d+$/.test(part)) return [];
    const m = /^(\d{4})-([123])$/.exec(scope);
    if (!m) return [];                       // 模拟卷是自定义题，没有同题可对应
    const year = Number(m[1]), subject = Number(m[2]);
    if (!LOADED_YEARS.has(year)) return [];  // 那一年数据还没载入，题干没法比对
    return sameQuestionTargets(year, subject, Number(part))
      .map(t => `${year}-${t.subject}|${t.n}`);
  }

  // onlyMissing=true：只在对方还没计时过时补上，不覆盖已有记录（载入时用）
  function syncTimerPeers(key, onlyMissing) {
    const src = TIMERS[key];
    let changed = 0;
    for (const pk of timerPeerKeys(key)) {
      const cur = TIMERS[pk];
      if (!src) {                            // 本条被重置：同题一起清掉
        if (!cur) continue;
        delete TIMERS[pk];
        changed++;
        continue;
      }
      if (onlyMissing && cur) continue;
      const same = cur && Math.round(cur.acc) === Math.round(src.acc) && (!cur.at === !src.at);
      if (same) continue;
      TIMERS[pk] = { acc: Math.round(src.acc), at: src.at };
      changed++;
    }
    return changed;
  }

  // 打开页面时把只在一科计过时的同题时间补到其他科目
  function reconcileLoadedTimers() {
    let changed = 0;
    for (const key of Object.keys(TIMERS)) changed += syncTimerPeers(key, true);
    if (changed) saveTimers();
    return changed;
  }

  /* ── 计时器放大：点时间数字弹出一个大号浮层，放远了也看得清 ── */
  let zoomKey = null;
  let zoomEl = null;
  const ZOOM_HTML = '<div class="tzoom-mask" data-tzoom-close></div>' +
    '<div class="tzoom-card" role="dialog" aria-modal="true" aria-label="计时器">' +
      '<p class="tzoom-lab"></p>' +
      '<p class="tzoom-time">00:00</p>' +
      '<div class="tzoom-btns">' +
        '<button class="tzoom-btn main" type="button" data-tzoom-toggle>开始</button>' +
        '<button class="tzoom-btn" type="button" data-tzoom-reset>重置</button>' +
        '<button class="tzoom-btn ghost" type="button" data-tzoom-close>关闭</button>' +
      '</div>' +
    '</div>';

  function mountZoom() {
    if (zoomEl) return zoomEl;
    zoomEl = document.createElement('div');
    zoomEl.className = 'tzoom';
    zoomEl.hidden = true;
    zoomEl.innerHTML = ZOOM_HTML;
    zoomEl.addEventListener('click', e => {
      if (e.target.closest('[data-tzoom-close]')) { closeZoom(); return; }
      if (!zoomKey || zoomKey.indexOf('sum:') === 0) return;
      if (e.target.closest('[data-tzoom-toggle]')) toggleTimer(zoomKey);
      else if (e.target.closest('[data-tzoom-reset]')) resetTimer(zoomKey);
    });
    document.body.appendChild(zoomEl);
    return zoomEl;
  }
  const zoomIsSum = () => !!zoomKey && zoomKey.indexOf('sum:') === 0;
  function paintZoom() {
    if (!zoomEl || zoomEl.hidden || !zoomKey) return;
    const sum = zoomIsSum();
    const t = sum ? null : TIMERS[zoomKey];
    const run = !!(t && t.at);
    zoomEl.querySelector('.tzoom-time').textContent =
      fmtClock(sum ? timerSum(zoomKey.slice(4)) : timerElapsed(TIMERS[zoomKey]));
    zoomEl.classList.toggle('is-run', run);
    const tog = zoomEl.querySelector('[data-tzoom-toggle]');
    const rst = zoomEl.querySelector('[data-tzoom-reset]');
    tog.hidden = sum;
    rst.hidden = sum;
    tog.textContent = run ? '暂停' : '开始';
    tog.classList.toggle('is-on', run);
  }
  // 放大层顶部的说明：选填是合在一起计时的，大题按题号
  function zoomLabelOf(box) {
    const n = String(box.dataset.timer || '').split('|')[1] || '';
    if (n === 'all') return '整套试卷 · 合计用时';
    if (n === 'sel') return '选择题 + 填空题 · 合计用时';
    if (n === 'big') return '解答题 · 合计用时';
    if (/^\d+$/.test(n)) return `第 ${n} 题用时`;
    return box.getAttribute('title') || '本题用时';
  }
  function openZoom(key, label) {
    mountZoom();
    zoomKey = key;
    zoomEl.querySelector('.tzoom-lab').textContent = label || '';
    zoomEl.hidden = false;
    document.body.classList.add('tzoom-open');
    paintZoom();
  }
  function closeZoom() {
    if (!zoomEl) return;
    zoomEl.hidden = true;
    zoomKey = null;
    document.body.classList.remove('tzoom-open');
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && zoomEl && !zoomEl.hidden) closeZoom();
  });

  function timerHTML(key, label, text) {
    const t = TIMERS[key];
    const run = !!(t && t.at);
    return `<span class="qtimer${run ? ' is-run' : ''}" data-timer="${attr(key)}" title="${attr(label)}">` +
      (text ? `<span class="qtimer-lab">${esc(text)}</span>` : '') +
      `<span class="qtimer-time" data-timer-zoom title="点一下放大">${fmtClock(timerElapsed(t))}</span>` +
      `<button class="qtimer-btn" type="button" data-timer-toggle aria-pressed="${run}" aria-label="${run ? '暂停计时' : '开始计时'}">${run ? '❚❚' : '▶'}</button>` +
      `<button class="qtimer-btn reset" type="button" data-timer-reset aria-label="重置计时" title="重置为 00:00">↺</button>` +
      `</span>`;
  }
  function paintTimer(el) {
    const key = el.dataset.timer;
    const t = TIMERS[key];
    const run = !!(t && t.at);
    const timeEl = el.querySelector('.qtimer-time');
    if (timeEl) timeEl.textContent = fmtClock(timerElapsed(t));
    el.classList.toggle('is-run', run);
    const btn = el.querySelector('[data-timer-toggle]');
    if (btn) {
      btn.textContent = run ? '❚❚' : '▶';
      btn.setAttribute('aria-pressed', String(run));
      btn.setAttribute('aria-label', run ? '暂停计时' : '开始计时');
    }
  }
  function paintTimers() {
    paintZoom();
    for (const el of appEl.querySelectorAll('[data-timer]')) paintTimer(el);
    const box = appEl.querySelector('[data-scorefloat]');
    if (box) {
      const y = Number(box.dataset.year), s = Number(box.dataset.subject);
      const el = box.querySelector('[data-sf="time"]');
      if (el) el.textContent = fmtClock(timerSum(`${y}-${s}`));
      // 题型用时每秒跟着计时器走，不整卡重绘，避免打断点击/滚动
      for (const t of box.querySelectorAll('[data-sf-t]')) {
        t.textContent = fmtClock(floatTimeOf(y, s, t.dataset.sfT));
      }
    }
    for (const el of appEl.querySelectorAll('[data-mock-time]')) {
      const card = el.closest('[data-mockcard]');
      if (card) el.textContent = fmtClock(timerSum(`mock:${card.dataset.mockId}`));
    }
  }
  function startTimer(key) {
    const t = TIMERS[key] || (TIMERS[key] = { acc: 0, at: null });
    if (t.at) return;
    // 同一份卷同时只走一个计时器，否则整卷用时会把重叠的部分算两遍
    const scope = timerScope(key);
    const stopped = [];
    for (const [k, o] of Object.entries(TIMERS)) {
      if (k !== key && timerScope(k) === scope && o.at) {
        o.acc += Date.now() - o.at;
        o.at = null;
        stopped.push(k);
      }
    }
    t.at = Date.now();
    // 同题共用一条计时：这一题开跑，别的卷子里同一道题也跟着走；被顺带停下的同题同步停住
    syncTimerPeers(key, false);
    for (const k of stopped) syncTimerPeers(k, false);
    saveTimers();
    paintTimers();
  }
  function pauseTimer(key) {
    const t = TIMERS[key];
    if (!t || !t.at) return;
    t.acc += Date.now() - t.at;
    t.at = null;
    syncTimerPeers(key, false);
    saveTimers();
    paintTimers();
  }
  function resetTimer(key) {
    const had = !!TIMERS[key];
    if (had) delete TIMERS[key];
    const peers = syncTimerPeers(key, false);
    if (!had && !peers) return;
    saveTimers();
    paintTimers();
  }
  const toggleTimer = key => {
    const t = TIMERS[key];
    if (t && t.at) pauseTimer(key); else startTimer(key);
  };
  setInterval(() => {
    if (!appEl.querySelector('[data-timer], [data-scorefloat], [data-mock-time]')) return;
    paintTimers();
  }, 1000);
  // 运行中每 5 秒落一次心跳，刷新后能判断是「还在用」还是「关了页面」
  setInterval(() => {
    if (Object.values(TIMERS).some(t => t.at)) saveTimers();
  }, 5000);
  // 浮卡里「未完成」显示几个题号跟窗口宽度有关，转屏或改窗口大小后重算
  let floatResizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(floatResizeTimer);
    floatResizeTimer = setTimeout(() => {
      const box = appEl.querySelector('[data-scorefloat]');
      if (box) updateFloatScore(Number(box.dataset.year), Number(box.dataset.subject));
      refreshPageFloat();
    }, 220);
  });

  /* ── 我的成绩面板 ── */
  const attr = s => esc(s).replace(/"/g, '&quot;');

  // 逐题精析里每题都能直接记：选填只标对错，解答题按步填分
  function scoreBoxHTML(year, subject, q, opts) {
    if (!opts || !opts.score) return '';
    const big = qKind(year, q.n) === 'big';
    const max = qMax(year, q.n);
    const rec = scoreRec(year, subject);
    if (!big) {
      const v = rec ? rec.sel[q.n] : undefined;
      return `<span class="qjudge" data-qsel="${year},${subject},${q.n}" role="group" aria-label="第 ${q.n} 题对错，与顶部「我的成绩」同步">
        <button class="qjudge-btn ok${v === 1 ? ' is-on' : ''}" type="button" data-sel-mark="1" aria-pressed="${v === 1}" title="第 ${q.n} 题做对（${max} 分）">✓</button>
        <button class="qjudge-btn no${v === 0 ? ' is-on' : ''}" type="button" data-sel-mark="0" aria-pressed="${v === 0}" title="第 ${q.n} 题做错">✗</button>
      </span>`;
    }
    const v = rec ? rec.big[q.n] : undefined;
    return `<span class="qscore" title="第 ${q.n} 题得分，与顶部「我的成绩」同步">
      <span class="qscore-lab">得分</span>
      <input type="number" inputmode="decimal" min="0" max="${max}" step="0.5" placeholder="—" value="${v === undefined ? '' : fmtScore(v)}" data-qbig="${year},${subject},${q.n}" aria-label="第 ${q.n} 题得分，满分 ${max} 分">
      <span class="qscore-max">/ ${max}</span>
    </span>`;
  }

  /* 成绩面板（我的成绩 / 模拟卷）整块收起：只留标题和当前得分 */
  const PANEL_FOLD_KEY = 'kaoyanMath.panelFold.v1';
  function panelFolded() {
    try { return localStorage.getItem(PANEL_FOLD_KEY) === '1'; } catch (e) { return false; }
  }
  function setPanelFolded(fold) {
    try { localStorage.setItem(PANEL_FOLD_KEY, fold ? '1' : '0'); } catch (e) {}
  }
  function panelToggleHTML(folded, what) {
    const label = (folded ? '展开' : '收起') + what;
    return `<button class="panel-toggle" type="button" data-panel-toggle data-panel-what="${what}" aria-expanded="${folded ? 'false' : 'true'}" aria-label="${label}" title="${label}"><svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.5 7.6 6 4.1 9.5 7.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  }
  function togglePanelFold(card) {
    const fold = !card.classList.contains('is-folded');
    card.classList.toggle('is-folded', fold);
    setPanelFolded(fold);
    const btn = card.querySelector('[data-panel-toggle]');
    if (btn) {
      const label = (fold ? '展开' : '收起') + (btn.dataset.panelWhat || '成绩面板');
      btn.setAttribute('aria-expanded', String(!fold));
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    }
  }

  function scorePanelHTML(year, subject) {
    const paper = PAPERS[paperKey(year, subject)] || [];
    const rec = scoreRec(year, subject);
    const c = computePaperScore(year, subject);
    const choiceQs = paper.filter(q => qKind(year, q.n) === 'choice');
    const fillQs = paper.filter(q => qKind(year, q.n) === 'fill');
    const bigQs = paper.filter(q => qKind(year, q.n) === 'big');

    const chip = q => {
      const v = rec ? rec.sel[q.n] : undefined;
      const got = v === undefined ? '' : v === 1 ? ' · 做对' : ' · 做错';
      const title = `${q.n} 题 · ${q.m} · ${attr(q.t)}${got}${sameQuestionHint(year, subject, q)}`;
      return `<button class="qsbtn${v === 0 ? ' is-wrong' : ''}" type="button" data-score-q="${q.n}" aria-pressed="${v === 1}" title="${title}">${q.n}</button>`;
    };

    const bigRows = bigQs.map(q => {
      const max = qMax(year, q.n);
      const v = rec ? rec.big[q.n] : undefined;
      const copies = otherSameQuestions(year, subject, q).map(o => {
        const src = scoreRec(year, o.subject);
        const sv = src ? src.big[o.q.n] : undefined;
        if (sv === undefined) return '';
        return `<button class="copybtn" type="button" data-copy-big="${o.subject},${o.q.n},${q.n}" title="复制 ${SUBJ[o.subject]}第 ${o.q.n} 题的得分">同题 ${shortSubj(o.subject)} ${o.q.n} · ${fmtScore(sv)} 分</button>`;
      }).join('');
      return `<div class="bigrow">
        <span class="bigq">${q.n}</span>
        <span class="bigmeta"><b>${q.m}</b> · ${max} 分</span>
        <span class="biginput"><input type="number" inputmode="decimal" min="0" max="${max}" step="0.5" placeholder="—" value="${v === undefined ? '' : fmtScore(v)}" data-score-big="${q.n}" aria-label="第 ${q.n} 题得分，满分 ${max} 分"><span class="bigmax">/ ${max}</span></span>
        ${copies}
      </div>`;
    }).join('');

    return `<section class="card scorecard${c.hasAny ? ' has-score' : ''}${panelFolded() ? ' is-folded' : ''}" data-scorecard data-year="${year}" data-subject="${subject}">
      <div class="scorecard-head">
        <div>
          <div class="rtitle">我的成绩 · ${paperTitle(year, subject)}</div>
          <p class="scmeta">满分 <b>150</b> · 选填 <b>${c.sel.max}</b> 分 + 大题 <b>${c.big.max}</b> 分</p>
        </div>
        <div class="sc-tools">
          <div class="scorenow"><span>当前得分</span><b data-score-sum="total">${fmtScore(c.total.score)}</b><i>/ 150</i></div>
          ${panelToggleHTML(panelFolded(), '成绩面板')}
        </div>
      </div>
      <div class="scblock">
        <div class="scblock-head">
          <h4>选择 · 填空</h4>
          <span class="scblock-meta">选择 ${c.choice.max} 分 · 填空 ${c.fill.max} 分 · 选填 ${c.sel.max} 分</span>
          <div class="scbtns">
            <button class="minibtn" type="button" data-score-all title="只把尚未标记的选填标为做对，已有记录保持不变">全选选填</button>
            <button class="minibtn" type="button" data-score-clear-sel>清空选填</button>
          </div>
        </div>
        <div class="qsgroup"><span class="qsgroup-lab">选择</span><div class="qsgrid">${choiceQs.map(chip).join('')}</div></div>
        <div class="qsgroup"><span class="qsgroup-lab">填空</span><div class="qsgrid">${fillQs.map(chip).join('')}</div></div>
        <p class="scsum">做对 <b data-score-correct>${c.sel.correct}</b> / ${c.sel.count} 题（已标记 <b data-score-set="sel">${c.sel.set}</b> / ${c.sel.count}）· 选填 <b data-score-sum="sel">${fmtScore(c.sel.score)}</b> / ${c.sel.max}</p>
      </div>
      <div class="scblock">
        <div class="scblock-head">
          <h4>解答题</h4>
          <span class="scblock-meta">${bigQs.length} 题 · ${c.big.max} 分</span>
          <div class="scbtns">
            <button class="minibtn" type="button" data-score-all-big title="只把尚未填写的大题补成满分，已有分数保持不变">大题全满分</button>
          </div>
        </div>
        <div class="bigrows">${bigRows}</div>
        <p class="scsum">已填 <b data-score-set="big">${c.big.set}</b> / ${c.big.count} 题 · 大题 <b data-score-sum="big">${fmtScore(c.big.score)}</b> / ${c.big.max}</p>
      </div>
      <div class="scorefoot">
        <span>点题号标记做对，再点一次标记做错；同题分数和用时都会自动同步到其他科目。「全选」和「大题全满分」只补齐未记录的部分，不会覆盖已填分数。未标记／未填写的题目按 0 分计。</span>
        <div class="scorefoot-btns">
          <button class="minibtn" type="button" data-score-sync title="同题已自动同步；这个按钮用于补齐以前留下的旧记录">补齐同题分数</button>
          <button class="minibtn danger" type="button" data-score-reset>清空本卷成绩</button>
        </div>
        <span class="scorestatus" data-score-status></span>
      </div>
      ${migrateBlockHTML()}
    </section>`;
  }

  function repaintScorecard(card, year, subject) {
    const tmp = document.createElement('div');
    tmp.innerHTML = scorePanelHTML(year, subject);
    const fresh = tmp.firstElementChild;
    if (!fresh) return card;
    card.replaceWith(fresh);
    refreshBigCardInputs(year, subject);   // 面板重画后，题目卡片上的分数也要跟上
    updateFloatScore(year, subject);       // 右下角的本卷得分卡同理
    return fresh;
  }

  function setScoreStatus(card, msg) {
    const el = card && card.querySelector('[data-score-status]');
    if (el) el.textContent = msg;
  }

  function updateScoreSums(card, year, subject) {
    const c = computePaperScore(year, subject);
    const put = (sel, val) => {
      const el = card.querySelector(sel);
      if (el) el.textContent = val;
    };
    put('[data-score-set="big"]', c.big.set);
    put('[data-score-sum="big"]', fmtScore(c.big.score));
    put('[data-score-sum="total"]', fmtScore(c.total.score));
    put('[data-score-set="sel"]', c.sel.set);
    put('[data-score-sum="sel"]', fmtScore(c.sel.score));
    put('[data-score-correct]', c.sel.correct);
    card.classList.toggle('has-score', c.hasAny);
    updateFloatScore(year, subject, c);
  }

  /* ── 右下角的本卷得分卡 ── */
  // 还没记分（选填没标对错、大题没填分）的题号，用来提示还差哪些题
  function floatMissing(year, subject) {
    const paper = PAPERS[paperKey(year, subject)] || [];
    const rec = scoreRec(year, subject);
    const out = [];
    for (const q of paper) {
      const isBig = qKind(year, q.n) === 'big';
      const raw = rec ? (isBig ? rec.big[q.n] : rec.sel[q.n]) : undefined;
      if (raw === undefined) out.push(q.n);
    }
    return out;
  }
  // 各题型用时：选填是一个计时单位（选择+填空合在一起走表），大题每题一个，这里按题型汇总
  function floatTimeOf(year, subject, kind) {
    const scope = paperKey(year, subject);
    if (kind === 'sel') return timerElapsed(TIMERS[`${scope}|sel`]);
    if (kind === 'big') {
      let sum = timerElapsed(TIMERS[`${scope}|big`]);
      for (const q of (PAPERS[scope] || [])) {
        if (qKind(year, q.n) === 'big') sum += timerElapsed(TIMERS[`${scope}|${q.n}`]);
      }
      return sum;
    }
    return 0;
  }
  function floatBodyHTML(year, subject, c) {
    const miss = floatMissing(year, subject);
    const done = Math.max(0, c.total.count - miss.length);
    const pct = c.total.max ? Math.min(100, c.total.score / c.total.max * 100) : 0;
    const limit = window.innerWidth <= 640 ? 6 : 10;
    const shown = miss.slice(0, limit);
    const row = (label, key, val, max, kind) =>
      `<div class="sf-line sf-sc"><span>${label}</span><b data-sf="${key}">${fmtScore(val)}</b><i>/ ${max}</i>` +
      `<em class="sf-t"${kind ? ` data-sf-t="${kind}"` : ''}>${kind ? fmtClock(floatTimeOf(year, subject, kind)) : ''}</em></div>`;
    return `<div class="sf-top"><span>本卷得分</span><b data-sf="total">${fmtScore(c.total.score)}</b><i>/ ${c.total.max}</i></div>` +
      row('选择题', 'choice', c.choice.score, c.choice.max) +
      row('填空题', 'fill', c.fill.score, c.fill.max) +
      row('选填', 'sel', c.sel.score, c.sel.max, 'sel') +
      row('大题', 'big', c.big.score, c.big.max, 'big') +
      `<div class="sf-line sf-sc"><span>用时</span><b data-sf="time">${fmtClock(timerSum(paperKey(year, subject)))}</b><em class="sf-t"></em></div>` +
      `<div class="sf-done"><span>已完成</span><b data-sf="done">${done}</b><i>/ ${c.total.count} 题</i>${miss.length ? '' : '<em class="sf-tick">✓</em>'}</div>` +
      (miss.length
        ? `<div class="sf-miss"><span class="sf-mlabel">未完成</span>${shown.map(n => `<a data-sf-jump="${n}" title="跳到第 ${n} 题">${n}</a>`).join('')}${miss.length > limit ? `<em class="sf-more">+${miss.length - limit}</em>` : ''}</div>`
        : '') +
      `<div class="sf-bar"><i data-sf="bar" style="width:${pct.toFixed(1)}%"></i></div>`;
  }
  // 收起状态：手机上默认收起成一条小胶囊，用户手动切过就按他的选择记住
  const FLOAT_FOLD_KEY = 'kaoyanMath.floatFold.v1';
  function floatFolded() {
    let v = null;
    try { v = localStorage.getItem(FLOAT_FOLD_KEY); } catch (e) {}
    if (v === '1') return true;
    if (v === '0') return false;
    return window.innerWidth <= 640;
  }
  function setFloatFolded(fold) {
    try { localStorage.setItem(FLOAT_FOLD_KEY, fold ? '1' : '0'); } catch (e) {}
  }
  function floatToggleHTML() {
    const folded = floatFolded();
    const label = folded ? '展开本卷得分卡' : '收起本卷得分卡';
    return `<button class="sf-toggle" type="button" data-sf-toggle aria-expanded="${folded ? 'false' : 'true'}" aria-label="${label}" title="${label}"><svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.5 7.6 6 4.1 9.5 7.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  }
  const floatTitle = folded => folded ? '点一下展开本卷得分卡' : '点击空白处回到「我的成绩」';
  function toggleFloatFold(box) {
    const fold = !box.classList.contains('is-collapsed');
    const isPage = box.hasAttribute('data-pagefloat');
    box.classList.toggle('is-collapsed', fold);
    setFloatFolded(fold);
    box.setAttribute('title', isPage ? pageFloatTitle(fold) : floatTitle(fold));
    const btn = box.querySelector('[data-sf-toggle]');
    if (btn) {
      const label = (fold ? '展开' : '收起') + (isPage ? '本页' : '本卷') + '得分卡';
      btn.setAttribute('aria-expanded', String(!fold));
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    }
  }
  function scoreFloatHTML(year, subject) {
    const c = computePaperScore(year, subject);
    const folded = floatFolded();
    return `<aside class="scorefloat${c.hasAny ? ' has-score' : ''}${folded ? ' is-collapsed' : ''}" data-scorefloat data-year="${year}" data-subject="${subject}" title="${floatTitle(folded)}">${floatToggleHTML()}${floatBodyHTML(year, subject, c)}</aside>`;
  }
  function updateFloatScore(year, subject, c) {
    const box = appEl.querySelector('[data-scorefloat]');
    if (!box) return;
    const score = c || computePaperScore(year, subject);
    box.innerHTML = floatToggleHTML() + floatBodyHTML(year, subject, score);
    box.classList.toggle('has-score', score.hasAny);
    box.classList.toggle('is-collapsed', floatFolded());   // 转屏 / 改窗口宽度时跟着默认值走
    box.setAttribute('title', floatTitle(floatFolded()));
    paintYearMarks();   // 这一卷刚记完最后一题的话，年份按钮立刻打勾
  }

  /* ── 重点题 / 补充真题页的得分卡 ──
     这两页的题来自不同年份的不同卷子（同一道题还常在数一/数二/数三里重复出现），
     所以不按「某一卷」汇总，而是按当前页面列出的题目汇总。
     分数仍然写回原卷的那一题：与真题页共用同一条记录，同题还会自动同步，
     这里只是多一个入口，不进右上角「成绩统计」另算一份。 */
  let PAGE_ITEMS = [];   // 当前页面列出的题目：[[subject, n], ...]
  // 同一道题在两份卷子里都列出来时只算一次（题干相同视为同题）
  function uniqueItems(year, raw) {
    const seen = new Set();
    const out = [];
    for (const [s, n] of raw) {
      const q = getQ(year, s, n);
      const k = q ? String(q.x).trim() : `${s}-${n}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([s, n]);
    }
    return out;
  }
  /* 某一年的重点题 / 补充真题会列出哪些题（与渲染时的去重口径一致）。
     年份条上的完成标记要按「这一页列出的题」算，所以单独抽出来，
     不依赖当前正在看的是哪一年。 */
  function keyPageItems(year) {
    const seen = new Set();
    const out = [];
    for (const g of (KEY_GROUPS[year] || [])) {
      for (const [subject, n] of g.items) {
        const q = getQ(year, subject, n);
        if (!q) continue;
        const stem = String(q.x).trim();
        if (seen.has(stem)) continue;
        seen.add(stem);
        out.push([subject, n]);
      }
    }
    return out;
  }
  function suppPageItems(year) {
    const groups = SUPP[year] || [];
    return uniqueItems(year, groups.flatMap(g => g.nums.map(n => [g.from, n])));
  }
  /* 年份条要显示 17 年的完成情况，而题库是按年懒加载的，
     所以别的年份用 keymap.js 里的静态清单（build-tools/gen-keymap.mjs 生成），
     当前这一年直接用渲染时算出的 PAGE_ITEMS，跟屏幕上的卡片一一对应。 */
  function pageItemsOf(year, view) {
    if (year === state.year && PAGE_ITEMS.length) return PAGE_ITEMS;
    const map = view === 'supp'
      ? (typeof SUPP_ITEMS !== 'undefined' ? SUPP_ITEMS : null)
      : (typeof KEY_ITEMS !== 'undefined' ? KEY_ITEMS : null);
    if (map && map[year] && map[year].length) return map[year];
    return view === 'supp' ? suppPageItems(year) : keyPageItems(year);
  }
  function pageScoreStats(year, items) {
    const mk = () => ({ score: 0, max: 0, count: 0, set: 0 });
    const subs = { 1: mk(), 2: mk(), 3: mk() };
    const sel = mk();
    const big = mk();
    const miss = [];
    for (const [subject, n] of items) {
      const max = qMax(year, n);
      const isBig = qKind(year, n) === 'big';
      const rec = scoreRec(year, subject);
      const raw = rec ? (isBig ? rec.big[n] : rec.sel[n]) : undefined;
      const got = raw === undefined ? 0 : isBig ? Math.min(max, Math.max(0, raw)) : (raw ? max : 0);
      for (const b of [subs[subject], isBig ? big : sel]) {
        b.max += max;
        b.score += got;
        b.count++;
        if (raw !== undefined) b.set++;
      }
      if (raw === undefined) miss.push([subject, n]);
    }
    const total = {
      score: sel.score + big.score,
      max: sel.max + big.max,
      count: sel.count + big.count,
      set: sel.set + big.set
    };
    const subCount = [1, 2, 3].filter(s => subs[s].count).length;
    return { subs, sel, big, total, miss, subCount };
  }
  function pageFloatBodyHTML(year) {
    const st = pageScoreStats(year, PAGE_ITEMS);
    // 一页里混着多份卷子时，未完成的题号要带科目，否则「3」看不出是哪一卷的
    const multi = st.subCount > 1;
    const limit = window.innerWidth <= 640 ? (multi ? 4 : 6) : (multi ? 6 : 10);
    const shown = st.miss.slice(0, limit);
    const pct = st.total.max ? Math.min(100, st.total.score / st.total.max * 100) : 0;
    const row = (label, c) => `<div class="sf-line sf-sc"><span>${label}</span><b>${fmtScore(c.score)}</b><i>/ ${c.max}</i></div>`;
    const chip = ([s, n]) => {
      const no = String(n).padStart(2, '0');
      return `<a data-page-jump="${s},${n}" title="跳到 ${shortSubj(s)}第 ${n} 题">${multi ? shortSubj(s) + no : no}</a>`;
    };
    return `<div class="sf-top"><span>本页得分</span><b>${fmtScore(st.total.score)}</b><i>/ ${st.total.max}</i></div>` +
      [1, 2, 3].filter(s => st.subs[s].count).map(s => row(shortSubj(s), st.subs[s])).join('') +
      row('选填', st.sel) +
      row('大题', st.big) +
      `<div class="sf-done"><span>已完成</span><b>${st.total.set}</b><i>/ ${st.total.count} 题</i>${st.miss.length ? '' : '<em class="sf-tick">✓</em>'}</div>` +
      (st.miss.length
        ? `<div class="sf-miss"><span class="sf-mlabel">未完成</span>${shown.map(chip).join('')}${st.miss.length > limit ? `<em class="sf-more">+${st.miss.length - limit}</em>` : ''}</div>`
        : '') +
      `<div class="sf-bar"><i style="width:${pct.toFixed(1)}%"></i></div>`;
  }
  const pageFloatTitle = folded => folded
    ? '点一下展开本页得分卡'
    : '本页得分 · 与真题原卷的那一题共用同一条记录';
  function pageFloatHTML(year) {
    const folded = floatFolded();
    const st = pageScoreStats(year, PAGE_ITEMS);
    return `<aside class="scorefloat pagefloat${st.total.set ? ' has-score' : ''}${folded ? ' is-collapsed' : ''}" data-pagefloat data-page-year="${year}" title="${pageFloatTitle(folded)}">${floatToggleHTML()}${pageFloatBodyHTML(year)}</aside>`;
  }
  // 记分后重画：只换卡片内部，不动页面上的输入框，避免打断正在输入的那一格
  function refreshPageFloat() {
    const box = appEl.querySelector('[data-pagefloat]');
    if (!box) return;
    const year = Number(box.dataset.pageYear);
    const st = pageScoreStats(year, PAGE_ITEMS);
    box.innerHTML = floatToggleHTML() + pageFloatBodyHTML(year);
    box.classList.toggle('has-score', st.total.set > 0);
    box.classList.toggle('is-collapsed', floatFolded());
    box.setAttribute('title', pageFloatTitle(floatFolded()));
    paintYearMarks();   // 本页记得的分数会影响本年份「还差几题」，同步刷新年份按钮
  }

  /* 分数有两个入口：顶部成绩面板与题目卡片。任改一处都要同步到另一处 */
  const cardScoreSel = (year, subject, n) =>
    `[data-score-big="${n}"], [data-qbig="${year},${subject},${n}"]`;
  function cardScoreCtx(el) {
    const raw = el.dataset.qbig;
    if (raw) {
      const [y, s, n] = raw.split(',').map(Number);
      if (!y || !s || !n) return null;
      return { year: y, subject: s, n: n };
    }
    const card = el.closest('[data-scorecard]');
    if (!card) return null;
    return {
      year: Number(card.dataset.year),
      subject: Number(card.dataset.subject),
      n: Number(el.dataset.scoreBig)
    };
  }
  // except：正在输入的那个框不回填，避免打断「12.」这类中间状态
  function mirrorCardScore(year, subject, n, v, except) {
    const val = v === undefined ? '' : fmtScore(v);
    for (const el of appEl.querySelectorAll(cardScoreSel(year, subject, n))) {
      if (el !== except && el.value !== val) el.value = val;   // 正在输入的那个框不回填
      el.classList.toggle('has-val', v !== undefined);
    }
    const card = appEl.querySelector('[data-scorecard]');
    if (card) updateScoreSums(card, year, subject);
  }
  // 选填：题目卡片上的对/错按钮与面板题号格保持同一状态
  function paintSelMarks(year, subject, n, v) {
    for (const box of appEl.querySelectorAll(`[data-qsel="${year},${subject},${n}"]`)) {
      for (const btn of box.querySelectorAll('[data-sel-mark]')) {
        const on = v !== undefined && Number(btn.dataset.selMark) === v;
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-pressed', String(on));
      }
    }
  }
  function syncSelState(year, subject, n, v) {
    paintSelMarks(year, subject, n, v);
    const card = appEl.querySelector('[data-scorecard]');
    if (!card) return;
    const chip = card.querySelector(`[data-score-q="${n}"]`);
    if (chip) {
      chip.classList.toggle('is-wrong', v === 0);
      chip.setAttribute('aria-pressed', String(v === 1));
    }
    updateScoreSums(card, year, subject);
  }
  // 全选 / 清空 / 重新渲染后，把页面上所有选填按钮的状态刷一遍
  function refreshSelButtons(year, subject) {
    const rec = scoreRec(year, subject);
    for (const box of appEl.querySelectorAll('[data-qsel]')) {
      const [y, s, n] = box.dataset.qsel.split(',').map(Number);
      if (y !== year || s !== subject) continue;
      paintSelMarks(year, subject, n, rec ? rec.sel[n] : undefined);
    }
  }
  // 一键全满分、清空、复制、重置后，把卡片上的输入框一起刷新
  function refreshBigCardInputs(year, subject) {
    const rec = scoreRec(year, subject);
    for (const el of appEl.querySelectorAll('[data-qbig]')) {
      const [y, s, n] = el.dataset.qbig.split(',').map(Number);
      if (y !== year || s !== subject) continue;
      const v = rec ? rec.big[n] : undefined;
      el.value = v === undefined ? '' : fmtScore(v);
      el.classList.toggle('has-val', v !== undefined);
    }
    refreshSelButtons(year, subject);
  }

  /* ── 模拟卷面板 ── */
  const mockDate = ts => {
    const d = new Date(ts);
    const p = v => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  function mockRows(subject) {
    return MOCKS.filter(m => m.subject === subject)
      .slice()
      .sort((a, b) => b.created - a.created)
      .map(m => computeMockScore(m));
  }

  function mockCounts() {
    const counts = { 1: 0, 2: 0, 3: 0 };
    for (const m of MOCKS) counts[m.subject]++;
    return counts;
  }

  function mockModsHTML(c) {
    return ['高数', '线代', '概率']
      .filter(k => c[k] && c[k].max > 0)
      .map(k => `<span class="mockmod">${k} <b>${fmtScore(c[k].score)}</b><i>/ ${fmtScore(c[k].max)}</i></span>`)
      .join('');
  }

  function mockChipHTML(mock, n) {
    const v = mock.sel[n];
    const module = mockModule(mock.subject, n);
    return `<button class="qsbtn${v === 0 ? ' is-wrong' : ''}" type="button" data-mock-sel="${n}" aria-pressed="${v === 1}" title="第 ${n} 题 · ${module} · 5 分">${n}</button>`;
  }

  function mockCardHTML(mock) {
    const c = computeMockScore(mock);
    const chipRows = [['选择', 1, 10], ['填空', 11, 16]].map(([label, from, to]) => {
      let chips = '';
      for (let n = from; n <= to; n++) chips += mockChipHTML(mock, n);
      return `<div class="qsgroup"><span class="qsgroup-lab">${label}</span><div class="qsgrid">${chips}</div></div>`;
    }).join('');

    let bigRows = '';
    for (let n = 17; n <= 22; n++) {
      const max = MOCK_MAX(n);
      const v = mock.big[n];
      bigRows += `<div class="bigrow">
        <span class="bigq">${n}</span>
        <span class="bigmeta"><b>${mockModule(mock.subject, n)}</b> · ${max} 分</span>
        <span class="biginput"><input type="number" inputmode="decimal" min="0" max="${max}" step="0.5" placeholder="—" value="${v === undefined ? '' : fmtScore(v)}" data-mock-big="${n}" aria-label="第 ${n} 题得分，满分 ${max} 分"><span class="bigmax">/ ${max}</span></span>
        ${timerHTML(`${mockScope(mock)}|${n}`, `第 ${n} 题计时`)}
      </div>`;
    }

    return `<section class="card scorecard mockcard${c.hasAny ? ' has-score' : ''}${panelFolded() ? ' is-folded' : ''}" data-mockcard data-mock-id="${attr(mock.id)}">
      <div class="scorecard-head">
        <div>
          <div class="rtitle"><span class="mockname">${esc(mock.name)}</span><span class="mocksub">${SUBJ[mock.subject]}</span></div>
          <p class="scmeta">${mockDate(mock.created)} 添加 · 满分 <b>150</b> · 选填 <b>80</b> + 大题 <b>70</b> · 用时 <b data-mock-time>${fmtClock(timerSum(mockScope(mock)))}</b> ${timerHTML(`${mockScope(mock)}|all`, '整套试卷计时：同一份卷同时只走一个计时器，总用时不会重复计', '整卷')}</p>
        </div>
        <div class="sc-tools">
          <div class="scorenow"><span>当前得分</span><b data-mock-sum="total">${fmtScore(c.total.score)}</b><i>/ 150</i></div>
          ${panelToggleHTML(panelFolded(), '本卷成绩面板')}
        </div>
      </div>
      <div class="mockmods" data-mock-mods>${mockModsHTML(c)}</div>
      <div class="scblock">
        <div class="scblock-head">
          <h4>选择 · 填空</h4>
          <span class="scblock-meta">选择 50 分 · 填空 30 分 · 选填 80 分</span>
          <div class="scbtns">
            <button class="minibtn" type="button" data-mock-all title="只把尚未标记的选填标为做对，已有记录保持不变">全选选填</button>
            <button class="minibtn" type="button" data-mock-clear-sel>清空选填</button>
            ${timerHTML(`${mockScope(mock)}|sel`, '选填（选择+填空）合计用时，按一个单位计', '选填')}
          </div>
        </div>
        ${chipRows}
        <p class="scsum">做对 <b data-mock-correct>${c.sel.correct}</b> / ${c.sel.count} 题（已标记 <b data-mock-set="sel">${c.sel.set}</b> / ${c.sel.count}）· 选填 <b data-mock-sum="sel">${fmtScore(c.sel.score)}</b> / ${c.sel.max}</p>
      </div>
      <div class="scblock">
        <div class="scblock-head">
          <h4>解答题</h4>
          <span class="scblock-meta">6 题 · 70 分</span>
          <div class="scbtns">
            <button class="minibtn" type="button" data-mock-all-big title="只把尚未填写的大题补成满分，已有分数保持不变">大题全满分</button>
            ${timerHTML(`${mockScope(mock)}|big`, '解答题（大题）合计用时，按一个单位计', '大题')}
          </div>
        </div>
        <div class="bigrows">${bigRows}</div>
        <p class="scsum">已填 <b data-mock-set="big">${c.big.set}</b> / ${c.big.count} 题 · 大题 <b data-mock-sum="big">${fmtScore(c.big.score)}</b> / ${c.big.max}</p>
      </div>
      <div class="scorefoot">
        <span>模拟卷按 2021 年后的题位记分，未标记／未填写的题按 0 分计。「全选」和「大题全满分」只补齐未记录的部分。</span>
        <div class="scorefoot-btns">
          <button class="minibtn" type="button" data-mock-rename>重命名</button>
          <button class="minibtn danger" type="button" data-mock-reset>清空本卷成绩</button>
          <button class="minibtn danger" type="button" data-mock-delete>删除模拟卷</button>
        </div>
        <span class="scorestatus" data-mock-status></span>
      </div>
    </section>`;
  }

  function repaintMockCard(card, mock) {
    const tmp = document.createElement('div');
    tmp.innerHTML = mockCardHTML(mock);
    const fresh = tmp.firstElementChild;
    if (!fresh) return card;
    card.replaceWith(fresh);
    return fresh;
  }

  function setMockStatus(card, msg) {
    const el = card && card.querySelector('[data-mock-status]');
    if (el) el.textContent = msg;
  }

  function updateMockSums(card, mock) {
    const c = computeMockScore(mock);
    const put = (sel, val) => {
      const el = card.querySelector(sel);
      if (el) el.textContent = val;
    };
    put('[data-mock-sum="total"]', fmtScore(c.total.score));
    put('[data-mock-set="sel"]', c.sel.set);
    put('[data-mock-sum="sel"]', fmtScore(c.sel.score));
    put('[data-mock-correct]', c.sel.correct);
    put('[data-mock-set="big"]', c.big.set);
    put('[data-mock-sum="big"]', fmtScore(c.big.score));
    const mods = card.querySelector('[data-mock-mods]');
    if (mods) mods.innerHTML = mockModsHTML(c);
    card.classList.toggle('has-score', c.hasAny);
  }

  function mockStatCard(label, value, sub) {
    return `<div class="stat">
      <span class="stat-label">${label}</span>
      <span class="stat-value">${value}</span>
      <span class="stat-sub">${sub}</span>
    </div>`;
  }

  function mockStatsBlockHTML(rows, subject) {
    if (!rows.length) {
      return `<div class="card statsempty mockempty">
        <p class="big">还没有 ${SUBJ[subject]} 的模拟卷</p>
        <p>在上面输入模拟卷名称并添加，记录选择、填空和大题分数，这里会自动汇总平均分与各模块得分。</p>
      </div>`;
    }
    const totals = rows.filter(r => r.total.complete);
    const avg = (list, fn) => list.length ? list.reduce((s, r) => s + fn(r), 0) / list.length : null;
    const avgTotal = avg(totals, r => r.total.score);
    const rateTotal = avg(totals, r => r.total.pct);
    const best = totals.length ? Math.max(...totals.map(r => r.total.score)) : null;
    const totalSub = avgTotal === null
      ? '满分 150 · 还没有完整记录'
      : `得分率 ${Math.round(rateTotal)}% · 最高 ${fmtScore(best)} · ${totals.length} 套`;
    let html = mockStatCard('平均总分', avgTotal === null ? '—' : `${fmtScore(avgTotal)}<small>/ 150</small>`, totalSub);

    for (const [key, label] of [['choice', '选择'], ['fill', '填空'], ['sel', '选填'], ['big', '大题'], ['高数', '高数'], ['线代', '线代'], ['概率', '概率']]) {
      if (key === '概率' && subject === 2) {
        html += mockStatCard('概率', '不考', '数学二不考该模块');
        continue;
      }
      const list = rows.filter(r => r[key] && r[key].complete && r[key].max > 0);
      const a = avg(list, r => r[key].score);
      const p = avg(list, r => r[key].pct);
      const max = rows[0][key].max;
      const sub = a === null
        ? `满分 ${max} · 还没有完整记录`
        : `得分率 ${Math.round(p)}% · 满分 ${max} · ${list.length} 套`;
      html += mockStatCard(label, a === null ? '—' : `${fmtScore(a)}<small>分</small>`, sub);
    }
    return `<div class="stats mockstats">${html}</div>
      <p class="sumnote">只有某一项的全部题目都记录后，才会计入对应的平均分；未填完的模拟卷不参与统计。</p>`;
  }

  function mockFormHTML(subject) {
    const hint = subject === 2
      ? '数二题位：选择 1—7 高数、8—10 线代；填空 11—15 高数、16 线代；解答 17—21 高数、22 线代。'
      : '数一/数三题位：选择 1—4 高数、5—7 线代、8—10 概率；填空 11—14 高数、15 线代、16 概率；解答 17—20 高数、21 线代、22 概率。';
    return `<section class="card mockformcard">
      <form class="mockform" data-mock-form>
        <label class="mockfield">
          <span>模拟卷名称</span>
          <input type="text" maxlength="40" placeholder="例如：李林六套卷（一）" data-mock-name-input autocomplete="off" required>
        </label>
        <label class="mockfield mockfield--subj">
          <span>科目</span>
          <select data-mock-subject-input>
            ${[1, 2, 3].map(s => `<option value="${s}"${s === subject ? ' selected' : ''}>${SUBJ[s]}</option>`).join('')}
          </select>
        </label>
        <button class="btn primary mockadd" type="submit">添加模拟卷</button>
      </form>
      <p class="mockhint">按 2021 年后的 150 分结构记分：选择 1—10 每题 5 分，填空 11—16 每题 5 分；解答 17 题 10 分、18—22 题每题 12 分。${hint}</p>
    </section>`;
  }

  function mockHTML() {
    const subject = state.mockSubject;
    const rows = mockRows(subject);
    const counts = mockCounts();
    const builtin = builtinPapers(subject).length;
    const seg = [1, 2, 3].map(s =>
      `<button class="segbtn" type="button" data-mock-subj="${s}" aria-pressed="${s === subject}">${SUBJ[s]}<span class="cnt">${counts[s] + builtinPapers(s).length}</span></button>`
    ).join('');
    const bits = [];
    if (builtin) bits.push(`已收录 <b>${builtin}</b> 套整卷`);
    if (rows.length) bits.push(`自建 <b>${rows.length}</b> 套`);
    if (!bits.length) bits.push('还没有模拟卷');
    const header = `<header class="yearhero statshead">
      <div>
        <p class="kicker">模拟卷</p>
        <h2>我的模拟卷</h2>
        <p class="meta">${SUBJ[subject]} · ${bits.join(' · ')} · 按 2021 年后的 150 分结构记录 · 成绩存在本机浏览器</p>
      </div>
      <div class="segmented" role="group" aria-label="选择科目">${seg}</div>
    </header>`;
    const detail = rows.length ? `<section class="sumsec">
      <div class="sumsec-head"><span class="sumsec-title">模拟卷明细</span><span class="sumsec-avg">按添加时间倒序</span></div>
      <p class="sumnote">每套卷按「已得 / 满分」记录；未标记的选填和未填写的大题按 0 分计。</p>
    </section>` + rows.map(r => mockCardHTML(r.mock)).join('') : '';
    return `${header}${builtinMocksHTML(subject)}${mockFormHTML(subject)}<div data-mock-stats>${mockStatsBlockHTML(rows, subject)}</div>${detail}`;
  }

  /* ── 成套模拟卷：识别好的整卷，题目用与真题相同的卡片渲染 ── */
  function builtinPapers(subject) {
    if (typeof MOCK_PAPERS === 'undefined') return [];
    return Object.keys(MOCK_PAPERS)
      .map(Number)
      .filter(y => MOCK_PAPERS[y] && (!subject || MOCK_PAPERS[y].subject === subject))
      .sort((a, b) => a - b);
  }

  function builtinMocksHTML(subject) {
    const years = builtinPapers(subject);
    if (!years.length) return '';
    const sets = [];
    for (const y of years) {
      const m = MOCK_PAPERS[y];
      if (!sets.includes(m.set)) sets.push(m.set);
    }
    const cards = years.map(y => {
      const m = MOCK_PAPERS[y];
      const paper = PAPERS[paperKey(y, m.subject)] || [];
      if (!paper.length) return '';
      const c = computePaperScore(y, m.subject);
      const started = c.total.set > 0;
      const rec = scoreRec(y, m.subject);
      const answered = rec ? Object.keys(rec.sel).length + Object.keys(rec.big).length : 0;
      const status = !answered
        ? '<span class="mp-stat">未开始</span>'
        : `<span class="mp-stat is-on">已做 ${answered} 题 · <b>${fmtScore(c.total.score)}</b> / 150</span>`;
      return `<button class="mockpcard" type="button" data-open-paper="${y}" data-paper-subj="${m.subject}">
        <span class="mp-set">${esc(m.setName || m.set)}</span>
        <strong class="mp-name">${esc(m.short || m.name)}</strong>
        <span class="mp-meta">${SUBJ[m.subject]} · ${paper.length} 题${m.time ? ` · ${m.time} 分钟` : ''}</span>
        ${status}
      </button>`;
    }).join('');
    const done = years.map(y => {
      const m = MOCK_PAPERS[y];
      const c = computePaperScore(y, m.subject);
      return c.total.set > 0 ? c.total.score : null;
    }).filter(v => v !== null);
    const avg = done.length ? done.reduce((a, b) => a + b, 0) / done.length : null;
    const hint = `${years.length} 套 · 题目已识别，可计时、判分、加错题本${avg === null ? '' : ` · 已做 ${done.length} 套，平均 ${fmtScore(avg)} 分`}`;
    return `<section class="section builtinmocks">
      <div class="sec-head"><h2>成套模拟卷</h2><span class="hint">${hint}</span></div>
      <p class="builtin-note">这些卷子的题目按真题样式排好：点进去就是整卷，选填点 ✓/✗、大题填分数，右上角显示实时得分；「答案 · 解析」里是原解析册的内容。</p>
      <div class="mockpgrid">${cards}</div>
    </section>`;
  }

  function mockPaperHTML(year, subject) {
    const meta = mockPaperMeta(year, subject);
    const paper = PAPERS[paperKey(year, subject)] || [];
    if (!meta || !paper.length) {
      return `<div class="card empty">这套模拟卷还没整理好。<button class="btn" type="button" data-close-paper>返回模拟卷</button></div>`;
    }
    const c = computePaperScore(year, subject);
    const groups = groupsFor(2027);
    const selTimer = timerHTML(`${paperKey(year, subject)}|sel`, '选填（选择+填空）合计用时，按一个单位计', '选填');
    const bigTimer = timerHTML(`${paperKey(year, subject)}|big`, '解答题（大题）合计用时，按一个单位计', '大题');
    const allTimer = timerHTML(`${paperKey(year, subject)}|all`, '整套试卷计时：同一份卷同时只走一个计时器，总用时不会重复计', '整卷');
    const body = groups.map(g => {
      const qs = paper.filter(q => q.n >= g.from && q.n <= g.to);
      if (!qs.length) return '';
      return `<section class="qgroup">
        <div class="qgroup-head"><h3>${g.title}</h3><span>${g.meta}</span>${g.to <= 16 ? selTimer : bigTimer}</div>
        ${qs.map(q => renderCard(q, subject, year, {
          score: true,
          pdf: meta.pdfPaper ? {
            paper: meta.pdfPaper,
            sol: meta.pdfSol || meta.pdfPaper,
            paperTitle: `${meta.name} 试卷`,
            solTitle: `${meta.name} 解析`,
            paperLabel: '试卷 PDF',
            solLabel: meta.pdfSol ? '解析 PDF' : '试卷 PDF'
          } : null
        })).join('')}
      </section>`;
    }).join('');

    return `<header class="yearhero">
        <div>
          <p class="kicker">${esc(meta.setName || meta.set)} · ${SUBJ[subject]}</p>
          <h2>${esc(meta.name)}</h2>
          <p class="meta">${paper.length} 题 · 满分 150 分${meta.time ? ` · 建议 <b>${meta.time} 分钟</b>` : ''} · 当前得分 <b>${fmtScore(c.total.score)}</b> / 150</p>
          <div class="herotimer">${allTimer}</div>
        </div>
        <div class="pdfbtns">
          ${meta.pdfPaper ? `<button class="btn primary" type="button" data-pdf="${meta.pdfPaper}" data-pdf-title="${esc(meta.name)} 试卷">试卷 PDF</button>` : ''}
          ${meta.pdfSol ? `<button class="btn" type="button" data-pdf="${meta.pdfSol}" data-pdf-title="${esc(meta.name)} 解析">解析 PDF</button>` : ''}
          <button class="btn" type="button" data-close-paper>返回列表</button>
        </div>
      </header>
      <section class="section">${scorePanelHTML(year, subject)}</section>
      <section class="section">
        <div class="sec-head"><h2>逐题精析</h2><span class="hint">点击「答案 · 解析」展开</span></div>
        ${body || '<div class="card empty">这套卷的题目整理中</div>'}
      </section>
      ${scoreFloatHTML(year, subject)}`;
  }

  function refreshMockStats() {
    const wrap = appEl.querySelector('[data-mock-stats]');
    if (!wrap) return;
    wrap.innerHTML = mockStatsBlockHTML(mockRows(state.mockSubject), state.mockSubject);
  }

  const mockFromEl = el => {
    const card = el.closest('[data-mockcard]');
    if (!card) return null;
    return { card, mock: MOCKS.find(m => m.id === card.dataset.mockId) || null };
  };

  /* ── 题目卡 ── */
  function renderCard(q, subject, year, opts) {
    opts = opts || {};
    const lv = levelOf(year, subject, q.n);
    const key = isKeyQ(year, subject, q.n);
    const marked = WRONG.has(wrongKey(year, subject, q.n));
    const options = q.o
      ? `<div class="opts">${q.o.map((t, i) =>
          `<div class="opt${bigOpt(t) ? ' big' : ''}"><span class="ol">${'ABCD'[i]}</span><span>${safe(t)}</span></div>`).join('')}</div>`
      : '';
    const pdfBtns = opts.pdf
      ? `<button class="minilink" type="button" data-pdf="${opts.pdf.paper}" data-pdf-title="${opts.pdf.paperTitle}">${opts.pdf.paperLabel || '做题本 PDF'}</button>
        <button class="minilink" type="button" data-pdf="${opts.pdf.sol}" data-pdf-title="${opts.pdf.solTitle}">${opts.pdf.solLabel || '做题本解析'}</button>`
      : `<button class="minilink" type="button" data-pdf="${paperPath(year, subject, 'paper')}" data-pdf-title="${year} 年${SUBJ[subject]}试卷">试卷 PDF</button>
        <button class="minilink" type="button" data-pdf="${paperPath(year, subject, 'sol')}" data-pdf-title="${year} 年${SUBJ[subject]}解析">解析 PDF</button>`;
    // 原卷定位：可以只给一处，也可以给一串（重点题里同一道题常出现在数一/数二/数三里），
    // 每处一个按钮，点了直接跳到那道题在原卷的位置
    const originList = Array.isArray(opts.origin)
      ? opts.origin
      : (opts.origin ? [[subject, q.n]] : []);
    const originBtn = originList.map(([s, n]) => {
      const label = originList.length > 1
        ? `原卷定位 · ${shortSubj(s)} ${String(n).padStart(2, '0')}`
        : '原卷定位';
      return `<button class="minilink jump" type="button" data-jump="${year},${s},${n}" title="跳到 ${year} 年${SUBJ[s]}第 ${n} 题">${label}</button>`;
    }).join('');
    // 同一道题在同年多个卷子里出现时，在题号旁标出各卷的题号（如 数一3、数二2、数三4）
    const seenSame = new Set();
    const sameList = [[subject, q.n], ...otherSameQuestions(year, subject, q).map(o => [o.subject, o.q.n])]
      .filter(([s, n]) => {
        const k = `${s}-${n}`;
        if (seenSame.has(k)) return false;
        seenSame.add(k);
        return true;
      })
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const sameTagHTML = sameList.length > 1
      ? `<span class="same-tag" title="同年同题：${sameList.map(([s, n]) => `${SUBJ[s]}第 ${n} 题`).join('，')}">同题 ${sameList.map(([s, n]) => `${shortSubj(s)}${n}`).join(' · ')}</span>`
      : '';
    return `<article class="qcard${key ? ' is-key' : ''}" id="q-${year}-${subject}-${q.n}" data-lv="${lv}"${key ? ' data-key="1"' : ''}>
      <div class="qhead">
        <span class="qnum">${q.n}</span>
        ${opts.noVideo ? '' : videoLinkHTML(biliQURL(year, subject, q.n), '视频', `在 B 站看第 ${q.n} 题的讲解（小崔说数）`)}
        ${sameTagHTML}
        <span class="chip ${LV_CLASS[lv]}">${lv}</span>
        ${opts.showSubject ? `<span class="chip mod-tag">${SUBJ[subject]}</span>` : ''}
        <span class="chip mod-tag">${q.m}</span>
        ${key && !opts.inKey ? '<span class="chip key-tag">重点</span>' : ''}
        <span class="qmeta">考点：<b>${safe(q.t)}</b></span>
        ${stars(q.st)}
        ${opts.score && !opts.noTimer && qKind(year, q.n) === 'big' ? timerHTML(`${paperKey(year, subject)}|${q.n}`, `第 ${q.n} 题计时${sameQuestionHint(year, subject, q).replace(/（[^）]*）/g, '')}`) : ''}
        ${scoreBoxHTML(year, subject, q, opts)}
      </div>
      <div class="qtext">${safe(q.x)}</div>
      ${options}
      <div class="qfoot">
        <button class="ansbtn" type="button" aria-expanded="false">答案 · 解析</button>
        <button class="minilink wrongbtn" type="button" data-wrong="${year}-${subject}-${q.n}" aria-pressed="${marked}">${marked ? '已加入错题本' : '加入错题本'}</button>
        ${pdfBtns}
        ${originBtn}
      </div>
      <div class="ansbox" hidden>
        ${String(q.a || '').trim() ? `<div class="ansline"><span class="lab">答案</span><b>${safe(q.a)}</b></div>` : ''}
        ${String(q.sol || '').trim()
          ? `<div class="sol"><p>${safe(q.sol)}</p></div>`
          : `<div class="sol"><p class="ansnone">${(() => {
              const mp = mockPaperMeta(year, subject);
              return mp && !mp.pdfSol
                ? '这套卷只收了做题本，没有配套解析，答案请对照试卷 PDF 自行核对。'
                : '这题暂未取到解析，可对照试卷 PDF 自行核对。';
            })()}</p></div>`}
      </div>
    </article>`;
  }

  /* ── 年份条 ── */
  /* 年份条放不下时左右边缘渐隐，提示还能横向滑动 */
  function paintYearFade() {
    const max = yearsEl.scrollWidth - yearsEl.clientWidth;
    yearsEl.classList.toggle('is-scroll', max > 1);
    yearsEl.classList.toggle('at-start', yearsEl.scrollLeft <= 1);
    yearsEl.classList.toggle('at-end', yearsEl.scrollLeft >= max - 1);
  }
  yearsEl.addEventListener('scroll', paintYearFade, { passive: true });
  window.addEventListener('resize', paintYearFade);
  function renderYears() {
    const live = liveYears();
    yearsEl.innerHTML = ALL_YEARS.map(y => {
      const on = live.includes(y);
      return `<button class="year" type="button" data-year="${y}" aria-current="${y === state.year}"${on ? '' : ' disabled'}>` +
        `<span class="y-num">${y}</span>${on ? '<span class="y-st"></span>' : ''}</button>`;
    }).join('');
    paintYearMarks();
    document.querySelectorAll('#modules .cnt:not(.wcnt)').forEach(el => { el.textContent = `${live.length}年`; });
    if (live.length) {
      const first = live[0], last = live[live.length - 1];
      const contiguous = live.every((y, i) => y === first + i);
      const subB = document.querySelector('.sub b');
      if (subB) subB.textContent = contiguous ? `已上线 ${first}—${last}` : `已上线 ${live.length} 年`;
      // 页脚统计：已上线年份的套卷数与题目总数
      const foot = document.getElementById('footStat');
      if (foot) {
        const papers = live.length * 3;
        const total = live.reduce((a, y) => a + (YEAR_INFO[y] || 0), 0);
        foot.textContent = `${first}—${last} · ${papers} 套卷 · ${total} 题`;
      }
    }
    const cur = yearsEl.querySelector('[aria-current="true"]');
    if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
    paintYearFade();
  }

  /* ── 年份条下面一行：这一卷做完了没 + 还有哪些年份没做 ── */
  const yearRangeText = list => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      let j = i;
      while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
      out.push(j > i ? `${list[i]}—${list[j]}` : String(list[i]));
      i = j;
    }
    return out.join('、');
  };

  /* 年份按钮上的完成态：题都记过分直接打勾，没做完就写还差几题
     重点题 / 补充真题没有「某一卷」的概念，按那一年这一页列出的题来算 */
  function paintYearMarks() {
    const subject = SUBJ_VIEW[state.view];
    const pageMode = state.view === 'key' || state.view === 'supp';
    const pageLabel = state.view === 'supp' ? '补充真题' : '重点题';
    yearsEl.querySelectorAll('.year').forEach(b => {
      const st = b.querySelector('.y-st');
      if (!st) return;
      const y = Number(b.dataset.year);
      let done = false;
      let left = 0;
      let label = '';
      if (subject) {
        done = yearDone(y, subject);
        left = done ? 0 : yearUnmarked(y, subject);
        label = SUBJ[subject];
      } else if (pageMode) {
        const items = pageItemsOf(y, state.view);
        if (!items.length) {   // 这一年还没有重点题 / 补充真题，不写标记
          st.textContent = '';
          b.classList.remove('is-done');
          b.removeAttribute('title');
          return;
        }
        const pst = pageScoreStats(y, items);
        left = pst.total.count - pst.total.set;
        done = left <= 0;
        label = pageLabel;
      } else {
        st.textContent = '';
        b.classList.remove('is-done');
        b.removeAttribute('title');
        return;
      }
      st.textContent = done ? '✓' : `${left} 题`;
      b.classList.toggle('is-done', done);
      b.title = done
        ? `${y} 年${label} · 已做完`
        : `${y} 年${label} · 还差 ${left} 题`;
    });
  }

  /* 下面那一行默认收起，点年份条右端的「进度」才展开（默认不占位置） */
  const YPROG_OPEN_KEY = 'kaoyanMath.yearProgOpen.v1';
  let yprogOpenMem = null;
  function yprogOpen() {
    if (yprogOpenMem !== null) return yprogOpenMem;
    try { return localStorage.getItem(YPROG_OPEN_KEY) === '1'; } catch (e) { return false; }
  }
  function setYprogOpen(open) {
    yprogOpenMem = !!open;
    try { localStorage.setItem(YPROG_OPEN_KEY, open ? '1' : '0'); } catch (e) {
      // 隐私模式下存不了，按本次打开的状态凑合
    }
    renderYearProgress();
  }

  function renderYearProgress() {
    const box = document.getElementById('yearprog');
    paintYearMarks();
    if (!box) return;
    const subject = SUBJ_VIEW[state.view];
    const open = yprogOpen();
    if (yprogBtn) {
      yprogBtn.hidden = !subject;
      yprogBtn.setAttribute('aria-expanded', String(!!subject && open));
      yprogBtn.title = open ? '收起这一行的完成情况' : '显示「这卷做完没」与剩余年份';
    }
    if (!subject) { box.hidden = true; box.innerHTML = ''; return; }
    if (!open) { box.hidden = true; return; }
    box.hidden = false;

    const live = liveYears();
    const year = state.year;
    const left = live.filter(y => !yearDone(y, subject));
    const doneN = live.length - left.length;
    const curDone = yearDone(year, subject);
    const auto = autoYearDone(year, subject);
    const unmarked = yearUnmarked(year, subject);

    const stateText = curDone
      ? `${year}<span class="yp-subj"> · ${SUBJ[subject]}</span> 已做完`
      : `${year}<span class="yp-subj"> · ${SUBJ[subject]}</span> 还没做完 · 还差 ${unmarked} 题`;
    const sum = !doneN
      ? `0/${live.length} 年 · 还没开始`
      : left.length
        ? `完成 ${doneN}/${live.length} 年 · 剩 ${yearRangeText(left)}`
        : `完成 ${doneN}/${live.length} 年 · 全部做完`;
    const markTitle = auto
      ? '这一卷的题都记过分了，已自动打勾'
      : curDone
        ? '手动补勾的「已做完」，可以取消'
        : '题都记过分后会自动勾上；在纸上做过、这页没记分的可以手动补勾';

    box.classList.toggle('is-done', curDone);
    box.innerHTML =
      `<label class="yp-mark${auto ? ' is-auto' : ''}" title="${markTitle}">` +
        `<input type="checkbox" data-year-done${curDone ? ' checked' : ''}${auto ? ' disabled' : ''} aria-label="把 ${year} 年${SUBJ[subject]}标记为已做完">` +
        `<span class="yp-state">${stateText}</span>` +
      `</label>` +
      `<span class="yp-sum"><span class="yp-sep" aria-hidden="true">｜</span>${sum}</span>`;
  }

  function setYearDone(year, subject, done) {
    const key = paperKey(year, subject);
    // 取消勾选只撤销「手动补勾」；题目都记过分的年份仍然算做完
    if (done) YEAR_DONE[key] = true; else delete YEAR_DONE[key];
    saveYearDone();
    renderYearProgress();
  }

  /* ── 数学一/二/三：正文 ── */
  function subjectHTML(subject) {
    const year = state.year;
    const review = REVIEW[year];
    const paper = PAPERS[`${year}-${subject}`] || [];
    const d = DIST[year][subject];
    const kps = KP[year][subject];
    const keyNos = KP_KEY[year][subject];

    // 官方未公布平均分的年份，meta 里写字符串（如「未公布」），不再追加「分」
    const avgText = v => typeof v === 'number' ? `${v}<small>分</small>` : String(v);
    const scores = [1, 2, 3].map(s =>
      `<div class="scorecell${s === subject ? ' now' : ''}">
        <div class="lab">${SUBJ[s]}平均分</div>
        <div class="val">${avgText(review.avg[s])}</div>
      </div>`).join('');

    const reviewCard = `<div class="card review">
      <div class="rtitle">真题评价 · ${year} · ${review.overall}${videoLinkHTML(biliReviewURL(year, subject), '看视频讲解', `${year} 年${SUBJ[subject]}真题点评`, 'vlink')}</div>
      <ul>${review.bullets.map(b => `<li><span>${safe(b)}</span></li>`).join('')}</ul>
      <p class="quote">${safe(review.quote)}</p>
    </div>`;

    const distRows = [['easy', '常规题'], ['mid', '中档题'], ['hard', '难题']].map(([k, label]) =>
      `<div class="distrow">
        <span class="tag ${k[0]}">${label}</span>
        <span class="qs">${d[k].qs}</span>
        <span class="sc"><b>${d[k].score} 分</b> · ${d[k].pct}%</span>
      </div>`).join('');

    const distCard = `<div class="card dist">
      <div class="serif" style="font-weight:700;font-size:14px;margin-bottom:6px">难度分布 · ${SUBJ[subject]}</div>
      <div class="distbar">
        <span class="e" style="width:${d.easy.score / 1.5}%"></span>
        <span class="m" style="width:${d.mid.score / 1.5}%"></span>
        <span class="h" style="width:${d.hard.score / 1.5}%"></span>
      </div>
      <div class="distrows">${distRows}</div>
      <p class="distnote">按分值统计（满分 150）。常规题约 ${d.easy.score} 分，是保底分。</p>
    </div>`;

    const kpCols = [1, 2, 3].map(s => {
      const list = KP[year][s];
      const keys = KP_KEY[year][s] || [];
      return `<div class="kpcol">
        <h3>${SUBJ[s]}</h3>
        <ol>${list.map((t, i) => {
          const no = i + 1;
          return `<li class="${keys.includes(no) ? 'is-key' : ''}"><span class="no">${String(no).padStart(2, '0')}</span><span class="txt">${safe(t)}</span></li>`;
        }).join('')}</ol>
      </div>`;
    }).join('');

    const kpCard = `<div class="card kpwrap">
      <div class="kpgrid">${kpCols}</div>
      <p class="distnote">考点按题号逐一标注；红字为当年重点题。</p>
    </div>`;

    // 筛选不重建页面：所有题目都渲染出来，切换难度/重点时只改显隐
    const filters = `<div class="filters" role="group" aria-label="筛选">
      ${[['all', '全部'], ['常规', '常规'], ['中档', '中档'], ['难题', '难题']].map(([v, label]) => {
        const on = !state.keyOnly && (state.level === v || (v === 'all' && state.level === 'all'));
        return `<button class="fbtn" type="button" data-filter="${v}" aria-pressed="${on}">${label}</button>`;
      }).join('')}
      <button class="fbtn key" type="button" data-filter="key" aria-pressed="${state.keyOnly}">只看重点</button>
      <span class="fcount">显示 ${paper.length} / ${paper.length} 题</span>
    </div>`;

    // 选择+填空算一个计时单位：两个小组的组头各放一个同样的计时器
    const selTimer = timerHTML(`${paperKey(year, subject)}|sel`, '选填（选择+填空）合计用时，按一个单位计', '选填');
    const bigTimer = timerHTML(`${paperKey(year, subject)}|big`, '解答题（大题）合计用时，按一个单位计', '大题');
    const allTimer = timerHTML(`${paperKey(year, subject)}|all`, '整套试卷计时：同一份卷同时只走一个计时器，总用时不会重复计', '整卷');
    const groups = groupsFor(year).map(g => {
      const qs = paper.filter(q => q.n >= g.from && q.n <= g.to);
      if (!qs.length) return '';
      return `<section class="qgroup">
        <div class="qgroup-head"><h3>${g.title}</h3><span>${g.meta}</span>${g.to <= 16 ? selTimer : bigTimer}</div>
        ${qs.map(q => renderCard(q, subject, year, { score: true })).join('')}
      </section>`;
    }).join('');

    return `<header class="yearhero">
        <div>
          <p class="kicker">${year} · ${SUBJ[subject]}</p>
          <h2>${year} 年${SUBJ[subject]}真题</h2>
          <p class="meta">${paper.length} 题 · 满分 150 分 · 建议 <b>${review.time} 分钟</b> · 整体 <b>${review.overall}</b></p>
          <div class="herotimer">${allTimer}</div>
        </div>
        <div class="pdfbtns">
          <button class="btn primary" type="button" data-pdf="${paperPath(year, subject, 'paper')}" data-pdf-title="${year} 年${SUBJ[subject]}试卷">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/><path d="M6 9h4M6 11.5h4"/></svg>试卷 PDF</button>
          <button class="btn" type="button" data-pdf="${paperPath(year, subject, 'sol')}" data-pdf-title="${year} 年${SUBJ[subject]}解析">解析 PDF</button>
          <button class="btn" type="button" data-pdf="${reviewPath(year)}" data-pdf-title="${year} 年真题评价 & 重点题">真题评价</button>
          ${biliReviewURL(year, subject) ? `<a class="btn bilibtn" href="${biliReviewURL(year, subject)}" target="_blank" rel="noopener noreferrer" title="${year} 年${SUBJ[subject]}真题点评（第 1 P）">${BILI_ICON}视频讲解</a>` : ''}
        </div>
      </header>
      <div class="scorestrip">${scores}</div>
      <section class="section">${scorePanelHTML(year, subject)}</section>
      <section class="section">${reviewCard}</section>
      <section class="section">${distCard}</section>
      <section class="section">
        <div class="sec-head"><h2>考点总览</h2><span class="hint">${SUBJ[subject]} · ${kps.length} 个考点</span></div>
        ${kpCard}
      </section>
      <section class="section">
        <div class="sec-head"><h2>逐题精析</h2><span class="hint">点击「答案 · 解析」展开</span></div>
        ${filters}
        ${groups || '<div class="card empty">该年份题目整理中</div>'}
        <div class="card empty filter-empty" hidden>没有符合筛选条件的题目</div>
      </section>
      ${scoreFloatHTML(year, subject)}`;
  }

  /* ── 重点题 ── */
  function keyHTML() {
    const year = state.year;
    const groups = KEY_GROUPS[year] || [];
    // 同一道题会同时出现在数一/数二/数三的试卷里（题干完全一致），
    // 重点题里只列一次，并在卡片上标注考过它的卷子与题号
    const firstSeen = new Map();   // 题干 -> { groupIndex, topic, papers: [[subject, n], ...] }
    const layout = groups.map((g, gi) => {
      const cards = [];
      const refs = [];
      g.items.forEach(([subject, n]) => {
        const q = getQ(year, subject, n);
        if (!q) return;
        const stem = String(q.x).trim();
        const hit = firstSeen.get(stem);
        if (hit) {
          hit.papers.push([subject, n]);
          if (hit.groupIndex !== gi) refs.push({ topic: hit.topic, index: hit.groupIndex });
          return;
        }
        const rec = { q, subject, n, papers: [[subject, n]] };
        firstSeen.set(stem, { groupIndex: gi, topic: g.topic, papers: rec.papers });
        cards.push(rec);
      });
      return { g, gi, cards, refs };
    });
    const rawTotal = groups.reduce((s, g) => s + g.items.length, 0);
    const total = firstSeen.size;
    // 本页列出的题目（去重后的卡片），右下角得分卡和年份条上的完成标记都按这一份算
    PAGE_ITEMS = keyPageItems(year);

    const body = layout.map(({ g, gi, cards, refs }) => {
      const cardHTML = cards
        .map(c => renderCard(c.q, c.subject, year, {
          showSubject: true,
          inKey: true,
          alsoIn: c.papers,
          score: true,
          noTimer: true,     // 这里只记分，不计时（计时器属于原卷那一题）
          origin: c.papers
        }))
        .join('');
      const refHTML = refs.map(r =>
        `<p class="dupref">同题已在第 ${String(r.index + 1).padStart(2, '0')} 组「${safe(r.topic)}」列出</p>`).join('');
      return `<article class="keytopic">
        <div class="topicbox">
          <div class="idx">${String(gi + 1).padStart(2, '0')} / ${String(groups.length).padStart(2, '0')}</div>
          <h4>${safe(g.topic)}</h4>
          <button class="ansbtn" type="button" aria-expanded="false">答案 · 解析</button>
          <div class="ansbox" hidden><p class="note">${safe(g.note)}</p></div>
        </div>
        <div class="qlist">${cardHTML}${refHTML}</div>
      </article>`;
    }).join('');

    return `<header class="yearhero">
        <div>
          <p class="kicker">重点题 · ${year}</p>
          <h2>${year} 年重点题</h2>
          <p class="meta"><b>${groups.length}</b> 组 · <b>${total}</b> 题 · 同一考点跨卷对比${total < rawTotal ? ' · 同题已合并' : ''}</p>
        </div>
        <div class="pdfbtns">
          <button class="btn primary" type="button" data-pdf="${reviewPath(year)}" data-pdf-title="${year} 年真题评价 & 重点题">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/><path d="M6 9h4M6 11.5h4"/></svg>重点题 PDF</button>
        </div>
      </header>
      <section class="section">${body || '<div class="card empty">该年份重点题整理中</div>'}</section>
      ${pageFloatHTML(year)}`;
  }

  /* ── 数一补充真题 ── */
  function suppHTML() {
    const year = state.year;
    const groups = SUPP[year] || [];
    const total = groups.reduce((s, g) => s + g.nums.length, 0);
    const suppPdf = {
      paper: '/pdfs/supplement/m1-supplement-paper.pdf',
      sol: '/pdfs/supplement/m1-supplement-sol.pdf',
      paperTitle: `${year} 年数一补充真题做题本`,
      solTitle: `${year} 年数一补充真题解析`
    };

    const table = groups.map(g => {
      const items = g.nums.map(n => {
        const q = getQ(year, g.from, n);
        if (!q) return '';
        return `<li>
          <span class="src">${SUBJ[g.from].replace('数学', '数')} ${String(n).padStart(2, '0')}</span>
          <a href="#q-${year}-${g.from}-${n}"><span class="tp">${safe(q.t)}</span></a>
          <span class="st">${'★'.repeat(q.st)}</span>
        </li>`;
      }).join('');
      return `<div class="card supp-card" id="supp-${year}-${g.from}">
        <h4>${g.title} · ${g.nums.length} 题</h4>
        <ul class="supp-list">${items}</ul>
      </div>`;
    }).join('');

    const detail = groups.map(g => {
      const qs = g.nums.map(n => getQ(year, g.from, n)).filter(Boolean);
      if (!qs.length) return '';
      return `<section class="qgroup">
        <div class="qgroup-head">
          <h3>${g.title} · 逐题</h3>
          <span>${qs.length} 题 · 题号对应 ${year} 年${SUBJ[g.from]}试卷</span>
        </div>
        ${qs.map(q => renderCard(q, g.from, year, { showSubject: true, origin: true, pdf: suppPdf, score: true, noTimer: true })).join('')}
      </section>`;
    }).join('');
    // 本页列出的题目，右下角得分卡和年份条上的完成标记都按这一份算
    PAGE_ITEMS = suppPageItems(year);

    return `<header class="yearhero">
        <div>
          <p class="kicker">补充真题 · ${year}</p>
          <h2>${year} 年数一补充真题</h2>
          <p class="meta">从数二、数三试卷中筛选的数一可做题 · 共 <b>${total}</b> 题</p>
        </div>
        <div class="pdfbtns">
          <button class="btn primary" type="button" data-pdf="/pdfs/supplement/m1-supplement-paper.pdf" data-pdf-title="数学（一）补充真题做题本">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/><path d="M6 9h4M6 11.5h4"/></svg>做题本 PDF</button>
          <button class="btn" type="button" data-pdf="/pdfs/supplement/m1-supplement-sol.pdf" data-pdf-title="数学（一）补充真题解析">解析 PDF</button>
        </div>
      </header>
      <div class="card supp-intro">
        <p><b>怎么用：</b>数一考生在刷完数一真题后，可把数二、数三中符合数一大纲的题目当作额外练习。这里按年份把补充题对照回原卷题号，并逐题列出题干、答案与解析。</p>
        <p>点击对照表中的题号，可直接定位到下方对应题目；每题右下角的「原卷定位」会跳回该题在数二／数三真题页的位置。</p>
        <p>每题上限的「✓ / ✗」与解答题的「得分」直接记在原卷那一题上：和在真题页记分是同一份数据，同题还会自动同步。</p>
      </div>
      <section class="section">
        <div class="sec-head"><h2>${year} 年补充题对照</h2><span class="hint">按来源分列 · 点击定位</span></div>
        <div class="supp-grid">${table || '<div class="card empty">该年份补充真题整理中</div>'}</div>
        <p class="supp-note">题号后星级为该题难度（1—5★），与真题页一致。</p>
      </section>
      <section class="section">
        <div class="sec-head"><h2>补充真题 · 逐题精析</h2><span class="hint">点击「答案 · 解析」展开</span></div>
        ${detail || '<div class="card empty">该年份补充真题整理中</div>'}
      </section>
      ${pageFloatHTML(year)}`;
  }

  /* ── 错题本 ── */
  function wrongEntries() {
    return [...WRONG]
      .map(k => k.split('-').map(Number))
      .filter(([year, subject, n]) => getQ(year, subject, n))
      .sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
  }

  function wrongHTML() {
    const entries = wrongEntries();

    const head = `<header class="yearhero">
        <div>
          <p class="kicker">错题本</p>
          <h2>我的错题本</h2>
          <p class="meta">${entries.length
            ? `共 <b>${entries.length}</b> 题 · 覆盖 <b>${new Set(entries.map(e => e[0])).size}</b> 份卷 · 数一 ${entries.filter(e => e[1] === 1).length} · 数二 ${entries.filter(e => e[1] === 2).length} · 数三 ${entries.filter(e => e[1] === 3).length}`
            : '在任意题目卡片点「加入错题本」，这里就会自动归档'}</p>
        </div>
        ${entries.length ? `<div class="pdfbtns">
          <button class="btn primary" type="button" data-wrong-export>导出 PDF</button>
          <button class="btn" type="button" data-wrong-practice>导出做题本</button>
          <button class="btn" type="button" data-wrong-clear>清空错题本</button></div>` : ''}
      </header>`;

    if (!entries.length) {
      return `${head}
        <div class="card empty">错题本还是空的。浏览真题时，点题目右下角的「加入错题本」即可收录，再点一次取消；收藏的题目会永久留在本机浏览器里。</div>`;
    }

    const byGroup = new Map();
    entries.forEach(([year, subject, n]) => {
      const k = `${year}-${subject}`;
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k).push(n);
    });

    const sections = [...byGroup.entries()].map(([k, nums]) => {
      const [year, subject] = k.split('-').map(Number);
      return `<section class="qgroup">
        <div class="qgroup-head"><h3>${paperLabel(year, subject)}</h3><span>${nums.length} 题</span></div>
        ${nums.map(n => {
          const q = getQ(year, subject, n);
          return q ? renderCard(q, subject, year, { origin: true }) : '';
        }).join('')}
      </section>`;
    }).join('');

    return `${head}
      <div class="card supp-intro">
        <p><b>说明：</b>错题保存在本机浏览器（localStorage）里，换浏览器或清除网站数据会丢失。点题目上的「已加入错题本」可移出。</p>
        <p>「原卷定位」会跳回该题所在的真题页；「试卷 PDF」「解析 PDF」打开对应原卷。</p>
        <p>「导出 PDF」会把整本错题按「年份 · 科目」排成 A4 打印版（含题干、选项、答案与解析），在打印对话框里选「存储为 PDF」即可得到文件。</p>
        <p>「导出做题本」只印题目、不带答案：选择填空每页两道，解答题一题一页，每题下面留出答题空白，适合把错题重新做一遍再对答案。</p>
      </div>
      <section class="section">
        <div class="sec-head"><h2>错题清单</h2><span class="hint">按年份倒序 · 同一年份内按科目</span></div>
        ${sections}
      </section>`;
  }

  /* ── 成绩统计 ── */
  const TYPE_SERIES = [
    { key: 'sel', label: '选填', color: 'var(--series-1)' },
    { key: 'big', label: '大题', color: 'var(--series-2)' },
    { key: 'total', label: '总分', color: 'var(--series-3)' }
  ];
  const MODULE_SERIES = [
    { key: '高数', label: '高数', color: 'var(--series-1)' },
    { key: '线代', label: '线代', color: 'var(--series-2)' },
    { key: '概率', label: '概率', color: 'var(--series-3)' }
  ];
  const STAT_DEFS = [
    { key: 'total', label: '总分' },
    { key: 'choice', label: '选择' },
    { key: 'fill', label: '填空' },
    { key: 'sel', label: '选填' },
    { key: 'big', label: '大题' },
    { key: '高数', label: '高数' },
    { key: '线代', label: '线代' },
    { key: '概率', label: '概率' }
  ];

  let STATS_CHARTS = [];
  const statsChartWidth = () => Math.max(280, Math.min(820, Math.floor(appEl.clientWidth || 640)));

  // 一项统计只有在对应的题目全部记录后才完整，未填完的不参与平均分和走势
  const STAT_KEYS = ['choice', 'fill', 'sel', 'big', 'total', '高数', '线代', '概率'];
  const completePart = c => !!(c && c.max > 0 && c.complete);
  const hasCompletePart = r => STAT_KEYS.some(k => completePart(r[k]));

  function statsCounts() {
    const counts = { 1: 0, 2: 0, 3: 0 };
    for (const [k, rec] of Object.entries(SCORES)) {
      const [y, s] = k.split('-').map(Number);
      if (counts[s] === undefined || rec.touched === false) continue;
      if (!LOADED_YEARS.has(y)) continue;
      if (hasCompletePart(computePaperScore(y, s))) counts[s]++;
    }
    return counts;
  }

  function statsRows(subject) {
    return ALL_YEARS
      .filter(y => LOADED_YEARS.has(y) && scoreRec(y, subject) && scoreRec(y, subject).touched !== false)
      .map(y => computePaperScore(y, subject))
      .filter(r => r.hasAny)
      .sort((a, b) => b.year - a.year);
  }

  // 2021 年改革后题型与分值都变了，均分按改革前后分开统计
  const ERA_DEFS = [
    { label: '21年前', from: 2010, to: 2020 },
    { label: '21年起', from: 2021, to: 9999 }
  ];

  function eraStats(rows, key, era) {
    const list = rows.filter(r => r.year >= era.from && r.year <= era.to && completePart(r[key]));
    const avg = list.length ? list.reduce((s, r) => s + r[key].score, 0) / list.length : null;
    const rate = list.length ? list.reduce((s, r) => s + r[key].pct, 0) / list.length : null;
    const maxes = [...new Set(list.map(r => r[key].max))].sort((a, b) => a - b);
    const maxText = !maxes.length ? '—'
      : maxes.length === 1 ? String(maxes[0]) : `${maxes[0]}—${maxes[maxes.length - 1]}`;
    return { avg, rate, maxText, count: list.length };
  }

  function eraRowHTML(era, s, total) {
    const value = s.avg === null ? '—'
      : total ? `${fmtScore(s.avg)}<small>/ 150</small>` : `${fmtScore(s.avg)}<small>分</small>`;
    const maxText = total ? '150' : s.maxText;
    const sub = s.avg === null
      ? `满分 ${maxText} · 还没有完整记录`
      : `得分率 ${Math.round(s.rate)}% · 满分 ${maxText} · ${s.count} 年`;
    return `<div class="staterow">
      <span class="staterow-era">${era.label}</span>
      <span class="staterow-val">${value}</span>
      <span class="staterow-sub">${sub}</span>
    </div>`;
  }

  function statCardHTML(def, rows, subject) {
    if (def.key === '概率' && subject === 2) {
      return `<div class="stat">
        <span class="stat-label">概率</span>
        <span class="stat-value">不考</span>
        <span class="stat-sub">数学二不考该模块</span>
      </div>`;
    }
    const eras = ERA_DEFS.map(era => [era, eraStats(rows, def.key, era)]);
    if (def.key === 'total') {
      // 总分一直是 150 分，保留全部年份的均分，同时列出改革前后两段
      const list = rows.filter(r => completePart(r.total));
      const avg = list.length ? list.reduce((s, r) => s + r.total.score, 0) / list.length : null;
      const rate = list.length ? list.reduce((s, r) => s + r.total.pct, 0) / list.length : null;
      const sub = avg === null
        ? '满分 150 · 全部年份还没有完整记录'
        : `全部 ${list.length} 年 · 得分率 ${Math.round(rate)}% · 满分 150`;
      return `<div class="stat stat--total">
        <span class="stat-label">总分</span>
        <span class="stat-value">${avg === null ? '—' : `${fmtScore(avg)}<small>/ 150</small>`}</span>
        <span class="stat-sub">${sub}</span>
        <div class="statsplits">${eras.map(([era, s]) => eraRowHTML(era, s, true)).join('')}</div>
      </div>`;
    }
    return `<div class="stat stat--split">
      <span class="stat-label">${def.label}</span>
      <div class="statsplits">${eras.map(([era, s]) => eraRowHTML(era, s, false)).join('')}</div>
    </div>`;
  }

  // 折线图只比较得分率：不同年份满分不同，直接比原始分没有意义
  function chartValue(row, key) {
    if (key === 'total') return completePart(row.total) ? row.total : null;
    const c = row[key];
    return completePart(c) ? c : null;
  }

  function chartPoints(rows, series) {
    return rows
      .slice()
      .sort((a, b) => a.year - b.year)
      .map(r => {
        const vals = {};
        let any = false;
        for (const s of series) {
          const c = chartValue(r, s.key);
          vals[s.key] = c ? { pct: c.pct, score: c.score, max: c.max } : null;
          if (c) any = true;
        }
        return any ? { year: r.year, vals } : null;
      })
      .filter(Boolean);
  }

  function buildChart(series, pts, width) {
    const active = series.filter(s => pts.some(p => p.vals[s.key]));
    if (!pts.length || !active.length) return null;

    const height = 232;
    const padL = 32, padR = 64, padT = 16, padB = 28;
    const plotW = Math.max(40, width - padL - padR);
    const plotH = height - padT - padB;
    const n = pts.length;
    const xs = pts.map((_, i) => n === 1 ? padL + plotW / 2 : padL + plotW * i / (n - 1));
    const yOf = pct => padT + (1 - pct / 100) * plotH;

    let grid = '';
    for (const v of [0, 25, 50, 75, 100]) {
      const y = yOf(v);
      grid += `<line class="grid-line" x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}"/>`;
      grid += `<text class="tick" x="${padL - 6}" y="${y + 3}" text-anchor="end">${v}%</text>`;
    }

    const stepPx = n > 1 ? plotW / (n - 1) : plotW;
    const dense = stepPx < 30;
    const every = Math.max(1, Math.ceil(30 / Math.max(stepPx, 1)));
    let xLabels = '';
    pts.forEach((p, i) => {
      if (i % every !== 0 && i !== n - 1) return;
      if (i !== n - 1 && n - 1 - i < every && n > 3) return;
      const text = dense ? String(p.year).slice(2) : String(p.year);
      xLabels += `<text class="tick" x="${xs[i].toFixed(1)}" y="${height - 8}" text-anchor="middle">${text}</text>`;
    });

    let paths = '', dots = '';
    for (const s of active) {
      let d = '', pen = false;
      pts.forEach((p, i) => {
        const v = p.vals[s.key];
        if (!v) { pen = false; return; }
        const y = yOf(v.pct);
        d += `${pen ? 'L' : 'M'}${xs[i].toFixed(1)} ${y.toFixed(1)}`;
        pen = true;
        dots += `<circle class="dot" cx="${xs[i].toFixed(1)}" cy="${y.toFixed(1)}" r="${dense ? 2.2 : 2.8}" fill="${s.color}"><title>${p.year} 年 ${s.label} ${Math.round(v.pct)}%</title></circle>`;
      });
      if (d) paths += `<path class="series-line" d="${d}" stroke="${s.color}"/>`;
    }

    const ends = active.map(s => {
      for (let i = pts.length - 1; i >= 0; i--) {
        if (pts[i].vals[s.key]) return { s, y: yOf(pts[i].vals[s.key].pct) };
      }
      return null;
    }).filter(Boolean).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) {
      if (ends[i].y - ends[i - 1].y < 11) ends[i].y = ends[i - 1].y + 11;
    }
    const endLabels = ends.map(e => {
      const y = Math.min(padT + plotH, Math.max(padT, e.y));
      return `<text class="end-label" x="${padL + plotW + 7}" y="${(y + 3).toFixed(1)}">${e.s.label}</text>`;
    }).join('');

    const crosshair = `<line class="crosshair" x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}"/>`;
    const svg = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="历年得分率折线图">${grid}${xLabels}${crosshair}${paths}${dots}${endLabels}</svg>`;
    return { svg, data: { pts, xs, width, active } };
  }

  function chartTipHTML(p, active) {
    const rows = active.map(s => {
      const v = p.vals[s.key];
      return `<div class="tip-row"><span><i style="background:${s.color}"></i>${s.label}</span>${
        v ? `<b>${Math.round(v.pct)}%<em> ${fmtScore(v.score)}/${v.max}</em></b>` : '<b class="empty">—</b>'
      }</div>`;
    }).join('');
    return `<div class="tip-year">${p.year} 年</div>${rows}`;
  }

  function bindChart(wrap, data) {
    const svg = wrap.querySelector('.chart');
    const tip = wrap.querySelector('.chart-tip');
    if (!svg || !tip) return;

    const show = clientX => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const scale = rect.width / data.width;
      const cx = (clientX - rect.left) / scale;
      const last = data.pts.length - 1;
      let idx = 0;
      if (last > 0) {
        const step = (data.xs[last] - data.xs[0]) / last;
        idx = Math.round((cx - data.xs[0]) / (step || 1));
        idx = Math.max(0, Math.min(last, idx));
      }
      const x = data.xs[idx];
      const cross = svg.querySelector('.crosshair');
      if (cross) {
        cross.setAttribute('x1', x);
        cross.setAttribute('x2', x);
        cross.style.opacity = '1';
      }
      tip.innerHTML = chartTipHTML(data.pts[idx], data.active);
      tip.hidden = false;
      const tipW = tip.offsetWidth;
      let left = x * scale + 12;
      if (left + tipW > rect.width - 4) left = x * scale - tipW - 12;
      if (left < 4) left = 4;
      tip.style.left = `${left}px`;
      tip.style.top = '8px';
    };

    const hide = () => {
      tip.hidden = true;
      const cross = svg.querySelector('.crosshair');
      if (cross) cross.style.opacity = '0';
    };

    wrap.addEventListener('pointermove', e => {
      if (e.pointerType !== 'touch') show(e.clientX);
    });
    wrap.addEventListener('pointerdown', e => show(e.clientX));
    wrap.addEventListener('pointerleave', e => {
      if (e.pointerType !== 'touch') hide();
    });
  }

  function bindStatsCharts() {
    if (!STATS_CHARTS.length) return;
    appEl.querySelectorAll('.chartwrap[data-chart]').forEach(wrap => {
      const data = STATS_CHARTS[Number(wrap.dataset.chart)];
      if (data) bindChart(wrap, data);
    });
  }

  /* 逐年分数表：年份 / 选择 / 填空 / 大题 / 总分，每格写「得分 / 满分」。
     某一类题目没记完时只写「—」和已记题数，口径和上面的均分一致（不计入统计） */
  function yearTableHTML(rows) {
    const cell = (c, extra = '') => {
      if (!c || !c.count) return `<span class="yt-cell is-empty${extra}"><b>—</b></span>`;
      if (!completePart(c)) return `<span class="yt-cell is-empty${extra}"><b>—</b><i>${c.set}/${c.count}</i></span>`;
      return `<span class="yt-cell${extra}"><b>${fmtScore(c.score)}</b><i>/ ${c.max}</i></span>`;
    };
    const body = rows.map(r => `<div class="yt-row">
        <span class="yt-year">${r.year}</span>
        ${cell(r.choice)}${cell(r.fill)}${cell(r.big)}${cell(r.total, ' is-total')}
      </div>`).join('');
    return `<section class="sumsec ytable">
        <div class="sumsec-head"><span class="sumsec-title">逐年分数</span><span class="sumsec-avg">按年份倒序</span></div>
        <div class="yt-row yt-head"><span>年份</span><span>选择</span><span>填空</span><span>大题</span><span>总分</span></div>
        ${body}
        <p class="sumnote">每格是「得分 / 满分」：2021 年起选择题 50 分、填空题 30 分、解答题 70 分，之前分别是 32 / 24 / 94。某一类题目没记完时只显示「—」和已记题数，和上面的均分一样不计入统计。</p>
      </section>`;
  }

  function statsHTML() {
    STATS_CHARTS = [];
    const subject = state.statsSubject;
    const allRows = statsRows(subject);
    // 只有某一项全部填完的年份才进入统计；只填了一部分的记录先不计入
    const rows = allRows.filter(hasCompletePart);
    const counts = statsCounts();
    const seg = [1, 2, 3].map(s =>
      `<button class="segbtn" type="button" data-stats-subj="${s}" aria-pressed="${s === subject}">${SUBJ[s]}<span class="cnt">${counts[s]}</span></button>`
    ).join('');
    const header = `<header class="yearhero statshead">
      <div>
        <p class="kicker">成绩统计</p>
        <h2>我的成绩统计</h2>
        <p class="meta">${SUBJ[subject]} · ${rows.length
          ? `有 <b>${rows.length}</b> 个年份包含填写完整的项目 · 按 2021 年改革前后分段统计`
          : allRows.length ? '已有成绩记录，但还没有填写完整的项目' : '还没有成绩记录' } · 数据保存在本机浏览器</p>
      </div>
      <div class="segmented" role="group" aria-label="选择科目">${seg}</div>
    </header>`;

    if (!rows.length) {
      const partial = allRows.length > 0;
      return `${header}
        <div class="card statsempty">
          <p class="big">${partial ? `还没有填写完整的 ${SUBJ[subject]} 项目` : `还没有 ${SUBJ[subject]} 的成绩记录`}</p>
          <p>${partial
            ? '已填写了一部分，但选择、填空、大题或某个模块还没有全部记录完，暂不计入统计。把对应部分的题目全部标记或填完后，这里会自动更新。'
            : '回到真题页，在每年的「我的成绩」面板里标记选填对错、填写大题分数，这里会自动汇总历年成绩。'}</p>
          <button class="btn primary" type="button" data-stats-start="${subject}">去记录成绩</button>
        </div>`;
    }

    const cards = STAT_DEFS.map(def => statCardHTML(def, rows, subject)).join('');
    const width = statsChartWidth();

    const chartSection = (title, series, note) => {
      const built = buildChart(series, chartPoints(rows, series), width);
      if (!built) return '';
      const idx = STATS_CHARTS.length;
      STATS_CHARTS.push(built.data);
      const legend = built.data.active
        .map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('');
      return `<section class="sumsec">
        <div class="sumsec-head"><span class="sumsec-title">${title}</span><span class="sumsec-avg">${built.data.pts.length} 个年份 · 得分率</span></div>
        <div class="legend">${legend}</div>
        <div class="chartwrap" data-chart="${idx}">${built.svg}<div class="chart-tip" hidden></div></div>
        <p class="sumnote">${note}</p>
      </section>`;
    };

    const charts = chartSection('题型趋势', TYPE_SERIES, '只有该题型全部题目都记录后才绘出；未填完的选填和大题不参与走势。')
      + chartSection('模块趋势', MODULE_SERIES, '只有该模块全部题目都记录后才绘出；数二不考概率，因此不会出现在图里。');

    return `${header}<div class="stats">${cards}</div>
      <p class="sumnote">均分按 2021 年改革前后分开统计；每个分段只计入对应部分题目已全部记录的成绩，未填完的不参与统计。总分满分始终是 150 分，因此另外保留了全部年份的均分。</p>
      ${yearTableHTML(allRows)}${charts}`;
  }

  /* ── 错题本导出 PDF：另建一份只用于打印的版式，交给浏览器「存储为 PDF」 ── */
  // 打印用的题目卡片；practice 版只留题目和答题空白，不带答案与解析
  function printCard(q, n, { label = '', practice = false, big = false } = {}) {
    const st = Math.max(0, Math.min(5, q.st || 0));
    const opts = q.o
      ? `<div class="opts">${q.o.map((t, i) =>
          `<div class="opt${bigOpt(t) ? ' big' : ''}"><span class="ol">${'ABCD'[i]}</span><span>${safe(t)}</span></div>`).join('')}</div>`
      : '';
    const head = `<div class="pqh"><span class="pno">${n}</span><span class="pkp">${label ? `${esc(label)} · ` : ''}${esc(q.m)} · ${safe(q.t)}</span><span class="pst">${'★'.repeat(st)}${'☆'.repeat(5 - st)}</span></div>`;
    if (practice) {
      return `<article class="pq practice${big ? ' big' : ''}">
        ${head}
        <div class="qtext">${safe(q.x)}</div>
        ${opts}
        <div class="pblank"><span>答题区</span></div>
      </article>`;
    }
    return `<article class="pq">
      ${head}
      <div class="qtext">${safe(q.x)}</div>
      ${opts}
      <div class="prow"><b>答案</b><span>${safe(q.a)}</span></div>
      ${q.sol ? `<div class="prow"><b>解析</b><span>${safe(q.sol)}</span></div>` : ''}
    </article>`;
  }

  function printDocHTML(entries) {
    const now = new Date();
    const pad = v => String(v).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const count = s => entries.filter(e => e[1] === s).length;

    const groups = new Map();
    entries.forEach(([year, subject, n]) => {
      const k = `${year}-${subject}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n);
    });

    const sections = [...groups.entries()].map(([k, nums]) => {
      const [year, subject] = k.split('-').map(Number);
      const cards = nums.map(n => {
        const q = getQ(year, subject, n);
        return q ? printCard(q, n) : '';
      }).join('');
      return `<section class="pgroup"><h2>${paperLabel(year, subject)}</h2>${cards}</section>`;
    }).join('');

    return `<div class="print-doc">
      <header class="phd">
        <h1>考研数学 · 我的错题本</h1>
        <p>共 <b>${entries.length}</b> 题 ｜ 数一 ${count(1)} · 数二 ${count(2)} · 数三 ${count(3)} ｜ 导出日期 ${date}</p>
      </header>
      ${sections}
    </div>`;
  }

  // 做题本：只印题目、不带答案，小题每页两道、大题一页一道，留出答题空白
  function practiceDocHTML(entries) {
    const now = new Date();
    const pad = v => String(v).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    // 大题（解答题）一题一页，小题（选择/填空）两题一页；顺序保持「年份倒序 · 同年按科目」
    const pages = [];
    let buf = [];
    let seq = 0;
    const flush = () => { if (buf.length) { pages.push(buf); buf = []; } };
    entries.forEach(([year, subject, n]) => {
      const q = getQ(year, subject, n);
      if (!q) return;
      const big = isBigQ(year, n);
      // 题号按做题顺序重新编号，原卷出处（年份·科目·题号）放在旁边
      const card = printCard(q, ++seq, { label: `${paperTitle(year, subject)}第 ${n} 题`, practice: true, big });
      if (big) { flush(); pages.push([card]); }
      else { buf.push(card); if (buf.length === 2) flush(); }
    });
    flush();

    return `<div class="print-doc practice">
      ${pages.map((pg, i) => `<section class="ppage">
        <div class="pph"><span>考研数学 · 错题做题本</span><span>第 ${i + 1} / ${pages.length} 页</span></div>
        ${i === 0 ? `<p class="pmeta">共 <b>${seq}</b> 题 · 小题每页 2 题、大题每页 1 题 · 导出日期 ${date}</p>` : ''}
        ${pg.join('')}
      </section>`).join('')}
    </div>`;
  }

  // 判大题：按当年卷面分组（选择/填空/解答）取题号区间，解答题即大题
  function isBigQ(year, n) {
    const g = groupsFor(year).find(g => n >= g.from && n <= g.to);
    return !!g && g.title.includes('解答');
  }

  let printRootEl = null;
  function exportPrint(html, practice) {
    if (printRootEl) printRootEl.remove();
    printRootEl = document.createElement('div');
    printRootEl.id = 'printRoot';
    if (practice) printRootEl.classList.add('practice');
    printRootEl.innerHTML = html;
    document.body.appendChild(printRootEl);
    document.documentElement.classList.add('printing');
    renderMath(printRootEl);

    const done = () => {
      document.documentElement.classList.remove('printing');
      if (printRootEl) { printRootEl.remove(); printRootEl = null; }
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    // 等 KaTeX 排版落地再唤起打印对话框
    setTimeout(() => { try { window.print(); } catch (e) { done(); } }, 150);
    setTimeout(done, 180000); // 极端情况下 afterprint 不触发时兜底清理
  }

  function exportWrongPDF() {
    const entries = wrongEntries();
    if (entries.length) exportPrint(printDocHTML(entries), false);
  }

  function exportPracticePDF() {
    const entries = wrongEntries();
    if (entries.length) exportPrint(practiceDocHTML(entries), true);
  }

  /* ── 主渲染 ── */
  // 复用已渲染好的 DOM 节点：切回同一年时既不重建页面，也不重排公式
  let renderToken = 0;

  const cacheKeyOf = () => state.view === 'stats'
    ? `stats|${state.statsSubject}|${statsChartWidth()}`
    : state.view === 'mock'
      ? `mock|${state.mockSubject}|${state.paper}`
      : `${state.view}|${state.year}`;

  // 难度 / 重点筛选只改显隐，不重建页面
  function applyFilter() {
    if (!SUBJ_VIEW[state.view]) return;
    const cards = [...appEl.querySelectorAll('.qcard[data-lv]')];
    let shown = 0;
    cards.forEach(c => {
      const hide = (state.keyOnly && c.dataset.key !== '1')
        || (state.level !== 'all' && c.dataset.lv !== state.level);
      c.hidden = hide;
      if (!hide) shown++;
    });
    appEl.querySelectorAll('.qgroup').forEach(g => {
      const inner = [...g.querySelectorAll('.qcard[data-lv]')];
      g.hidden = inner.length > 0 && inner.every(c => c.hidden);
    });
    const cnt = appEl.querySelector('.fcount');
    if (cnt) cnt.textContent = `显示 ${shown} / ${cards.length} 题`;
    const empty = appEl.querySelector('.filter-empty');
    if (empty) empty.hidden = shown > 0 || !cards.length;
    appEl.querySelectorAll('.fbtn').forEach(b => {
      const v = b.dataset.filter;
      const on = v === 'key' ? state.keyOnly : (!state.keyOnly && state.level === v);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  // 错题本 / 成绩统计会跨年份取题，涉及的年份都要先载入
  function neededYears() {
    if (state.view === 'mock') return [];
    if (state.view === 'stats') {
      const years = [...new Set(Object.keys(SCORES).map(k => Number(k.split('-')[0])))];
      return years.filter(y => ALL_YEARS.includes(y));
    }
    if (state.view !== 'wrong') return [state.year];
    const years = [...new Set([...WRONG].map(k => Number(k.split('-')[0])))];
    return years.length ? years.filter(y => ALL_YEARS.includes(y)) : [state.year];
  }

  function render() {
    const token = ++renderToken;
    // 模拟卷题库按需加载，加载完再真正渲染一次
    if (needMockData() && typeof MOCK_PAPERS === 'undefined') {
      document.documentElement.dataset.loading = 'true';
      // 题库到位后重新走一遍 render()：错题本里可能还有真题年份要加载
      ensureMockData().then(() => {
        document.documentElement.dataset.loading = '';
        if (token === renderToken) render();
      }, () => {
        document.documentElement.dataset.loading = '';
        if (token === renderToken) render();
      });
      return;
    }
    const missing = neededYears().filter(y => !LOADED_YEARS.has(y));
    if (missing.length) {
      document.documentElement.dataset.loading = 'true';
      Promise.all(missing.map(loadYear)).then(() => {
        document.documentElement.dataset.loading = '';
        if (token === renderToken) renderNow();
      }, err => {
        document.documentElement.dataset.loading = '';
        if (token !== renderToken) return;
        appEl.innerHTML = `<div class="card empty">${err.message}。请检查网络后刷新重试。</div>`;
      });
      return;
    }
    renderNow();
  }

  function renderNow() {
    document.documentElement.dataset.view = state.view;
    // 打开某一套模拟卷时，以题库里的科目为准（URL 里没带 subj 也能正确显示）
    if (state.paper && typeof MOCK_PAPERS !== 'undefined' && MOCK_PAPERS[state.paper]) {
      state.mockSubject = MOCK_PAPERS[state.paper].subject;
    }
    try {
      const qs = new URLSearchParams({ view: state.view, year: String(state.year) });
      if (state.view === 'stats') qs.set('subj', String(state.statsSubject));
      if (state.view === 'mock') {
        qs.set('subj', String(state.mockSubject));
        if (state.paper) qs.set('paper', String(state.paper));
      }
      history.replaceState(null, '', `?${qs}`);
    } catch (e) { /* file:// 下部分浏览器不允许改写地址 */ }
    savePosition();

    reconcileLoadedScores();
    reconcileLoadedTimers();
    const cacheKey = cacheKeyOf();
    const cachedNodes = VIEW_CACHE.get(cacheKey);
    if (cachedNodes) {
      VIEW_CACHE.delete(cacheKey);      // 挪到队尾，LRU 淘汰最久未用的
      VIEW_CACHE.set(cacheKey, cachedNodes);
      appEl.replaceChildren(...cachedNodes);
    } else {
      const subject = SUBJ_VIEW[state.view];
      if (subject) appEl.innerHTML = subjectHTML(subject);
      else if (state.view === 'key') appEl.innerHTML = keyHTML();
      else if (state.view === 'wrong') appEl.innerHTML = wrongHTML();
      else if (state.view === 'stats') { appEl.innerHTML = statsHTML(); bindStatsCharts(); }
      else if (state.view === 'mock') appEl.innerHTML = state.paper ? mockPaperHTML(state.paper, state.mockSubject) : mockHTML();
      else appEl.innerHTML = suppHTML();
      renderMath();
      VIEW_CACHE.set(cacheKey, [...appEl.childNodes]);
      if (VIEW_CACHE.size > VIEW_CACHE_MAX) VIEW_CACHE.delete(VIEW_CACHE.keys().next().value);
    }
    applyFilter();

    modulesEl.querySelectorAll('.mod').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
    });
    const activeMod = modulesEl.querySelector('.mod[aria-pressed="true"]');
    if (activeMod) activeMod.scrollIntoView({ block: 'nearest', inline: 'center' });
    yearsEl.querySelectorAll('.year').forEach(b => {
      b.setAttribute('aria-current', String(Number(b.dataset.year) === state.year));
    });
    renderYearProgress();
  }

  function renderMath(root) {
    if (typeof renderMathInElement !== 'function') return;
    try {
      renderMathInElement(root || appEl, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '$', right: '$', display: false }
        ],
        throwOnError: false,
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option']
      });
    } catch (err) {
      console.warn('KaTeX 渲染失败：', err);
    }
  }

  function scrollTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function jumpTo(year, subject, n, smooth = true) {
    // 内置模拟卷（伪年份）没有年份页，直接打开那一套。
    // 题库是懒加载的：锚点可能在 mockdata.js 到位之前就跳过来，先等它加载完。
    if (isMockYear(year)) {
      const go = () => {
        if (!mockPaperMeta(year, subject)) return;
        state.view = 'mock';
        state.paper = year;
        state.mockSubject = subject;
        render();
        requestAnimationFrame(() => {
          const el = document.getElementById(`q-${year}-${subject}-${n}`);
          if (!el) return;
          el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
          el.classList.add('flash');
          setTimeout(() => el.classList.remove('flash'), 1700);
        });
      };
      if (typeof MOCK_PAPERS === 'undefined') ensureMockData().then(go, () => {});
      else go();
      return;
    }
    state.view = 'm' + subject;
    state.year = year;
    state.level = 'all';
    state.keyOnly = false;
    const ready = LOADED_YEARS.has(year) ? Promise.resolve() : loadYear(year);
    ready.then(() => {
      render();
      requestAnimationFrame(() => {
        const el = document.getElementById(`q-${year}-${subject}-${n}`);
        if (!el) return;
        el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1700);
      });
    }).catch(() => {});
  }

  /* ── PDF 浮层 ── */
  function openPdf(path, title) {
    pdfTitleEl.textContent = title || 'PDF';
    frameEl.src = path;
    pdfOpenEl.href = path;
    sheetEl.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closePdf() {
    sheetEl.hidden = true;
    frameEl.src = 'about:blank';
    document.body.style.overflow = '';
  }

  /* ── 事件 ── */
  appEl.addEventListener('click', e => {
    const syncBridge = e.target.closest('[data-sync-bridge]');
    if (syncBridge) {
      const ep = syncEndpoint();
      if (ep.isHub) {
        // 先跳到数学站，它会把本机记录打包带回到这里
        const u = new URL(ep.src, location.href);
        u.hash = '';
        u.searchParams.set('pullTo', location.origin + location.pathname);
        location.href = u.href;
      } else {
        syncPushTo(ep.hub);
      }
      return;
    }
    if (e.target.closest('[data-sync-export]')) {
      syncDownload();
      return;
    }
    const syncImport = e.target.closest('[data-sync-import]');
    if (syncImport) {
      const box = syncImport.closest('[data-scorecard]');
      const file = box && box.querySelector('[data-sync-file]');
      if (file) file.click();
      return;
    }
    const mockSubj = e.target.closest('[data-mock-subj]');
    if (mockSubj) {
      const s = Number(mockSubj.dataset.mockSubj);
      if (s === state.mockSubject) return;
      state.mockSubject = s;
      state.paper = 0;
      render();
      scrollTop();
      return;
    }

    const openPaper = e.target.closest('[data-open-paper]');
    if (openPaper) {
      const y = Number(openPaper.dataset.openPaper);
      const s = Number(openPaper.dataset.paperSubj) || (MOCK_PAPERS[y] || {}).subject || state.mockSubject;
      if (!y) return;
      state.view = 'mock';
      state.paper = y;
      state.mockSubject = s;
      render();
      scrollTop();
      return;
    }
    if (e.target.closest('[data-close-paper]')) {
      state.paper = 0;
      render();
      scrollTop();
      return;
    }

    const mockChip = e.target.closest('[data-mock-sel]');
    if (mockChip) {
      const ctx = mockFromEl(mockChip);
      if (!ctx || !ctx.mock) return;
      const n = Number(mockChip.dataset.mockSel);
      const cur = ctx.mock.sel[n];
      if (cur === 1) ctx.mock.sel[n] = 0;
      else if (cur === 0) delete ctx.mock.sel[n];
      else ctx.mock.sel[n] = 1;
      saveMocks();
      repaintMockCard(ctx.card, ctx.mock);
      refreshMockStats();
      return;
    }

    const mockAll = e.target.closest('[data-mock-all]');
    if (mockAll) {
      const ctx = mockFromEl(mockAll);
      if (!ctx || !ctx.mock) return;
      let filled = 0;
      let kept = 0;
      for (let n = 1; n <= 16; n++) {
        if (ctx.mock.sel[n] !== undefined) { kept++; continue; }
        ctx.mock.sel[n] = 1;
        filled++;
      }
      saveMocks();
      const fresh = repaintMockCard(ctx.card, ctx.mock);
      refreshMockStats();
      setMockStatus(fresh, filled
        ? `已补齐 ${filled} 道未标记的选填为做对，保留 ${kept} 道已有记录。`
        : `没有需要补齐的选填，${kept} 道已有记录保持不变。`);
      return;
    }

    const mockAllBig = e.target.closest('[data-mock-all-big]');
    if (mockAllBig) {
      const ctx = mockFromEl(mockAllBig);
      if (!ctx || !ctx.mock) return;
      let filled = 0;
      let kept = 0;
      for (let n = 17; n <= 22; n++) {
        if (ctx.mock.big[n] !== undefined) { kept++; continue; }
        ctx.mock.big[n] = MOCK_MAX(n);
        filled++;
      }
      saveMocks();
      const fresh = repaintMockCard(ctx.card, ctx.mock);
      refreshMockStats();
      setMockStatus(fresh, filled
        ? `已补齐 ${filled} 道未填写的大题为满分，保留 ${kept} 道已有分数，可继续逐题修改。`
        : `没有需要补齐的大题，${kept} 道已有分数保持不变。`);
      return;
    }

    const mockClearSel = e.target.closest('[data-mock-clear-sel]');
    if (mockClearSel) {
      const ctx = mockFromEl(mockClearSel);
      if (!ctx || !ctx.mock) return;
      ctx.mock.sel = {};
      saveMocks();
      const fresh = repaintMockCard(ctx.card, ctx.mock);
      refreshMockStats();
      setMockStatus(fresh, '已清空本卷选填记录。');
      return;
    }

    const mockReset = e.target.closest('[data-mock-reset]');
    if (mockReset) {
      const ctx = mockFromEl(mockReset);
      if (!ctx || !ctx.mock) return;
      if (!window.confirm(`清空模拟卷「${ctx.mock.name}」的成绩？模拟卷名称会保留。`)) return;
      ctx.mock.sel = {};
      ctx.mock.big = {};
      saveMocks();
      const fresh = repaintMockCard(ctx.card, ctx.mock);
      refreshMockStats();
      setMockStatus(fresh, '已清空本卷成绩，名称保留。');
      return;
    }

    const mockRename = e.target.closest('[data-mock-rename]');
    if (mockRename) {
      const ctx = mockFromEl(mockRename);
      if (!ctx || !ctx.mock) return;
      const next = window.prompt('修改模拟卷名称', ctx.mock.name);
      if (next === null) return;
      const name = next.trim().slice(0, 40);
      if (!name) return;
      ctx.mock.name = name;
      saveMocks();
      repaintMockCard(ctx.card, ctx.mock);
      return;
    }

    const mockDelete = e.target.closest('[data-mock-delete]');
    if (mockDelete) {
      const ctx = mockFromEl(mockDelete);
      if (!ctx || !ctx.mock) return;
      if (!window.confirm(`删除模拟卷「${ctx.mock.name}」？该卷的所有分数会一并删除，此操作不可撤销。`)) return;
      const idx = MOCKS.indexOf(ctx.mock);
      if (idx >= 0) MOCKS.splice(idx, 1);
      saveMocks();
      render();
      return;
    }

    const timerZoom = e.target.closest('[data-timer-zoom]');
    if (timerZoom) {
      const box = timerZoom.closest('[data-timer]');
      if (box) openZoom(box.dataset.timer, zoomLabelOf(box));
      return;
    }

    const sfTime = e.target.closest('[data-sf="time"]');
    if (sfTime) {
      const fb = sfTime.closest('[data-scorefloat]');
      if (fb) openZoom(`sum:${fb.dataset.year}-${fb.dataset.subject}`, `${fb.dataset.year} 年 · 本卷总用时`);
      return;
    }

    const timerBtn = e.target.closest('[data-timer-toggle], [data-timer-reset]');
    if (timerBtn) {
      const box = timerBtn.closest('[data-timer]');
      if (!box) return;
      if (timerBtn.hasAttribute('data-timer-reset')) resetTimer(box.dataset.timer);
      else toggleTimer(box.dataset.timer);
      return;
    }

    const sfJump = e.target.closest('[data-sf-jump]');
    if (sfJump) {
      const fb = sfJump.closest('[data-scorefloat]');
      if (fb) {
        const el = document.getElementById(`q-${fb.dataset.year}-${fb.dataset.subject}-${sfJump.dataset.sfJump}`);
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      return;
    }

    const sfToggle = e.target.closest('[data-sf-toggle]');
    if (sfToggle) {
      const fb = sfToggle.closest('[data-scorefloat], [data-pagefloat]');
      if (fb) toggleFloatFold(fb);
      return;
    }

    const panelToggle = e.target.closest('[data-panel-toggle]');
    if (panelToggle) {
      const card = panelToggle.closest('[data-scorecard], [data-mockcard]');
      if (card) togglePanelFold(card);
      return;
    }

    // 未完成的题号：跳到本页里那道题（先于整块点击处理，否则会被卡片吞掉）
    const pageJump = e.target.closest('[data-page-jump]');
    if (pageJump) {
      const box = pageJump.closest('[data-pagefloat]');
      const [s, n] = pageJump.dataset.pageJump.split(',').map(Number);
      const el = box && document.getElementById(`q-${box.dataset.pageYear}-${s}-${n}`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1600);
      }
      return;
    }

    // 重点题 / 补充真题页的得分卡：只在收起时点开，没有「我的成绩」面板可跳
    const pageBox = e.target.closest('[data-pagefloat]');
    if (pageBox) {
      if (pageBox.classList.contains('is-collapsed')) toggleFloatFold(pageBox);
      return;
    }

    const floatBox = e.target.closest('[data-scorefloat]');
    if (floatBox) {
      // 收起状态下点整块就是展开，展开时才跳到「我的成绩」面板
      if (floatBox.classList.contains('is-collapsed')) {
        toggleFloatFold(floatBox);
        return;
      }
      const panel = appEl.querySelector('[data-scorecard]');
      if (panel) panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }

    const selMark = e.target.closest('[data-sel-mark]');
    if (selMark) {
      const box = selMark.closest('[data-qsel]');
      if (!box) return;
      const [year, subject, n] = box.dataset.qsel.split(',').map(Number);
      const rec = ensureScoreRec(year, subject);
      const want = Number(selMark.dataset.selMark);
      if (rec.sel[n] === want) delete rec.sel[n];   // 再点一次取消
      else rec.sel[n] = want;
      const synced = propagateScore(year, subject, n, rec.sel[n], false);
      pruneScoreRec(year, subject);
      saveScores();
      syncSelState(year, subject, n, rec.sel[n]);
      refreshPageFloat();
      const card = appEl.querySelector('[data-scorecard]');
      if (synced && card) setScoreStatus(card, `第 ${n} 题已自动同步到 ${synced} 道同题。`);
      return;
    }

    const scoreQ = e.target.closest('[data-score-q]');
    if (scoreQ) {
      const card = scoreQ.closest('[data-scorecard]');
      if (!card) return;
      const year = Number(card.dataset.year);
      const subject = Number(card.dataset.subject);
      const n = Number(scoreQ.dataset.scoreQ);
      const rec = ensureScoreRec(year, subject);
      const cur = rec.sel[n];
      if (cur === 1) rec.sel[n] = 0;
      else if (cur === 0) delete rec.sel[n];
      else rec.sel[n] = 1;
      const synced = propagateScore(year, subject, n, rec.sel[n], false);
      pruneScoreRec(year, subject);
      saveScores();
      const fresh = repaintScorecard(card, year, subject);
      if (synced) setScoreStatus(fresh, `第 ${n} 题已自动同步到 ${synced} 道同题。`);
      return;
    }

    const scoreAll = e.target.closest('[data-score-all]');
    if (scoreAll) {
      const card = scoreAll.closest('[data-scorecard]');
      if (!card) return;
      const year = Number(card.dataset.year);
      const subject = Number(card.dataset.subject);
      const rec = ensureScoreRec(year, subject);
      let filled = 0;
      let kept = 0;
      let synced = 0;
      // 只补齐还没标记的题，已经记过的（包括从同题同步来的）保持原样
      for (const q of (PAPERS[paperKey(year, subject)] || [])) {
        if (qKind(year, q.n) === 'big') continue;
        if (rec.sel[q.n] !== undefined) { kept++; continue; }
        rec.sel[q.n] = 1;
        filled++;
        synced += propagateScore(year, subject, q.n, 1, false);
      }
      saveScores();
      const fresh = repaintScorecard(card, year, subject);
      setScoreStatus(fresh, filled
        ? `已补齐 ${filled} 道未标记的选填为做对，保留 ${kept} 道已有记录${synced ? `；并同步 ${synced} 道同题` : ''}。`
        : `没有需要补齐的选填，${kept} 道已有记录保持不变。`);
      return;
    }

    const scoreAllBig = e.target.closest('[data-score-all-big]');
    if (scoreAllBig) {
      const card = scoreAllBig.closest('[data-scorecard]');
      if (!card) return;
      const year = Number(card.dataset.year);
      const subject = Number(card.dataset.subject);
      const rec = ensureScoreRec(year, subject);
      let filled = 0;
      let kept = 0;
      let synced = 0;
      // 只补齐还没填写的大题，已经填过的分数保持原样
      for (const q of (PAPERS[paperKey(year, subject)] || [])) {
        if (qKind(year, q.n) !== 'big') continue;
        if (rec.big[q.n] !== undefined) { kept++; continue; }
        rec.big[q.n] = qMax(year, q.n);
        filled++;
        synced += propagateScore(year, subject, q.n, rec.big[q.n], false);
      }
      saveScores();
      const fresh = repaintScorecard(card, year, subject);
      setScoreStatus(fresh, filled
        ? `已补齐 ${filled} 道未填写的大题为满分，保留 ${kept} 道已有分数，可继续逐题修改${synced ? `；并同步 ${synced} 道同题` : ''}。`
        : `没有需要补齐的大题，${kept} 道已有分数保持不变。`);
      return;
    }

    const scoreClearSel = e.target.closest('[data-score-clear-sel]');
    if (scoreClearSel) {
      const card = scoreClearSel.closest('[data-scorecard]');
      if (!card) return;
      const year = Number(card.dataset.year);
      const subject = Number(card.dataset.subject);
      const rec = ensureScoreRec(year, subject);
      let synced = 0;
      for (const n of Object.keys(rec.sel).map(Number)) {
        synced += propagateScore(year, subject, n, undefined, false);
      }
      rec.sel = {};
      pruneScoreRec(year, subject);
      saveScores();
      const fresh = repaintScorecard(card, year, subject);
      if (synced) setScoreStatus(fresh, `已清空选填，并同步清除 ${synced} 道同题记录。`);
      return;
    }

    const scoreCopy = e.target.closest('[data-copy-big]');
    if (scoreCopy) {
      const card = scoreCopy.closest('[data-scorecard]');
      if (!card) return;
      const year = Number(card.dataset.year);
      const subject = Number(card.dataset.subject);
      const [srcSubject, srcN, tgtN] = scoreCopy.dataset.copyBig.split(',').map(Number);
      const src = scoreRec(year, srcSubject);
      const val = src ? src.big[srcN] : undefined;
      if (val === undefined) return;
      const rec = ensureScoreRec(year, subject);
      rec.big[tgtN] = Math.min(qMax(year, tgtN), Math.max(0, val));
      const synced = propagateScore(year, subject, tgtN, rec.big[tgtN], false);
      saveScores();
      const fresh = repaintScorecard(card, year, subject);
      setScoreStatus(fresh, `已从 ${SUBJ[srcSubject]} 第 ${srcN} 题复制 ${fmtScore(rec.big[tgtN])} 分${synced ? `，并同步 ${synced} 道同题` : ''}。`);
      return;
    }

    const scoreSync = e.target.closest('[data-score-sync]');
    if (scoreSync) {
      const card = scoreSync.closest('[data-scorecard]');
      if (!card) return;
      const year = Number(card.dataset.year);
      const subject = Number(card.dataset.subject);
      const res = syncSameScores(year, subject);
      const fresh = repaintScorecard(card, year, subject);
      setScoreStatus(fresh, res.count
        ? `已从其他科目同步 ${res.count} 道同题成绩。`
        : '没有找到其他科目里已记录的同题成绩。');
      return;
    }

    const scoreReset = e.target.closest('[data-score-reset]');
    if (scoreReset) {
      const card = scoreReset.closest('[data-scorecard]');
      if (!card) return;
      const year = Number(card.dataset.year);
      const subject = Number(card.dataset.subject);
      const rec = scoreRec(year, subject);
      if (!rec) return;
      if (!window.confirm(`清空「${paperLabel(year, subject)}」的记录？其他科目的同题记录也会一并清除。`)) return;
      const selNs = Object.keys(rec.sel).map(Number);
      const bigNs = Object.keys(rec.big).map(Number);
      delete SCORES[paperKey(year, subject)];
      let synced = 0;
      for (const n of selNs) synced += propagateScore(year, subject, n, undefined, false);
      for (const n of bigNs) synced += propagateScore(year, subject, n, undefined, false);
      saveScores();
      const fresh = repaintScorecard(card, year, subject);
      setScoreStatus(fresh, `已清空本卷成绩${synced ? `，并同步清除 ${synced} 道同题记录` : ''}。`);
      return;
    }

    const wb = e.target.closest('[data-wrong]');
    if (wb) {
      const k = wb.dataset.wrong;
      if (WRONG.has(k)) WRONG.delete(k); else WRONG.add(k);
      saveWrong();
      VIEW_CACHE.clear();   // 缓存里的按钮状态已过期
      if (state.view === 'wrong') {
        const sy = window.scrollY;
        render();
        updateWrongBadge();
        window.scrollTo(0, sy);
      } else {
        syncWrongBtns();
      }
      return;
    }

    const expW = e.target.closest('[data-wrong-export]');
    if (expW) { exportWrongPDF(); return; }

    const pracW = e.target.closest('[data-wrong-practice]');
    if (pracW) { exportPracticePDF(); return; }

    const clearW = e.target.closest('[data-wrong-clear]');
    if (clearW) {
      if (!WRONG.size) return;
      if (!window.confirm(`清空错题本里的 ${WRONG.size} 道题？此操作不可撤销。`)) return;
      WRONG.clear();
      saveWrong();
      VIEW_CACHE.clear();
      updateWrongBadge();
      render();
      return;
    }

    const ans = e.target.closest('.ansbtn');
    if (ans) {
      // 题目卡里的按钮在 .qfoot 里，重点题的按钮紧挨着答案框，两种都支持
      const box = ans.nextElementSibling && ans.nextElementSibling.classList.contains('ansbox')
        ? ans.nextElementSibling
        : ans.closest('.qcard').querySelector('.ansbox');
      const open = box.hidden;
      box.hidden = !open;
      ans.setAttribute('aria-expanded', String(open));
      ans.textContent = open ? '收起解析' : '答案 · 解析';
      return;
    }

    const pdf = e.target.closest('[data-pdf]');
    if (pdf) {
      openPdf(pdf.dataset.pdf, pdf.dataset.pdfTitle);
      return;
    }

    const fbtn = e.target.closest('.fbtn');
    if (fbtn) {
      const v = fbtn.dataset.filter;
      if (v === 'key') {
        state.keyOnly = !state.keyOnly;
      } else {
        state.level = v;
        state.keyOnly = false;
      }
      applyFilter();
      return;
    }

    const jump = e.target.closest('[data-jump]');
    if (jump) {
      e.preventDefault();
      const [y, s, n] = jump.dataset.jump.split(',').map(Number);
      jumpTo(y, s, n);
      return;
    }

    const statsSeg = e.target.closest('[data-stats-subj]');
    if (statsSeg) {
      const s = Number(statsSeg.dataset.statsSubj);
      if (s === state.statsSubject) return;
      state.statsSubject = s;
      render();
      scrollTop();
      return;
    }

    const statsStart = e.target.closest('[data-stats-start]');
    if (statsStart) {
      const s = Number(statsStart.dataset.statsStart);
      state.statsSubject = s;
      state.view = `m${s}`;
      state.level = 'all';
      state.keyOnly = false;
      render();
      scrollTop();
    }
  });

  appEl.addEventListener('submit', e => {
    const form = e.target.closest('[data-mock-form]');
    if (!form) return;
    e.preventDefault();
    const nameInput = form.querySelector('[data-mock-name-input]');
    const subjectInput = form.querySelector('[data-mock-subject-input]');
    const name = (nameInput.value || '').trim().slice(0, 40);
    const subject = Number(subjectInput.value);
    if (!name) { nameInput.focus(); return; }
    if (![1, 2, 3].includes(subject)) return;
    MOCKS.push({ id: mockId(), name, subject, sel: {}, big: {}, created: Date.now() });
    state.mockSubject = subject;
    saveMocks();
    render();
  });

  appEl.addEventListener('input', e => {
    const mockInp = e.target.closest('[data-mock-big]');
    if (mockInp) {
      const ctx = mockFromEl(mockInp);
      if (!ctx || !ctx.mock) return;
      const n = Number(mockInp.dataset.mockBig);
      const raw = mockInp.value.trim();
      if (raw === '') {
        delete ctx.mock.big[n];
      } else {
        const v = Number(raw);
        if (!Number.isFinite(v)) return;
        const clamped = Math.min(MOCK_MAX(n), Math.max(0, v));
        ctx.mock.big[n] = clamped;
        if (clamped !== v) mockInp.value = fmtScore(clamped);
      }
      saveMocks();
      updateMockSums(ctx.card, ctx.mock);
      refreshMockStats();
      return;
    }
    const inp = e.target.closest('[data-score-big], [data-qbig]');
    if (!inp) return;
    const ctx = cardScoreCtx(inp);
    if (!ctx) return;
    const year = ctx.year;
    const subject = ctx.subject;
    const n = ctx.n;
    const raw = inp.value.trim();
    const rec = ensureScoreRec(year, subject);
    if (raw === '') {
      delete rec.big[n];
    } else {
      const v = Number(raw);
      if (!Number.isFinite(v)) return;
      const clamped = Math.min(qMax(year, n), Math.max(0, v));
      rec.big[n] = clamped;
      if (clamped !== v) inp.value = fmtScore(clamped);
    }
    const synced = propagateScore(year, subject, n, rec.big[n], false);
    pruneScoreRec(year, subject);
    saveScores();
    mirrorCardScore(year, subject, n, rec.big[n], inp);
    refreshPageFloat();
    const card = appEl.querySelector('[data-scorecard]');
    if (synced && card) setScoreStatus(card, `第 ${n} 题已自动同步到 ${synced} 道同题。`);
  });

  // 选中导出的 json 文件后导入
  appEl.addEventListener('change', e => {
    const file = e.target.closest('[data-sync-file]');
    if (!file || !file.files || !file.files[0]) return;
    const card = file.closest('[data-scorecard]');
    const status = card && card.querySelector('[data-sync-status]');
    syncReadFile(file.files[0], pack => {
      if (!pack || !pack.data) {
        if (status) status.textContent = '这个文件里没有可导入的成绩记录';
        return;
      }
      runSyncImport(pack, () => {
        if (status) status.textContent = '没有新的记录可导入（可能已经导入过）';
      });
    });
    file.value = '';
  });

  // 失焦时把越界或只写了一半的数字回填成实际存下的分数
  appEl.addEventListener('focusout', e => {
    const mockInp = e.target.closest('[data-mock-big]');
    if (mockInp) {
      const ctx = mockFromEl(mockInp);
      if (!ctx || !ctx.mock) return;
      const n = Number(mockInp.dataset.mockBig);
      const v = ctx.mock.big[n];
      mockInp.value = v === undefined ? '' : fmtScore(v);
      return;
    }
    const inp = e.target.closest('[data-score-big], [data-qbig]');
    if (!inp) return;
    const ctx = cardScoreCtx(inp);
    if (!ctx) return;
    const rec = scoreRec(ctx.year, ctx.subject);
    const v = rec ? rec.big[ctx.n] : undefined;
    inp.value = v === undefined ? '' : fmtScore(v);
    inp.classList.toggle('has-val', v !== undefined);
  });

  modulesEl.addEventListener('click', e => {
    const btn = e.target.closest('.mod');
    if (!btn) return;
    if (btn.dataset.view === 'stats') {
      const cur = SUBJ_VIEW[state.view];
      if (cur) state.statsSubject = cur;
    }
    if (btn.dataset.view === 'mock') {
      const cur = SUBJ_VIEW[state.view];
      if (cur) state.mockSubject = cur;
      state.paper = 0;
    }
    state.view = btn.dataset.view;
    render();
    scrollTop();
  });

  yearsEl.addEventListener('click', e => {
    const btn = e.target.closest('.year');
    if (!btn || btn.disabled) return;
    state.year = Number(btn.dataset.year);
    render();
    scrollTop();
  });

  // 「这卷做完了」的小勾：手动标记当前年份，覆盖自动判据
  const yearprogEl = document.getElementById('yearprog');
  if (yearprogEl) {
    yearprogEl.addEventListener('change', e => {
      const cb = e.target.closest('[data-year-done]');
      const subject = SUBJ_VIEW[state.view];
      if (!cb || !subject) return;
      setYearDone(state.year, subject, cb.checked);
    });
  }

  // 年份条右端的「进度」按钮：展开 / 收起下面那一行
  if (yprogBtn) {
    yprogBtn.addEventListener('click', () => setYprogOpen(!yprogOpen()));
  }

  // 统计图表按容器宽度绘制，窗口尺寸变化后重画一次
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (state.view !== 'stats') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      VIEW_CACHE.delete(cacheKeyOf());
      render();
    }, 180);
  });

  document.getElementById('pdfClose').addEventListener('click', closePdf);
  sheetEl.addEventListener('click', e => {
    if (e.target === sheetEl) closePdf();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !sheetEl.hidden) closePdf();
  });

  /* ── 数据迁移：把本机的成绩、模拟卷、错题搬到另一个站点 ──
     数据只在浏览器里流转：要么走地址栏片段（# 后面的内容不会发给服务器），
     要么走本地 json 文件。导出只读，不会改动当前站点已有的记录。 */
  const SYNC_VERSION = 1;
  const SYNC_BANNER_KEY = 'kaoyanMath.sync.banner';
  const SYNC_HUB_URL = 'https://kaoyan.feikntn111.us.ci/math/';
  const SYNC_MATH_URL = 'https://math.feikntn111.us.ci/';
  const SYNC_KEYS = [SCORE_STORE_KEY, MOCK_KEY, WRONG_KEY];

  const b64encode = str => {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  };
  const b64decode = str => {
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };

  // 当前页是总库的数学页，还是独立的数学站（可用 ?syncTarget= / ?syncSource= 覆盖，便于本地调试）
  // 注意：renderNow() 会把 ?view=&year= 之外的参数从地址栏抹掉，所以要在启动前先读一遍
  const SYNC_PARAMS = new URLSearchParams(location.search);
  function syncEndpoint() {
    return {
      isHub: /^\/math(\/|$)/.test(location.pathname),
      hub: SYNC_PARAMS.get('syncTarget') || SYNC_HUB_URL,
      src: SYNC_PARAMS.get('syncSource') || SYNC_MATH_URL
    };
  }

  function collectSyncData() {
    const data = {};
    for (const k of SYNC_KEYS) {
      // 成绩走内存里的当前状态：旧格式可能还停在 localStorage 里没换算过
      if (k === SCORE_STORE_KEY) {
        if (Object.keys(SCORES).length) data[k] = JSON.stringify(SCORES);
        continue;
      }
      const v = localStorage.getItem(k);
      if (v !== null) data[k] = v;
    }
    return data;
  }

  const syncSourceName = () => (location.protocol === 'file:' ? '本机文件' : location.host);

  function syncEnvelope() {
    return { v: SYNC_VERSION, scoreVer: 4, from: syncSourceName(), at: Date.now(), data: collectSyncData() };
  }

  const countOf = o => (o && typeof o === 'object' ? Object.keys(o).length : 0);
  const readStore = (key, fallback) => {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  };

  // 合并原则：来源里有分数的题以来源为准，本机独有的记录保留不删
  // legacy：来源是旧版导出（只存 1/0），需要把 1 换算成满分
  function mergeScoreStore(incoming, legacy) {
    const cur = readStore(SCORE_STORE_KEY, {}) || {};
    let changed = 0;
    for (const [k, rec] of Object.entries(incoming && typeof incoming === 'object' ? incoming : {})) {
      if (!/^\d{4}-[123]$/.test(k) || !rec || typeof rec !== 'object') continue;
      const tgt = cur[k] && typeof cur[k] === 'object' ? cur[k] : (cur[k] = { sel: {}, big: {}, touched: rec.touched !== false });
      if (!tgt.sel || typeof tgt.sel !== 'object') tgt.sel = {};
      if (!tgt.big || typeof tgt.big !== 'object') tgt.big = {};
      const year = Number(k.split('-')[0]);
      for (const [n, v] of Object.entries(rec.sel || {})) {
        const qn = Number(n);
        if (!(qn >= 1) || qKind(year, qn) === 'big') continue;
        const max = qMax(year, qn);
        const num = Number(v);
        if (!Number.isFinite(num)) continue;
        const sv = num > 0 ? 1 : 0;
        if (tgt.sel[qn] !== sv) { tgt.sel[qn] = sv; changed++; }
      }
      for (const [n, v] of Object.entries(rec.big || {})) {
        const num = Number(v);
        if (Number.isFinite(num) && tgt.big[n] !== num) { tgt.big[n] = num; changed++; }
      }
      if (rec.touched !== false) tgt.touched = true;
    }
    if (changed) localStorage.setItem(SCORE_STORE_KEY, JSON.stringify(cur));
    return changed;
  }

  function mergeMockStore(incoming) {
    const cur = readStore(MOCK_KEY, []);
    const list = Array.isArray(cur) ? cur : [];
    const ids = new Set(list.map(m => m && m.id));
    let changed = 0;
    for (const m of Array.isArray(incoming) ? incoming : []) {
      if (!m || !m.id || ids.has(m.id)) continue;
      if (!m.name || !m.subject) continue;
      list.push(m);
      ids.add(m.id);
      changed++;
    }
    if (changed) localStorage.setItem(MOCK_KEY, JSON.stringify(list));
    return changed;
  }

  function mergeWrongStore(incoming) {
    const cur = readStore(WRONG_KEY, []);
    const set = new Set((Array.isArray(cur) ? cur : []).filter(k => typeof k === 'string'));
    let changed = 0;
    for (const k of Array.isArray(incoming) ? incoming : []) {
      if (typeof k === 'string' && /^\d{4}-[123]-\d+$/.test(k) && !set.has(k)) { set.add(k); changed++; }
    }
    if (changed) localStorage.setItem(WRONG_KEY, JSON.stringify([...set]));
    return changed;
  }

  function applySyncEnvelope(pack) {
    const data = (pack && pack.data) || {};
    const res = { score: 0, mocks: 0, wrong: 0 };
    try {
      if (data[SCORE_STORE_KEY]) {
        res.score = mergeScoreStore(JSON.parse(data[SCORE_STORE_KEY]), !(pack && Number(pack.scoreVer) >= 4));
      }
    } catch (e) { /* 跳过坏数据 */ }
    try { if (data[MOCK_KEY]) res.mocks = mergeMockStore(JSON.parse(data[MOCK_KEY])); } catch (e) { /* 同上 */ }
    try { if (data[WRONG_KEY]) res.wrong = mergeWrongStore(JSON.parse(data[WRONG_KEY])); } catch (e) { /* 同上 */ }
    return res;
  }

  function syncToast(text) {
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.style.cssText = [
      'position:fixed', 'left:50%', 'top:18px', 'transform:translateX(-50%)', 'z-index:9999',
      'max-width:min(92vw,560px)', 'padding:11px 16px', 'border-radius:12px',
      'background:#1b211d', 'color:#fffdf8', 'font:13px/1.55 "Noto Sans SC",-apple-system,"PingFang SC",sans-serif',
      'box-shadow:0 10px 30px rgba(0,0,0,.22)'
    ].join(';');
    box.textContent = text;
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 9000);
  }

  function showSyncBanner() {
    let info = null;
    try { info = JSON.parse(sessionStorage.getItem(SYNC_BANNER_KEY) || 'null'); } catch (e) { return; }
    if (!info) return;
    try { sessionStorage.removeItem(SYNC_BANNER_KEY); } catch (e) { /* 忽略 */ }
    const from = info.from ? ` ${info.from} ` : '';
    syncToast(`已从${from}导入：成绩 ${info.score} 项 · 模拟卷 ${info.mocks} 套 · 错题 ${info.wrong} 道`);
  }

  function runSyncImport(pack, onEmpty) {
    const res = applySyncEnvelope(pack);
    if (!res.score && !res.mocks && !res.wrong) {
      if (onEmpty) onEmpty();
      return 0;
    }
    try {
      sessionStorage.setItem(SYNC_BANNER_KEY, JSON.stringify({
        score: res.score, mocks: res.mocks, wrong: res.wrong, from: (pack && pack.from) || ''
      }));
    } catch (e) { /* 忽略 */ }
    location.reload();
    return res.score + res.mocks + res.wrong;
  }

  // 地址栏里带了 #sync=... 就导入（导入后立刻把片段从地址栏抹掉，避免被复制分享出去）
  function syncFromHash() {
    const m = /[#&]sync=([^&]+)/.exec(location.hash || '');
    if (!m) return false;
    let pack = null;
    try { pack = JSON.parse(b64decode(decodeURIComponent(m[1]))); } catch (e) { pack = null; }
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* 忽略 */ }
    if (!pack || pack.v !== SYNC_VERSION || !pack.data || !countOf(pack.data)) return false;
    const ok = window.confirm(
      `检测到来自「${pack.from || '另一个站点'}」的成绩记录。\n\n` +
      '导入会与本机现有记录合并：来源里有分数的题以来源为准，本机独有的记录保留。\n' +
      '不会修改另一个站点的数据。\n\n继续导入？'
    );
    if (!ok) return false;
    runSyncImport(pack);
    return true;
  }

  function syncPushTo(targetUrl) {
    const payload = encodeURIComponent(b64encode(JSON.stringify(syncEnvelope())));
    location.href = targetUrl.replace(/#.*$/, '') + '#sync=' + payload;
  }

  function syncDownload() {
    const text = JSON.stringify(syncEnvelope(), null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kaoyan-math-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  function syncReadFile(file, done) {
    const reader = new FileReader();
    reader.onload = () => {
      let pack = null;
      try { pack = JSON.parse(String(reader.result)); } catch (e) { pack = null; }
      done(pack);
    };
    reader.readAsText(file);
  }

  function migrateBlockHTML() {
    const ep = syncEndpoint();
    const label = ep.isHub ? '从数学站导入' : '迁移到总库';
    const title = ep.isHub
      ? '打开 math.feikntn111.us.ci，把那里的成绩、模拟卷和错题带过来'
      : '把这里填过的成绩、模拟卷和错题带到总库的数学页';
    return `<div class="scorefoot migrate">
        <span>换站迁移：把本机在另一个站点记录的成绩、模拟卷和错题带过来。数据只在浏览器里流转（不进服务器），原站点的记录不会被改动。</span>
        <div class="scorefoot-btns">
          <button class="minibtn" type="button" data-sync-bridge title="${attr(title)}">${label}</button>
          <button class="minibtn" type="button" data-sync-export title="导出成 json 文件，用于备份或换设备">导出文件</button>
          <button class="minibtn" type="button" data-sync-import title="选择之前导出的 json 文件">导入文件</button>
        </div>
        <input type="file" accept="application/json,.json" data-sync-file hidden>
        <span class="scorestatus" data-sync-status></span>
      </div>`;
  }

  /* ── 数据迁移结束 ── */

  /* ── 启动：显式网址参数优先，其次恢复上次位置 ── */
  const params = new URLSearchParams(location.search);
  // 数学站被总库叫来取数据：打包后跳回总库，片段不会被发到服务器
  const pullTo = params.get('pullTo');
  if (pullTo && /^https?:\/\//i.test(pullTo)) {
    location.replace(pullTo.replace(/#.*$/, '') + '#sync=' + encodeURIComponent(b64encode(JSON.stringify(syncEnvelope()))));
    return;
  }
  if (syncFromHash()) return;
  const previous = loadPosition();
  const pv = params.get('view');
  if (pv && VALID_VIEWS.includes(pv)) state.view = pv;
  else if (previous && VALID_VIEWS.includes(previous.view)) state.view = previous.view;
  const ps = Number(params.get('subj'));
  if (ps >= 1 && ps <= 3) {
    state.statsSubject = ps;
    state.mockSubject = ps;
  } else if (previous) {
    const prevStats = Number(previous.statsSubject);
    const prevMock = Number(previous.mockSubject);
    if (prevStats >= 1 && prevStats <= 3) state.statsSubject = prevStats;
    if (prevMock >= 1 && prevMock <= 3) state.mockSubject = prevMock;
  }
  const py = Number(params.get('year'));
  const previousYear = previous ? Number(previous.year) : 0;
  const live = liveYears();
  if (live.includes(py)) state.year = py;
  else if (!params.has('year') && live.includes(previousYear)) state.year = previousYear;
  else if (live.length && !live.includes(state.year)) state.year = live[0];
  // 内置模拟卷：?view=mock&paper=3211&subj=2 —— 直接打开某一套
  // 题库是懒加载的，这里只认伪年份区间，具体科目等数据到位后由 renderNow 校正
  const pp = Number(params.get('paper'));
  if (state.view === 'mock' && isMockYear(pp)) state.paper = pp;
  const hash = location.hash.match(/^#q-(\d{4})-(\d)-(\d+)$/);
  renderYears();
  updateWrongBadge();
  render();
  // 深链进来的锚点直接落位（长距离平滑滚动很晃），点链接跳转才用平滑
  if (hash) jumpTo(Number(hash[1]), Number(hash[2]), Number(hash[3]), false);
  showSyncBanner();
})();

/* 页脚 Star 计数：离线或接口失败时只显示「给个 Star」 */
(function () {
  const el = document.getElementById('starCount');
  if (!el || typeof fetch !== 'function') return;
  fetch('https://api.github.com/repos/3456038583-gif/kaoyan-hub', {
    headers: { Accept: 'application/vnd.github+json' }
  })
    .then(r => (r.ok ? r.json() : null))
    .then(d => {
      if (!d || typeof d.stargazers_count !== 'number') return;
      el.textContent = d.stargazers_count;
      el.hidden = false;
    })
    .catch(() => {});
})();
