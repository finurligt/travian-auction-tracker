# Travian Auction Tracker (Firefox)

Manually capture finished auctions from Travian's **Auctions → Your bids** list and
keep price statistics.

## Fair-play guarantees

- Nothing runs on the game page until you press **Capture** in the toolbar popup.
- The capture script (`src/parser.js`) only *reads* the DOM. It never clicks, types,
  scrolls, submits or changes anything, and it makes no network requests.
- Paging, sorting and reloading are always done by you, by hand.
- Data is stored in the extension's own storage, not on the game's site.

## Install (development)

1. Firefox → `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
2. Pick `manifest.json` in this folder.

Temporary add-ons are removed when Firefox restarts (the stored data stays as long as
the add-on ID is unchanged). To keep it installed permanently, sign it as an
unlisted add-on on addons.mozilla.org, or use Firefox Developer Edition with
`xpinstall.signatures.required = false`.

## Use

1. Open Auctions → Your bids. Keep it sorted by **Finish** (the default).
2. Click the toolbar icon → **Capture auctions on this page**.
3. Go to other pages of the list yourself and capture them too. Captures can be
   repeated as often as you like; duplicates are removed.
4. **Open statistics** for the price development chart, per-item prices, top buyers,
   the auction list, and JSON/CSV export.

The page shows no finish time, so each auction is dated by the **first capture that
showed it finished**. Capture regularly and the dates stay close to the real finish
times.

Only *finished* auctions are tracked. Running auctions are dropped while the page is
read and never stored, not even in the raw captures. The parser looks at them only to
see which way the list is sorted.

## Server age

Every auction records its game server (the page address, e.g.
`ts1.x1.europe.travian.com`) and that server's speed (`x1` = 1×). To compare price
trends by how old a server is, enter each server's rounds under
**Price by server age → Servers**: a start date (day 1) and the last day of the round.
Leave the end empty while a round is running. When a new server starts on the same
address, end the old round and add a new one.

Auctions that fall outside every round you've entered get no server day. That's
safer than counting them towards an old round. A round without an end that is
followed by another round ends where the next one starts.

The chart shows the median price per unit per server day, one line per round. Tick
"Scale days by server speed" to line up servers of different speeds. The CSV export
includes `speed`, `round` and `serverDay`.

The game page doesn't show a server's dates, so they have to be entered by hand. They
sync between PCs and show on the web version.

## How duplicates are detected

The game shows no auction id. An auction is identified by server + item + quantity +
price + buyer + bid count, **plus the finished auctions directly before and after it**
in the list. Sorted by finish time, finished auctions never change order, so those
neighbours stay the same. Two rows are treated as the same auction unless a neighbour
that is known in both differs. That keeps two identical sales (same buyer, same item,
same price) apart while still matching rows at page edges. If the list is sorted by
another column, neighbours are ignored and the popup warns you.

Page breaks move as new auctions finish, so the first and last row of a page are seen
with only one neighbour; a missing neighbour never counts as a mismatch. After every
capture all auctions are recomputed from all raw captures, starting with the rows that
had the most context (both neighbours visible). So a page-edge row gets assigned once
the full context is known, whichever order you captured the pages in.

One case can't be decided right away: two *identical* auctions where you have only
ever seen one at the top of a page and the other at the bottom of a different page.
They may be merged until a later capture shows either of them in the middle of a page.
That happens on its own as page breaks shift, and the counts then correct themselves.

Every raw capture is kept, so **Rebuild from captures** can recompute everything,
for example after deleting a bad capture or importing data from another browser.

## Sync between PCs and the web version (optional)

A small server (`api/` + `server/`, deployed on Vercel with a Neon Postgres database)
does two things:

- **Sync:** each PC with the extension uploads its new captures and downloads the ones
  made elsewhere, after every capture and whenever the statistics page opens. Captures
  never change, so they merge without conflicts. Deleting a capture while sync is on
  deletes it on all PCs.
- **Web version:** the same statistics page, read-only, at the server's address. Use it
  from your phone or any browser without the extension. It asks for a token once and
  remembers it.

The extension only ever talks to your own server, never to Travian.

### Deploy (Vercel + Neon)

1. Vercel → **Add New → Project** → import this repository. Keep the Root Directory at
   the repository root; `vercel.json` sets up the build. Deploy.
2. In the new project: **Storage → Create/Connect → Neon**, region **Frankfurt
   (eu-central-1)**, to match the function region in `vercel.json`. This adds
   `DATABASE_URL`. The table is created automatically on the first request.
3. **Settings → Environment Variables**, then redeploy:
   - `SYNC_TOKEN`: long random value (`openssl rand -base64 32`). Used by the extension;
     can read, add and delete.
   - `VIEW_TOKEN` (optional): another random value that can only *view* the statistics.
     Use this one on your phone so the write token stays on your PCs.
4. Check it: `curl -H "Authorization: Bearer <SYNC_TOKEN>" https://<project>.vercel.app/api/captures`
   should answer `{"captures":[],"next":0,"more":false}`.

### Connect each PC

On the statistics page, under **Data → Sync between PCs**, enter
`https://<project>.vercel.app` and the `SYNC_TOKEN`, then click **Save**. That PC's
existing captures are uploaded, and the other PCs' captures are downloaded.

The token is stored in the extension's local storage on each PC. It's never included in
JSON exports. To change it, set a new `SYNC_TOKEN` in Vercel, redeploy, and enter it on
each PC.

### Phone / any browser

Open `https://<project>.vercel.app` and enter the `VIEW_TOKEN` (or the `SYNC_TOKEN`).
On a phone, "Add to Home Screen" gives it an app-like icon. It shows whatever has been
synced; capture with the extension on a PC as usual.

## Develop

```sh
npm install
npm test            # extension, web page and server; server tests use an in-memory Postgres (PGlite)
npm run build:web   # web version into dist-web/ (Vercel runs this)
npm run package     # extension zip for addons.mozilla.org
```

`test/fixtures/your-bids.html` is a trimmed copy of a real "Your bids" page.
