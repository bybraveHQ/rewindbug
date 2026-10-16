import type { Trigger, TriggerError } from "../types.ts";
import { serializeArgs } from "../shared/serialize.ts";
import { filterUrlsInText, type UrlFilter } from "../shared/url-filter.ts";

const MAX_MESSAGE_LENGTH = 1000;
const MAX_STACK_LENGTH = 8000;
const MAX_NAME_LENGTH = 200;
const SCRIPT_ERROR = "Script error.";
const MANUAL = "manual capture";

const clip = (text: string, max: number, filter: UrlFilter) =>
  filterUrlsInText(text, filter).slice(0, max);

const isErrorLike = (value: unknown): value is Error =>
  value instanceof Error ||
  (typeof value === "object" &&
    value !== null &&
    typeof (value as Error).name === "string" &&
    typeof (value as Error).message === "string");

export const toTriggerError = (
  value: unknown,
  filter: UrlFilter,
): TriggerError => {
  if (!isErrorLike(value)) {
    return {
      name: "NonError",
      message: clip(serializeArgs([value], filter), MAX_MESSAGE_LENGTH, filter),
    };
  }
  const error: TriggerError = {
    name: value.name.slice(0, MAX_NAME_LENGTH),
    message: clip(value.message, MAX_MESSAGE_LENGTH, filter),
  };
  if (typeof value.stack === "string")
    error.stack = clip(value.stack, MAX_STACK_LENGTH, filter);
  return error;
};

export const installErrorHandlers = (
  onTrigger: (trigger: Trigger) => void,
  filter: UrlFilter,
  now: () => number,
  reported: WeakSet<object>,
): (() => void) => {
  const onError = (event: Event) => {
    if (!(event instanceof ErrorEvent)) return;
    if (event.error !== undefined && event.error !== null) {
      const error = toTriggerError(event.error, filter);
      onTrigger({ kind: "error", at: now(), message: error.message, error });
      return;
    }
    const message = clip(
      event.message || SCRIPT_ERROR,
      MAX_MESSAGE_LENGTH,
      filter,
    );
    onTrigger({ kind: "error", at: now(), message });
  };
  const onRejection = (event: Event) => {
    const reason: unknown = (event as PromiseRejectionEvent).reason;
    // an uncaught failed fetch already became a network trigger
    if (typeof reason === "object" && reason !== null && reported.has(reason))
      return;
    const error = toTriggerError(reason, filter);
    onTrigger({
      kind: "unhandledrejection",
      at: now(),
      message: error.message,
      error,
    });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
};

export const manualTrigger = (
  value: unknown,
  filter: UrlFilter,
  at: number,
): Trigger => {
  if (value === undefined) return { kind: "manual", at, message: MANUAL };
  const error = toTriggerError(value, filter);
  return { kind: "manual", at, message: error.message, error };
};
