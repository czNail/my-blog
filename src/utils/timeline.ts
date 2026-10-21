type PublishedPost = {
  id: string;
  data: { pubDatetime: Date; timezone?: string };
};

export function publicationDate(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)!.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  return {
    year,
    month,
    day,
    key: `${year}-${month}`,
    short: `${month}.${day}`,
    full: `${year}年${Number(month)}月${Number(day)}日`,
  };
}

export function sortByPublication<T extends PublishedPost>(posts: T[]): T[] {
  return [...posts].sort(
    (a, b) =>
      b.data.pubDatetime.getTime() - a.data.pubDatetime.getTime() ||
      a.id.localeCompare(b.id)
  );
}

export function groupTimelinePosts<T extends PublishedPost>(
  posts: T[],
  defaultTimezone: string
) {
  const years = new Map<
    string,
    Map<string, { post: T; date: ReturnType<typeof publicationDate> }[]>
  >();
  for (const post of sortByPublication(posts)) {
    const date = publicationDate(
      post.data.pubDatetime,
      post.data.timezone || defaultTimezone
    );
    if (!years.has(date.year)) years.set(date.year, new Map());
    const months = years.get(date.year)!;
    if (!months.has(date.key)) months.set(date.key, []);
    months.get(date.key)!.push({ post, date });
  }
  return [...years.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, months]) => ({
      year,
      months: [...months.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([key, entries]) => ({
          key,
          label: `${Number(entries[0].date.month)} 月`,
          entries,
        })),
    }));
}
