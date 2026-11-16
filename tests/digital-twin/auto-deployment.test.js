const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const {
  install,
  restore,
  snapshot,
} = require("../../scripts/update-digital-twin-auto-vps.cjs");
test("automatic-view release can be rolled back after each boundary, including a half-complete rename", () => {
  for (let stop = 0; stop <= 2; stop++) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "triangle-auto-"));
    const tasks = [];
    try {
      for (let i = 0; i < 2; i++) {
        const t = {
          source: root + "/new" + i,
          live: root + "/live" + i,
          backup: root + "/old" + i,
          rejected: root + "/rejected" + i,
          started: false,
        };
        fs.mkdirSync(t.source);
        fs.mkdirSync(t.live);
        fs.writeFileSync(t.source + "/data", "new");
        fs.writeFileSync(t.live + "/data", "old");
        tasks.push(t);
      }
      for (let i = 0; i < stop; i++) {
        tasks[i].started = true;
        install(tasks[i]);
      }
      if (stop < 2) {
        tasks[stop].started = true;
        fs.renameSync(tasks[stop].live, tasks[stop].backup);
      }
      for (const t of [...tasks].reverse()) restore(t);
      for (const t of tasks) {
        assert.equal(fs.readFileSync(t.live + "/data", "utf8"), "old");
        assert.equal(
          fs.readFileSync(
            (fs.existsSync(t.rejected) ? t.rejected : t.source) + "/data",
            "utf8",
          ),
          "new",
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
test("source manifest excludes build and dependencies but detects source edits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "triangle-source-"));
  try {
    fs.writeFileSync(root + "/app.tsx", "old");
    fs.mkdirSync(root + "/.next");
    fs.writeFileSync(root + "/.next/cache", "cache");
    const before = snapshot(root);
    assert.deepEqual(Object.keys(before), ["app.tsx"]);
    fs.writeFileSync(root + "/app.tsx", "changed");
    assert.notDeepEqual(snapshot(root), before);
    fs.symlinkSync("/etc/passwd", root + "/link");
    assert.throws(() => snapshot(root), /Lien source/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("release refuses to overwrite an existing backup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "triangle-backup-"));
  try {
    const t = {
      source: root + "/new",
      live: root + "/live",
      backup: root + "/backup",
    };
    for (const p of Object.values(t)) fs.writeFileSync(p, "retained");
    assert.throws(() => install(t), /Destination/);
    for (const p of Object.values(t))
      assert.equal(fs.readFileSync(p, "utf8"), "retained");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
