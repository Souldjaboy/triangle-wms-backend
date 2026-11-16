#!/usr/bin/env node
"use strict";
// Activation de la candidate compilée. Le rollback remet le code et le build,
// jamais une ancienne base : les mouvements saisis entre-temps sont conservés.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const ROOT = "/var/www/triangle-wms",
  BACK = ROOT + "/backend",
  FRONT = ROOT + "/frontend";
const HOST = "trianglewmspro.com";
const MANIFEST = {
  functions: {
    authenticateToken:
      "f0b6de182851dfaf14c44b57854b988178ba7f46c6edf008c42f3cfebeb60c5a",
    getEffectiveCompanyIdStrict:
      "4857a55a6a3d65a717816b4c61ae8b27a89bd9719616c6dce625720a72be3ed3",
    getEffectiveCompanyId:
      "c8698e311bbd232cfb3433c2c79a089ee0fb97d028b41761a0a37bb337a153d4",
    isSuperAdminUser:
      "b21b45def9e9086e6d0643897fe4d97ca6d069da6528db03bb1410cb32003465",
    getRequestedActiveCompanyId:
      "f7322afa64f5ff8d8af966ebfd0338df4f604b49c15c860d2fabeeaaedd3b270",
    societesHabilitees:
      "1eb3801268dd1e480c24d27dd306295801cea460ff0dc2babaff542e7bdcf420",
    societeDemandeeAutorisee:
      "9c7c8b8d1c2b4a20a48982d2c5b692f99a367639f859ff321d27250e28461518",
    getAuthTokenFromRequest:
      "cc675f3dd749aaab164b3971849a80c6687e28e8a9d7bb0b2667ab1dbbe9bfff",
    getTenantFromRequest:
      "2af9c5ef535f78fa3294a6c0c9b3a5b07d191609406696cfd86214f7460591e6",
    normalizeTenantId:
      "241dcd9d7b19a7076a01baa8048b9d8102506ec2f614e4b0b2f01477aa9675ab",
    companyBelongsToTenant:
      "2e653e5fbe61c0d0f7299e21fe5fe1cd70b583afd3ae0c8d6fdea7e789eac154",
  },
  live_hashes: {
    "backend/server.js":
      "7585cc46f8639da674b4a358a188495d9a825b4377d2cec001c96052eee98abb",
    "backend/services/permissions.js":
      "161e4f48c6f3d4053759e12ab5f901b416b1062f9a6864352cbe5f9dad58d4d6",
    "backend/rbac-triangle.js":
      "e0b742aeb90b529440a6e407669b659140036abcd6fabcc676d24b9291a5bf9d",
    "backend/services/location-rules.js":
      "f7b392a1cb0b2831d7e4df876dec60e47dc6567fc80d692aa0cec8b321f8d461",
    "frontend/app/lib/api.ts":
      "8875185d581cd2d2a99e0c042ee009f6d5db32f0ed61eff92897574604e001d7",
    "frontend/middleware.ts":
      "d89ca703836eb0d6ddb77b93ae9de5b681165e778412870add512c83c4828f9e",
    "frontend/next.config.ts":
      "0ee5c04780771726e51cdc6865e779852b45f528f79fdbd4260c2df07f4d1d79",
  },
  candidates: {
    backend: {
      commit: "e7584334581064ae86f914f3c921dbb9e837dcde",
      files: {
        "digital-twin/model.js":
          "017c6d47cf3077c429ced17583103c9b7ed15f4deea9e0a55b5b3facddd17550",
        "digital-twin/service.js":
          "1b417a510f8bab402c2db80e92cc3850a12575da45cb51fcf8b169de982d7d4a",
        "routes/digital-twin.js":
          "f8b9544c4fa1e148255cd257af34c40077a4f1d0f32bb6fc266f5d78b2c5fe2f",
        "sql/064_digital_twin.sql":
          "6f51b30addbae2c47bab6e36aeedb0ea5a240f67cb72f133a2e4940ca520022b",
        "tests/digital-twin/model.test.js":
          "e5626eb4645d737165f6ebefe3a1b9d975c4da1f8eb442cb2653d6da41860ad2",
        "tests/digital-twin/integration.test.js":
          "516bd48c8ee98dfbdfb0f0910997240be5f8dd9f704aa877de7c02a689018c1c",
      },
    },
    frontend: {
      commit: "4f1341ef4e5ba7d6812be12b300f83de65c41aed",
      files: {
        "app/stocks/digital-twin/Configurator.tsx":
          "864c3966c508be2220fb499f9c5f19ca3f75d8031e71f2ce02543de6f69ec1b6",
        "app/stocks/digital-twin/Plan2D.tsx":
          "105f4b3278e36ba5c27a533378afc8c5264bc3ab825620225f34b9aeee1502af",
        "app/stocks/digital-twin/Plan3D.tsx":
          "1bedbd8ab9b48988f3221e16f1ea1da6ed6d648a4d38c6099a1b5e8c4ca7d8f4",
        "app/stocks/digital-twin/Scene.tsx":
          "23935e41d8588c04c028dd15fed4a368f7396d023e38a5c668c66a02773ffef1",
        "app/stocks/digital-twin/page.tsx":
          "728b4898dd57209c0b39b3bfd0e7cb30e66679c3a9e579c02e5eb7fed836c4c5",
        "app/stocks/digital-twin/twin.css":
          "96fe213f93f1ee72b6b2d83c434bfa101e4115f84a689c30c024c865ebfa3421",
        "app/stocks/digital-twin/types.ts":
          "9b7dae5cae21a6c21de22fb56e6ee72b517e528c1bdf9aef6aa067570b3d8ab1",
      },
    },
  },
  dependencies: {
    dependencies: {
      three: "0.187.0",
      "@react-three/drei": "10.7.9",
      "@react-three/fiber": "9.8.2",
    },
    devDependencies: {
      "@types/three": "0.187.0",
    },
  },
  test_dependencies: {
    express: "5.2.1",
    "@electric-sql/pglite": "0.5.16",
  },
};
const hash = (x) => crypto.createHash("sha256").update(x).digest("hex");
const read = (p) => fs.readFileSync(p, "utf8");
const exists = (p) => fs.existsSync(p);
let interrupted = false,
  recovering = false;
