// Builds travian-auction-tracker.zip for addons.mozilla.org, using Python's
// built-in zip tool. Python is called python3 on Linux/macOS but usually
// python or py on Windows, so try each.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const ZIP = "travian-auction-tracker.zip";
const FILES = ["manifest.json", "background", "icons", "popup", "src", "stats"];
const root = new URL("../", import.meta.url);

// The Windows Store shortcut named python3 exits with an error and prints
// nothing, so require an actual "Python 3.x" version answer.
const python = ["python3", "python", "py"].find((cmd) => {
  const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
  return r.status === 0 && /^Python 3\./.test(`${r.stdout}${r.stderr}`.trim());
});
if (!python) {
  console.error("Python 3 not found (tried python3, python, py). Install it, or zip the files by hand:");
  console.error(`  ${FILES.join(", ")}`);
  process.exit(1);
}

rmSync(new URL(ZIP, root), { force: true });
const r = spawnSync(python, ["-m", "zipfile", "-c", ZIP, ...FILES], { cwd: root, stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`Built ${ZIP} (using ${python})`);
