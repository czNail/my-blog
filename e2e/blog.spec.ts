import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const btree = "posts/b-tree-里的重复-key-与旧记录的清理/";

test("timeline preserves publication dates, equal entries, native month disclosure and keyboard feedback", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator(".timeline-entry")).toHaveCount(8);
  await expect(page.locator("#featured")).toHaveCount(0);
  const october = page.locator(".timeline-month").first();
  await october.locator("summary").click();
  await expect(october).not.toHaveAttribute("open");
  await october.locator("summary").press("Enter");
  await expect(october).toHaveAttribute("open");
  const second = october.locator(".timeline-entry").nth(1);
  await second.locator("a").focus();
  await expect(second).toHaveClass(/is-active/);
  await expect.poll(() => page.locator(".timeline-active-line").first().evaluate(element => parseFloat((element as HTMLElement).style.height))).toBeGreaterThan(0);
  const href = await second.locator("a").getAttribute("href");
  await second.locator("a").press("Enter");
  await expect(page).toHaveURL(new RegExp(encodeURI(href!).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await expect(page.locator(".post-page h1")).toHaveCount(1);
  await page.goBack();
  await expect(page.locator(".timeline-entry")).toHaveCount(8);
});

test("automatic contents, section anchors, code copy and progress survive Astro navigation", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(btree);
  await expect(page.locator("h1")).toHaveCount(1);
  const toc = page.locator(".post-toc-desktop");
  await expect(toc).toBeVisible();
  const target = toc.locator("a").nth(4);
  const hash = await target.getAttribute("href");
  await target.click();
  await expect(page).toHaveURL(new RegExp(encodeURI(hash!).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await expect.poll(() => page.locator(`.post-toc-desktop a[href="${hash}"]`).getAttribute("aria-current")).toBe("location");
  await expect.poll(() => page.locator("[data-reading-progress]").evaluate(element => getComputedStyle(element).transform)).not.toBe("matrix(0, 0, 0, 1, 0, 0)");
  await page.locator(".code-block").first().scrollIntoViewIfNeeded();
  await page.locator("[data-copy-code]").first().click();
  await expect(page.locator("[data-copy-code]").first()).toHaveText("已复制");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("CREATE TABLE");
  expect(copied).not.toContain("复制");
  const permalink = await page.locator("#article h2").first().getAttribute("id");
  await page.goto(`${btree}#${permalink}`);
  await expect.poll(() => page.locator(`#${permalink}`).evaluate(element => Math.round(element.getBoundingClientRect().top))).toBeGreaterThanOrEqual(70);
  await expect.poll(() => page.locator(`#${permalink}`).evaluate(element => Math.round(element.getBoundingClientRect().top))).toBeLessThan(300);
  await page.locator(".article-pagination a").first().click();
  await expect(page.locator(".reading-progress")).toHaveCount(1);
  expect(await page.locator(".code-block").count()).toBe(await page.locator("[data-copy-code]").count());
  await page.goBack();
  await expect(page.locator(".post-heading h1")).toHaveText("B-tree 里的重复 Key 与旧记录的清理");
  await expect(page.locator(".reading-progress")).toHaveCount(1);
  expect(await page.locator(".heading-link").count()).toBe(await page.locator("#article h2[id], #article h3[id], #article h4[id], #article h5[id], #article h6[id]").count());
  await page.locator(".article-footer").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "回到顶部", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(5);
  expect(errors).toEqual([]);
});

test("all article pages fit a narrow screen; mobile contents closes after following a section", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await page.goto("archives/");
  const links = await page.locator(".timeline-title").evaluateAll(links => links.map(link => (link as HTMLAnchorElement).href));
  expect(links.length).toBeGreaterThan(0);
  await expect(page.locator(".timeline-entry").filter({ has: page.locator('.timeline-title[href*="heap-page-"]') }).locator("time")).toHaveText("10.01");
  for (const url of links) {
    await page.goto(url);
    await expect(page.locator("h1")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), url).toBe(true);
    expect(await page.locator("#article").innerText()).not.toBe("");
  }
  await page.goto(btree);
  const contents = page.locator(".post-toc-mobile");
  await contents.locator("summary").click();
  await expect(contents).toHaveAttribute("open");
  await contents.locator("a").nth(3).click();
  await expect(contents).not.toHaveAttribute("open");
  await page.locator("#article pre").first().scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("no-JavaScript reading and month disclosure work; reduced motion does not hide entries", async ({ browser }) => {
  const noJS = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 375, height: 900 } });
  const page = await noJS.newPage();
  await page.goto("http://127.0.0.1:4174/my-blog/archives/");
  expect(await page.locator(".timeline-entry").count()).toBeGreaterThan(0);
  const month = page.locator(".timeline-month").first();
  await month.locator("summary").click();
  await expect(month).not.toHaveAttribute("open");
  await page.goto(`http://127.0.0.1:4174/my-blog/${btree}`);
  await expect(page.locator("h1")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await noJS.close();
  const reduced = await browser.newContext({ reducedMotion: "reduce" });
  const reducedPage = await reduced.newPage();
  await reducedPage.goto("http://127.0.0.1:4174/my-blog/");
  await expect(reducedPage.locator(".timeline-entry").first()).toBeVisible();
  expect(await reducedPage.locator(".timeline-entry").evaluateAll(entries => entries.flatMap(entry => entry.getAnimations()).length)).toBe(0);
  await reduced.close();
});

test("clipboard denial gives feedback, and search still finds article content", async ({ page }) => {
  await page.goto(btree);
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } }); });
  await page.locator("[data-copy-code]").first().click();
  await expect(page.locator("[data-copy-code]").first()).toHaveText("复制失败");
  await expect(page.locator("[data-copy-status]").first()).toContainText("手动复制");
  await page.goto("search/?q=WAL");
  await expect(page.locator(".pagefind-ui__result").first()).toBeVisible();
  const result = page.locator(".pagefind-ui__result-title a").first();
  expect(new URL((await result.getAttribute("href"))!, page.url()).pathname).toMatch(/^\/my-blog\/posts\//);
  await result.click();
  await expect(page.locator(".post-page h1")).toBeVisible();
});

test("light and dark screenshots cover the timeline and reading layout on desktop and mobile", async ({ page }) => {
  await mkdir("artifacts/blog", { recursive: true });
  for (const width of [375, 1280]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto("./");
    await page.evaluate(theme => { localStorage.setItem("neil-homepage:theme", theme); }, theme);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.screenshot({ path: `artifacts/blog/timeline-${width}-${theme}.png`, fullPage: true, animations: "disabled" });
    await page.goto(btree);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.screenshot({ path: `artifacts/blog/reading-${width}-${theme}.png`, animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
});
