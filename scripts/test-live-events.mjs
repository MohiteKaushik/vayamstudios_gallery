import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";

const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.env.GALLERY_TEST_URL ?? "http://127.0.0.1:8788";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const errors = [];
await mkdir(".test-output", { recursive: true });
try {
  // Exercise the actual routes with isolated API responses; never modify gallery data.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  let role = "admin";
  const events = [
    { id: "summit", name: "TTPOC Career Nexus 3.0", recent: true, live: false, collectionIds: ["day1", "day2"] },
    { id: "connect", name: "Ioniq Connect", recent: false, live: false, collectionIds: ["connect-day"] },
    { id: "archive", name: "Archive event", recent: true, live: false, collectionIds: ["archive-day"] },
  ];
  const folders = [
    { id: "day1", name: "TTPOC Day 1", showcaseEventId: "summit" },
    { id: "day2", name: "TTPOC Day 2", showcaseEventId: "summit" },
    { id: "connect-day", name: "Connect Day 1", showcaseEventId: "connect" },
    { id: "archive-day", name: "Archive Day 1", showcaseEventId: "archive" },
  ].map((folder) => ({ ...folder, photoCount: 1, description: null, coverUrl: "/vayam-logo-white.png" }));
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  await context.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const reply = (json, status = 200) => route.fulfill({ json, status });
    if (url.pathname === "/api/me") return reply({
      id: "test-admin", email: "admin@example.test", fullName: "Test admin", phone: "",
      role, onboarded: true, createdAt: 0, lastSignInAt: 0,
    });
    if (url.pathname === "/api/site/events") {
      if (req.method() === "PATCH") {
        const body = req.postDataJSON();
        Object.assign(events.find((event) => event.id === body.id), body);
      }
      return reply({ events });
    }
    if (url.pathname === "/api/collections") {
      if (req.method() === "POST") {
        const body = req.postDataJSON();
        const folder = { id: "new-day", name: body.name, showcaseEventId: body.eventId, photoCount: 0 };
        folders.push(folder);
        events.find((event) => event.id === body.eventId).collectionIds.push(folder.id);
        return reply(folder, 201);
      }
      const selected = events.find((event) => event.id === url.searchParams.get("event"));
      const matches = events.filter((event) =>
        (!url.searchParams.has("live") || event.live) &&
        (!url.searchParams.has("recent") || event.recent) &&
        (!selected || selected.id === event.id));
      return reply({ collections: folders.filter((folder) => matches.some((event) => event.id === folder.showcaseEventId)),
        ...(selected ? { event: selected } : {}) });
    }
    const photoMatch = url.pathname.match(/^\/api\/collections\/([^/]+)\/photos$/);
    if (photoMatch) return reply({ photos: photoMatch[1] === "new-day" ? [] : [{
      id: photoMatch[1] + "-photo", fileName: photoMatch[1] + ".jpg",
      width: 800, height: 600, thumbUrl: "/vayam-logo-white.png", fullUrl: "/vayam-logo-white.png",
      collectionId: photoMatch[1], createdAt: 0,
    }] });
    if (url.pathname === "/api/site/cover") return reply({ coverUrl: null });
    if (url.pathname === "/api/waiting") return reply({ waiting: [] });
    if (url.pathname === "/api/members") return reply({ members: [] });
    if (url.pathname === "/api/bin") return reply({ groups: [] });
    if (url.pathname.endsWith("/status")) return reply({ total: 1, indexed: 1, pending: 0 });
    return reply({ error: "Not in isolated fixture: " + url.pathname }, 404);
  });
  const page = await context.newPage();
  await page.goto(base + "/home");
  await page.getByRole("heading", { name: "Live Events", exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Open Live Event", exact: true }).getAttribute("target"), "_blank");
  for (const event of events.slice(0, 2)) {
    const toggle = page.getByRole("switch", { name: "Show " + event.name + " in live events", exact: true });
    await toggle.click();
    await page.waitForFunction((name) => [...document.querySelectorAll('[role="switch"]')]
      .some((el) => el.getAttribute("aria-label") === name && el.getAttribute("aria-checked") === "true"),
    "Show " + event.name + " in live events");
  }
  assert.equal(events[0].recent, true);
  assert.equal(events[1].recent, false);
  await page.screenshot({ path: ".test-output/live-admin-desktop.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  const connectToggle = page.getByRole("switch", { name: "Show Ioniq Connect in live events", exact: true });
  await connectToggle.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Show Ioniq Connect in live events"]')?.getAttribute("aria-checked") === "false");
  await connectToggle.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Show Ioniq Connect in live events"]')?.getAttribute("aria-checked") === "true");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: ".test-output/live-admin-mobile.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const popupPromise = context.waitForEvent("page");
  await page.getByRole("link", { name: "Open Live Event", exact: true }).click();
  const live = await popupPromise;
  await live.waitForURL("**/live-events");
  await live.getByRole("heading", { name: "Live Events", exact: true }).waitFor();
  for (const event of events.slice(0, 2)) await live.getByRole("button", { name: "Open " + event.name + " subfolders" }).waitFor();
  assert.equal(await live.getByRole("button", { name: "Open Archive event subfolders" }).count(), 0);
  assert.equal(await live.getByRole("button", { name: "Open TTPOC Day 1", exact: true }).count(), 0);
  await live.screenshot({ path: ".test-output/live-desktop.png", fullPage: true, animations: "disabled" });
  await live.getByRole("button", { name: "Open TTPOC Career Nexus 3.0 subfolders" }).click();
  await live.getByRole("button", { name: "Open TTPOC Day 1", exact: true }).waitFor();
  await live.getByRole("button", { name: "Open TTPOC Day 2", exact: true }).waitFor();
  assert.equal(await live.getByRole("button", { name: "Open Connect Day 1", exact: true }).count(), 0);
  await live.getByRole("button", { name: "Open TTPOC Day 1", exact: true }).click();
  await live.getByRole("heading", { name: "TTPOC Day 1", exact: true }).waitFor();
  assert.ok(live.url().includes("/live-events?"));
  await live.getByRole("button", { name: "Add subfolder", exact: true }).click();
  await live.getByLabel("Subfolder name", { exact: true }).fill("TTPOC Day 3");
  await live.getByRole("button", { name: "Create subfolder", exact: true }).click();
  await live.getByRole("heading", { name: "TTPOC Day 3", exact: true }).waitFor();
  assert.ok(live.url().includes("/live-events?"));
  assert.equal(folders.at(-1).showcaseEventId, "summit");
  // Returning to Recent Events must retain its independent selections.
  await live.goto(base + "/collections");
  await live.getByRole("button", { name: "Open Archive event subfolders" }).waitFor();
  assert.equal(await live.getByRole("button", { name: "Open Ioniq Connect subfolders" }).count(), 0);
  // Member layout, touch navigation and no horizontal overflow at narrow widths.
  role = "member";
  for (const width of [320, 390, 768, 1440]) {
    await live.setViewportSize({ width, height: 900 });
    await live.goto(base + "/live-events");
    await live.getByRole("heading", { name: "Live Events", exact: true }).waitFor();
    assert.equal(await live.getByRole("button", { name: "New event", exact: true }).count(), 0);
    assert.equal(await live.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await live.screenshot({ path: ".test-output/live-member-" + width + ".png", fullPage: true, animations: "disabled" });
    await live.getByRole("button", { name: "Open TTPOC Career Nexus 3.0 subfolders" }).click();
    await live.getByRole("button", { name: "Open TTPOC Day 2", exact: true }).click();
    await live.getByRole("heading", { name: "TTPOC Day 2", exact: true }).waitFor();
    await live.getByRole("img", { name: "day2.jpg", exact: true }).waitFor();
    assert.equal(await live.getByRole("img", { name: "day1.jpg", exact: true }).count(), 0);
    assert.equal(await live.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  assert.deepEqual(errors, []);
  console.log("Live Events browser checks passed: admin multi-toggle, new-tab CTA, main events -> subfolders -> photos, subfolder creation, independent Recent Events, member access, desktop/mobile layout, no page errors.");
} finally {
  await browser.close();
}
