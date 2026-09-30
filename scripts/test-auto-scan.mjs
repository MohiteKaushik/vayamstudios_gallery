import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";

const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.env.GALLERY_TEST_URL ?? "http://127.0.0.1:8788";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const errors = [];
const requests = [];
let onboarded = true;
const scans = new Map([
  ["day-one", { scannedAt: 1, hits: [hit("day-one", "one")], possible: [] }],
]);

try {
  await mkdir(".test-output", { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = (json, status = 200) => route.fulfill({ json, status });
    if (url.pathname === "/api/me") return reply({
      id: "auto-scan-member", email: "member@example.test", fullName: "Test Member", phone: "",
      role: "member", onboarded, createdAt: 0, lastSignInAt: 0,
    });
    if (url.pathname === "/api/collections") return reply({ collections: [
      { id: "day-one", name: "Day 1", photoCount: 1 },
      { id: "day-two", name: "Day 2", photoCount: 1 },
      { id: "day-three", name: "Day 3", photoCount: 1 },
      { id: "empty", name: "Empty", photoCount: 0 },
    ] });
    if (url.pathname.startsWith("/api/scan/") && request.method() === "GET") {
      return reply(scans.get(url.pathname.slice(10)) ?? { scannedAt: 0, hits: [], possible: [] });
    }
    if (url.pathname === "/api/scan" && request.method() === "POST") {
      const body = request.postDataJSON();
      requests.push(body);
      assert.equal(body.background, true);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const result = { scannedAt: Date.now(), hits: [hit(body.collectionId, body.collectionId)], possible: [] };
      scans.set(body.collectionId, result);
      return reply(result);
    }
    return reply({ error: "Not in isolated fixture" }, 404);
  });
  const page = await context.newPage();
  await page.goto(base + "/photos");
  await page.getByRole("heading", { name: "Photos of you" }).waitFor();
  await page.getByText("3 photos", { exact: true }).waitFor();
  await page.screenshot({ path: ".test-output/auto-scan-desktop.png", fullPage: true, animations: "disabled" });
  assert.deepEqual(requests.map((request) => request.collectionId).sort(), ["day-three", "day-two"]);
  assert.equal(await page.getByRole("img").count() >= 3, true);
  await page.reload();
  await page.getByText("3 photos", { exact: true }).waitFor();
  assert.equal(requests.length, 2, "saved scans must not run again");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: ".test-output/auto-scan-mobile.png", fullPage: true, animations: "disabled" });
  onboarded = false;
  const firstTime = await context.newPage();
  await firstTime.goto(base + "/photos");
  await firstTime.getByRole("button", { name: "Add reference photo" }).waitFor();
  await firstTime.getByRole("button", { name: "Add reference photo" }).click();
  await firstTime.getByRole("dialog", { name: "Add a reference photo of yourself" }).waitFor();
  assert.equal(await firstTime.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log("Automatic member scanning passed: all populated events, cached results reused, background requests, progressive Photos results and mobile layout.");
} finally {
  await browser.close();
}

function hit(collectionId, photoId) {
  return {
    photoId, fileName: `${photoId}.jpg`, confidence: 0.95, hops: 0, width: 1200, height: 800,
    thumbUrl: "/vayam-logo-white.png", fullUrl: `/media/p/${collectionId}/${photoId}`,
  };
}
