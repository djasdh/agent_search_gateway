/** 三个后端共用的宽松 JSON 取值：外部数据不可信，全部返回 undefined 而不是抛错。 */

export type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 依次尝试多个字段名，返回第一个可用的原值。 */
export function pick(src: Json | undefined, ...keys: string[]): unknown {
  if (!src) return undefined;
  for (const key of keys) {
    const value = src[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function str(src: Json | undefined, ...keys: string[]): string | undefined {
  return asString(pick(src, ...keys));
}

export function num(src: Json | undefined, ...keys: string[]): number | undefined {
  const value = pick(src, ...keys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** 只要数字字段的 map，丢弃其余键。 */
export function numRecord(value: unknown): Record<string, number> | undefined {
  const src = asRecord(value);
  if (!src) return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(src)) {
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function strArray(value: unknown): string[] | undefined {
  const list = asArray(value)
    .map((item) => (typeof item === "string" ? item : asString(asRecord(item)?.name)))
    .filter((item): item is string => Boolean(item));
  return list.length > 0 ? list : undefined;
}

/** 从混杂输出里取最后一个 JSON 对象（yt-dlp 的 --dump-json）。 */
export function lastJsonObject(text: string): Json | undefined {
  for (const line of text.trim().split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return asRecord(JSON.parse(trimmed));
    } catch {
      /* 继续找上一行 */
    }
  }
  return undefined;
}
