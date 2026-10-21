let disposeReading: (() => void) | undefined;

function initReading() {
  disposeReading?.();
  const page = document.querySelector<HTMLElement>(".post-page");
  const article = page?.querySelector<HTMLElement>("#article");
  if (!page || !article) return;
  const controller = new AbortController();
  const { signal } = controller;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let frame = 0;
  let active = "";
  let start = 0;
  let height = 0;
  let positions: { id: string; top: number }[] = [];
  const headings = Array.from(
    article.querySelectorAll<HTMLElement>(
      "h2[id], h3[id], h4[id], h5[id], h6[id]"
    )
  );
  const tocLinks = Array.from(
    page.querySelectorAll<HTMLAnchorElement>(".post-toc a")
  );
  const progress = page.querySelector<HTMLElement>("[data-reading-progress]");
  const topButton = page.querySelector<HTMLButtonElement>("[data-back-to-top]");
  headings.forEach(heading => {
    if (heading.querySelector(".heading-link")) return;
    const link = document.createElement("a");
    link.className = "heading-link";
    link.href = `#${heading.id}`;
    link.setAttribute("aria-label", `链接到：${heading.textContent}`);
    link.setAttribute("data-pagefind-ignore", "");
    link.textContent = "#";
    heading.append(link);
  });
  article.querySelectorAll<HTMLPreElement>("pre").forEach(pre => {
    const code = pre.querySelector("code");
    if (!code) return;
    let wrapper = pre.parentElement!;
    if (!wrapper.classList.contains("code-block")) {
      wrapper = document.createElement("div");
      wrapper.className = "code-block";
      pre.before(wrapper);
      wrapper.append(pre);
    }
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", "代码块，可横向滚动");
    let button = wrapper.querySelector<HTMLButtonElement>("[data-copy-code]");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "copy-code";
      button.dataset.copyCode = "";
      button.setAttribute("data-pagefind-ignore", "");
      wrapper.append(button);
    }
    button.textContent = "复制";
    button.disabled = false;
    let status = wrapper.querySelector<HTMLElement>("[data-copy-status]");
    if (!status) {
      status = document.createElement("span");
      status.className = "sr-only";
      status.dataset.copyStatus = "";
      status.setAttribute("aria-live", "polite");
      status.setAttribute("data-pagefind-ignore", "");
      wrapper.append(status);
    }
    const copyButton = button;
    const copyStatus = status;
    button.addEventListener(
      "click",
      async () => {
        copyButton.disabled = true;
        try {
          await navigator.clipboard.writeText(code.innerText);
          if (signal.aborted) return;
          copyButton.textContent = "已复制";
          copyStatus.textContent = "代码已复制到剪贴板";
        } catch {
          if (signal.aborted) return;
          copyButton.textContent = "复制失败";
          copyStatus.textContent = "无法访问剪贴板，请选中代码后手动复制";
        } finally {
          if (!signal.aborted) {
            copyButton.disabled = false;
            const timer = setTimeout(() => {
              copyButton.textContent = "复制";
              copyStatus.textContent = "";
              timers.delete(timer);
            }, 1800);
            timers.add(timer);
          }
        }
      },
      { signal }
    );
  });
  article.querySelectorAll<HTMLTableElement>("table").forEach(table => {
    if (table.parentElement?.classList.contains("table-scroll")) return;
    const wrapper = document.createElement("div");
    wrapper.className = "table-scroll";
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", "表格，可横向滚动");
    table.before(wrapper);
    wrapper.append(table);
  });
  function update() {
    frame = 0;
    const offset = window.matchMedia("(max-width: 700px)").matches ? 136 : 112;
    const range = Math.max(1, height - window.innerHeight + offset);
    const amount = Math.min(
      1,
      Math.max(0, (window.scrollY - start + offset) / range)
    );
    if (progress) progress.style.transform = `scaleX(${amount})`;
    if (topButton) topButton.hidden = window.scrollY < window.innerHeight;
    const selected =
      positions.findLast(heading => heading.top <= window.scrollY + offset + 24)
        ?.id ??
      positions[0]?.id ??
      "";
    if (selected !== active) {
      active = selected;
      tocLinks.forEach(link => {
        if (decodeURIComponent(link.hash.slice(1)) === selected)
          link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
    }
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }
  function measure() {
    start = window.scrollY + article!.getBoundingClientRect().top;
    height = article!.getBoundingClientRect().height;
    positions = headings
      .filter(heading => heading.matches("h2, h3"))
      .map(heading => ({
        id: heading.id,
        top: window.scrollY + heading.getBoundingClientRect().top,
      }));
    schedule();
  }
  topButton?.addEventListener(
    "click",
    () => {
      window.scrollTo({
        top: 0,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
    },
    { signal }
  );
  tocLinks.forEach(link =>
    link.addEventListener(
      "click",
      () => {
        const details = link.closest<HTMLDetailsElement>("details");
        if (details) details.open = false;
      },
      { signal }
    )
  );
  window.addEventListener("scroll", schedule, { passive: true, signal });
  window.addEventListener("resize", measure, { signal });
  const resize = new ResizeObserver(measure);
  resize.observe(page);
  void document.fonts.ready.then(() => {
    if (!signal.aborted) measure();
  });
  measure();
  disposeReading = () => {
    controller.abort();
    resize.disconnect();
    cancelAnimationFrame(frame);
    timers.forEach(timer => clearTimeout(timer));
  };
}

initReading();
document.addEventListener("astro:page-load", initReading);
document.addEventListener("astro:before-swap", () => disposeReading?.());
