---
author: Neil Chen
pubDatetime: 2026-05-16T02:15:00+08:00
title: 你好
description: 一篇用来打招呼，也用来展示文章格式的测试文章。
tags:
  - others
---

你好，我是 Neil。

这是新博客的一篇中文测试文章。之后写文章时，可以复制这篇文件，改掉最上面的信息，再把正文替换成自己的内容。

## 文章信息怎么写

每篇文章最上面这段叫 frontmatter：

```yaml
---
author: Neil Chen
pubDatetime: 2026-05-16T02:15:00+08:00
title: 文章标题
description: 文章摘要，会显示在列表和 RSS 里。
tags:
  - others
---
```

常用字段说明：

- `author`：作者名，通常写 `Neil Chen`
- `pubDatetime`：发布时间，建议用 `YYYY-MM-DDTHH:mm:ss+08:00`
- `title`：文章标题
- `description`：文章摘要
- `tags`：文章标签；不写时默认是 `others`

## 正文怎么写

正文使用 Markdown。普通段落直接写文字，中间空一行就会变成新段落。

### 小标题

用 `##`、`###`、`####` 创建不同层级的小标题。

### 列表

无序列表：

- 第一项
- 第二项
- 第三项

有序列表：

1. 第一步
2. 第二步
3. 第三步

### 链接

链接写法如下：

```md
[Astro 官网](https://astro.build/)
```

效果是：[Astro 官网](https://astro.build/)。

### 引用

> 这是一段引用。适合放摘录、提醒，或者想强调的一句话。

### 代码

行内代码用反引号，比如 `pnpm run dev`。

多行代码这样写：

```ts
const message = "Hello, Neil";
console.log(message);
```

### 图片

如果图片放在 `public/images/example.png`，文章里可以这样引用：

```md
![图片说明](/my-blog/images/example.png)
```

如果以后换成自定义域名或根路径部署，再把 `/my-blog` 去掉。

## 写作建议

一篇文章可以按这个结构来写：

1. 先说明这篇文章要解决什么问题
2. 再写背景或上下文
3. 然后分小节展开
4. 最后放总结或下一步

这篇文章就是一个起点。之后新建中文文章时，把文件放到：

```text
src/data/blog/zh/your-post.md
```

如果要写对应英文版，就放到：

```text
src/data/blog/en/your-post.md
```
