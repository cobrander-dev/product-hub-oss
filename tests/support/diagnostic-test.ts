import { writeFile } from "node:fs/promises";
import { test as base } from "@playwright/test";
import {
  diagnosticPath,
  diagnosticRedactor,
  environmentSecrets,
} from "./diagnostic-redaction";

// Lazy page override: API-only tests do not gain an extra browser/page fixture.
export const test = base.extend({
  page: async ({ page }, provide, info) => {
    const secrets = environmentSecrets();
    const redact = diagnosticRedactor(secrets);
    const events: object[] = [];
    const start = performance.now();
    const requests = new WeakMap<object, number>();
    const add = (event: object) => {
      if (events.length < 10_000)
        events.push({ ms: Math.round(performance.now() - start), ...event });
    };
    page.on("request", (request) => {
      requests.set(request, performance.now());
      add({
        kind: "request",
        method: request.method(),
        path: diagnosticPath(request.url(), redact),
      });
    });
    page.on("response", (response) =>
      add({
        kind: "response",
        method: response.request().method(),
        path: diagnosticPath(response.url(), redact),
        status: response.status(),
        duration: Math.round(
          performance.now() -
            (requests.get(response.request()) ?? performance.now()),
        ),
      }),
    );
    page.on("requestfailed", (request) =>
      add({
        kind: "requestfailed",
        path: diagnosticPath(request.url(), redact),
      }),
    );
    page.on("console", (message) =>
      add({ kind: "console", level: message.type() }),
    );
    page.on("pageerror", () => add({ kind: "pageerror" }));
    page.on("dialog", (dialog) => add({ kind: "dialog", type: dialog.type() }));
    await provide(page);
    if (info.status === info.expectedStatus) return;
    add({
      kind: "result",
      status: info.status,
      path: diagnosticPath(page.url(), redact),
    });
    await writeFile(
      info.outputPath("safe-network.json"),
      JSON.stringify(events, null, 2),
      { mode: 0o600 },
    );
    if (page.isClosed()) return;
    // Mask both editable and read-only fields; also mask a known credential if
    // an error page accidentally renders it as ordinary text. No raw filmstrip.
    await page.screenshot({
      path: info.outputPath("safe-failure.png"),
      timeout: 5_000,
      mask: [
        page.locator("input,textarea,[contenteditable],pre,code"),
        ...secrets.map((secret) => page.getByText(secret, { exact: false })),
      ],
    });
  },
});
