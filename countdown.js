/* 27 考研初试倒计时：2026-12-19 08:30（北京时间）
 * 自包含：自带样式，注入到 body 最上方，全站共用。
 * 页面若需留白，可自行给 body 加 padding-top；默认作为普通横幅随页面滚动。
 */
(function () {
  var TARGET = new Date('2026-12-19T08:30:00+08:00');
  var LABEL = '27 考研初试';
  var DATE_TEXT = '2026.12.19';

  function pad(n) { return (n < 10 ? '0' : '') + n; }

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
      + '.cd-nums{display:inline-flex;align-items:baseline;gap:3px;'
      + 'font-family:var(--mono,"IBM Plex Mono",ui-monospace,Menlo,monospace);'
      + 'font-variant-numeric:tabular-nums;color:var(--red,#a33a2c);font-weight:600;}'
      + '.cd-d{font-size:15px;letter-spacing:.02em;}'
      + '.cd-hms{font-size:12px;opacity:.85;letter-spacing:.03em;}'
      + '.cd-unit{font-size:11.5px;color:var(--muted,#6d746c);font-weight:400;margin-right:2px;}'
      + '.cd-date{font-family:var(--mono,"IBM Plex Mono",ui-monospace,Menlo,monospace);'
      + 'font-size:11.5px;letter-spacing:.04em;color:var(--muted,#6d746c);}'
      + '.cd-sep{color:var(--line-strong,#bcbcae);}'
      + '.cd-done{color:var(--accent,#2f5d8a);font-family:var(--mono,monospace);}'
      + '@media (max-width:640px){'
      + '.cd-in{padding:6px 12px;gap:7px;font-size:12px;}'
      + '.cd-date{display:none;}.cd-sep{display:none;}'
      + '.cd-d{font-size:14px;}'
      + '}'
      + '@media print{.cd-bar{display:none;}}';
    var st = document.createElement('style');
    st.id = 'cd-style';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  function build() {
    var bar = document.createElement('div');
    bar.className = 'cd-bar';
    bar.setAttribute('role', 'status');
    bar.innerHTML = ''
      + '<div class="cd-in">'
      + '<span class="cd-tag">' + LABEL + '倒计时</span>'
      + '<span class="cd-nums" id="cd-nums">'
      + '<span class="cd-d" id="cd-d">--</span><span class="cd-unit">天</span>'
      + '<span class="cd-hms" id="cd-hms">--:--:--</span>'
      + '</span>'
      + '<span class="cd-sep">·</span>'
      + '<span class="cd-date">' + DATE_TEXT + ' 08:30 开考</span>'
      + '</div>';
    return bar;
  }

  function tick(numsRoot) {
    var diff = TARGET.getTime() - Date.now();
    if (diff <= 0) {
      numsRoot.innerHTML = '<span class="cd-done">已开考，稳住，能赢</span>';
      return false;
    }
    var day = Math.floor(diff / 86400000);
    var rest = diff - day * 86400000;
    var h = Math.floor(rest / 3600000);
    var m = Math.floor((rest % 3600000) / 60000);
    var s = Math.floor((rest % 60000) / 1000);
    var dEl = document.getElementById('cd-d');
    var hEl = document.getElementById('cd-hms');
    if (dEl) dEl.textContent = day;
    if (hEl) hEl.textContent = pad(h) + ':' + pad(m) + ':' + pad(s);
    return true;
  }

  function start() {
    injectStyle();
    var bar = build();
    document.body.insertBefore(bar, document.body.firstChild);
    var nums = document.getElementById('cd-nums');
    if (tick(nums)) {
      // 每秒走一次；页面在后台时浏览器会自动降频，无需额外处理
      setInterval(function () { if (!tick(nums)) clearInterval(this); }, 1000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
