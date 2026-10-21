/* Blocking, same-origin script: applies the shared preference before first paint. */
(() => {
  if (window.__siteUI) { window.__siteUI.refresh(); return; }
  const key = 'neil-homepage:theme';
  const legacyKeys = ['theme', 'portfolio-pilot:theme'];
  let theme = 'light';
  function preference() {
    try {
      for (const name of [key, ...legacyKeys]) {
        const value = localStorage.getItem(name);
        if (value === 'light' || value === 'dark') return value;
      }
    } catch { /* Keep the current tab usable when storage is disabled. */ }
    return theme;
  }
  function reflect() {
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('[data-site-theme]').forEach(button => {
      const label = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.setAttribute('aria-pressed', String(theme === 'dark'));
    });
    const background = getComputedStyle(document.documentElement).getPropertyValue('--site-bg').trim();
    if (background) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
  }
  function setTheme(value) {
    if (value !== 'light' && value !== 'dark') return;
    theme = value;
    try { localStorage.setItem(key, value); } catch { /* Theme still works in this tab. */ }
    reflect();
  }
  function refresh() { theme = preference(); reflect(); }
  function closeMenus(target, focus = false) {
    document.querySelectorAll('.site-ui-header details[open]').forEach(menu => {
      if (target && menu.contains(target)) return;
      menu.open = false;
      if (focus) menu.querySelector('summary')?.focus();
    });
  }
  window.__siteUI = { refresh, setTheme, getTheme: () => theme };
  theme = preference();
  // Migrate an old preference once; never touch tool data or account storage.
  setTheme(theme);
  document.addEventListener('DOMContentLoaded', refresh);
  document.addEventListener('astro:page-load', refresh);
  document.addEventListener('astro:after-swap', refresh);
  document.addEventListener('astro:before-swap', event => {
    event.newDocument.documentElement.dataset.theme = theme;
  });
  document.addEventListener('click', event => {
    if (event.target.closest('[data-site-theme]')) setTheme(theme === 'dark' ? 'light' : 'dark');
    if (event.target.closest('.site-ui-header .tools-popover a')) closeMenus();
  });
  document.addEventListener('pointerdown', event => closeMenus(event.target));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenus(null, true); });
  document.addEventListener('focusout', () => { setTimeout(() => closeMenus(document.activeElement), 0); });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) refresh();
  });
})();