function checkInterrupt() {
  if (interrupted && !recovering)
    throw new Error("Interruption demandée ; conservation du retour arrière");
}
function check(ok, message) {
  if (!ok) throw new Error(message);
}
function json(p) {
  return JSON.parse(read(p));
}
function writeState(p, value) {
  const t = p + ".tmp";
  fs.writeFileSync(t, JSON.stringify(value, null, 2), { mode: 0o600 });
  const fd = fs.openSync(t, "r");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(t, p);
}
function run(p, args, options = {}) {
  checkInterrupt();
  try {
    return execFileSync(p, args, {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 12 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
  } catch {
    throw new Error("Échec de " + p + " ; aucun secret affiché");
  }
}
function snapshot(dir) {
  const out = {},
    skip = new Set([".git", "node_modules", ".next", "uploads", "backups"]);
  function walk(d, p = "") {
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (skip.has(e.name)) continue;
      const rel = p + e.name,
        f = path.join(d, e.name);
      check(!e.isSymbolicLink(), "Lien inattendu : " + rel);
      if (e.isDirectory()) walk(f, rel + "/");
      else if (e.isFile()) out[rel] = hash(fs.readFileSync(f));
    }
  }
  walk(dir);
  return out;
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function applyTask(task) {
  fs.mkdirSync(path.dirname(task.backup), { recursive: true });
  fs.mkdirSync(path.dirname(task.live), { recursive: true });
  check(!exists(task.backup), "Sauvegarde déjà présente : " + task.live);
  check(
    exists(task.live) === task.hadOriginal,
    "Destination modifiée : " + task.live,
  );
  if (task.hadOriginal) fs.renameSync(task.live, task.backup);
  fs.renameSync(task.source, task.live);
}
function undoTask(task) {
  if (!task.started) return;
  if (exists(task.backup)) {
    if (exists(task.live)) {
      check(!exists(task.rejected), "Retour arrière déjà occupé");
      fs.mkdirSync(path.dirname(task.rejected), { recursive: true });
      fs.renameSync(task.live, task.rejected);
    }
    fs.renameSync(task.backup, task.live);
  } else if (!task.hadOriginal && !exists(task.source) && exists(task.live)) {
    fs.mkdirSync(path.dirname(task.rejected), { recursive: true });
    fs.renameSync(task.live, task.rejected);
  } else if (task.hadOriginal && !exists(task.live))
    throw new Error("Fichier original manquant : " + task.live);
}
function backendPort(output, pid) {
  const ports = new Set();
  for (const line of output.split("\n")) {
    if (!new RegExp("pid=" + pid + "(?:,|\\))").test(line)) continue;
    const local = line.trim().split(/\s+/)[3],
      m = local?.match(/:(\d+)$/);
    if (m) ports.add(Number(m[1]));
  }
  check(ports.size === 1, "Port backend ambigu ou introuvable");
  return [...ports][0];
}
function envForDump(connection, stage) {
  const u = new URL(connection);
  check(
    ["postgres:", "postgresql:"].includes(u.protocol),
    "URL PostgreSQL non prise en charge",
  );
  const allowed = new Set([
    "sslmode",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "connect_timeout",
    "application_name",
  ]);
  for (const k of u.searchParams.keys())
    check(allowed.has(k), "Option PostgreSQL à examiner avant sauvegarde");
  const values = [
    decodeURIComponent(u.hostname),
    u.port || "5432",
    decodeURIComponent(u.pathname.slice(1)),
    decodeURIComponent(u.username),
    decodeURIComponent(u.password),
  ];
  check(values.slice(0, 4).every(Boolean), "Connexion PostgreSQL incomplète");
  check(
    values.every((v) => !/[\r\n]/.test(v)),
    "Connexion incompatible avec le fichier de mot de passe",
  );
  const pass = path.join(stage, "dump.pgpass");
  fs.writeFileSync(
    pass,
    values.map((v) => v.replace(/\\/g, "\\\\").replace(/:/g, "\\:")).join(":") +
      "\n",
    { mode: 0o600, flag: "wx" },
  );
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C.UTF-8",
    PGHOST: values[0],
    PGPORT: values[1],
    PGDATABASE: values[2],
    PGUSER: values[3],
    PGPASSFILE: pass,
    PGCONNECT_TIMEOUT: "10",
    PGSSLMODE: u.searchParams.get("sslmode") || "prefer",
  };
  for (const [q, k] of [
    ["sslcert", "PGSSLCERT"],
    ["sslkey", "PGSSLKEY"],
    ["sslrootcert", "PGSSLROOTCERT"],
  ])
    if (u.searchParams.has(q)) env[k] = u.searchParams.get(q);
  return { env, pass };
}
async function dumpDatabase(connection, stage) {
  const { env, pass } = envForDump(connection, stage),
    file = path.join(stage, "database-before.dump"),
    log = path.join(stage, "database-backup.log");
  try {
    const fd = fs.openSync(log, "a", 0o600);
    try {
      await new Promise((resolve, reject) => {
        const c = spawn(
          "pg_dump",
          [
            "--format=custom",
            "--no-password",
            "--lock-wait-timeout=10000",
            "--file",
            file,
          ],
          { env, stdio: ["ignore", fd, fd] },
        );
        const timer = setTimeout(() => c.kill("SIGTERM"), 20 * 60 * 1000);
        const progress = setInterval(
          () => console.log("  Sauvegarde PostgreSQL en cours…"),
          45000,
        );
        const done = () => {
          clearTimeout(timer);
          clearInterval(progress);
        };
        c.on("error", () => {
          done();
          reject(new Error("pg_dump indisponible"));
        });
        c.on("exit", (code) => {
          done();
          code === 0
            ? resolve()
            : reject(
                new Error(
                  "Sauvegarde PostgreSQL échouée ; arrêt avant migration",
                ),
              );
        });
      });
    } finally {
      fs.closeSync(fd);
    }
    check(fs.statSync(file).size > 1024, "Sauvegarde vide");
    const toc = run("pg_restore", ["--list", file]);
    for (const table of [
      "products",
      "locations",
      "stock_movements",
      "stock_location_balances",
    ])
      check(
        toc.includes("TABLE DATA public " + table + " "),
        "Table absente de la sauvegarde : " + table,
      );
    const digest = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) {
      checkInterrupt();
      digest.update(chunk);
    }
    fs.writeFileSync(
      file + ".sha256",
      digest.digest("hex") + "  database-before.dump\n",
    );
    return file;
  } finally {
    fs.rmSync(pass, { force: true });
  }
}
function http(url, { publicHost = false } = {}) {
  const args = [
    "--silent",
    "--show-error",
    "--max-time",
    "12",
    "--output",
    "/dev/null",
    "--write-out",
    "%{http_code}",
    "--header",
    "Host: " + HOST,
  ];
  if (publicHost) args.push("--resolve", HOST + ":443:127.0.0.1");
  args.push(url);
  try {
    return Number(run("curl", args));
  } catch {
    return 0;
  }
}
async function ready(url, status, opts) {
  for (let n = 0; n < 30; n++) {
    checkInterrupt();
    if (http(url, opts) === status) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Contrôle HTTP non satisfait : " + new URL(url).pathname);
}
function appList() {
  return JSON.parse(run("pm2", ["jlist"]));
}
function pm2(action, name, env) {
  run(
    "pm2",
    [action, name, ...(action === "restart" ? ["--update-env"] : [])],
    { env: { ...process.env, ...env } },
  );
}
async function rollback(state, file) {
  recovering = true;
  console.log("Retour arrière du code et du frontend…");
  const errors = [];
  for (const name of ["triangle-frontend", "triangle-backend"])
    try {
      pm2("stop", name);
    } catch (e) {
      errors.push(e.message);
    }
  for (const task of [...state.tasks].reverse())
    try {
      undoTask(task);
    } catch (e) {
      errors.push(e.message);
    }
  for (const name of ["triangle-backend", "triangle-frontend"])
    try {
      pm2(
        "restart",
        name,
        name === "triangle-backend"
          ? { DIGITAL_TWIN_ENABLED: state.oldEnabled || "false" }
          : undefined,
      );
    } catch (e) {
      errors.push(e.message);
    }
  try {
    await ready("http://127.0.0.1:" + state.backendPort + "/", 200);
    await ready("http://127.0.0.1:3000/login", 200);
    run("pm2", ["save"]);
  } catch (e) {
    errors.push(e.message);
  }
  state.status = errors.length ? "ROLLBACK_REQUIRES_REVIEW" : "ROLLED_BACK";
  writeState(file, state);
  check(!errors.length, "Retour arrière à vérifier : " + errors.join(" | "));
  console.log(
    "Version précédente rétablie. Les tables additives et tous les mouvements sont conservés.",
  );
}
async function main() {
  process.umask(0o077);
  check(process.getuid() === 0, "Exécuter avec le compte root du VPS");
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => {
      interrupted = true;
    });
  const stage = path.resolve(process.argv[2] || "");
  check(
    /^\/var\/backups\/triangle-digital-twin\/candidate-[A-Za-z0-9]+$/.test(
      stage,
    ),
    "Dossier candidat invalide",
  );
  check(fs.realpathSync(stage) === stage, "Dossier candidat indirect");
  check(
    fs.statSync(stage).uid === process.getuid() &&
      (fs.statSync(stage).mode & 0o077) === 0,
    "Dossier candidat non privé",
  );
  const stateFile = path.join(stage, "activation-state.json");
  if (process.argv[3] === "--rollback") {
    const state = json(stateFile);
    check(state.status !== "ROLLED_BACK", "Retour arrière déjà effectué");
    await rollback(state, stateFile);
    return;
  }
  check(
    !exists(stateFile),
    "Activation déjà tentée : consulter activation-state.json ou utiliser --rollback",
  );
  const report = json(path.join(stage, "report.json"));
  check(
    report.directory === stage &&
      report.status === "CANDIDATE_COMPILED_NOT_DEPLOYED" &&
      report.backend_tests === "PASS" &&
      report.frontend_build === "PASS",
    "Candidate non validée",
  );
  const stageBack = path.join(stage, "backend"),
    stageFront = path.join(stage, "frontend");
  for (const [f, h] of Object.entries(MANIFEST.live_hashes))
    check(
      hash(fs.readFileSync(path.join(ROOT, f))) === h,
      "Code modifié depuis le diagnostic : " + f,
    );
  const before = json(path.join(stage, "frontend-before.json"));
  check(
    same(snapshot(FRONT), before),
    "Frontend modifié depuis la compilation ; nouvelle préparation nécessaire",
  );
  for (const [side, meta] of Object.entries(MANIFEST.candidates))
    for (const [f, h] of Object.entries(meta.files))
      check(
        hash(fs.readFileSync(path.join(stage, side, f))) === h,
        "Candidate altérée : " + f,
      );
  const stagedSources = snapshot(stageFront);
  for (const [f, h] of Object.entries(before))
    if (
      ![
        "package.json",
        "package-lock.json",
        "next-env.d.ts",
        "tsconfig.tsbuildinfo",
      ].includes(f)
    )
      check(stagedSources[f] === h, "Source compilée différente : " + f);
  check(
    read(path.join(stageFront, ".next/BUILD_ID")).trim() ===
      report.frontend_build_id,
    "Build remplacé",
  );
  const apps = appList();
  for (const name of ["triangle-backend", "triangle-frontend"])
    check(
      apps.filter((a) => a.name === name).length === 1,
      "Nom PM2 ambigu : " + name,
    );
  const backend = apps.find((a) => a.name === "triangle-backend"),
    frontend = apps.find((a) => a.name === "triangle-frontend");
  for (const [app, cwd] of [
    [backend, BACK],
    [frontend, FRONT],
  ])
    check(
      app?.pm2_env.pm_cwd === cwd && app.pm2_env.status === "online",
      "Service ou dossier de production inattendu",
    );
  for (const app of [backend, frontend])
    check(
      /^Uid:\s+0\s/m.test(read("/proc/" + app.pid + "/status")),
      "Compte de service différent de root",
    );
  check(
    same(frontend.pm2_env.args, ["start", "--", "-p", "3000"]),
    "Arguments frontend modifiés",
  );
  const port = backendPort(run("ss", ["-ltnp"]), backend.pid);
  const rewrites = json(
    path.join(stageFront, ".next/routes-manifest.json"),
  ).rewrites;
  const all = Array.isArray(rewrites)
    ? rewrites
    : Object.values(rewrites).flat();
  const api = all.find((r) => r.source === "/api/:path*");
  check(api, "Proxy API absent du build");
  const destination = new URL(api.destination.replace(":path*", ""));
  check(
    ["localhost", "127.0.0.1"].includes(destination.hostname) &&
      Number(destination.port) === port,
    "Le build ne cible pas le backend en service",
  );
  check(
    http("http://127.0.0.1:" + port + "/") === 200,
    "Backend existant indisponible",
  );
  check(
    http("http://127.0.0.1:3000/login") === 200,
    "Frontend existant indisponible",
  );
  check(
    http("https://" + HOST + "/login", { publicHost: true }) === 200,
    "Accès HTTPS existant indisponible",
  );
  const requireBack = createRequire(BACK + "/package.json"),
    requireFront = createRequire(FRONT + "/package.json");
  const dotenv = requireBack("dotenv");
  const oldEnv = exists(BACK + "/.env") ? read(BACK + "/.env") : "";
  const runtime = {
    ...dotenv.parse(oldEnv),
    ...process.env,
    ...backend.pm2_env.env,
    ...backend.pm2_env,
  };
  check(typeof runtime.DATABASE_URL === "string", "DATABASE_URL indisponible");
  check((runtime.DEFAULT_TENANT_ID || "triangle") === "triangle", "Le backend ne cible pas le tenant Triangle attendu");
  const source = read(BACK + "/server.js");
  check(
    /connectionString\s*:\s*process\.env\.DATABASE_URL\b/.test(source),
    "Configuration PostgreSQL à examiner",
  );
  const ast = requireFront("next/dist/compiled/acorn").parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
  });
  const anchors = ast.body.filter(
    (n) =>
      n.type === "ExpressionStatement" &&
      n.expression.type === "CallExpression" &&
      n.expression.callee.type === "MemberExpression" &&
      n.expression.callee.object.name === "app" &&
      n.expression.callee.property.name === "listen",
  );
  check(anchors.length === 1, "Montage du serveur ambigu");
  const mount =
    'if (process.env.DIGITAL_TWIN_ENABLED === "true") {\n  app.use("/digital-twin", require("./routes/digital-twin")({ pool, authenticateToken, getEffectiveCompanyId: getEffectiveCompanyIdStrict }));\n}\n\n';
  const expected =
    source.slice(0, anchors[0].start) + mount + source.slice(anchors[0].start);
  check(
    read(stageBack + "/server.js") === expected,
    "Montage candidat non conforme",
  );
  run(process.execPath, ["--check", stageBack + "/server.js"]);
  run("pg_dump", ["--version"]);
  run("pg_restore", ["--version"]);
  const free = fs.statfsSync(stage);
  const db = new (requireBack("pg").Client)({
    connectionString: runtime.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
    application_name: "triangle-digital-twin-deploy",
  });
  let state;
  try {
    await db.connect();
    check(
      (
        await db.query(
          "SELECT pg_try_advisory_lock(hashtext('triangle_digital_twin_deploy')) AS locked",
        )
      ).rows[0].locked,
      "Autre activation en cours",
    );
    const info = (
      await db.query(
        "SELECT pg_database_size(current_database()) AS size,current_schema() AS schema",
      )
    ).rows[0];
    check(info.schema === "public", "Schéma PostgreSQL inattendu");
    check(
      free.bavail * free.bsize > Number(info.size) * 1.2 + 2 * 1024 ** 3,
      "Espace insuffisant pour la sauvegarde PostgreSQL",
    );
    check(
      !(
        await db.query(
          "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('dt_layouts','dt_nodes','dt_warehouse_access')",
        )
      ).rows.length,
      "Tables Digital Twin déjà présentes ; examiner avant nouvelle migration",
    );
    console.log(
      "1/4 — Sauvegarde PostgreSQL et conservation des versions actuelles",
    );
    await dumpDatabase(runtime.DATABASE_URL, stage);
    fs.writeFileSync(
      path.join(stage, "pm2-triangle-before.json"),
      JSON.stringify([backend, frontend], null, 2),
    );
    fs.copyFileSync(
      __filename,
      path.join(stage, "activate-digital-twin-vps.cjs"),
    );
    const payload = path.join(stage, "activation-payload");
    fs.mkdirSync(payload, { mode: 0o700 });
    const tasks = [];
    function task(src, rel) {
      const live = path.join(ROOT, rel);
      check(
        !exists(live) || !fs.lstatSync(live).isSymbolicLink(),
        "Destination indirecte : " + rel,
      );
      tasks.push({
        source: src,
        live,
        backup: path.join(stage, "rollback", rel),
        rejected: path.join(stage, "rejected", rel),
        hadOriginal: exists(live),
        started: false,
      });
    }
    const files = [
      "digital-twin/model.js",
      "digital-twin/service.js",
      "routes/digital-twin.js",
    ];
    for (const f of files) {
      const src = path.join(payload, "backend", f);
      fs.mkdirSync(path.dirname(src), { recursive: true });
      fs.copyFileSync(path.join(stageBack, f), src);
      check(!exists(path.join(BACK, f)), "Fichier module déjà installé : " + f);
      task(src, "backend/" + f);
    }
    fs.copyFileSync(stageBack + "/server.js", payload + "/server.js");
    task(payload + "/server.js", "backend/server.js");
    fs.writeFileSync(
      payload + "/backend.env",
      oldEnv
        .replace(/^(?:export\s+)?DIGITAL_TWIN_ENABLED\s*=.*(?:\r?\n|$)/gm, "")
        .replace(/\s*$/, "") + "\nDIGITAL_TWIN_ENABLED=true\n",
    );
    task(payload + "/backend.env", "backend/.env");
    for (const f of ["package.json", "package-lock.json"]) {
      fs.copyFileSync(stageFront + "/" + f, payload + "/" + f);
      task(payload + "/" + f, "frontend/" + f);
    }
    check(
      !exists(FRONT + "/app/stocks/digital-twin"),
      "Route frontend déjà existante",
    );
    fs.cpSync(
      stageFront + "/app/stocks/digital-twin",
      payload + "/digital-twin",
      { recursive: true },
    );
    task(payload + "/digital-twin", "frontend/app/stocks/digital-twin");
    for (const f of ["node_modules", ".next"]) {
      check(
        fs.statSync(stageFront + "/" + f).dev === fs.statSync(FRONT).dev,
        "Disques différents : bascule atomique impossible",
      );
      task(stageFront + "/" + f, "frontend/" + f);
    }
    state = {
      status: "PREPARED",
      backendPort: port,
      oldEnabled: runtime.DIGITAL_TWIN_ENABLED || null,
      tasks,
    };
    writeState(stateFile, state);
    console.log(
      "2/4 — Ajout transactionnel des tables du plan, sans modification des stocks",
    );
    checkInterrupt();
    const migration = read(stageBack + "/sql/064_digital_twin.sql").replace(
      /^\\.*$/gm,
      "",
    );
    await db.query(migration);
    state.status = "MIGRATED";
    writeState(stateFile, state);
    // Lecture métier sur la base réelle avec un compte existant autorisé.
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const u = (
        await db.query(
          "SELECT u.id,u.company_id,c.tenant_id FROM users u JOIN companies c ON c.id=u.company_id WHERE u.is_active=TRUE AND c.tenant_id='triangle' AND (u.is_super_admin=TRUE OR lower(u.role) IN ('admin','super_admin','administrateur')) ORDER BY u.is_super_admin DESC NULLS LAST,u.id LIMIT 1",
        )
      ).rows[0];
      check(u, "Compte administrateur actif absent pour le contrôle métier");
      const svc = require(stageBack + "/digital-twin/service.js");
      const ctx = await svc.context(
        db,
        { user: { id: u.id }, tenant_id: u.tenant_id, headers: {}, query: {} },
        (_r, f) => f,
      );
      const ws = await svc.warehouses(db, ctx);
      for (const w of ws) await svc.snapshot(db, ctx, w.id);
      await db.query("COMMIT");
    } catch {
      await db.query("ROLLBACK");
      throw new Error(
        "Contrôle métier sur la base réelle non satisfait ; activation annulée",
      );
    }
    check(
      same(snapshot(FRONT), before) &&
        hash(read(BACK + "/server.js")) === report.live_backend_sha,
      "Code modifié pendant la sauvegarde",
    );
    checkInterrupt();
    // Les anciens chunks restent disponibles pour les sessions déjà ouvertes.
    if (exists(FRONT + "/.next/static"))
      fs.cpSync(FRONT + "/.next/static", stageFront + "/.next/static", {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    // Le dossier de préparation est privé ; seuls les assets publiquement servis
    // doivent devenir lisibles par les workers Nginx après déplacement.
    fs.chmodSync(stageFront + "/.next", 0o755);
    function publicAssets(dir) {
      fs.chmodSync(dir, 0o755);
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        check(!e.isSymbolicLink(), "Lien inattendu dans les assets");
        if (e.isDirectory()) publicAssets(p);
        else fs.chmodSync(p, 0o644);
      }
    }
    publicAssets(stageFront + "/.next/static");
    console.log("3/4 — Bascule des deux services Triangle");
    state.status = "SWITCHING";
    writeState(stateFile, state);
    pm2("stop", "triangle-frontend");
    pm2("stop", "triangle-backend");
    for (const t of tasks) {
      checkInterrupt();
      t.started = true;
      writeState(stateFile, state);
      applyTask(t);
    }
    pm2("restart", "triangle-backend", { DIGITAL_TWIN_ENABLED: "true" });
    await ready("http://127.0.0.1:" + port + "/", 200);
    await ready("http://127.0.0.1:" + port + "/digital-twin/warehouses", 401);
    pm2("restart", "triangle-frontend");
    console.log("4/4 — Contrôles HTTP et authentification obligatoire");
    await ready("http://127.0.0.1:3000/login", 200);
    await ready("http://127.0.0.1:3000/api/digital-twin/warehouses", 401);
    await ready("https://" + HOST + "/login", 200, { publicHost: true });
    await ready("https://" + HOST + "/api/digital-twin/warehouses", 401, {
      publicHost: true,
    });
    const protectedStatus = http("https://" + HOST + "/stocks/digital-twin", {
      publicHost: true,
    });
    check(
      [302, 303, 307, 308].includes(protectedStatus),
      "La page protégée ne redirige pas vers la connexion",
    );
    run("pm2", ["save"]);
    state.status = "DEPLOYED";
    state.finished_at = new Date().toISOString();
    writeState(stateFile, state);
    console.log(
      JSON.stringify(
        {
          status: "DEPLOYED_SMOKE_CHECKS_PASSED",
          url: "https://" + HOST + "/stocks/digital-twin",
          backup: stage,
          backend_port: port,
          frontend_port: 3000,
          stock_mutations: 0,
          authenticated_visual_check: "A_EFFECTUER_DANS_LE_NAVIGATEUR",
          rollback:
            "node " +
            stage +
            "/activate-digital-twin-vps.cjs " +
            stage +
            " --rollback",
        },
        null,
        2,
      ),
    );
  } catch (e) {
    if (state?.status === "SWITCHING") await rollback(state, stateFile);
    else if (state) {
      state.status = "STOPPED_BEFORE_SWITCH";
      writeState(stateFile, state);
    }
    throw e;
  } finally {
    await db.end().catch(() => {});
  }
}
if (require.main === module && !process.env.TRIANGLE_DT_LOCKED) {
  const result = spawnSync(
    "flock",
    [
      "-n",
      "/var/backups/triangle-digital-twin/.activation.lock",
      process.execPath,
      __filename,
      ...process.argv.slice(2),
    ],
    { stdio: "inherit", env: { ...process.env, TRIANGLE_DT_LOCKED: "1" } },
  );
  if (result.error || result.status !== 0)
    console.error("Activation non terminée ; consulter le résultat ci-dessus.");
  process.exit(result.status === 0 ? 0 : result.status || 1);
}
if (require.main === module)
  main().catch((e) => {
    console.error(
      "ACTIVATION INTERROMPUE : " +
        (/^[A-Z0-9_]+$/.test(e.code || "")
          ? "contrôle système ou PostgreSQL non satisfait (" + e.code + ")"
          : e.message),
    );
    process.exitCode = 1;
  });
module.exports = { applyTask, undoTask, backendPort, envForDump, snapshot };
