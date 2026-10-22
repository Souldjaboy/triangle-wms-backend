"use strict";
/**
 * CE QUE LA BRANCHE VEUT APPLIQUER, FACE À CE QUE LA BASE PORTE DÉJÀ.
 *
 *   DATABASE_URL=... node scripts/verifier-migrations.js
 *   DATABASE_URL=... node scripts/verifier-migrations.js --json
 *
 * STRICTEMENT EN LECTURE SEULE : transaction `READ ONLY`, donc une écriture
 * accidentelle échouerait avec le code PostgreSQL 25006 au lieu de passer.
 *
 * POURQUOI CE SCRIPT EXISTE
 *
 * Le numéro 106 est utilisé en production pour les documents RH (V16), et
 * cette migration n'est pas dans Git. Deux fichiers différents portant le
 * même numéro, c'est un ordre d'application ambigu et deux lignes de registre
 * qu'on croit être la même. Plutôt que de deviner ce que porte la production,
 * on va le lire.
 *
 * Il répond à trois questions :
 *   1. quels numéros sont déjà pris, et par quel fichier ;
 *   2. quelles migrations de la branche ne sont pas encore appliquées ;
 *   3. quels OBJETS que la branche veut créer existent déjà — c'est la
 *      question qui compte vraiment, le numéro n'étant qu'une étiquette.
 */
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const JSON_SEUL = process.argv.includes("--json");
const log = (...a) => { if (!JSON_SEUL) console.log(...a); };
const RACINE = path.join(__dirname, "..");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquant.");
  process.exit(1);
}

/* Les objets que chaque migration de la branche crée. Lus dans le fichier :
   une liste tenue à la main divergerait du jour au lendemain. */
