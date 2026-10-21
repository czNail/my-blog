import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTimelinePosts, sortByPublication } from "../src/utils/timeline.ts";
import remarkReadingTitle from "../src/utils/remark-reading-title.mjs";

const post = (id: string, date: string, timezone?: string) => ({ id, data: { pubDatetime: new Date(date), timezone } });

test("month and year boundaries use the publication timezone, not the build server timezone", () => {
  const groups = groupTimelinePosts([
    post("new-year", "2027-01-01T00:00:00+08:00"),
    post("october", "2026-10-01T00:00:00+08:00"),
    post("september", "2026-09-30T23:59:59+08:00"),
  ], "Asia/Shanghai");
  assert.deepEqual(groups.map(group => [group.year, group.months.map(month => month.key)]), [["2027", ["2027-01"]], ["2026", ["2026-10", "2026-09"]]]);
  assert.equal(groups[1].months[0].entries[0].date.short, "10.01");
});

test("post-specific timezone and stable ordering are respected without mutating source data", () => {
  const posts = [post("z", "2026-10-01T00:00:00Z", "America/Los_Angeles"), post("a", "2026-10-01T00:00:00Z")];
  assert.deepEqual(sortByPublication(posts).map(post => post.id), ["a", "z"]);
  assert.deepEqual(posts.map(post => post.id), ["z", "a"]);
  const months = groupTimelinePosts(posts, "Asia/Shanghai")[0].months;
  assert.deepEqual(months.map(month => month.key), ["2026-10", "2026-09"]);
  assert.deepEqual(groupTimelinePosts([], "Asia/Shanghai"), []);
});

test("updating an old article does not move its publication in the timeline", () => {
  const old = { ...post("old", "2026-08-01T00:00:00+08:00"), data: { pubDatetime: new Date("2026-08-01T00:00:00+08:00"), modDatetime: new Date("2026-11-01T00:00:00+08:00") } };
  const recent = post("recent", "2026-10-01T00:00:00+08:00");
  assert.deepEqual(sortByPublication([old, recent]).map(post => post.id), ["recent", "old"]);
});

test("rendering removes only an opening title that repeats frontmatter", () => {
  const transform = remarkReadingTitle();
  const repeated = { children: [{ type: "heading", depth: 1, children: [{ value: "Shared Buffers 不是一个 Cache" }] }, { type: "paragraph", children: [{ value: "Keep the article." }] }] };
  transform(repeated, { data: { astro: { frontmatter: { title: "Shared Buffers 不是一个 Cache？" } } } });
  assert.equal(repeated.children.length, 1);
  const different = { children: [{ type: "heading", depth: 1, children: [{ value: "A distinct section" }] }] };
  transform(different, { data: { astro: { frontmatter: { title: "The post title" } } } });
  assert.equal(different.children.length, 1);
});
