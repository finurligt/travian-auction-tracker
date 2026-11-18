// Builds the read-only web version of the statistics page into dist-web/,
// which Vercel serves next to the API (see vercel.json).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const out = new URL("dist-web/", root);
const from = (p) => new URL(p, root);
const to = (p) => new URL(p, out);

rmSync(out, { recursive: true, force: true });
mkdirSync(to("src/"), { recursive: true });
cpSync(from("stats/"), to("stats/"), { recursive: true });
cpSync(from("icons/"), to("icons/"), { recursive: true });
for (const f of ["common.css", "dedup.js", "serverAge.js"]) cpSync(from(`src/${f}`), to(`src/${f}`));
cpSync(from("web/platform.js"), to("src/platform.js"));

// Serve the page at "/" instead of /stats/stats.html.
const html = readFileSync(from("stats/stats.html"), "utf8")
  .replaceAll('href="../', 'href="')
  .replace('href="stats.css"', 'href="stats/stats.css"')
  .replace('src="stats.js"', 'src="stats/stats.js"');
writeFileSync(to("index.html"), html);
console.log("Built dist-web/");
