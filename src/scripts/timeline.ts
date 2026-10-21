let disposeTimeline: (() => void) | undefined;

function initTimelines() {
  disposeTimeline?.();
  const controller = new AbortController();
  const { signal } = controller;
  const observers: { disconnect(): void }[] = [];
  const animations = new Set<Animation>();
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

  document
    .querySelectorAll<HTMLElement>("[data-article-timeline]")
    .forEach(root => {
      const entries = Array.from(
        root.querySelectorAll<HTMLElement>("[data-timeline-entry]")
      );
      let current: HTMLElement | null = null;
      function activate(entry: HTMLElement | null) {
        current = entry?.closest<HTMLDetailsElement>("details")?.open
          ? entry
          : null;
        entries.forEach(item =>
          item.classList.toggle("is-active", item === current)
        );
        root
          .querySelectorAll<HTMLElement>("[data-timeline-track]")
          .forEach(track => {
            const line = track.querySelector<HTMLElement>(
              ".timeline-active-line"
            )!;
            if (!current || !track.contains(current)) {
              line.style.height = "0px";
              return;
            }
            const nodeOffset = window.matchMedia("(max-width: 600px)").matches
              ? 22.5
              : 29.5;
            line.style.height = `${Math.max(0, current.getBoundingClientRect().top - track.getBoundingClientRect().top + nodeOffset - 10)}px`;
          });
      }
      entries.forEach(entry => {
        entry.addEventListener("pointerenter", () => activate(entry), {
          signal,
        });
        entry.addEventListener(
          "pointerleave",
          () => {
            if (!entry.contains(document.activeElement)) activate(null);
          },
          { signal }
        );
        entry.addEventListener("focusin", () => activate(entry), { signal });
      });
      root.addEventListener(
        "focusout",
        () => {
          queueMicrotask(() => {
            if (!signal.aborted)
              activate(
                document.activeElement?.closest<HTMLElement>(
                  "[data-timeline-entry]"
                ) ?? null
              );
          });
        },
        { signal }
      );
      root.querySelectorAll("details").forEach(details => {
        details.addEventListener("toggle", () => activate(current), { signal });
      });
      const resize = new ResizeObserver(() => activate(current));
      resize.observe(root);
      observers.push(resize);

      if (!motion.matches && "IntersectionObserver" in window) {
        const reveal = new IntersectionObserver(
          changes => {
            changes.forEach(change => {
              if (!change.isIntersecting) return;
              const entry = change.target as HTMLElement;
              if (entry.dataset.timelineRevealed) {
                reveal.unobserve(entry);
                return;
              }
              entry.dataset.timelineRevealed = "true";
              // Content is visible before JS and while waiting; animate only newly entered rows.
              if (!motion.matches) {
                const animation = change.target.animate(
                  [
                    { transform: "translateY(8px)", opacity: 0.6 },
                    { transform: "translateY(0)", opacity: 1 },
                  ],
                  { duration: 360, easing: "cubic-bezier(.2,.6,.2,1)" }
                );
                animations.add(animation);
                void animation.finished.then(
                  () => animations.delete(animation),
                  () => animations.delete(animation)
                );
              }
              reveal.unobserve(change.target);
            });
          },
          { threshold: 0.12 }
        );
        entries
          .filter(entry => !entry.dataset.timelineRevealed)
          .forEach(entry => reveal.observe(entry));
        observers.push(reveal);
      }
    });
  motion.addEventListener(
    "change",
    () => {
      if (motion.matches) animations.forEach(animation => animation.cancel());
    },
    { signal }
  );
  disposeTimeline = () => {
    controller.abort();
    observers.forEach(observer => observer.disconnect());
    animations.forEach(animation => animation.cancel());
    animations.clear();
  };
}

initTimelines();
document.addEventListener("astro:page-load", initTimelines);
document.addEventListener("astro:before-swap", () => disposeTimeline?.());
