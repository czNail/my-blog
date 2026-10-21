import type { CollectionEntry } from "astro:content";
import postFilter from "./postFilter";
import { sortByPublication } from "./timeline";

const getSortedPosts = (posts: CollectionEntry<"blog">[]) => {
  return sortByPublication(posts.filter(postFilter));
};

export default getSortedPosts;
