const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const {
  addStockEntry,
  install,
  restore,
} = require("../../scripts/update-digital-twin-navigation-vps.cjs");
// The VPS resolves TypeScript in the staged real frontend.
const ts = require(
  process.env.TRIANGLE_TEST_TYPESCRIPT ||
    "../../../frontend/node_modules/typescript",
);
test("Stocks entry is additive, idempotent and stays inside existing permission guards", () => {
  const source =
    '"use client"; export default function Stocks(){if(!canView) return <p>Refusé</p>; return <main><h1 className="x">Stocks</h1><section>LIVE CHANGES</section></main>}';
  const result = addStockEntry(source, ts);
  assert.ok(result.includes("Entrepôts — Vue 3D / 2D"));
  assert.ok(
    result.indexOf("if(!canView)") <
      result.indexOf('href="/stocks/digital-twin"'),
  );
  assert.equal(
    result.replace(/\n      <a href="\/stocks\/digital-twin".*?<\/a>\n/, ""),
    source,
  );
  assert.equal(addStockEntry(result, ts), result);
  assert.throws(
    () => addStockEntry(source.replace("Stocks</h1>", "Other</h1>"), ts),
    /unique/,
  );
  assert.throws(
    () =>
      addStockEntry(
        source.replace("<section>", "<h1>Stocks</h1><section>"),
        ts,
      ),
    /unique/,
  );
});
test("rollback restores module, single modified Stocks file and build at every rename boundary", () => {
  for (let stop = 0; stop <= 3; stop++) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "triangle-navigation-"));
    const tasks = [];
    try {
      for (let i = 0; i < 3; i++) {
        const t = {
          source: root + "/new" + i,
          live: root + "/live" + i,
          backup: root + "/old" + i,
          rejected: root + "/rejected" + i,
          started: false,
        };
        if (i === 1) {
          fs.writeFileSync(t.source, "NEW LINK");
          fs.writeFileSync(t.live, "LIVE STOCKS");
        } else {
          fs.mkdirSync(t.source);
          fs.mkdirSync(t.live);
          fs.writeFileSync(t.source + "/data", "new");
          fs.writeFileSync(t.live + "/data", "old");
        }
        tasks.push(t);
      }
      for (let i = 0; i < stop; i++) {
        tasks[i].started = true;
        install(tasks[i]);
      }
      if (stop < 3) {
        tasks[stop].started = true;
        fs.renameSync(tasks[stop].live, tasks[stop].backup);
      }
      for (const t of [...tasks].reverse()) restore(t);
      assert.equal(fs.readFileSync(tasks[1].live, "utf8"), "LIVE STOCKS");
      for (const i of [0, 2])
        assert.equal(fs.readFileSync(tasks[i].live + "/data", "utf8"), "old");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
