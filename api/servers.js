import { query } from "../server/lib/db.js";
import { createServersHandler } from "../server/lib/handler.js";
import { createStore } from "../server/lib/store.js";

export default createServersHandler({ store: createStore(query), token: process.env.SYNC_TOKEN });
