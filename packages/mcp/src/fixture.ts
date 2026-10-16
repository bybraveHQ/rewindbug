import type { Report } from "rewindbug";

export const fixture = {
  schemaVersion: 0,
  id: "0b7c4c1e-6a51-4c8e-9a3e-2f1d6b0c9e11",
  fingerprint: "f00dbabe",
  createdAt: 1_760_000_000_000,
  sdk: { name: "rewindbug", version: "0.0.1", rrwebVersion: "2.1.7" },
  trigger: { kind: "error", at: 1_760_000_000_000, message: "boom" },
  context: {
    url: "https://app.example/cart",
    title: "Cart",
    userAgent: "test",
    language: "en",
    timezone: "UTC",
    viewport: { width: 1280, height: 720, dpr: 1 },
  },
  range: {
    start: 1_759_999_970_000,
    end: 1_760_000_000_000,
    startUrl: "https://app.example/cart",
  },
  steps: [],
  stepsMarkdown: "Error: boom",
  test: 'import { test, expect } from "@playwright/test";\n',
  console: [],
  network: [],
  replay: null,
  limits: { truncated: [] },
} satisfies Report;
