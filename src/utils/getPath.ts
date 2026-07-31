import { getBasePath } from "./getBasePath";
import { slugifyStr } from "./slugify";

export function getPath(
  id: string,
  _filePath?: string,
  includeBase = true
) {
  const slug = slugifyStr(id.replace(/\.md$/, "").split("/").pop() || id);
  if (!includeBase) return slug;
  return getBasePath(`/posts/${slug}`);
}
