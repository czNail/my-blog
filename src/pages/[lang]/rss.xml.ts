import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import { getPath } from "@/utils/getPath";
import getSortedPosts from "@/utils/getSortedPosts";
import { SITE } from "@/config";
import { getPostsByLang, isLang, LANGS, ui } from "@/i18n";

export function getStaticPaths() {
  return LANGS.map(lang => ({ params: { lang } }));
}

export async function GET({ params }: { params: { lang?: string } }) {
  const lang = isLang(params.lang) ? params.lang : "en";
  const posts = getPostsByLang(await getCollection("blog"), lang);
  const sortedPosts = getSortedPosts(posts);
  const t = ui[lang];

  return rss({
    title: t.siteTitle,
    description: t.siteDesc,
    site: new URL(`${lang}/`, SITE.website).href,
    items: sortedPosts.map(({ data, id, filePath }) => ({
      link: getPath(id, filePath),
      title: data.title,
      description: data.description,
      pubDate: new Date(data.modDatetime ?? data.pubDatetime),
    })),
  });
}
