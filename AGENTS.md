# Agent notes

This project is hosted on Cloudflare Workers. It is not connected to any
external editor or sync service, so its git history is ordinary and no special
constraints apply to rebasing or force pushing.

## Stack

- **App**: TanStack Start on Cloudflare Workers, built with the Cloudflare Vite plugin.
- **Photos**: R2 bucket, bound as `PHOTOS`.
- **Metadata**: D1 (SQLite), bound as `DB`.
- **Face index**: Vectorize, bound as `FACE_INDEX`, 128 dimensions, euclidean metric.

## Rules

- Face embeddings are generated in the browser and never leave as raw images.
  Keep it that way; the server only ever sees 128 floats.
- `MATCH_MAX_DISTANCE` in `src/lib/face.ts` is the single source of truth for
  the match threshold. The Vectorize query and any UI copy must read it from
  there rather than hardcoding a number.
- Never commit `.dev.vars`. Production values are Worker secrets.
