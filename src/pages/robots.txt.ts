import type { APIRoute } from "astro";
import { SITE } from "@/config";
import { getBasePath } from "@/utils/getBasePath";

const getRobotsTxt = (sitemapURL: URL) => `
User-agent: *
Allow: /

Sitemap: ${sitemapURL.href}
`;

export const GET: APIRoute = ({ site }) => {
  const sitemapURL = new URL(
    getBasePath("sitemap-index.xml"),
    site ?? SITE.website
  );
  return new Response(getRobotsTxt(sitemapURL));
};
