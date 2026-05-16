import type { CollectionEntry } from "astro:content";
import { getBasePath } from "@/utils/getBasePath";

export const LANGS = ["en", "zh"] as const;
export type Lang = (typeof LANGS)[number];

export const defaultLang: Lang = "en";

export const ui = {
  en: {
    siteTitle: "Neil's Blog",
    siteDesc: "Neil Chen's personal blog.",
    homeTitle: "Hi, I'm Neil",
    homeDesc:
      "Welcome to Neil Chen's personal blog. This site is a small place for notes, experiments, and things worth writing down.",
    navPosts: "Posts",
    navTags: "Tags",
    navAbout: "About",
    navArchives: "Archives",
    navSearch: "Search",
    socialLinks: "Social Links:",
    featured: "Featured",
    recentPosts: "Recent Posts",
    allPosts: "All Posts",
    postsTitle: "Posts",
    postsDesc: "All the articles I've posted.",
    tagsTitle: "Tags",
    tagsDesc: "All the tags used in posts.",
    tagTitle: "Tag:",
    archivesTitle: "Archives",
    archivesDesc: "All the articles I've archived.",
    searchTitle: "Search",
    searchDesc: "Search any article ...",
    aboutTitle: "About",
    aboutBody: [
      "Hi, I'm Neil Chen.",
      "This is Neil's personal blog, built with Astro and AstroPaper.",
      "More notes will show up here over time.",
    ],
    previousPost: "Previous Post",
    nextPost: "Next Post",
    goBack: "Go back",
    sharePost: "Share this post on:",
  },
  zh: {
    siteTitle: "Neil 的博客",
    siteDesc: "Neil Chen 的个人博客。",
    homeTitle: "你好，我是 Neil",
    homeDesc:
      "欢迎来到 Neil Chen 的个人博客。这里会放一些笔记、实验，以及值得写下来的东西。",
    navPosts: "文章",
    navTags: "标签",
    navAbout: "关于",
    navArchives: "归档",
    navSearch: "搜索",
    socialLinks: "社交链接：",
    featured: "精选",
    recentPosts: "最近文章",
    allPosts: "全部文章",
    postsTitle: "文章",
    postsDesc: "这里是我发布的所有文章。",
    tagsTitle: "标签",
    tagsDesc: "文章使用的所有标签。",
    tagTitle: "标签：",
    archivesTitle: "归档",
    archivesDesc: "按时间归档的所有文章。",
    searchTitle: "搜索",
    searchDesc: "搜索文章 ...",
    aboutTitle: "关于",
    aboutBody: [
      "你好，我是 Neil Chen。",
      "这是 Neil 的个人博客，使用 Astro 和 AstroPaper 构建。",
      "之后会慢慢在这里放更多笔记。",
    ],
    previousPost: "上一篇",
    nextPost: "下一篇",
    goBack: "返回",
    sharePost: "分享这篇文章到：",
  },
} as const;

export function isLang(lang: string | undefined): lang is Lang {
  return LANGS.includes(lang as Lang);
}

export function getLangFromUrl(url: URL): Lang {
  const lang = url.pathname
    .replace(import.meta.env.BASE_URL.replace(/\/$/, ""), "")
    .split("/")
    .filter(Boolean)[0];

  return isLang(lang) ? lang : defaultLang;
}

export function getPostLang(post: CollectionEntry<"blog">): Lang {
  const lang = post.id.split("/")[0];
  return isLang(lang) ? lang : defaultLang;
}

export function getPostsByLang(posts: CollectionEntry<"blog">[], lang: Lang) {
  return posts.filter(post => getPostLang(post) === lang);
}

export function localizedPath(path: string, lang: Lang) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return getBasePath(`/${lang}${normalizedPath === "/" ? "" : normalizedPath}`);
}

export function getAlternateLang(lang: Lang): Lang {
  return lang === "zh" ? "en" : "zh";
}

export function getLanguageSwitchPath(pathname: string, lang: Lang) {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const relativePath = pathname.replace(base, "") || "/";
  const parts = relativePath.split("/").filter(Boolean);

  if (isLang(parts[0])) {
    parts[0] = lang;
  } else {
    parts.unshift(lang);
  }

  return getBasePath(`/${parts.join("/")}`);
}
