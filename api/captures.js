import { query } from "../server/lib/db.js";
import { createHandler } from "../server/lib/handler.js";
import { createStore } from "../server/lib/store.js";

export default createHandler({ store: createStore(query), token: process.env.SYNC_TOKEN });
