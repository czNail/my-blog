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
