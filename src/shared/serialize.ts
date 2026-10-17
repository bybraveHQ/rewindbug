import { filterUrlsInText, type UrlFilter } from "./url-filter.ts";

const MAX_DEPTH = 3;
const MAX_KEYS = 50;
const MAX_ARG_LENGTH = 1000;
const MAX_MESSAGE_LENGTH = 1000;

export const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const isElement = (value: object): value is Element =>
  typeof Element !== "undefined" && value instanceof Element;

const format = (
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): string => {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return depth === 0 ? value : JSON.stringify(value);
    case "undefined":
      return "undefined";
    case "function":
      return `[Function ${value.name || "anonymous"}]`;
    case "object":
      break;
    default:
      return String(value);
  }
  if (isElement(value)) return `<${value.tagName.toLowerCase()}>`;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? "[Array]" : "[Object]";
  seen.add(value);
  const next = (v: unknown) => format(v, depth + 1, seen);
  let out: string;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_KEYS).map(next);
    if (value.length > MAX_KEYS) items.push("…");
    out = `[${items.join(", ")}]`;
  } else {
    const keys = Object.keys(value);
    const pairs = keys
      .slice(0, MAX_KEYS)
      .map((key) => `${key}: ${next((value as Record<string, unknown>)[key])}`);
    if (keys.length > MAX_KEYS) pairs.push("…");
    out = `{${pairs.join(", ")}}`;
  }
  seen.delete(value);
  return out;
};

const piece = (arg: unknown): string => {
  try {
    return truncate(format(arg, 0, new WeakSet()), MAX_ARG_LENGTH);
  } catch {
    return "[Unserializable]";
  }
};

// console's format string, as browsers apply it: only when arguments follow;
// %c takes its css argument and prints nothing, a placeholder without an
// argument stays
const substitute = (args: readonly unknown[]): readonly unknown[] => {
  const [first, ...rest] = args;
  if (typeof first !== "string" || rest.length === 0) return args;
  let used = 0;
  const text = first.replace(/%([sdifoOc%])/g, (match, code: string) => {
    if (code === "%") return "%";
    if (used >= rest.length) return match;
    const arg = rest[used++];
    // String() takes a symbol where a template literal would throw
    return code === "c"
      ? ""
      : code === "f"
        ? String(parseFloat(String(arg)))
        : code === "d" || code === "i"
          ? String(parseInt(String(arg)))
          : piece(arg);
  });
  return [text, ...rest.slice(used)];
};

export const serializeArgs = (
  args: readonly unknown[],
  filter: UrlFilter,
): string => {
  const parts = substitute(args).map(piece);
  return truncate(
    filterUrlsInText(parts.join(" "), filter),
    MAX_MESSAGE_LENGTH,
  );
};
