import assert from "node:assert/strict";
import { beginPhotoUpload, getActiveUploads } from "../src/lib/upload-activity.ts";

const collectionId = crypto.randomUUID();
const eventId = crypto.randomUUID();
const tracker = beginPhotoUpload({ collectionId, eventId, collectionName: "TTPOC Day 1", total: 3 });
assert.equal(getActiveUploads().length, 1);
assert.deepEqual(getActiveUploads()[0], {
  id: getActiveUploads()[0]!.id,
  collectionId,
  collectionName: "TTPOC Day 1",
  eventId,
  progress: {
    processed: 0, total: 3, faces: 0, indexed: 0, failed: 0,
    bytesIn: 0, bytesOut: 0, indexPending: 0,
  },
  startedAt: getActiveUploads()[0]!.startedAt,
});
const update = {
  processed: 1, total: 3, faces: 2, indexed: 2, failed: 0,
  bytesIn: 100, bytesOut: 120, indexPending: 0, current: "photo-2.jpg",
};
tracker.report(update);
update.processed = 99;
assert.equal(getActiveUploads()[0]!.progress.processed, 1, "Published progress is copied");
assert.equal(getActiveUploads()[0]!.progress.current, "photo-2.jpg");
assert.throws(
  () => beginPhotoUpload({ collectionId, collectionName: "Same folder", total: 1 }),
  /already uploading/,
);
tracker.finish();
tracker.finish();
assert.deepEqual(getActiveUploads(), []);
console.log("Upload activity: start, progress, immutable snapshot, duplicate prevention and completion passed.");
