---
author: Neil Chen
pubDatetime: 2026-05-16T02:15:00+08:00
title: Hello
description: A tiny test post that also demonstrates the article format.
tags:
  - others
---

Hello, this is Neil.

This is the English version of a small test post for the new blog. You can copy this file when writing a new post, update the metadata at the top, and replace the body with your own notes.

## Post Metadata

The block at the top of each post is called frontmatter:

```yaml
---
author: Neil Chen
pubDatetime: 2026-05-16T02:15:00+08:00
title: Post Title
description: A short summary shown in lists and RSS.
tags:
  - others
---
```

Common fields:

- `author`: the author name, usually `Neil Chen`
- `pubDatetime`: publish time, preferably `YYYY-MM-DDTHH:mm:ss+08:00`
- `title`: post title
- `description`: post summary
- `tags`: post tags; if omitted, the post uses `others`

## Writing The Body

Posts use Markdown. Write normal text as paragraphs, and leave a blank line between paragraphs.

### Headings

Use `##`, `###`, and `####` for section headings.

### Lists

Unordered list:

- First item
- Second item
- Third item

Ordered list:

1. First step
2. Second step
3. Third step

### Links

Links look like this:

```md
[Astro](https://astro.build/)
```

Rendered result: [Astro](https://astro.build/).

### Quotes

> This is a blockquote. It is useful for notes, excerpts, or a sentence you want to highlight.

### Code

Inline code uses backticks, like `pnpm run dev`.

Code blocks look like this:

```ts
const message = "Hello, Neil";
console.log(message);
```

### Images

If an image is stored at `public/images/example.png`, reference it like this:

```md
![Image description](/my-blog/images/example.png)
```

If the site later moves to a custom domain or root deployment, remove `/my-blog`.

## Suggested Structure

A post can follow this shape:

1. Explain what the post is about
2. Add background or context
3. Break the topic into sections
4. End with a summary or next steps

For a new English post, create a file here:

```text
src/data/blog/en/your-post.md
```

For the matching Chinese version, create:

```text
src/data/blog/zh/your-post.md
```
