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
4. **Open statistics** for per-item prices, top buyers, the auction list, and
   JSON/CSV export.

Only *finished* auctions are tracked. Running auctions are dropped while the page is
read and never stored, not even in the raw captures. The parser looks at them only to
see which way the list is sorted.

## How duplicates are detected

The game shows no auction id. An auction is identified by server + item + quantity +
price + buyer + bid count, **plus the finished auctions directly before and after it**
in the list. Sorted by finish time, finished auctions never change order, so those
neighbours stay the same. Two rows are treated as the same auction unless a neighbour
that is known in both differs. That keeps two identical sales (same buyer, same item,
same price) apart while still matching rows at page edges. If the list is sorted by
another column, neighbours are ignored and the popup warns you.

Every raw capture is kept, so **Rebuild from captures** can recompute everything,
for example after deleting a bad capture or importing data from another browser.

## Develop

```sh
npm install
npm test
```

`test/fixtures/your-bids.html` is a trimmed copy of a real "Your bids" page.
