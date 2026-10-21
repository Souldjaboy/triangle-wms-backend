"use strict";
/**
 * LA V16 RH FACE À LA NOUVELLE PARTIE A.
 *
 *   node scripts/comparer-rh-v16.js livraison/v16-recuperee
 *
 * Objectif : garder UNE seule interface RH. Ce rapport dit où les deux se
 * recouvrent, où elles divergent, et ce qu'il faut décider.
 *
 * Il ne décide rien lui-même et ne modifie aucun fichier. Fusionner deux
 * implémentations RH demande de savoir laquelle est déjà utilisée par qui ;
 * le logiciel ne le sait pas, vous si.
 */
const fs = require("fs");
const path = require("path");

const DOSSIER = process.argv[2];
const JSON_SEUL = process.argv.includes("--json");
const RACINE = path.join(__dirname, "..");
const log = (...a) => { if (!JSON_SEUL) console.log(...a); };

if (!DOSSIER || !fs.existsSync(DOSSIER)) {
  console.error("Usage : node scripts/comparer-rh-v16.js <dossier de la V16 récupérée>");
  console.error("Récupérez-la d'abord : livraison/recuperer-v16.sh utilisateur@vps");
  process.exit(1);
}

const lire = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const fichiersDe = (d) => { try { return fs.readdirSync(d).filter((f) => !f.startsWith(".")); } catch { return []; } };

