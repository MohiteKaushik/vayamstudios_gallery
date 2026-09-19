import assert from "node:assert/strict";
import { stablePhotoPages } from "../src/lib/photo-pages.ts";
import { layoutPhotos, photoAspectRatio } from "../src/lib/photo-layout.ts";

const first = { photos: [{ id: "old", createdAt: 1 }, { id: "older", createdAt: 0 }] };
const next = { photos: [{ id: "new", createdAt: 100 }, { id: "old", createdAt: 1 }] };
const input = [first, next];
const snapshot = JSON.stringify(input);
const pages = stablePhotoPages(input);
assert.deepEqual(pages[0], stablePhotoPages([first])[0]);
assert.deepEqual(pages.flatMap((page) => page.photos.map((photo) => photo.id)), ["old", "older", "new"]);
assert.equal(pages[1]?.offset, 2);
assert.equal(JSON.stringify(input), snapshot);
assert.deepEqual(stablePhotoPages(undefined), []);
assert.deepEqual(stablePhotoPages([{ photos: [] }, first, first, next]).map(({ key, offset }) => ({ key, offset })),
  [{ key: 1, offset: 0 }, { key: 3, offset: 2 }]);
assert.deepEqual(stablePhotoPages([{ photos: [{ id: "a" }, { id: "a" }] }])[0]?.photos, [{ id: "a" }]);
console.log("Photo pagination: stable append order, duplicates, empty pages, viewer offsets and immutability passed.");

const photos = Array.from({ length: 93 }, (_, i) => ({
  width: [400, 1200, 800, 250][i % 4]!,
  height: [1200, 600, 800, 1600][i % 4]!,
}));
for (const [width, columns] of [[358, 2], [850, 3], [1410, 4]] as const) {
  const firstLayout = layoutPhotos(photos.slice(0, 40), width, columns);
  const secondLayout = layoutPhotos(photos.slice(0, 80), width, columns);
  const finalLayout = layoutPhotos(photos, width, columns);
  assert.deepEqual(secondLayout.items.slice(0, 40), firstLayout.items, "Existing photos must never move on append");
  assert.deepEqual(finalLayout.items.slice(0, 80), secondLayout.items);
  assert.ok(finalLayout.height >= secondLayout.height);
  const columnBottoms = new Map<number, number>();
  for (const item of finalLayout.items) {
    const expectedTop = columnBottoms.has(item.left) ? columnBottoms.get(item.left)! + 12 : 0;
    assert.ok(Math.abs(item.top - expectedTop) < 0.001, "Every column must have only the normal 12px gap, including batch boundaries");
    columnBottoms.set(item.left, item.top + item.height);
    assert.ok(item.left >= 0 && item.left + item.width <= width + 0.001);
  }
  assert.equal(layoutPhotos([], width, columns).height, 0);
}
for (const value of [null, 0, -1, NaN, Infinity]) {
  assert.equal(photoAspectRatio({ width: value, height: 100 }), 3 / 4);
  assert.equal(photoAspectRatio({ width: 100, height: value }), 3 / 4);
}
console.log("Masonry: stable coordinates for 40/80/93 photos, gap-free column continuation, responsive widths, and missing dimensions passed.");
