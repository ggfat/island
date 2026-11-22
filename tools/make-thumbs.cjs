// node tools/make-thumbs.cjs  (richiede "npx vite --port 5288" acceso nella cartella del progetto)
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "../src/components/PlanetDemo.jsx"), "utf8");
const SP = (n) => `/models/space/${n}.gltf`;
const paths = [];
for (const m of src.matchAll(/chars: (\[[^\]]*\][^\n]*),\n/g)) paths.push(...eval(m[1]));
(async () => {
  const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const p = await b.newPage();
  p.on("pageerror", (e) => console.log("errore pagina:", e.message));
  await p.goto("http://localhost:5288/tools/thumbs.html");
  await p.waitForFunction(() => window.ready, null, { timeout: 120000 });
  for (const pt of paths) {
    const data = await p.evaluate((x) => window.renderThumb(x), pt);
    const out = path.join(__dirname, "../public/models/thumbs", path.basename(pt).replace(/\.gltf$/, ".webp"));
    fs.writeFileSync(out, Buffer.from(data.split(",")[1], "base64"));
    console.log("ok", path.basename(out));
  }
  await b.close();
})();
