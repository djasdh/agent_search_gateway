/** 请求类别匹配（文本源 / 反向图搜共用；不依赖 search service，避免循环导入）。 */

/** 请求类别里是否出现指定类别名（大小写不敏感，按逗号分隔）。 */
export function hasCategory(categories: string | undefined, name: string): boolean {
  const want = (name ?? "").trim().toLowerCase();
  if (!want) return false;
  return (categories ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .some((c) => c === want);
}
