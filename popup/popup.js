import { applyCapture } from "../src/dedup.js";
import { loadDb, requestSync, saveDb } from "../src/storage.js";

const statusEl = document.getElementById("status");
const totalsEl = document.getElementById("totals");
const captureBtn = document.getElementById("capture");
const syncEl = document.getElementById("sync");

function showStatus(html, kind = "") {
  statusEl.hidden = false;
  statusEl.className = `status ${kind}`;
  statusEl.innerHTML = html;
}

async function showTotals() {
  const db = await loadDb();
  totalsEl.textContent = `${db.auctions.length} auctions stored from ${db.captures.length} captures.`;
}

captureBtn.addEventListener("click", async () => {
  captureBtn.disabled = true;
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const [injection] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["/src/parser.js"],
    });
    const capture = injection && injection.result;
    if (!capture || !capture.tables.length) {
      showStatus("No auction list found. Open <b>Auctions → Your bids</b> and try again.", "error");
      return;
    }
    if (!capture.tables.some((t) => t.rows.length)) {
      showStatus("No finished auctions on this page – nothing stored.", "error");
      return;
    }

    capture.id = crypto.randomUUID();
    const db = await loadDb();
    const summary = applyCapture(db, capture);
    if (!summary.stored) {
      showStatus(
        `Nothing new on this page – not stored.<br><span class="muted">${summary.finished} finished auctions, all already known.</span>`,
        "ok",
      );
      return;
    }
    await saveDb(db);

    let html = `<b>${summary.added}</b> new, ${summary.duplicates} already known (${summary.finished} finished).<br>` +
      `<span class="muted">${summary.skippedRunning} still running – not stored.</span>`;
    if (summary.unordered) {
      html += "<br><span class=\"warn\">List isn't sorted by Finish, so duplicate detection is weaker. Sort by Finish for best results.</span>";
    }
    showStatus(html, "ok");
    await showTotals();
    await sync();
  } catch (e) {
    showStatus("", "error");
    statusEl.textContent = `Capture failed: ${e.message}`;
  } finally {
    captureBtn.disabled = false;
  }
});

async function sync() {
  syncEl.hidden = false;
  syncEl.className = "muted";
  syncEl.textContent = "Syncing…";
  const result = await requestSync();
  if (result.skipped) {
    syncEl.hidden = true;
  } else if (result.ok) {
    syncEl.textContent = result.downloaded ? `Synced – ${result.downloaded} captures from other PCs.` : "Synced.";
    await showTotals();
  } else {
    syncEl.className = "warn";
    syncEl.textContent = `Not synced (${result.error}). Saved here; it will retry next time.`;
  }
}

document.getElementById("stats").addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("stats/stats.html") });
  window.close();
});

showTotals();
