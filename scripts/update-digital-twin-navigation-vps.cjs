#!/usr/bin/env node
"use strict";
// Navigation et rendu : mise à jour du seul frontend ; aucune connexion à la base, aucune migration.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const FRONT = "/var/www/triangle-wms/frontend",
  ROOT = "/var/backups/triangle-digital-twin",
  HOST = "trianglewmspro.com";
const RELEASE = {
  commit: "9d0716905ecabc9ca091f4faee6714d803be86ac",
  before: {
    "app/stocks/digital-twin/Automatic2D.tsx":
      "22357f1c3c9664cec99f2450642578f0e8169f0ef2891a150a111a64bcdddc3f",
    "app/stocks/digital-twin/Configurator.tsx":
      "864c3966c508be2220fb499f9c5f19ca3f75d8031e71f2ce02543de6f69ec1b6",
    "app/stocks/digital-twin/Plan2D.tsx":
      "105f4b3278e36ba5c27a533378afc8c5264bc3ab825620225f34b9aeee1502af",
    "app/stocks/digital-twin/Plan3D.tsx":
      "b22752911d12851193d3457390203944a0aec42bd7961aada418eb97e219638a",
    "app/stocks/digital-twin/Scene.tsx":
      "e86d75c8bbe720e92613abf8184ef4937ac8f754d1e300449e736d3219daf9bc",
    "app/stocks/digital-twin/automatic.ts":
      "559113e53c0474153e70d07f2df45da7b0075caaca7b421404da5173d24825e9",
    "app/stocks/digital-twin/page.tsx":
      "1f7410d43ea750f469a2c4e4cc247993ca4e6b6ba5048b1c06817f251c16c47e",
    "app/stocks/digital-twin/twin.css":
      "84f1002cc8aa74ac329827637cd2ca669cf410324c6aa46fa79c8f6e02cd6626",
    "app/stocks/digital-twin/types.ts":
      "b402bb12e9297c4a9ae8253cea09dd28b578b9ff08a693404397966ffbca9745",
  },
  after: {
    "app/stocks/digital-twin/Automatic2D.tsx":
      "22357f1c3c9664cec99f2450642578f0e8169f0ef2891a150a111a64bcdddc3f",
    "app/stocks/digital-twin/Configurator.tsx":
      "864c3966c508be2220fb499f9c5f19ca3f75d8031e71f2ce02543de6f69ec1b6",
    "app/stocks/digital-twin/Navigation.tsx":
      "81b9e265f63d83581ad5613e2c07039cbf6732a055121b3639a6707547727048",
    "app/stocks/digital-twin/Plan2D.tsx":
      "105f4b3278e36ba5c27a533378afc8c5264bc3ab825620225f34b9aeee1502af",
    "app/stocks/digital-twin/Plan3D.tsx":
      "4c3dec09c40c08e4baf7632af8d405537b09d7a2a1bd054067135a9fdf3d0193",
    "app/stocks/digital-twin/Scene.tsx":
      "8c8493f7b2806180aec31203c8d7302c141cf463ce137808c1b18372e1803149",
    "app/stocks/digital-twin/automatic.ts":
      "7e94bf01049de02998d0157c3c0b14e3dbc1a54f10e82b6ae800f7ffd50639c6",
    "app/stocks/digital-twin/page.tsx":
      "e8cc9b542eab2b0dccd5d44c239b2769b88a3a44249cff6f0e26555813ba6e99",
    "app/stocks/digital-twin/scene-math.ts":
      "01405995cd8a167314d6ebf9e17d10a1715c95ed2a2b8147a579b74308d2a3d3",
    "app/stocks/digital-twin/twin.css":
      "ca7d309dfb531a230cd1b578c5967ed0e8dfa10c187b70fcd660e73a056b0549",
    "app/stocks/digital-twin/types.ts":
      "b402bb12e9297c4a9ae8253cea09dd28b578b9ff08a693404397966ffbca9745",
    "tests/digital-twin-automatic.test.cjs":
      "eaa2e57e757cd0c174a60d5e2eff46d16285c684b8339cefeefb509fed0af784",
  },
};
const hash = (x) => crypto.createHash("sha256").update(x).digest("hex"),
  read = (p) => fs.readFileSync(p, "utf8"),
  exists = (p) => fs.existsSync(p);
let interrupted = false,
  recovering = false;
