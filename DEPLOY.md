# Deploying

The app runs as a single Cloudflare Worker. It serves the interface as static
assets, which are free and unlimited, and handles photos, search and sign-in
itself.

## What must already exist

Both are already created on this account:

```sh
npx wrangler r2 bucket create vayam-photos
```

```sh
npx wrangler vectorize create vayam-faces --dimensions=128 --metric=euclidean
```

If either command says it already exists, that is the expected answer.

## The three secrets

These are **not** in the repository, and must not be. `.env` is gitignored and
only covers local development; production needs them set on the Worker.

| Secret | What it is |
|---|---|
| `SESSION_SECRET` | Signs the session cookie. Any long random string. Changing it signs everyone out. |
| `ADMIN_EMAIL` | The one address that gets the operator console. |
| `ADMIN_PASSWORD` | Its password. On first sign-in this creates the console account. |

`SESSION_SECRET` is not something to look up. It is generated once. There is
already one in your local `.env`, and you can either reuse that value or make a
fresh one:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Set all three. Each command prompts for the value, so nothing is written to your
shell history:

```sh
npx wrangler secret put SESSION_SECRET
```

```sh
npx wrangler secret put ADMIN_EMAIL
```

```sh
npx wrangler secret put ADMIN_PASSWORD
```

## Deploying from this machine

```sh
npx wrangler deploy
```

This publishes to `vayamstudios-gallery.<your-subdomain>.workers.dev`, which is
not your public domain. Test there first, then attach a custom domain in the
dashboard when you are satisfied.

## Deploying from GitHub instead

In the Cloudflare dashboard, under Workers, create a Worker connected to this
repository. Two things have to line up or the build fails:

- **The Worker name must be `vayamstudios-gallery`**, matching the `name` in
  `wrangler.jsonc`.
- **The root directory is the repository root.** `package.json`,
  `wrangler.jsonc` and `vite.config.ts` all sit there.

Build settings:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |

Secrets are set the same way, either with the commands above or under the
Worker's Settings, Variables and Secrets. **Secrets set through the CLI and
through the dashboard land in the same place**, so do it once, either way.

## After the first deploy

1. Open the `workers.dev` URL and sign in on the Admin console tab with
   `ADMIN_EMAIL` and `ADMIN_PASSWORD`. That first sign-in creates the account.
2. Create a collection and upload a handful of photos.
3. Wait about a minute. Vectorize applies writes asynchronously, so faces are
   not searchable the instant they upload. The app says so rather than claiming
   there are no matches.
4. Check the collection is ready:
   `GET /api/collections/{id}/status` reports photos, processed, withFaces,
   indexed and pending. `pending` should reach 0.
5. Prove the search works on your own photos:
   `POST /api/collections/{id}/selftest` takes a face already in the collection,
   searches with it, and checks it finds its own photo. If that passes, any
   later "no match" is a real answer about that person rather than a fault.

If a collection was uploaded while the index was unreachable, its faces are
still safe in R2 and can be put back into the index without re-uploading:

```sh
curl -X POST https://<your-worker>/api/collections/<id>/reindex
```

## After changing the recogniser

A face record in R2 holds the numbers one model produced, and those numbers
only mean anything to that model. When the recogniser changes, every stored
face has to be read again.

Open each event on the Live Event tab and press **Re-analyse**. It fetches each
photograph back from R2, looks at it again in your browser, and rewrites the
face record. Nothing is re-uploaded and no photograph changes. Keep the tab open
until it finishes; stopping half way is safe, and pressing it again picks up
where it left off.

Members who enrolled before the change are asked for a new reference photo the
next time they press Find me, rather than being silently matched against
nothing.

Check it worked:

```sh
curl -X POST https://<your-worker>/api/collections/<id>/selftest
```

It should say the search is working, and report a median distance near 0.9. A
median far below that means the collection still holds records from the old
recogniser.


## Local development is slower than production, deliberately

`npm run dev` reaches the real R2 bucket and the real Vectorize index across the
internet. That keeps local and production looking at the same data, which is
what you want when checking whether a photo actually uploaded, but every call
pays internet latency. A single sign-in has been measured between 1 and 21
seconds locally.

In production the Worker runs beside both services and those calls are
milliseconds. **Do not judge performance from local development.**

## A note on the public bucket

`vayam-photos` is set to public, so anything in it can be fetched by anyone who
knows an object key. The app does not rely on that: photos are served through
`/media/...`, which checks the session first. But the direct `r2.dev` URLs
bypass that check entirely.

Keys are random identifiers, so they are not guessable, but this is obscurity
rather than access control. If the collections hold photographs of identifiable
people at private events, making the bucket private again is the safer setting,
and nothing in the app breaks if you do.
