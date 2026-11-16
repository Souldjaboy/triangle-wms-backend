const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const {
  applyTask,
  undoTask,
  backendPort,
  envForDump,
} = require("../../scripts/activate-digital-twin-vps.cjs");
function fixture(original = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "triangle-deploy-test-"));
  const task = {
    source: dir + "/new",
    live: dir + "/live",
    backup: dir + "/backup/old",
    rejected: dir + "/rejected/new",
    hadOriginal: original,
    started: true,
  };
  fs.writeFileSync(task.source, "new-code");
  if (original) fs.writeFileSync(task.live, "old-code");
  return {
    dir,
    task,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
test("deployment swaps a file and rollback restores original without losing new code", () => {
  const f = fixture();
  try {
    applyTask(f.task);
    assert.equal(fs.readFileSync(f.task.live, "utf8"), "new-code");
    undoTask(f.task);
    assert.equal(fs.readFileSync(f.task.live, "utf8"), "old-code");
    assert.equal(fs.readFileSync(f.task.rejected, "utf8"), "new-code");
  } finally {
    f.cleanup();
  }
});
test("rollback recovers an interruption between the two renames", () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.dirname(f.task.backup));
    fs.renameSync(f.task.live, f.task.backup);
    undoTask(f.task);
    assert.equal(fs.readFileSync(f.task.live, "utf8"), "old-code");
    assert.equal(fs.readFileSync(f.task.source, "utf8"), "new-code");
  } finally {
    f.cleanup();
  }
});
test("new module rollback removes only the added module and retains it privately", () => {
  const f = fixture(false);
  try {
    applyTask(f.task);
    undoTask(f.task);
    assert.equal(fs.existsSync(f.task.live), false);
    assert.equal(fs.readFileSync(f.task.rejected, "utf8"), "new-code");
  } finally {
    f.cleanup();
  }
});
test("rollback ignores tasks never begun and tasks journaled before first rename", () => {
  const f = fixture();
  try {
    undoTask({ ...f.task, started: false });
    undoTask(f.task);
    assert.equal(fs.readFileSync(f.task.live, "utf8"), "old-code");
  } finally {
    f.cleanup();
  }
});
test("deployment refuses a destination changed after preparation", () => {
  const f = fixture(false);
  try {
    fs.writeFileSync(f.task.live, "external-change");
    assert.throws(() => applyTask(f.task), /Destination modifiée/);
    assert.equal(fs.readFileSync(f.task.live, "utf8"), "external-change");
  } finally {
    f.cleanup();
  }
});
test("backend port discovery uses the exact backend PID and refuses ambiguity", () => {
  const line = (p) => `LISTEN 0 511 *:${p} *:* users:(("node",pid=123,fd=18))`;
  assert.equal(
    backendPort(
      line(5050) + '\nLISTEN 0 511 *:5051 *:* users:(("node",pid=1234,fd=18))',
      123,
    ),
    5050,
  );
  assert.throws(
    () => backendPort(line(5050) + "\n" + line(8000), 123),
    /ambigu/,
  );
  assert.throws(() => backendPort(line(5050), 999), /introuvable/);
});
test("pg_dump receives credentials only through a private escaped password file", () => {
  const f = fixture();
  try {
    const { env, pass } = envForDump(
      "postgresql://app:p%3Aa%5Css@127.0.0.1:5432/wms?sslmode=require",
      f.dir,
    );
    assert.equal(env.PGSSLMODE, "require");
    assert.equal(env.PGDATABASE, "wms");
    assert.equal(env.PGPASSWORD, undefined);
    assert.equal(fs.statSync(pass).mode & 0o777, 0o600);
    assert.equal(
      fs.readFileSync(pass, "utf8"),
      "127.0.0.1:5432:wms:app:p\\:a\\\\ss\n",
    );
  } finally {
    f.cleanup();
  }
});
test("unsupported database options stop before touching production", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        envForDump(
          "postgresql://app:secret@localhost/db?password=override",
          f.dir,
        ),
      /Option PostgreSQL/,
    );
    assert.equal(fs.existsSync(f.dir + "/dump.pgpass"), false);
  } finally {
    f.cleanup();
  }
});
test("a failure at each switch boundary restores the whole release without deleting artifacts", () => {
  for (let boundary = 0; boundary <= 3; boundary++) {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "triangle-release-test-"),
    );
    const tasks = [];
    try {
      for (let i = 0; i < 3; i++) {
        const live = dir + "/live-" + i,
          source = dir + "/source-" + i;
        fs.mkdirSync(live);
        fs.mkdirSync(source);
        fs.writeFileSync(live + "/version", "old-" + i);
        fs.writeFileSync(source + "/version", "new-" + i);
        tasks.push({
          live,
          source,
          backup: dir + "/backup-" + i,
          rejected: dir + "/rejected-" + i,
          hadOriginal: true,
          started: false,
        });
      }
      for (let i = 0; i < boundary; i++) {
        tasks[i].started = true;
        applyTask(tasks[i]);
      }
      if (boundary < 3) {
        tasks[boundary].started = true;
        fs.renameSync(tasks[boundary].live, tasks[boundary].backup);
      }
      for (const task of [...tasks].reverse()) undoTask(task);
      for (let i = 0; i < 3; i++) {
        assert.equal(
          fs.readFileSync(tasks[i].live + "/version", "utf8"),
          "old-" + i,
        );
        const kept = fs.existsSync(tasks[i].rejected)
          ? tasks[i].rejected
          : tasks[i].source;
        assert.equal(fs.readFileSync(kept + "/version", "utf8"), "new-" + i);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
