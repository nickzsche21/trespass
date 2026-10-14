import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
const root = path.resolve(__dirname, ".."), dist = path.join(root, "dist");
async function main() {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  for (const [entry, out] of [["src/app.ts", "app.js"], ["src/worker.ts", "worker.js"]]) {
    await build({ entryPoints: [path.join(root, entry)], bundle: true, minify: true, format: "iife", target: "es2020", outfile: path.join(dist, out) });
  }
  for (const f of ["index.html", "style.css"]) fs.copyFileSync(path.join(root, f), path.join(dist, f));
  const kb = (f: string) => `${(fs.statSync(path.join(dist, f)).size / 1024).toFixed(0)} KB`;
  console.log(`dist: app.js ${kb("app.js")}, worker.js ${kb("worker.js")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
