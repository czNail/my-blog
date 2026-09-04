import type { CollectionEntry } from "astro:content";

// 只过滤草稿，不按 pubDatetime 过滤：
// 写好的文章不排队等"定时发布"，日期写哪天就哪天显示。
const postFilter = ({ data }: CollectionEntry<"blog">) => {
  return !data.draft;
};

export default postFilter;