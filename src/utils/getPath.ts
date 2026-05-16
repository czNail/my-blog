import { BLOG_PATH } from "@/content.config";
import { defaultLang, isLang } from "@/i18n";
import { getBasePath } from "./getBasePath";
import { slugifyStr } from "./slugify";

/**
 * Get full path of a blog post
 * @param id - id of the blog post (aka slug)
 * @param filePath - the blog post full file location
 * @param includeBase - whether to include `/posts` in return value
 * @returns blog post path
 */
export function getPath(
  id: string,
  filePath: string | undefined,
  includeBase = true
) {
  const pathSegments = filePath
    ?.replace(BLOG_PATH, "")
    .split("/")
    .filter(path => path !== "") // remove empty string in the segments ["", "other-path"] <- empty string will be removed
    .filter(path => !path.startsWith("_")) // exclude directories start with underscore "_"
    .slice(0, -1) // remove the last segment_ file name_ since it's unnecessary
    .map(segment => slugifyStr(segment)); // slugify each segment path

  const lang = isLang(pathSegments?.[0]) ? pathSegments[0] : defaultLang;
  const localizedSegments = isLang(pathSegments?.[0])
    ? pathSegments?.slice(1)
    : pathSegments;
  const basePath = includeBase ? `/${lang}/posts` : "";

  // Making sure `id` does not contain the directory
  const blogId = id.split("/");
  const slug = blogId.length > 0 ? blogId.slice(-1) : blogId;

  // If not inside the sub-dir, simply return the file path
  if (!includeBase) {
    return !localizedSegments || localizedSegments.length < 1
      ? slug.join("/")
      : [...localizedSegments, ...slug].join("/");
  }

  const path =
    !localizedSegments || localizedSegments.length < 1
      ? [basePath, slug].join("/")
      : [basePath, ...localizedSegments, slug].join("/");

  return getBasePath(path);
}
