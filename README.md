# Neil's Blog

Neil Chen 的 Astro + AstroPaper 博客，部署在 GitHub Pages。

## 技术栈

- Astro 5
- AstroPaper
- Tailwind CSS
- Pagefind 搜索
- GitHub Pages 部署
- 默认浅色模式，支持手动切换深色

## 开发

```bash
pnpm install
pnpm run dev
```

## 构建

```bash
pnpm run build
pnpm run preview
```

## 内容

博客文章放在 `src/data/blog` 下。

站点配置在 `src/config.ts` 中。

## 部署

推送到 `main` 分支会自动触发 `.github/workflows/deploy.yml`，将 `dist` 发布到 GitHub Pages。

站点地址：

```text
https://cznail.github.io/my-blog/
```

## 共享站点样式

配色、字体、钉子标志、全站导航、页脚与深浅色切换来自 [主页仓库的 site-ui](https://github.com/czNail/cznail.github.io/tree/main/packages/site-ui)。`vendor/site-ui` 是自动生成的副本，`site-ui.lock.json` 记录来源提交和 SHA-256 校验值。不要直接编辑副本。

- 更新：`node scripts/sync-site-ui.mjs --update`；核验：`npm run check:site-ui`。
- 构建和开发前自动核验副本并生成本站的主题脚本、图标；上线后不依赖跨站脚本加载。
- 每日工作流检查上游更新，通过本项目构建后提出升级 PR；仓库需要允许 GitHub Actions 创建 PR。
- 共享改版先在主页仓库运行四站桌面/手机、浅色/深色检查并审查截图；本项目保留自己的业务布局与数据格式。

## 时间线与阅读体验

- 首页、文章分页、标签结果与归档复用 `ArticleTimeline.astro`。依据发表时间排序，使用文章时区（默认 Asia/Shanghai）生成年月和日期；更新旧文不会把它移动到时间线顶部。
- 首页展示最近 8 篇，文章分页每页数量及既有链接保持一致。所有文章使用相同样式，无封面或置顶精选要求。月份使用原生 details，关闭 JavaScript 仍可浏览、折叠与跳转。
- 时间线条目首次进入视野时轻微上移渐显；悬停和键盘聚焦突出节点与连线。减少动效设置下停用位移动画。内容默认可见，不依赖动画加载。
- 文章目录由现有二、三级标题生成；宽屏固定在正文右侧，手机使用折叠目录。原有 Markdown、标题锚点、文章地址和标签均保留。
- 调整正文段落、标题、引用、代码和表格排版；代码支持复制反馈与横向滚动，表格在自身容器内滚动。阅读进度以正文区域为范围，保留相邻文章与回到顶部入口。
- Markdown 首个一级标题与文章标题重复时，仅在渲染时省略重复标题，不修改原稿。文章脚本在 Astro 页面切换时清理监听器，避免重复按钮和进度条。
- 验证：`pnpm test`、`pnpm run lint`、`pnpm run format:check:changed`、`pnpm run build`；浏览器检查覆盖手机/桌面、深浅色、减少动效、目录锚点、代码复制、搜索和前进后退。
