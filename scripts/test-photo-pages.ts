import assert from "node:assert/strict";
import { stablePhotoPages } from "../src/lib/photo-pages.ts";

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
