import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";

const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.env.GALLERY_TEST_URL ?? "http://127.0.0.1:8788";
const ids = {
  event1: "00000000-0000-4000-8000-000000000001",
  event2: "00000000-0000-4000-8000-000000000002",
  photo1: "10000000-0000-4000-8000-000000000001",
  photo2: "10000000-0000-4000-8000-000000000002",
};
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const errors = [];
await mkdir(".test-output", { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await context.addInitScript(() => {
    window.__memberDownloadTest = { files: [], bytes: 0 };
    window.showDirectoryPicker = async () => ({
      getDirectoryHandle: async (folder) => {
        window.__memberDownloadTest.folder = folder;
        return {
          getDirectoryHandle: async () => { throw new Error("Unexpected nested folder"); },
          getFileHandle: async (name) => ({
            createWritable: async () => new WritableStream({
              write(chunk) {
                window.__memberDownloadTest.files.push(name);
                window.__memberDownloadTest.bytes += chunk.byteLength;
              },
            }),
          }),
          removeEntry: async () => {},
        };
      },
    });
  });
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  await context.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const reply = (json, status = 200) => route.fulfill({ json, status });
    if (url.pathname === "/api/me") return reply({
      id: "member-test", email: "member@example.test", fullName: "Test Member", phone: "",
      role: "member", onboarded: true, createdAt: 0, lastSignInAt: 0,
    });
    if (url.pathname === "/api/collections") return reply({ collections: [
      { id: ids.event1, name: "Day 1" }, { id: ids.event2, name: "Day 2" },
    ] });
    const scan = url.pathname.match(/^\/api\/scan\/(.+)$/)?.[1];
    if (scan === ids.event1) return reply({ scannedAt: 1, possible: [], facesSearched: 1, hits: [
      hit(ids.event1, ids.photo1, "portrait-one.jpg", 0.98),
      hit(ids.event1, ids.photo2, "portrait-two.jpg", 0.95),
    ] });
    if (scan === ids.event2) return reply({ scannedAt: 1, possible: [], facesSearched: 1, hits: [
      hit(ids.event2, ids.photo1, "another-event.jpg", 0.92),
    ] });
    return reply({ error: "Not in isolated fixture" }, 404);
  });
  await context.route("**/media/p/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/jpeg",
    body: Buffer.from([255, 216, 255, 224, 1, 2, 3, 255, 217]),
  }));
  const page = await context.newPage();
  await page.goto(base + "/photos");
  await page.getByRole("heading", { name: "Photos of you" }).waitFor();
  await page.getByText("3 photos", { exact: true }).waitFor();
  const button = page.getByRole("button", { name: "Download all", exact: true });
  await button.click();
  await page.getByRole("alertdialog").waitFor();
  await page.getByRole("heading", { name: "Review photos before sharing" }).waitFor();
  await page.getByText(/Some photos may include other attendees/).waitFor();
  await page.getByRole("button", { name: "Continue & download" }).click();
  await page.getByText("All 3 photos downloaded.", { exact: false }).waitFor();
  const saved = await page.evaluate(() => window.__memberDownloadTest);
  assert.equal(saved.files.length, 3);
  assert.ok(saved.bytes > 0);
  assert.match(saved.folder, /^Vayam-My-Photos-/);
  assert.equal(await page.evaluate(() => document.querySelector(".vite-error-overlay") !== null), false);
  assert.ok((await page.locator("body").innerText()).trim().length > 0);
  await page.screenshot({ path: ".test-output/member-download-desktop.png", fullPage: true, animations: "disabled" });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "Download all", exact: true }).click();
  await page.getByRole("alertdialog").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: ".test-output/member-download-mobile.png", fullPage: true, animations: "disabled" });
  assert.deepEqual(errors, []);
  console.log("Member download browser checks passed: top-right action, privacy warning, folder selection, three original files across two events, completion feedback, desktop/mobile layout, no page errors.");
} finally {
  await browser.close();
}

function hit(collectionId, photoId, fileName, confidence) {
  return {
    photoId, fileName, confidence, hops: 0, width: 1200, height: 800,
    thumbUrl: "/vayam-logo-white.png",
    fullUrl: `/media/p/${collectionId}/${photoId}`,
  };
}
