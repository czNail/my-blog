import logo from './logo.mjs';
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const defaultTools = [
  { id: 'portfolio-pilot', name: '仓位助手', url: '/portfolio-pilot/', description: '记录大类仓位与目标比例，安排定投与再平衡。' },
  { id: 'totp', name: 'TOTP 验证器', url: '/totp/', description: '在浏览器本地加密保存账号，生成动态验证码。' },
];
const moon = '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>';
const sun = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>';
const icon = (path, name) => `<svg class="site-ui-${name}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

export function headerMarkup({ active = '', tools = defaultTools } = {}) {
  const current = section => active === section ? ' aria-current="page"' : '';
  const entries = tools.filter(tool => tool.url && tool.status !== 'planned').filter(tool => {
    try { const url = new URL(tool.url, 'https://cznail.github.io'); return url.protocol === 'https:'; } catch { return false; }
  }).map(tool => `<a href="${escape(tool.url)}" data-repository="${escape(tool.repository || tool.id || '')}"${current(tool.id)}><strong>${escape(tool.name)}</strong><small>${escape(tool.description || '')}</small></a>`).join('');
  return `<header class="site-ui-header"><div class="site-ui-inner"><a class="site-ui-brand" href="/" aria-label="木匠钉子，返回个人主页"><span class="site-ui-mark">${logo}</span><span>木匠钉子</span></a><nav class="site-ui-nav" aria-label="站点导航"><a href="/"${current('home')}>个人主页</a><a href="/#projects">项目</a><a href="/my-blog/"${current('blog')}>博客</a><details class="tools-menu"${active && !['home', 'blog'].includes(active) ? ' data-current-section="tools"' : ''}><summary>小工具</summary><div class="tools-popover"><div data-tools-list>${entries || '<p>暂时没有已发布的小工具。</p>'}</div><a href="/#tools">查看全部小工具 →</a></div></details><a href="https://github.com/czNail">GitHub ↗</a></nav><button class="site-ui-theme" type="button" data-site-theme aria-label="切换到深色主题" aria-pressed="false">${icon(moon, 'moon')}${icon(sun, 'sun')}</button></div></header>`;
}

export function footerMarkup({ year = new Date().getFullYear() } = {}) {
  return `<footer class="site-ui-footer"><a class="site-ui-footer-brand" href="/">木匠钉子 <span>/ Neil Chen</span></a><nav aria-label="页脚导航"><a href="/wechat/" data-wechat-open>公众号</a><a href="/my-blog/rss.xml">RSS</a><a href="https://github.com/czNail">GitHub ↗</a></nav><p>© ${escape(year)} Neil Chen</p></footer>`;
}
