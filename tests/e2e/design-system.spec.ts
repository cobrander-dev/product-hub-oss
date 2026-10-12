import { expect } from "@playwright/test";
import { test } from "../support/diagnostic-test";
import axeCore from "axe-core";

const axeSource = axeCore.source;

const viewports = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
] as const;

test("design system showcase responds without horizontal overflow", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Exact viewport matrix runs once in Chromium.",
  );

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/design-system");
    await expect(
      page.getByRole("heading", { name: "让数据安静地成为主角" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();

    const desktopTable = page.getByRole("table", {
      name: "产品数据表视觉示例",
    });
    if (viewport.width < 768) {
      await expect(desktopTable).toBeHidden();
      await expect(page.getByText("恒温淋浴系统").last()).toBeVisible();
    } else {
      await expect(desktopTable).toBeVisible();
    }
  }
});

test("dialog, sheet, tabs and toast have usable interaction states", async ({
  page,
}) => {
  await page.goto("/design-system");
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "打开 Dialog" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "确认更新资料？" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.getByRole("button", { name: "打开 Sheet" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "关闭导航" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.getByRole("tab", { name: "错误" }).click();
  await expect(page.getByText("暂时无法载入")).toBeVisible();

  await page.getByRole("button", { name: "显示 Toast" }).click();
  await expect(page.getByText("视觉状态已更新")).toBeVisible();
});

test("login and design system pass the WCAG AA axe baseline", async ({
  page,
}) => {
  for (const path of ["/login", "/design-system"]) {
    await page.goto(path);
    await page.addScriptTag({ content: axeSource });
    const violations = await page.evaluate(async () => {
      const axe = (
        window as typeof window & {
          axe: {
            run: (options: { runOnly: string[] }) => Promise<{
              violations: Array<{
                id: string;
                impact: string | null;
                nodes: Array<{ target: string[]; failureSummary: string }>;
              }>;
            }>;
          };
        }
      ).axe;
      const result = await axe.run({
        runOnly: ["wcag2a", "wcag2aa", "wcag22aa"],
      });
      return result.violations.map(({ id, impact, nodes }) => ({
        id,
        impact,
        nodes: nodes.map(({ target, failureSummary }) => ({
          target,
          failureSummary,
        })),
      }));
    });
    expect(violations, `${path} accessibility violations`).toEqual([]);
  }
});

test("reduced motion preference suppresses non-essential motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/design-system");
  const duration = await page
    .getByRole("button", { name: "主要操作" })
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.00001);
});
