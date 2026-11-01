# 考研数学真题速查

2010–2026 年考研数学（数一 / 数二 / 数三）真题的离线速查网页：按年份、科目、难度筛选题目，标记关键题，维护错题本，并可直接查看对应年份的原卷与解析 PDF。

纯静态站点，无构建步骤、无后端依赖，双击 `index.html` 即可在本地使用。

线上地址：<https://math.feikntn111.us.ci>

## 功能

- **年份切换**：2010–2026，每年三科数据齐全才显示
- **科目切换**：数一 / 数二 / 数三
- **难度筛选**：常规 / 中档 / 难题 / 全部
- **关键题**：一键只看标记为重点的题目
- **错题本**：标记错题，数据存 `localStorage`（`file://` 下同样可用）
- **公式渲染**：KaTeX 本地化，离线可用
- **原卷对照**：题目卡片可打开对应年份的真题 / 解析 PDF
- **题型自动适配**：2021 年改革前后（8+6+9 与 10+6+6）分别呈现

## 目录结构

```
index.html        页面骨架与样式
app.js            渲染与交互逻辑
data.js           汇总入口 + 年份清单 + 按年懒加载器
dataYYYY.js       各年份题库（题目、考点、难度、答案要点）
metaYYYY.js       各年份元信息（试卷结构、分值）
pdfs/YYYY/        真题与解析 PDF（每年 m1/m2/m3 的 paper 与 sol，部分年份含 review）
pdfs/supplement/  补充题（试卷 + 解析）
figs/             题目配图
vendor/katex/     KaTeX（本地化，离线可用）
wrangler.jsonc    Cloudflare Workers 静态资源部署配置
```

## 性能

- **按年懒加载**：首屏只载入当前年份的题库，其余年份点选时再拉取（`data.js` 里的 `loadYear`），首屏脚本从 1.1MB / 36 个请求降到约 350KB / 5 个请求。
- **复用已渲染节点**：切回看过的年份时直接复用那份 DOM，不重建页面、不重排公式。
- **筛选不重建**：难度与「只看重点」只切换题目卡的显隐，不做整页重绘。
- **字体非阻塞**：Google Fonts 用 `media="print" onload` 异步加载，先用系统字体出字。
- **长缓存**：`_headers` 给 `pdfs/` 与 `vendor/` 设置一年期缓存。

## 本地运行

直接打开 `index.html` 即可。若想避免个别浏览器的本地文件限制，也可以起一个静态服务器：

```bash
python3 -m http.server 8000
# 浏览器访问 http://localhost:8000
```

## 部署

站点当前部署在 Cloudflare（Workers 静态资源）：

```bash
NODE_OPTIONS=--dns-result-order=ipv4first npx wrangler@latest deploy
```

> 这台机器上 Node 解析 IPv6 会导致 wrangler `fetch failed`，需要加 `--dns-result-order=ipv4first`。

自定义域名在 `wrangler.jsonc` 的 `routes` 中通过 `custom_domain: true` 绑定。

## 说明

- 仓库内的 PDF 经过压缩（ghostscript `/ebook`，补充题解析单独降至 115dpi/JPEG q62），以便通过托管平台的单文件体积限制；如需高清原卷请另行获取。
- 真题与解析 PDF 版权归原作者及出版方所有，本仓库仅用于个人学习与检索，请勿用于商业用途。题目文本、考点标注与网页代码为本项目整理成果。
