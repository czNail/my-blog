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
