import { query } from "../server/lib/db.js";
import { createAuctionsHandler } from "../server/lib/handler.js";
import { createStore } from "../server/lib/store.js";

export default createAuctionsHandler({
  store: createStore(query),
  token: process.env.SYNC_TOKEN,
  viewToken: process.env.VIEW_TOKEN,
});
