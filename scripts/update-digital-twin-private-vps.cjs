#!/usr/bin/env node
"use strict";
// Accès privé : sauvegarde PostgreSQL, migration additive, backend et frontend contrôlés.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const BACK = "/var/www/triangle-wms/backend";
const FRONT = "/var/www/triangle-wms/frontend",
  ROOT = "/var/backups/triangle-digital-twin",
  HOST = "trianglewmspro.com";
const RELEASE = {
  "commit": "8cecca89880ecbaf5e4e92b0319334db91e4ebc0",
  "before": [
    {
      "app/stocks/digital-twin/Automatic2D.tsx": "22357f1c3c9664cec99f2450642578f0e8169f0ef2891a150a111a64bcdddc3f",
      "app/stocks/digital-twin/Configurator.tsx": "864c3966c508be2220fb499f9c5f19ca3f75d8031e71f2ce02543de6f69ec1b6",
      "app/stocks/digital-twin/Plan2D.tsx": "105f4b3278e36ba5c27a533378afc8c5264bc3ab825620225f34b9aeee1502af",
      "app/stocks/digital-twin/Plan3D.tsx": "b22752911d12851193d3457390203944a0aec42bd7961aada418eb97e219638a",
      "app/stocks/digital-twin/Scene.tsx": "e86d75c8bbe720e92613abf8184ef4937ac8f754d1e300449e736d3219daf9bc",
      "app/stocks/digital-twin/automatic.ts": "559113e53c0474153e70d07f2df45da7b0075caaca7b421404da5173d24825e9",
      "app/stocks/digital-twin/page.tsx": "1f7410d43ea750f469a2c4e4cc247993ca4e6b6ba5048b1c06817f251c16c47e",
      "app/stocks/digital-twin/twin.css": "84f1002cc8aa74ac329827637cd2ca669cf410324c6aa46fa79c8f6e02cd6626",
      "app/stocks/digital-twin/types.ts": "b402bb12e9297c4a9ae8253cea09dd28b578b9ff08a693404397966ffbca9745"
    },
    {
      "app/stocks/digital-twin/Automatic2D.tsx": "22357f1c3c9664cec99f2450642578f0e8169f0ef2891a150a111a64bcdddc3f",
      "app/stocks/digital-twin/Configurator.tsx": "864c3966c508be2220fb499f9c5f19ca3f75d8031e71f2ce02543de6f69ec1b6",
      "app/stocks/digital-twin/Navigation.tsx": "81b9e265f63d83581ad5613e2c07039cbf6732a055121b3639a6707547727048",
      "app/stocks/digital-twin/Plan2D.tsx": "105f4b3278e36ba5c27a533378afc8c5264bc3ab825620225f34b9aeee1502af",
      "app/stocks/digital-twin/Plan3D.tsx": "4c3dec09c40c08e4baf7632af8d405537b09d7a2a1bd054067135a9fdf3d0193",
      "app/stocks/digital-twin/Scene.tsx": "8c8493f7b2806180aec31203c8d7302c141cf463ce137808c1b18372e1803149",
      "app/stocks/digital-twin/automatic.ts": "7e94bf01049de02998d0157c3c0b14e3dbc1a54f10e82b6ae800f7ffd50639c6",
      "app/stocks/digital-twin/page.tsx": "e8cc9b542eab2b0dccd5d44c239b2769b88a3a44249cff6f0e26555813ba6e99",
      "app/stocks/digital-twin/scene-math.ts": "01405995cd8a167314d6ebf9e17d10a1715c95ed2a2b8147a579b74308d2a3d3",
      "app/stocks/digital-twin/twin.css": "ca7d309dfb531a230cd1b578c5967ed0e8dfa10c187b70fcd660e73a056b0549",
      "app/stocks/digital-twin/types.ts": "b402bb12e9297c4a9ae8253cea09dd28b578b9ff08a693404397966ffbca9745"
    }
  ],
  "after": {
    "app/stocks/digital-twin/Access.tsx": "8862325a4f7a3670ecc10be05d1fa3b9bd8fc2293f1c0c4ce23830449f82dcf0",
    "app/stocks/digital-twin/Automatic2D.tsx": "22357f1c3c9664cec99f2450642578f0e8169f0ef2891a150a111a64bcdddc3f",
    "app/stocks/digital-twin/Configurator.tsx": "864c3966c508be2220fb499f9c5f19ca3f75d8031e71f2ce02543de6f69ec1b6",
    "app/stocks/digital-twin/Navigation.tsx": "81b9e265f63d83581ad5613e2c07039cbf6732a055121b3639a6707547727048",
    "app/stocks/digital-twin/Plan2D.tsx": "105f4b3278e36ba5c27a533378afc8c5264bc3ab825620225f34b9aeee1502af",
    "app/stocks/digital-twin/Plan3D.tsx": "4c3dec09c40c08e4baf7632af8d405537b09d7a2a1bd054067135a9fdf3d0193",
    "app/stocks/digital-twin/Scene.tsx": "8c8493f7b2806180aec31203c8d7302c141cf463ce137808c1b18372e1803149",
    "app/stocks/digital-twin/automatic.ts": "7e94bf01049de02998d0157c3c0b14e3dbc1a54f10e82b6ae800f7ffd50639c6",
    "app/stocks/digital-twin/page.tsx": "e010427b1264c3d7fa8bdb95692af62813728b32653bf8287a3b3afff1af2f43",
    "app/stocks/digital-twin/scene-math.ts": "01405995cd8a167314d6ebf9e17d10a1715c95ed2a2b8147a579b74308d2a3d3",
    "app/stocks/digital-twin/twin.css": "ab52928eeda3e0904f4aab1f7692512e7dd25a0f5b50c70188db1bd5e5e5efad",
    "app/stocks/digital-twin/types.ts": "b402bb12e9297c4a9ae8253cea09dd28b578b9ff08a693404397966ffbca9745",
    "tests/digital-twin-automatic.test.cjs": "efd05f7c8d51fe9a6ffd1c331584aa73dd74a441e68906b6786d739d08ced419"
  }
};
const BACK_RELEASE = {
  "commit": "6368ccd5912b12094face8fc5d7c38bdceff04e9",
  "before": {
    "digital-twin/service.js": "1b417a510f8bab402c2db80e92cc3850a12575da45cb51fcf8b169de982d7d4a",
    "routes/digital-twin.js": "f8b9544c4fa1e148255cd257af34c40077a4f1d0f32bb6fc266f5d78b2c5fe2f",
    "digital-twin/model.js": "017c6d47cf3077c429ced17583103c9b7ed15f4deea9e0a55b5b3facddd17550"
  },
  "after": {
    "digital-twin/access.js": "587c49a3c2d96d33576117b8a5ddae6d96e630e2c32cbcb285b9459f97157728",
    "digital-twin/service.js": "083cef19828c277a3e5e3d099d07871ebbebcd452463155a94646b505a0d8f42",
    "routes/digital-twin.js": "78949ca40a7a6440958055ef9ee26af165cfac6f5d35c24aad5de50b452df04f",
    "sql/065_digital_twin_private_access.sql": "c3068972440f5e9a29ad08971e7aff18dcece632480803ce9463f2612d7d6ad0"
  }
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
  console.log("Retour arrière : module 3D fermé, restauration des fichiers…");
  const errors = [];
  // Persist the closed gate before restoring any older broad-access code.
  fs.appendFileSync(BACK+'/.env','\nDIGITAL_TWIN_ENABLED=false\n',{mode:0o600});
  try {run('pm2',['stop','triangle-backend']);}
  catch {state.status='ROLLBACK_REQUIRES_REVIEW';journal(file,state);throw new Error('Arrêt backend impossible : aucun ancien code réinstallé');}
  try {pm2('stop');}catch(e){errors.push(e.message);}
  for (const t of [...state.tasks].reverse())
    try {
      restore(t);
    } catch (e) {
      errors.push(e.message);
    }
  try {
    closeModule();
    pm2("restart");
    for(let i=0;i<25 && status("/login")!==200;i++)await new Promise(r=>setTimeout(r,1000));
    check(status("/login")===200,"Frontend à vérifier après restauration");
  } catch (e) {
    errors.push(e.message);
  }
  state.status = errors.length ? "ROLLBACK_REQUIRES_REVIEW" : "ROLLED_BACK";
  journal(file, state);
  check(!errors.length, "Retour arrière à vérifier : " + errors.join(" | "));
  console.log("Fichiers rétablis. Digital Twin désactivé pour conserver la confidentialité. Aucun stock modifié.");
}
function addStockEntry(source, ts) {
  const ast=ts.createSourceFile("page.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  check(ast.parseDiagnostics.length===0,"Page Stocks non analysable");
  if(source.includes('import DigitalTwinEntry from "./digital-twin/Access"'))return source;
  check(!/\bDigitalTwinEntry\b/.test(source),"Nom DigitalTwinEntry déjà utilisé");
  const headings=[],links=[];
  function visit(n){
    if(ts.isJsxElement(n)){
      if(n.openingElement.attributes.properties.some(a=>ts.isJsxAttribute(a)&&a.name.getText(ast)==='href'&&a.initializer&&ts.isStringLiteral(a.initializer)&&a.initializer.text==='/stocks/digital-twin'))links.push(n);
      if(n.openingElement.tagName.getText(ast)==='h1'&&n.children.every(c=>ts.isJsxText(c))&&n.children.map(c=>c.text).join('').trim()==='Stocks')headings.push(n);
    }
    ts.forEachChild(n,visit);
  }
  visit(ast);
  let edits=links.map(n=>({start:n.getStart(ast),end:n.end,text:'<DigitalTwinEntry />'}));
  if(!edits.length){check(headings.length===1,'Titre Stocks unique introuvable');edits.push({start:headings[0].end,end:headings[0].end,text:'\n<DigitalTwinEntry />\n'});}
  const directive=ast.statements[0];
  check(directive && ts.isExpressionStatement(directive)&&ts.isStringLiteral(directive.expression)&&directive.expression.text==='use client','Directive client Stocks introuvable');
  edits.push({start:directive.end,end:directive.end,text:'\nimport DigitalTwinEntry from "./digital-twin/Access";\n'});
  for(const e of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,e.start)+e.text+source.slice(e.end);
  check(ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX).parseDiagnostics.length===0,'Insertion privée invalide');
  return source;
}
function closeModule() {
  // Rollback must never reactivate the former broad-access backend.
  const envFile=BACK+'/.env';
  fs.appendFileSync(envFile,'\nDIGITAL_TWIN_ENABLED=false\n',{mode:0o600});
  run('pm2',['restart','triangle-backend','--update-env'],{env:{...process.env,DIGITAL_TWIN_ENABLED:'false'}});
  run('pm2',['save']);
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
      active();
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
      /^\/var\/backups\/triangle-digital-twin\/private-[A-Za-z0-9]+$/.test(
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
  const liveFiles=snapshot(FRONT+'/app/stocks/digital-twin');
  check(RELEASE.before.some(manifest=>Object.keys(manifest).length===Object.keys(liveFiles).length && Object.entries(manifest).every(([p,h])=>liveFiles[p.replace('app/stocks/digital-twin/','')]===h)),"Version du module frontend à examiner");
  check(apps.filter(a=>a.name==='triangle-backend').length===1,'Backend ambigu');
  const backend=apps.find(a=>a.name==='triangle-backend');
  check(backend.pm2_env.pm_cwd===BACK && backend.pm2_env.status==='online','Backend attendu indisponible');
  for(const [p,h] of Object.entries(BACK_RELEASE.before))check(hash(fs.readFileSync(BACK+'/'+p))===h,'Source backend modifiée : '+p);
  check(!exists(BACK+'/digital-twin/access.js'),'Contrôle privé déjà présent : vérifier la version');
  const beforeBack={module:snapshot(BACK+'/digital-twin'),route:hash(fs.readFileSync(BACK+'/routes/digital-twin.js')),server:hash(fs.readFileSync(BACK+'/server.js')),env:hash(fs.readFileSync(BACK+'/.env')),permissions:hash(fs.readFileSync(BACK+'/services/permissions.js'))};
  const {createRequire}=require('node:module'),requireBack=createRequire(BACK+'/package.json');
  const runtime={...requireBack('dotenv').parse(read(BACK+'/.env')),...process.env,...backend.pm2_env.env,...backend.pm2_env};
  check(typeof runtime.DATABASE_URL==='string','DATABASE_URL indisponible');
  check(runtime.DIGITAL_TWIN_ENABLED==='true','Module actuellement désactivé : activation à examiner');
  check((runtime.DEFAULT_TENANT_ID||'triangle')==='triangle','Tenant inattendu');
  check(/connectionString\s*:\s*process\.env\.DATABASE_URL\b/.test(read(BACK+'/server.js')),'Connexion backend à examiner');
  check(read(BACK+'/server.js').includes('if (process.env.DIGITAL_TWIN_ENABLED === "true") {'),'Interrupteur de confidentialité introuvable');
  const db=new (requireBack('pg').Client)({connectionString:runtime.DATABASE_URL});
  await db.connect();
  const owners=(await db.query("SELECT u.id,u.company_id,u.is_active,u.is_super_admin,u.role,c.tenant_id FROM users u LEFT JOIN companies c ON c.id=u.company_id WHERE lower(trim(u.email))='diallogcif@gmail.com'")).rows;
  check(owners.length===1 && owners[0].is_active===true && (owners[0].is_super_admin===true || owners[0].role.toLowerCase()==='super_admin') && owners[0].tenant_id==='triangle','Compte propriétaire absent, ambigu ou inactif');
  const owner=owners[0];
  await db.end();
  check(
    status("/login") === 200 && status("/api/digital-twin/warehouses") === 401,
    "État HTTP initial non conforme",
  );
  const free = fs.statfsSync(FRONT);
  check(free.bavail * free.bsize > 3 * 1024 ** 3, "Moins de 3 Gio disponibles");
  const before = snapshot(FRONT);
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const folder = fs.mkdtempSync(ROOT + "/private-"),
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
  const stageBack=folder+'/backend';
  fs.mkdirSync(stageBack+'/routes',{recursive:true});
  fs.cpSync(BACK+'/digital-twin',stageBack+'/digital-twin',{recursive:true});
  fs.copyFileSync(BACK+'/.env',folder+'/backend-env-before');
  fs.writeFileSync(folder+'/backend-source-before.json',JSON.stringify(beforeBack));
  await command('tar',['-cf',folder+'/backend-before.tar','-C',BACK,'digital-twin','routes/digital-twin.js','.env'],folder,log);
  fs.symlinkSync(BACK+'/node_modules',stageBack+'/node_modules','dir');
  for(const [file,h] of Object.entries(BACK_RELEASE.after)){
    const res=await fetch('https://raw.githubusercontent.com/Souldjaboy/triangle-wms-backend/'+BACK_RELEASE.commit+'/'+file,{signal:AbortSignal.timeout(60000)});
    check(res.ok,'Téléchargement backend impossible : '+file);const bytes=Buffer.from(await res.arrayBuffer());check(hash(bytes)===h,'Empreinte backend incorrecte : '+file);
    fs.mkdirSync(path.dirname(stageBack+'/'+file),{recursive:true});fs.writeFileSync(stageBack+'/'+file,bytes);
    if(file.endsWith('.js'))run(process.execPath,['--check',stageBack+'/'+file]);
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
  check(JSON.stringify(snapshot(BACK+'/digital-twin'))===JSON.stringify(beforeBack.module) && hash(fs.readFileSync(BACK+'/routes/digital-twin.js'))===beforeBack.route && hash(fs.readFileSync(BACK+'/server.js'))===beforeBack.server && hash(fs.readFileSync(BACK+'/.env'))===beforeBack.env && hash(fs.readFileSync(BACK+'/services/permissions.js'))===beforeBack.permissions,'Backend modifié pendant la préparation');
  console.log('Sauvegarde PostgreSQL avant restriction du module…');
  await dumpDatabase(runtime.DATABASE_URL,folder);
  const state = {
      status: "PREPARED",
      folder,
      owner_id: owner.id,
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
  state.tasks.push(...['digital-twin','routes/digital-twin.js'].map((rel,i)=>({live:BACK+'/'+rel,source:stageBack+'/'+rel,backup:folder+'/old-back-'+i,rejected:folder+'/rejected-back-'+i,started:false})));
  journal(file, state);
  try {
    active();
    console.log("3/3 — Activation privée : propriétaire unique et permissions explicites");
    state.status = "SWITCHING";
    journal(file, state);
    const migrationDb=new (requireBack('pg').Client)({connectionString:runtime.DATABASE_URL});
    await migrationDb.connect();
    try {await migrationDb.query(read(stageBack+'/sql/065_digital_twin_private_access.sql').replace(/^\\.*$/gm,''));}
    finally {await migrationDb.end();}
    pm2("stop");
    run('pm2',['stop','triangle-backend']);
    for (const t of state.tasks) {
      active();
      t.started = true;
      journal(file, state);
      install(t);
    }
    run('pm2',['restart','triangle-backend']);
    pm2("restart");
    await ready();
    check(status('/api/digital-twin/access')===401,'API privée sans JWT non protégée');
    const verify=new (requireBack('pg').Client)({connectionString:runtime.DATABASE_URL});await verify.connect();
    try {
      await verify.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const Access=require(BACK+'/digital-twin/access');
      check((await Access.read(verify,owner.id,owner.company_id)).isOwner,'Propriétaire non reconnu');
      const ownerContext=await require(BACK+'/digital-twin/service').context(verify,{user:{id:owner.id},tenant_id:'triangle',headers:{},query:{},body:{}},(_r,f)=>f);
      check(ownerContext.canView && ownerContext.canManageAccess,'Droits effectifs du propriétaire indisponibles');
      check(Number((await verify.query('SELECT COUNT(*) AS n FROM dt_module_access WHERE allowed=TRUE')).rows[0].n)===0,'Droits préexistants inattendus');
      const others=(await verify.query('SELECT id FROM users WHERE id<>$1 AND company_id=$2 AND is_active=TRUE LIMIT 20',[owner.id,owner.company_id])).rows;
      for(const u of others)check(!(await Access.read(verify,u.id,owner.company_id)).canView,'Accès non propriétaire inattendu');
      await verify.query('COMMIT');
    }finally{await verify.end();}
    state.status = "DEPLOYED";
    journal(file, state);
    console.log(
      JSON.stringify(
        {
          status: "PRIVATE_DIGITAL_TWIN_DEPLOYED",
          url: "https://" + HOST + "/stocks/digital-twin",
          backup: folder,
          database_changes: "additive_access_tables_only",
          owner: "diallogcif@gmail.com",
          initial_other_accounts_allowed: 0,
          backend_restarted: true,
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
module.exports = { install, restore, snapshot, addStockEntry, envForDump };
