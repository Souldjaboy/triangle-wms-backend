#!/usr/bin/env node
"use strict";
// Prépare et teste une copie privée. Aucun accès PostgreSQL, aucune mutation PM2,
// aucune migration, aucune écriture dans les répertoires de production.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const ROOT = "/var/www/triangle-wms";
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const read = (p) => fs.readFileSync(p, "utf8");
const MANIFEST = require("./stage-digital-twin-manifest.json");
function fail(message) {
  throw new Error(message);
}
function run(program, args, cwd) {
  return execFileSync(program, args, {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function logged(program, args, cwd, log, env = process.env) {
  const fd = fs.openSync(log, "a", 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(program, args, {
        cwd,
        env,
        stdio: ["ignore", fd, fd],
      });
      const timer = setTimeout(() => child.kill("SIGTERM"), 20 * 60 * 1000);
      const heartbeat = setInterval(
        () => console.log("  Vérification en cours…"),
        45000,
      );
      child.once("error", (e) => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        reject(e);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        code === 0
          ? resolve()
          : reject(
              new Error(
                "Commande échouée : " + program + " ; journal privé : " + log,
              ),
            );
      });
    });
  } finally {
    fs.closeSync(fd);
  }
}
async function download(repo, ref, file, dest, hash) {
  if (!/^[a-f0-9]{40}$/.test(ref) || file.includes(".."))
    fail("Référence candidate invalide");
  const res = await fetch(
    `https://raw.githubusercontent.com/Souldjaboy/${repo}/${ref}/${file}`,
    { signal: AbortSignal.timeout(60000) },
  );
  if (!res.ok) fail("Téléchargement impossible : " + file);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (sha(bytes) !== hash) fail("Empreinte candidate incorrecte : " + file);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(dest, bytes, { mode: 0o600, flag: "wx" });
}
function sourceFiles(dir) {
  const excluded = new Set([
    ".git",
    "node_modules",
    ".next",
    "uploads",
    "backups",
  ]);
  const out = {};
  function walk(current, prefix = "") {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (excluded.has(entry.name)) continue;
      const rel = prefix + entry.name,
        absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) fail("Lien symbolique à examiner : " + rel);
      if (entry.isDirectory()) walk(absolute, rel + "/");
      else if (entry.isFile()) out[rel] = sha(fs.readFileSync(absolute));
    }
  }
  walk(dir);
  return out;
}
async function main() {
  process.umask(0o077);
  const back = path.join(ROOT, "backend"),
    front = path.join(ROOT, "frontend");
  if (
    !fs.existsSync(path.join(back, "server.js")) ||
    !fs.existsSync(path.join(front, "package-lock.json"))
  )
    fail("Dossiers attendus introuvables");
  const apps = JSON.parse(run("pm2", ["jlist"], ROOT));
  for (const [name, cwd] of [
    ["triangle-backend", back],
    ["triangle-frontend", front],
  ]) {
    const found = apps.filter((a) => a.name === name);
    if (
      found.length !== 1 ||
      found[0].pm2_env.pm_cwd !== cwd ||
      found[0].pm2_env.status !== "online"
    )
      fail("Processus inattendu : " + name);
  }
  for (const [file, expected] of Object.entries(MANIFEST.live_hashes))
    if (sha(fs.readFileSync(path.join(ROOT, file))) !== expected)
      fail("Fichier de sécurité différent du diagnostic : " + file);
  const req = createRequire(path.join(front, "package.json"));
  const acorn = req("next/dist/compiled/acorn");
  const source = read(path.join(back, "server.js"));
  const ast = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
  });
  const changed = [];
  for (const [name, expected] of Object.entries(MANIFEST.functions)) {
    const n = ast.body.find(
      (n) => n.type === "FunctionDeclaration" && n.id.name === name,
    );
    if (!n || sha(source.slice(n.start, n.end)) !== expected)
      changed.push(name);
  }
  if (changed.length)
    fail(
      "Fonctions du serveur à examiner avant intégration : " +
        changed.join(", "),
    );
  if (source.includes("routes/digital-twin"))
    fail("Un module Digital Twin est déjà monté");
  const anchors = ast.body.filter(
    (n) =>
      n.type === "ExpressionStatement" &&
      n.expression.type === "CallExpression" &&
      n.expression.callee.type === "MemberExpression" &&
      n.expression.callee.object.name === "app" &&
      n.expression.callee.property.name === "listen",
  );
  if (anchors.length !== 1) fail("Point de montage du serveur ambigu");
  const free = fs.statfsSync(ROOT);
  if (free.bavail * free.bsize < 12 * 1024 ** 3)
    fail("Moins de 12 Gio disponibles pour la copie et la compilation");
  const parent = "/var/backups/triangle-digital-twin";
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(parent).isSymbolicLink())
    fail("Dossier de préparation non sûr");
  const stage = fs.mkdtempSync(path.join(parent, "candidate-"));
  fs.chmodSync(stage, 0o700);
  console.log("Préparation privée : " + stage);
  const frontStage = path.join(stage, "frontend"),
    backStage = path.join(stage, "backend");
  fs.mkdirSync(frontStage, { mode: 0o700 });
  fs.mkdirSync(backStage, { mode: 0o700 });
  const before = sourceFiles(front);
  fs.writeFileSync(
    path.join(stage, "frontend-before.json"),
    JSON.stringify(before),
  );
  // Archive de la source réelle, y compris les modifications locales et la
  // configuration privée. Elle reste sur le VPS, accessible seulement à root.
  console.log("1/4 — Copie et sauvegarde du frontend réel");
  const archive = path.join(stage, "frontend-before.tar");
  await logged(
    "tar",
    [
      "--exclude=./.git",
      "--exclude=./node_modules",
      "--exclude=./.next",
      "--exclude=./uploads",
      "--exclude=./backups",
      "-cf",
      archive,
      "-C",
      front,
      ".",
    ],
    ROOT,
    path.join(stage, "copy.log"),
  );
  await logged(
    "tar",
    ["-xf", archive, "-C", frontStage],
    ROOT,
    path.join(stage, "copy.log"),
  );
  if (JSON.stringify(sourceFiles(frontStage)) !== JSON.stringify(before))
    fail(
      "La source a changé pendant la copie ; recommencer hors modification de code",
    );
  fs.copyFileSync(
    path.join(back, "server.js"),
    path.join(stage, "server-before.js"),
  );
  for (const file of [
    "services/permissions.js",
    "services/location-rules.js",
    "rbac-triangle.js",
  ]) {
    const target = path.join(backStage, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(back, file), target);
  }
  console.log("2/4 — Chargement des seuls fichiers candidats vérifiés");
  for (const [side, meta] of Object.entries(MANIFEST.candidates)) {
    for (const [file, hash] of Object.entries(meta.files)) {
      const dest = path.join(side === "backend" ? backStage : frontStage, file);
      if (fs.existsSync(dest))
        fail(
          "La candidate remplacerait un fichier existant : " +
            side +
            "/" +
            file,
        );
      await download("triangle-wms-" + side, meta.commit, file, dest, hash);
    }
  }
  const mount =
    'if (process.env.DIGITAL_TWIN_ENABLED === "true") {\n  app.use("/digital-twin", require("./routes/digital-twin")({ pool, authenticateToken, getEffectiveCompanyId: getEffectiveCompanyIdStrict }));\n}\n\n';
  fs.writeFileSync(
    path.join(backStage, "server.js"),
    source.slice(0, anchors[0].start) + mount + source.slice(anchors[0].start),
  );
  run(process.execPath, ["--check", path.join(backStage, "server.js")], stage);
  const fp = JSON.parse(read(path.join(frontStage, "package.json")));
  for (const [section, deps] of Object.entries(MANIFEST.dependencies)) {
    fp[section] ??= {};
    for (const [name, version] of Object.entries(deps)) {
      if (fp[section][name] && fp[section][name] !== version)
        fail("Dépendance 3D déjà présente avec une autre version : " + name);
      fp[section][name] = version;
    }
  }
  fs.writeFileSync(
    path.join(frontStage, "package.json"),
    JSON.stringify(fp, null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(backStage, "package.json"),
    JSON.stringify({
      private: true,
      type: "commonjs",
      dependencies: MANIFEST.test_dependencies,
    }),
  );
  console.log("3/4 — Tests métier avec les permissions réelles du VPS");
  const env = { ...process.env, NODE_ENV: "development" };
  await logged(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    backStage,
    path.join(stage, "backend-tests.log"),
    env,
  );
  await logged(
    process.execPath,
    [
      "--test",
      "tests/digital-twin/model.test.js",
      "tests/digital-twin/integration.test.js",
    ],
    backStage,
    path.join(stage, "backend-tests.log"),
    env,
  );
  console.log("4/4 — Compilation de la copie du frontend réel");
  await logged(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    frontStage,
    path.join(stage, "frontend-build.log"),
    env,
  );
  const installed = JSON.parse(
    read(path.join(frontStage, "node_modules/next/package.json")),
  );
  if (installed.version !== "16.2.6") fail("La version de Next a changé");
  const liveApp = apps.find((a) => a.name === "triangle-frontend").pm2_env;
  const buildEnv = {
    ...process.env,
    NODE_ENV: "production",
    NEXT_PUBLIC_DIGITAL_TWIN_ENABLED: "true",
  };
  for (const [k, v] of Object.entries({ ...liveApp.env, ...liveApp }))
    if (k.startsWith("NEXT_PUBLIC_") && typeof v === "string") buildEnv[k] = v;
  buildEnv.NEXT_PUBLIC_DIGITAL_TWIN_ENABLED = "true";
  await logged(
    process.execPath,
    ["node_modules/next/dist/bin/next", "build", "--webpack"],
    frontStage,
    path.join(stage, "frontend-build.log"),
    buildEnv,
  );
  if (
    !fs.existsSync(
      path.join(frontStage, ".next/server/app/stocks/digital-twin/page.js"),
    )
  )
    fail("Route absente du build");
  if (
    JSON.stringify(sourceFiles(front)) !== JSON.stringify(before) ||
    read(path.join(back, "server.js")) !== source
  )
    fail(
      "Le code de production a changé pendant la préparation ; ne pas activer cette copie",
    );
  const report = {
    status: "CANDIDATE_COMPILED_NOT_DEPLOYED",
    directory: stage,
    backend_tests: "PASS",
    frontend_build: "PASS",
    production_files_changed: false,
    database_changes: false,
    services_restarted: false,
    source_frontend_files: Object.keys(before).length,
    backend_mount: "getEffectiveCompanyIdStrict",
    backend_port: typeof anchors[0].expression.arguments[0]?.value === "number"
      ? anchors[0].expression.arguments[0].value : null,
    frontend_pm2_args: Array.isArray(liveApp.args) && liveApp.args.every(
      (a) => /^(?:run|start|--|-p|--port|-H|--hostname|[0-9]{1,5}|127\.0\.0\.1|0\.0\.0\.0)$/.test(a),
    ) ? liveApp.args : null,
    frontend_port_env: /^[0-9]{1,5}$/.test(String(liveApp.PORT || liveApp.env?.PORT || ""))
      ? Number(liveApp.PORT || liveApp.env?.PORT) : null,
    live_backend_sha: sha(source),
    frontend_build_id: read(path.join(frontStage, ".next/BUILD_ID")).trim(),
  };
  fs.writeFileSync(
    path.join(stage, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  console.log(
    "Préparation terminée. Aucune migration ni activation. Conserver ce dossier pour la bascule et le retour arrière.",
  );
}
if (require.main === module)
  main().catch((e) => {
    console.error(
      "ARRÊT SANS DÉPLOIEMENT : " +
        (e.message?.includes("Command failed")
          ? "Précondition système non satisfaite."
          : e.message),
    );
    process.exitCode = 1;
  });
module.exports = { sourceFiles, sha };