function objetsCrees(chemin) {
  const sql = fs.readFileSync(chemin, "utf8");
  const trouve = (motif) => [...sql.matchAll(motif)].map((m) => m[1].toLowerCase());
  return {
    tables: [...new Set(trouve(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi))],
    vues:   [...new Set(trouve(/CREATE(?:\s+OR REPLACE)?\s+VIEW\s+([a-z_][a-z0-9_]*)/gi))],
    colonnes: [...new Set([...sql.matchAll(
      /ALTER TABLE\s+([a-z_][a-z0-9_]*)[\s\S]*?ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi)]
      .map((m) => `${m[1].toLowerCase()}.${m[2].toLowerCase()}`))],
    modules: [...new Set([...sql.matchAll(/'([a-z_]+(?:\.[a-z_]+)?)'\s*,\s*'[a-z_]*'\s*,\s*'[^']+'/gi)]
      .map((m) => m[1]).filter((m) => m.includes(".")))],
  };
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const rapport = { genere_le: new Date().toISOString(), conflits: [], a_appliquer: [], deja_present: [] };

  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '30s'");

    /* Ce que la base dit avoir appliqué. */
    const aRegistre = (await client.query(
      `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS existe`)).rows[0].existe;
    const appliquees = aRegistre
      ? (await client.query(`SELECT filename FROM schema_migrations ORDER BY filename`)).rows.map((r) => r.filename)
      : [];

    const fichiers = fs.readdirSync(path.join(RACINE, "sql"))
      .filter((f) => /^\d+_.*\.sql$/.test(f)).sort();

    /* Les objets réellement présents. */
    const tables = new Set((await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`
    )).rows.map((r) => r.table_name));
    const vues = new Set((await client.query(
      `SELECT table_name FROM information_schema.views WHERE table_schema='public'`
    )).rows.map((r) => r.table_name));
    const colonnes = new Set((await client.query(
      `SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema='public'`
    )).rows.map((r) => r.c));
    const modules = new Set(
      tables.has("permission_modules")
        ? (await client.query(`SELECT module_key FROM permission_modules`)).rows.map((r) => r.module_key)
        : []);

    log(`\n${"═".repeat(74)}`);
    log("  MIGRATIONS DE LA BRANCHE FACE À LA BASE");
    log("═".repeat(74));
    log(`\n  registre schema_migrations : ${aRegistre ? `${appliquees.length} entrée(s)` : "ABSENT"}`);
    log(`  fichiers dans la branche   : ${fichiers.length}`);

    /* ── 1. NUMÉROS EN DOUBLE ─────────────────────────────────────────── */
    log(`\n§1. NUMÉROS\n`);
    const parNumero = new Map();
    for (const f of [...new Set([...fichiers, ...appliquees])]) {
      const n = f.slice(0, f.indexOf("_"));
      if (!parNumero.has(n)) parNumero.set(n, new Set());
      parNumero.get(n).add(f);
    }
    /* DEUX SORTES DE DOUBLONS, ET UNE SEULE EST GRAVE.
       Un numéro porté par deux fichiers DU DÉPÔT est un désordre ancien :
       les deux sont connus, versionnés et déjà appliqués, l'ordre entre eux
       est figé depuis longtemps. Un numéro partagé entre un fichier de la
       branche et un fichier que SEULE LA BASE connaît, c'est autre chose :
       personne ne sait lequel doit passer en premier, ni ce que l'autre a
       fait. C'est celui-là qui bloque. */
    let bloquants = 0; let anciens = 0;
    for (const [n, noms] of [...parNumero].sort()) {
      if (noms.size < 2) continue;
      const horsBranche = [...noms].filter((x) => !fichiers.includes(x));
      const dansBranche = [...noms].filter((x) => fichiers.includes(x));
      /* Bloquant seulement si les DEUX côtés sont représentés : deux fichiers
         que seule la base connaît sont son affaire, pas la nôtre. */
      if (horsBranche.length && dansBranche.length) {
        bloquants += 1;
        rapport.conflits.push({ numero: n, fichiers: [...noms], gravite: "BLOQUANT" });
        log(`  ✘ numéro ${n} — COLLISION BRANCHE / BASE`);
        for (const nom of noms) {
          log(`      ${nom}  [${fichiers.includes(nom) ? "branche" : "BASE SEULEMENT"}`
            + `${appliquees.includes(nom) ? ", appliquée" : ""}]`);
        }
        log("      → renumérotez le fichier de la branche avant de déployer.");
      } else if (horsBranche.length) {
        rapport.conflits.push({ numero: n, fichiers: [...noms], gravite: "HORS_BRANCHE" });
        log(`  ! numéro ${n} porté par deux fichiers que la branche ne connaît pas :`);
        for (const nom of noms) log(`      ${nom}`);
        log("      → posés directement sur le serveur. À rapatrier dans Git.");
      } else {
        anciens += 1;
        rapport.conflits.push({ numero: n, fichiers: [...noms], gravite: "ANCIEN" });
      }
    }
    if (!bloquants) log("  ✔ aucun numéro partagé entre la branche et la base");
    if (anciens) {
      log(`\n  ${anciens} doublon(s) ANCIENS, internes au dépôt :`);
      for (const c of rapport.conflits.filter((x) => x.gravite === "ANCIEN")) {
        log(`      ${c.numero} : ${c.fichiers.join("  +  ")}`);
      }
      log("      → les deux fichiers sont versionnés et l'ordre entre eux est");
      log("        figé. Non bloquant, mais à ne pas reproduire.");
    }

    const enBase = appliquees.filter((a) => !fichiers.includes(a));
    if (enBase.length) {
      log(`\n  ${enBase.length} migration(s) appliquées en base et ABSENTES de la branche :`);
      for (const f of enBase) log(`      ${f}`);
      log("      → elles viennent d'ailleurs (V16 posée directement sur le serveur).");
      log("        Récupérez-les avec livraison/recuperer-v16.sh avant de déployer.");
      rapport.hors_branche = enBase;
    }

    /* ── 2. CE QUI RESTE À APPLIQUER ──────────────────────────────────── */
    log(`\n§2. À APPLIQUER\n`);
    const restantes = fichiers.filter((f) => !appliquees.includes(f));
    if (!restantes.length) log("  ✔ aucune : la base est à jour avec la branche");
    for (const f of restantes) { log(`      ${f}`); rapport.a_appliquer.push(f); }

    /* ── 3. LES OBJETS — LA VRAIE QUESTION ────────────────────────────── */
    log(`\n§3. OBJETS DÉJÀ PRÉSENTS\n`);
    log("  Un numéro est une étiquette ; ce qui compte est de savoir si la");
    log("  structure existe déjà. Une migration idempotente la saute ; une");
    log("  structure de MÊME NOM mais de forme différente est un vrai danger.\n");

    let dejaLa = 0;
    for (const f of restantes) {
      const o = objetsCrees(path.join(RACINE, "sql", f));
      const presents = {
        tables: o.tables.filter((t) => tables.has(t)),
        vues: o.vues.filter((v) => vues.has(v)),
        colonnes: o.colonnes.filter((c) => colonnes.has(c)),
        modules: o.modules.filter((m) => modules.has(m)),
      };
      const total = Object.values(presents).reduce((n, x) => n + x.length, 0);
      if (!total) continue;
      dejaLa += 1;
      rapport.deja_present.push({ fichier: f, ...presents });
      log(`  ${f}`);
      for (const [quoi, liste] of Object.entries(presents)) {
        if (liste.length) log(`      ${quoi.padEnd(9)} déjà là : ${liste.join(", ")}`);
      }
    }
    if (!dejaLa) log("  ✔ aucune structure de la branche n'existe déjà en base");

    /* ── 4. LE CAS RH ─────────────────────────────────────────────────── */
    log(`\n§4. DOCUMENTS RH (V16)\n`);
    const rhConnues = ["hr_contracts", "hr_documents", "hr_contract_clauses"];
    const rhAutres = [...tables].filter((t) =>
      /^(hr_|rh_)/.test(t) && !rhConnues.includes(t));
    const rhMiennes = rhConnues.filter((t) => tables.has(t));
    if (rhMiennes.length) {
      log(`  ! ${rhMiennes.join(", ")} existent déjà.`);
      log("    La migration 154 est idempotente et ne les écrasera pas, MAIS si");
      log("    leur forme diffère, les routes échoueront. Comparez avant.");
      rapport.rh_existantes = rhMiennes;
    } else {
      log("  ✔ aucune table hr_contracts / hr_documents / hr_contract_clauses");
    }
    if (rhAutres.length) {
      log(`\n  ${rhAutres.length} table(s) RH d'un AUTRE modèle en base :`);
      for (const t of rhAutres) log(`      ${t}`);
      log("      → ce sont probablement les tables de la V16.");
      log("        Ne déployez pas 154 avant de les avoir comparées.");
      rapport.rh_v16 = rhAutres;
    }

    /* ── VERDICT ──────────────────────────────────────────────────────────
     *
     * DEUX SITUATIONS QU'IL NE FAUT PAS CONFONDRE.
     *
     * Un CONFLIT (code 2) : la branche veut créer une structure qui existe
     * déjà, ou un numéro est représenté des deux côtés. Appliquer par-dessus
     * laisserait le registre et le schéma en désaccord. Cela doit arrêter un
     * déploiement, sans exception.
     *
     * Une RECONNAISSANCE À FAIRE (code 3) : les tables RH de la V16 sont là.
     * Elles y seront TOUJOURS — c'est la production. En faire un blocage
     * permanent reviendrait à interdire tout déploiement pour de bon. Il faut
     * donc une reconnaissance explicite, une fois, de la part de la personne
     * qui déploie : elle atteste avoir comparé les deux modèles.
     *
     * Les mélanger, comme le faisait la première version de ce script,
     * transforme un garde-fou utile en porte murée.
     */
    const conflit = bloquants > 0;
    const aReconnaitre = (rapport.rh_v16 || []).length > 0 || (rapport.rh_existantes || []).length > 0;
    const reconnu = process.env.V16_RH_RECONCILIEE === "oui";

    log(`\n${"═".repeat(74)}`);
    if (conflit) {
      log("  VERDICT : NE PAS DÉPLOYER. Conflit réel de structures — voir §1.");
    } else if (aReconnaitre && !reconnu) {
      log("  VERDICT : aucun conflit de structures. Mais les tables RH de la V16");
      log("  sont en base, et leur modèle n'a pas été déclaré comparé.");
      log("");
      log("  Comparez-les (scripts/comparer-rh-v16.js), puis déployez avec :");
      log("      V16_RH_RECONCILIEE=oui ./livraison/deployer.sh deployer");
      log("");
      log("  Cette reconnaissance ne modifie rien : elle atteste seulement que");
      log("  vous avez vu les deux modèles et choisi de les laisser coexister.");
    } else if (aReconnaitre) {
      log("  VERDICT : aucun conflit. Coexistence avec la V16 RH reconnue.");
    } else {
      log("  VERDICT : aucun conflit bloquant détecté.");
    }
    log("  Aucune écriture n'a été tentée : transaction en lecture seule.");
    log("═".repeat(74) + "\n");

    rapport.conflit = conflit;
    rapport.reconnaissance_requise = aReconnaitre && !reconnu;
    rapport.bloquant = conflit;   /* conservé : d'anciens appels le lisent */
    if (JSON_SEUL) console.log(JSON.stringify(rapport, null, 2));
    process.exitCode = conflit ? 2 : (aReconnaitre && !reconnu ? 3 : 0);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
})().catch((e) => { console.error("Vérification impossible :", e.message); process.exit(1); });
