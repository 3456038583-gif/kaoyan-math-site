/* 27 考研初试倒计时：2026-12-19 08:30（北京时间）
 * 自包含：自带样式，注入到 body 最上方，全站共用。
 * 只显示天数，不显示时分秒。
 */
(function () {
  var TARGET = new Date('2026-12-19T08:30:00+08:00');
  var LABEL = '27 考研初试';
  var DATE_TEXT = '2026.12.19';

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

  function build() {
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
      + '</div>';
    return bar;
  }

  function tick(numsRoot) {
    var diff = TARGET.getTime() - Date.now();
    if (diff <= 0) {
      numsRoot.innerHTML = '<span class="cd-done">已开考，稳住，能赢</span>';
      return false;
    }
    // 只显示天数：不足一天按 1 天计，避免出现「0 天」
    var day = Math.ceil(diff / 86400000);
    var dEl = document.getElementById('cd-d');
    if (dEl) dEl.textContent = day;
    return true;
  }

  function start() {
    injectStyle();
    var bar = build();
    document.body.insertBefore(bar, document.body.firstChild);
    var nums = document.getElementById('cd-nums');
    if (!nums) return;
    tick(nums);
    // 天级变化不需要每秒刷新，每分钟校准一次即可；回到前台时立刻校准
    setInterval(function () { tick(nums); }, 60000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) tick(nums);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