function check(v, message) {
  if (!v) throw new Error(message);
}
function active() {
  check(!interrupted || recovering, "Interruption demandée");
}
function run(bin, args, options = {}) {
  active();
  try {
    return execFileSync(bin, args, {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 12 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
  } catch {
    throw new Error("Commande échouée : " + bin);
  }
}
function journal(file, data) {
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
  const fd = fs.openSync(file + ".tmp", "r");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(file + ".tmp", file);
}
function snapshot(dir) {
  const out = {},
    skip = new Set([".git", "node_modules", ".next", "uploads", "backups"]);
  function walk(d, p = "") {
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (skip.has(e.name)) continue;
      check(!e.isSymbolicLink(), "Lien source à examiner : " + p + e.name);
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, p + e.name + "/");
      else out[p + e.name] = hash(fs.readFileSync(f));
    }
  }
  walk(dir);
  return out;
}
function install(t) {
  check(
    exists(t.live) && !exists(t.backup),
    "Destination de bascule inattendue",
  );
  fs.renameSync(t.live, t.backup);
  fs.renameSync(t.source, t.live);
}
function restore(t) {
  if (!t.started || !exists(t.backup)) return;
  if (exists(t.live)) {
    check(!exists(t.rejected), "Dossier de retour arrière déjà occupé");
    fs.renameSync(t.live, t.rejected);
  }
  fs.renameSync(t.backup, t.live);
}
function pm2(action) {
  run("pm2", [action, "triangle-frontend"]);
}
function status(route) {
  try {
    return Number(
      run("curl", [
        "--silent",
        "--show-error",
        "--max-time",
        "12",
        "--resolve",
        HOST + ":443:127.0.0.1",
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code}",
        "https://" + HOST + route,
      ]),
    );
  } catch {
    return 0;
  }
}
async function ready() {
  for (let i = 0; i < 25; i++) {
    active();
    if (
      status("/login") === 200 &&
      status("/api/digital-twin/warehouses") === 401 &&
      [302, 303, 307, 308].includes(status("/stocks/digital-twin"))
    )
      return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Contrôles HTTP non satisfaits");
}
async function command(bin, args, cwd, log, env = process.env) {
  active();
  const fd = fs.openSync(log, "a", 0o600);
  try {
    await new Promise((resolve, reject) => {
      const c = spawn(bin, args, { cwd, env, stdio: ["ignore", fd, fd] });
      const timeout = setTimeout(() => c.kill("SIGTERM"), 20 * 60 * 1000),
        pulse = setInterval(
          () => console.log("  Vérification / compilation en cours…"),
          45000,
        );
      const done = () => {
        clearTimeout(timeout);
        clearInterval(pulse);
      };
      c.on("error", () => {
        done();
        reject(new Error(bin + " indisponible"));
      });
      c.on("exit", (code) => {
        done();
        code === 0
          ? resolve()
          : reject(new Error("Échec de " + bin + " ; journal privé : " + log));
      });
    });
  } finally {
    fs.closeSync(fd);
  }
}
async function rollback(state, file) {
  recovering = true;
  console.log("Restauration du frontend précédent…");
  const errors = [];
  try {
    pm2("stop");
  } catch (e) {
    errors.push(e.message);
  }
  for (const t of [...state.tasks].reverse())
    try {
      restore(t);
    } catch (e) {
      errors.push(e.message);
    }
  try {
    pm2("restart");
    await ready();
  } catch (e) {
    errors.push(e.message);
  }
  state.status = errors.length ? "ROLLBACK_REQUIRES_REVIEW" : "ROLLED_BACK";
  journal(file, state);
  check(!errors.length, "Retour arrière à vérifier : " + errors.join(" | "));
  console.log("Frontend précédent rétabli. Aucun stock modifié.");
}
// Insert one link after the existing Stocks heading, never replace the live page.
function addStockEntry(source, ts) {
  const ast = ts.createSourceFile(
    "page.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  check(ast.parseDiagnostics.length === 0, "Page Stocks non analysable");
  const headings = [],
    links = [];
  function visit(n) {
    if (
      ts.isJsxAttribute(n) &&
      n.name.getText(ast) === "href" &&
      n.initializer &&
      ts.isStringLiteral(n.initializer) &&
      n.initializer.text === "/stocks/digital-twin"
    )
      links.push(n);
    if (
      ts.isJsxElement(n) &&
      n.openingElement.tagName.getText(ast) === "h1" &&
      n.children.every((c) => ts.isJsxText(c)) &&
      n.children
        .map((c) => c.text)
        .join("")
        .trim() === "Stocks"
    )
      headings.push(n);
    ts.forEachChild(n, visit);
  }
  visit(ast);
  if (links.length) return source;
  check(
    headings.length === 1,
    "Titre Stocks unique introuvable : aucune modification de production",
  );
  const pos = headings[0].end;
  const entry =
    '\n      <a href="/stocks/digital-twin" style={{display:"inline-flex",margin:"16px 0",padding:"12px 18px",borderRadius:10,background:"#153752",color:"#ffd349",fontWeight:700,textDecoration:"none"}}>Entrepôts — Vue 3D / 2D</a>\n';
  const result = source.slice(0, pos) + entry + source.slice(pos);
  const parsed = ts.createSourceFile(
    "page.tsx",
    result,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  check(
    parsed.parseDiagnostics.length === 0,
    "Insertion du lien Stocks invalide",
  );
  return result;
}
async function main() {
  process.umask(0o077);
  check(process.getuid() === 0, "Utiliser le compte root du VPS");
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(sig, () => {
      interrupted = true;
    });
  if (process.argv[2] === "--rollback") {
    const folder = path.resolve(process.argv[3] || "");
    check(
      /^\/var\/backups\/triangle-digital-twin\/navigation-[A-Za-z0-9]+$/.test(
        folder,
      ) && fs.realpathSync(folder) === folder,
      "Dossier de retour arrière invalide",
    );
    const file = folder + "/state.json";
    const state = JSON.parse(read(file));
    check(state.status !== "ROLLED_BACK", "Retour arrière déjà effectué");
    await rollback(state, file);
    return;
  }
  const apps = JSON.parse(run("pm2", ["jlist"]));
  check(
    apps.filter((a) => a.name === "triangle-frontend").length === 1,
    "Processus frontend ambigu",
  );
  const app = apps.find((a) => a.name === "triangle-frontend");
  check(
    app.pm2_env.pm_cwd === FRONT && app.pm2_env.status === "online",
    "Frontend attendu non disponible",
  );
  check(
    JSON.stringify(app.pm2_env.args) ===
      JSON.stringify(["start", "--", "-p", "3000"]),
    "Arguments de démarrage modifiés",
  );
  for (const [file, h] of Object.entries(RELEASE.before))
    check(
      hash(fs.readFileSync(FRONT + "/" + file)) === h,
      "Module modifié depuis sa publication : " + file,
    );
  check(
    Object.keys(snapshot(FRONT + "/app/stocks/digital-twin")).length ===
      Object.keys(RELEASE.before).length,
    "Fichiers supplémentaires à conserver dans le module : examen nécessaire",
  );
  check(
    status("/login") === 200 && status("/api/digital-twin/warehouses") === 401,
    "État HTTP initial non conforme",
  );
  const free = fs.statfsSync(FRONT);
  check(free.bavail * free.bsize > 3 * 1024 ** 3, "Moins de 3 Gio disponibles");
  const before = snapshot(FRONT);
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const folder = fs.mkdtempSync(ROOT + "/navigation-"),
    copy = folder + "/frontend",
    log = folder + "/build.log";
  fs.mkdirSync(copy, { mode: 0o700 });
  console.log("Sauvegarde et préparation : " + folder);
  fs.copyFileSync(__filename, folder + "/update.cjs");
  fs.writeFileSync(folder + "/source-before.json", JSON.stringify(before));
  console.log("1/3 — Copie du frontend actuel et chargement de la correction");
  await command(
    "tar",
    [
      "--exclude=./.git",
      "--exclude=./node_modules",
      "--exclude=./.next",
      "--exclude=./uploads",
      "--exclude=./backups",
      "-cf",
      folder + "/source-before.tar",
      "-C",
      FRONT,
      ".",
    ],
    folder,
    log,
  );
  await command(
    "tar",
    ["-xf", folder + "/source-before.tar", "-C", copy],
    folder,
    log,
  );
  check(
    JSON.stringify(snapshot(copy)) === JSON.stringify(before),
    "Source modifiée pendant la copie",
  );
  fs.symlinkSync(FRONT + "/node_modules", copy + "/node_modules", "dir");
  for (const [file, h] of Object.entries(RELEASE.after)) {
    active();
    const res = await fetch(
      "https://raw.githubusercontent.com/Souldjaboy/triangle-wms-frontend/" +
        RELEASE.commit +
        "/" +
        file,
      { signal: AbortSignal.timeout(60000) },
    );
    check(res.ok, "Téléchargement impossible : " + file);
    const bytes = Buffer.from(await res.arrayBuffer());
    check(hash(bytes) === h, "Empreinte incorrecte : " + file);
    const dest = copy + "/" + file;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
  }
  const stockPage = copy + "/app/stocks/page.tsx";
  const ts = require(copy + "/node_modules/typescript");
  fs.writeFileSync(stockPage, addStockEntry(read(stockPage), ts));
  console.log(
    "2/3 — Tests et compilation, pendant que Triangle reste accessible",
  );
  const env = {
    ...process.env,
    NODE_ENV: "production",
    NEXT_PUBLIC_DIGITAL_TWIN_ENABLED: "true",
  };
  for (const [k, v] of Object.entries({ ...app.pm2_env.env, ...app.pm2_env }))
    if (
      (k.startsWith("NEXT_PUBLIC_") || k === "BACKEND_URL") &&
      typeof v === "string"
    )
      env[k] = v;
  env.NEXT_PUBLIC_DIGITAL_TWIN_ENABLED = "true";
  await command(
    process.execPath,
    ["--test", "tests/digital-twin-automatic.test.cjs"],
    copy,
    log,
    env,
  );
  await command(
    process.execPath,
    ["node_modules/next/dist/bin/next", "build", "--webpack"],
    copy,
    log,
    env,
  );
  check(
    exists(copy + "/.next/server/app/stocks/digital-twin/page.js"),
    "Page absente du build",
  );
  check(
    JSON.stringify(snapshot(FRONT)) === JSON.stringify(before),
    "Code de production modifié pendant la compilation",
  );
  if (exists(FRONT + "/.next/static"))
    fs.cpSync(FRONT + "/.next/static", copy + "/.next/static", {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  function assets(dir) {
    fs.chmodSync(dir, 0o755);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      check(!e.isSymbolicLink(), "Lien inattendu dans les assets");
      const p = path.join(dir, e.name);
      if (e.isDirectory()) assets(p);
      else fs.chmodSync(p, 0o644);
    }
  }
  fs.chmodSync(copy + "/.next", 0o755);
  assets(copy + "/.next/static");
  check(
    fs.statSync(copy).dev === fs.statSync(FRONT).dev,
    "Bascule entre deux disques refusée",
  );
  const state = {
      status: "PREPARED",
      folder,
      tasks: ["app/stocks/digital-twin", "app/stocks/page.tsx", ".next"].map(
        (rel, i) => ({
          live: FRONT + "/" + rel,
          source: copy + "/" + rel,
          backup: folder + "/old-" + i,
          rejected: folder + "/rejected-" + i,
          started: false,
        }),
      ),
    },
    file = folder + "/state.json";
  journal(file, state);
  try {
    active();
    console.log("3/3 — Activation du frontend corrigé");
    state.status = "SWITCHING";
    journal(file, state);
    pm2("stop");
    for (const t of state.tasks) {
      active();
      t.started = true;
      journal(file, state);
      install(t);
    }
    pm2("restart");
    await ready();
    state.status = "DEPLOYED";
    journal(file, state);
    console.log(
      JSON.stringify(
        {
          status: "NAVIGATION_VIEW_DEPLOYED",
          url: "https://" + HOST + "/stocks/digital-twin",
          backup: folder,
          database_changes: false,
          backend_restarted: false,
          refresh_seconds: 15,
          rollback: "node " + folder + "/update.cjs --rollback " + folder,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    if (state.status === "SWITCHING") await rollback(state, file);
    throw e;
  }
}
if (require.main === module && !process.env.TRIANGLE_AUTO_LOCKED) {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const r = spawnSync(
    "flock",
    [
      "-n",
      ROOT + "/.activation.lock",
      process.execPath,
      __filename,
      ...process.argv.slice(2),
    ],
    { stdio: "inherit", env: { ...process.env, TRIANGLE_AUTO_LOCKED: "1" } },
  );
  process.exit(r.status === 0 ? 0 : r.status || 1);
}
if (require.main === module)
  main().catch((e) => {
    console.error("MISE À JOUR INTERROMPUE : " + e.message);
    process.exitCode = 1;
  });
module.exports = { install, restore, snapshot, addStockEntry };
