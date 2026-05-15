const base = import.meta.env.BASE_URL.replace(/\/$/, "");

export function getBasePath(path = "/") {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (normalizedPath === "/") {
    return import.meta.env.BASE_URL;
  }

  return `${base}${normalizedPath}`;
}