/* Les routes déclarées dans un corpus de fichiers. */
function routesDe(textes) {
  const out = new Set();
  for (const t of textes) {
    /* `[^"'`\n]+` et pas `[^"'`]+` : le fichier liste-routes.txt contient des
       lignes TRONQUÉES, sans guillemet fermant. Sans exclure le retour à la
       ligne, le motif avalait la ligne suivante et fabriquait des routes
       fantômes comme « /rh/bulletins/:id\nrouter.get( ». */
    for (const m of t.matchAll(/(?:router|app)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`\n]+)/g)) {
      out.add(`${m[1].toUpperCase()} ${m[2]}`);
    }
    /* Le fichier liste-routes.txt du script de récupération. */
    for (const l of t.split("\n")) {
      const m = l.match(/\.(get|post|put|patch|delete)\(\s*["'`]([^"'`\n]+)/);
      if (m) out.add(`${m[1].toUpperCase()} ${m[2]}`);
    }
  }
  return out;
}

const tablesDe = (textes) => new Set(textes.flatMap((t) =>
  [...t.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:public\.)?["']?([a-z_][a-z0-9_]*)/gi)]
    .map((m) => m[1].toLowerCase())));

const modulesDe = (textes) => new Set(textes.flatMap((t) =>
  [...t.matchAll(/\b((?:rh|hr|paie)[a-z_]*(?:\.[a-z_]+)?)\s*\|/gi)].map((m) => m[1].toLowerCase())
    .concat([...t.matchAll(/'((?:rh|hr|paie)[a-z_]*\.[a-z_]+)'/gi)].map((m) => m[1].toLowerCase()))));

/* ─────────────────────────── LA V16 ─────────────────────────────────── */
const v16 = {
  routes: fichiersDe(path.join(DOSSIER, "routes")).map((f) => lire(path.join(DOSSIER, "routes", f))),
  services: fichiersDe(path.join(DOSSIER, "services")),
  sql: fichiersDe(path.join(DOSSIER, "sql")).map((f) => lire(path.join(DOSSIER, "sql", f))),
  schema: lire(path.join(DOSSIER, "schema", "tables-rh.sql")),
  migrations: lire(path.join(DOSSIER, "schema", "migrations-appliquees.txt")).split("\n").filter(Boolean),
  modules: lire(path.join(DOSSIER, "permissions", "modules-rh.txt")),
  droits: lire(path.join(DOSSIER, "permissions", "droits-par-role.txt")),
  frontend: fichiersDe(path.join(DOSSIER, "frontend")),
};

/* ───────────────────────── LA BRANCHE ───────────────────────────────── */
const branche = {
  routes: [lire(path.join(RACINE, "routes", "documents-rh.js"))],
  services: ["rh-bulletin.js", "pdf-documents-rh.js"],
  sql: [lire(path.join(RACINE, "sql", "154_documents_rh.sql"))],
};

const rapport = { genere_le: new Date().toISOString(), decisions: [] };

log(`\n${"═".repeat(74)}`);
log("  V16 RH (serveur)  ⟷  PARTIE A (branche)");
log("═".repeat(74));

/* ── 1. LES ROUTES ────────────────────────────────────────────────────── */
log("\n§1. ROUTES\n");
const rV16 = routesDe([...v16.routes, lire(path.join(DOSSIER, "routes", "liste-routes.txt"))]);
const rBr = routesDe(branche.routes);
const communes = [...rV16].filter((r) => rBr.has(r));
const seulesV16 = [...rV16].filter((r) => !rBr.has(r));
const seulesBr = [...rBr].filter((r) => !rV16.has(r));

log(`  V16     : ${rV16.size} route(s)`);
log(`  branche : ${rBr.size} route(s)`);
if (communes.length) {
  log(`\n  ✘ ${communes.length} route(s) DÉCLARÉES DES DEUX CÔTÉS :`);
  for (const r of communes.sort()) log(`      ${r}`);
  log("\n      Express retient la PREMIÈRE enregistrée : celle de la V16 si son");
  log("      routeur est monté avant. Le nouveau code serait donc inatteignable,");
  log("      sans la moindre erreur au démarrage. À trancher avant de déployer.");
  rapport.routes_en_double = communes;
  rapport.decisions.push("Choisir, pour chaque route commune, quel routeur la sert.");
}
if (seulesV16.length) {
  log(`\n  ${seulesV16.length} route(s) que SEULE la V16 porte :`);
  for (const r of seulesV16.sort()) log(`      ${r}`);
  log("      → à conserver, ou à reporter dans le nouveau routeur.");
  rapport.routes_v16_seules = seulesV16;
}
if (seulesBr.length) {
  log(`\n  ${seulesBr.length} route(s) que SEULE la branche apporte :`);
  for (const r of seulesBr.sort()) log(`      ${r}`);
  rapport.routes_branche_seules = seulesBr;
}
if (!rV16.size) log("  (aucune route V16 récupérée : le dossier routes/ est-il vide ?)");

/* ── 2. LES TABLES ────────────────────────────────────────────────────── */
log("\n§2. TABLES\n");
const tV16 = tablesDe([...v16.sql, v16.schema]);
const tBr = tablesDe(branche.sql);
const tCommunes = [...tV16].filter((t) => tBr.has(t));

log(`  V16     : ${[...tV16].join(", ") || "(aucune)"}`);
log(`  branche : ${[...tBr].join(", ") || "(aucune)"}`);

if (tCommunes.length) {
  log(`\n  ✘ ${tCommunes.length} table(s) de MÊME NOM des deux côtés : ${tCommunes.join(", ")}`);
  log("      La migration de la branche est idempotente : elle NE TOUCHERA PAS");
  log("      une table existante. Si sa forme diffère, les routes échoueront à");
  log("      l'exécution, pas au déploiement. Comparez les colonnes ci-dessous.");
  rapport.tables_en_double = tCommunes;
  rapport.decisions.push("Comparer colonne à colonne les tables de même nom.");

  /* Les colonnes, quand le schéma a été récupéré. */
  for (const t of tCommunes) {
    const colsV16 = colonnesDe(v16.schema || v16.sql.join("\n"), t);
    const colsBr = colonnesDe(branche.sql.join("\n"), t);
    if (!colsV16.size && !colsBr.size) continue;
    const manquantes = [...colsBr].filter((c) => !colsV16.has(c));
    const enTrop = [...colsV16].filter((c) => !colsBr.has(c));
    log(`\n      ${t}`);
    if (manquantes.length) log(`        attendues par la branche, absentes de la V16 : ${manquantes.join(", ")}`);
    if (enTrop.length) log(`        présentes en V16, inconnues de la branche      : ${enTrop.join(", ")}`);
    if (!manquantes.length && !enTrop.length) log("        mêmes colonnes des deux côtés");
  }
} else if (tV16.size && tBr.size) {
  log("\n  ✔ aucun nom de table partagé : les deux modèles coexistent sans se");
  log("    marcher dessus. Reste à décider lequel les écrans utilisent.");
  rapport.decisions.push("Choisir quel modèle de tables RH les écrans utilisent, et migrer l'autre.");
}

function colonnesDe(sql, table) {
  const re = new RegExp(`CREATE TABLE(?:\\s+IF NOT EXISTS)?\\s+(?:public\\.)?["']?${table}["']?\\s*\\(([\\s\\S]*?)\\n\\);`, "i");
  const m = sql.match(re);
  if (!m) return new Set();
  return new Set(m[1].split("\n")
    .map((l) => l.trim().split(/[\s(]/)[0].replace(/["',]/g, "").toLowerCase())
    .filter((c) => c && !/^(constraint|primary|foreign|unique|check|exclude)$/.test(c)));
}

/* ── 3. LES SERVICES ──────────────────────────────────────────────────── */
log("\n§3. SERVICES\n");
log(`  V16     : ${v16.services.join(", ") || "(aucun)"}`);
log(`  branche : ${branche.services.join(", ")}`);
const pdfV16 = v16.services.filter((f) => /pdf|modele|template/i.test(f));
if (pdfV16.length) {
  log(`\n  ! ${pdfV16.length} générateur(s) PDF côté V16 : ${pdfV16.join(", ")}`);
  log("      La branche en apporte un autre (pdf-documents-rh.js). Deux");
  log("      générateurs produiraient deux mises en page pour la même pièce,");
  log("      et personne ne s'en apercevrait avant qu'un salarié compare.");
  rapport.pdf_en_double = pdfV16;
  rapport.decisions.push("Garder UN seul générateur PDF pour les documents RH.");
}

/* ── 4. LES PERMISSIONS ───────────────────────────────────────────────── */
log("\n§4. PERMISSIONS\n");
const mV16 = modulesDe([v16.modules]);
log(`  modules V16     : ${[...mV16].join(", ") || "(aucun récupéré)"}`);
log("  module branche  : rh.document (actions : visible, view, create, update,");
log("                    delete, print, export, voir_remuneration)");
if (mV16.has("rh.document")) {
  log("\n  ✘ « rh.document » existe DÉJÀ côté V16.");
  log("      La migration 154 fusionne les actions sans écraser les droits");
  log("      existants (ON CONFLICT ... WHERE updated_by IS NULL). Vérifiez");
  log("      tout de même que les actions de la V16 gardent leur sens.");
  rapport.module_en_double = true;
  rapport.decisions.push("Vérifier que les actions de rh.document gardent leur sens des deux côtés.");
} else if (mV16.size) {
  log(`\n  ! la V16 utilise d'autres clés : ${[...mV16].join(", ")}`);
  log("      Un même écran gardé par deux clés différentes donne deux réponses");
  log("      à la même question. À unifier.");
  rapport.decisions.push("Unifier les clés de permission RH entre la V16 et la branche.");
}
const nDroits = v16.droits.split("\n").filter(Boolean).length;
if (nDroits) {
  log(`\n  ${nDroits} droit(s) par rôle déjà configurés côté V16.`);
  log("      Ils sont PRÉSERVÉS : la migration ne réécrit que les lignes dont");
  log("      updated_by est NULL, c'est-à-dire jamais touchées à la main.");
}

/* ── 5. LES ÉCRANS ────────────────────────────────────────────────────── */
log("\n§5. ÉCRANS\n");
log(`  V16     : ${v16.frontend.join(", ") || "(aucun récupéré)"}`);
log("  branche : aucun écran RH dédié — les routes existent, les écrans");
log("            restent à faire. Si la V16 en a, ce sont EUX qu'il faut");
log("            brancher sur le nouveau routeur.");
if (v16.frontend.length) {
  rapport.decisions.push("Brancher les écrans RH de la V16 sur les routes retenues.");
}

/* ── 6. LES MIGRATIONS ────────────────────────────────────────────────── */
log("\n§6. MIGRATIONS\n");
const mig106 = v16.migrations.filter((m) => /^106/.test(m));
if (mig106.length) {
  log(`  La V16 occupe le numéro 106 : ${mig106.join(", ")}`);
  log("  Les migrations de cette branche ont été renumérotées en 150–154 pour");
  log("  libérer la place. Aucune ambiguïté d'ordre ne subsiste.");
  rapport.migrations_v16 = mig106;
} else if (v16.migrations.length) {
  log(`  ${v16.migrations.length} migration(s) appliquées côté serveur.`);
} else {
  log("  (registre non récupéré)");
}

/* ── CE QU'IL RESTE À DÉCIDER ─────────────────────────────────────────── */
log(`\n${"═".repeat(74)}`);
if (rapport.decisions.length) {
  log(`  ${rapport.decisions.length} DÉCISION(S) À PRENDRE AVANT DE DÉPLOYER\n`);
  rapport.decisions.forEach((d, i) => log(`    ${i + 1}. ${d}`));
  log("\n  Ce rapport ne tranche pas : fusionner deux implémentations demande de");
  log("  savoir laquelle est déjà utilisée, et par qui.");
} else {
  log("  Aucun recouvrement détecté entre la V16 et la branche.");
}
log("\n  Aucun fichier n'a été modifié.");
log("═".repeat(74) + "\n");

if (JSON_SEUL) console.log(JSON.stringify(rapport, null, 2));
process.exitCode = rapport.decisions.length ? 2 : 0;
