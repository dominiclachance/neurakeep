import { expect, test } from "@playwright/test";

test("NeuraKeep routed React app core flows", async ({ page }) => {
  await page.goto("/index.html");
  await expect(page.getByRole("heading", { name: "NeuraKeep", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByText("Explore", { exact: true })).toBeVisible();
  await expect(page.getByText("Workflow", { exact: true })).toBeVisible();
  await expect(page.getByText("System", { exact: true })).toBeVisible();
  await expect(page.getByTestId("sigma-graph")).toBeVisible();
  await expect(page.locator(".toolbar input")).toHaveValue("");
  await expect(page.getByText("Keyboard node list")).toBeVisible();
  await page.screenshot({ path: "test-results/neurakeep-graph-react.png", fullPage: true });

  await page.locator(".toolbar input").fill("NeuraKeep");
  await page.locator(".toolbar").getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Search Results" })).toBeVisible();
  await page.evaluate(() => {
    const preview = document.createElement("div");
    preview.className = "citationPreview open";
    preview.textContent = "Floating preview";
    preview.style.cssText = "position:fixed;left:45%;top:35%;width:320px;height:160px;z-index:35;background:red;";
    document.body.appendChild(preview);
  });
  await expect.poll(async () => page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;
    const rect = dialog.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(top?.closest('[role="dialog"]'));
  })).toBe(true);
  await page.screenshot({ path: "test-results/neurakeep-search-modal-react.png", fullPage: true });
  await page.getByRole("button", { name: "Close" }).click();
  await page.locator(".citationPreview").evaluateAll((elements) => elements.forEach((element) => element.remove()));

  await page.getByRole("button", { name: "Props" }).click();
  await expect(page.getByRole("heading", { name: "Proposal Inbox" })).toBeVisible();
  await page.screenshot({ path: "test-results/neurakeep-proposals-react.png", fullPage: true });

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("Auth / User")).toBeVisible();
  await page.getByLabel("Display name").fill("QA NeuraKeep User");
  const saveResponse = page.waitForResponse((response) =>
    response.url().includes("/api/auth/settings") && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Save auth settings" }).click();
  expect((await saveResponse).ok()).toBe(true);
  await expect(page.getByLabel("Display name")).toHaveValue("QA NeuraKeep User");
  await page.screenshot({ path: "test-results/neurakeep-settings-react.png", fullPage: true });
});

test("routes stay viewport locked with no minimap", async ({ page }) => {
  await page.goto("/index.html#graph");

  const routes = [
    { hash: "graph", marker: '[data-testid="sigma-graph"]' },
    { hash: "search", marker: 'h2:has-text("Search")' },
    { hash: "inbox", marker: 'h2:has-text("Inbox")' },
    { hash: "proposals", marker: 'h2:has-text("Proposal Inbox")' },
    { hash: "connect", marker: 'h2:has-text("MCP Connection")' },
    { hash: "activity", marker: 'h2:has-text("Activity")' },
    { hash: "quality", marker: 'h2:has-text("Quality")' },
    { hash: "settings", marker: 'h2:has-text("Settings")' }
  ];

  for (const route of routes) {
    await page.goto(`/index.html#${route.hash}`);
    await expect(page.locator(route.marker).first()).toBeVisible();
    await expect(page.locator(".minimap, #miniMap, [data-testid='minimap']")).toHaveCount(0);
    await expect.poll(async () => page.evaluate(() => {
      const html = document.documentElement;
      const body = document.body;
      const aside = document.querySelector("aside");
      return {
        htmlOverflow: getComputedStyle(html).overflow,
        bodyOverflow: getComputedStyle(body).overflow,
        bodyScrollHeight: body.scrollHeight,
        bodyClientHeight: body.clientHeight,
        bodyScrollWidth: body.scrollWidth,
        bodyClientWidth: body.clientWidth,
        asideOverflow: aside ? getComputedStyle(aside).overflow : "",
        route: document.querySelector(".app")?.getAttribute("data-route")
      };
    })).toEqual({
      htmlOverflow: "hidden",
      bodyOverflow: "hidden",
      bodyScrollHeight: 950,
      bodyClientHeight: 950,
      bodyScrollWidth: 1440,
      bodyClientWidth: 1440,
      asideOverflow: "hidden",
      route: route.hash
    });
  }
});

test("GA4 CTA events fire on hosted app interactions", async ({ page }) => {
  await page.addInitScript(() => {
    const events: unknown[][] = [];
    (window as unknown as { __gaEvents: unknown[][] }).__gaEvents = events;
    (window as unknown as { gtag: (...args: unknown[]) => void }).gtag = (...args: unknown[]) => {
      events.push(args);
    };
  });
  await page.goto("/index.html");
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();

  await page.getByRole("button", { name: "Inbox" }).click();
  await page.getByRole("button", { name: "Import first-run sample" }).click();
  await expect.poll(async () => page.evaluate(() =>
    (window as unknown as { __gaEvents: unknown[][] }).__gaEvents
      .filter((entry) => entry[0] === "event")
      .map((entry) => entry[1])
  )).toContain("demo_sample_import_click");

  await page.getByRole("button", { name: "Log out" }).click();
  await expect.poll(async () => page.evaluate(() =>
    (window as unknown as { __gaEvents: unknown[][] }).__gaEvents
      .filter((entry) => entry[0] === "event")
      .map((entry) => entry[1])
  )).toContain("hosted_logout_click");

  const payload = await page.evaluate(() =>
    (window as unknown as { __gaEvents: unknown[][] }).__gaEvents
      .find((entry) => entry[1] === "demo_sample_import_click")?.[2]
  );
  expect(payload).toMatchObject({ section: "inbox", app_surface: "hosted_app" });
});
