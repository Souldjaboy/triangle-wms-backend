"use strict";

/**
 * VÉRIFICATION POST-061a — STRICTEMENT LECTURE SEULE.
 *
 * Ce script ne contient QUE des SELECT. Aucune écriture, aucune migration,
 * aucun stock touché. Il peut être relancé autant de fois que voulu.
 *
 *   node scripts/verify-061a.js --company=<id> \
 *        [--produits=247] [--stock=151237] [--fusions=10]
 *
 * Il vérifie que l'état issu de 061a est celui attendu, et que 061 n'a PAS
 * été exécutée. Chaque contrôle sort OK ou ÉCHEC ; le code de sortie est 1
 * si un seul échoue, pour être utilisable dans un enchaînement.
 */

require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
};
const n = (v) => Number(v || 0).toLocaleString("fr-FR");

let ok = 0, ko = 0;
const chk = (label, cond, detail = "") => {
  if (cond) { ok += 1; console.log(`  OK    ${label}${detail ? "   " + detail : ""}`); }
  else { ko += 1; console.log(`  ÉCHEC ${label}${detail ? "   " + detail : ""}`); }
};

const WRITE_OFF = "(WRITE[[:space:]_-]*OFF|REBUT|CASSE)";
const NON_PRECISE = "(NON[[:space:]_-]*PRECISE|NON[[:space:]_-]*PRÉCIS|INCONNU|DIVERS)";
const PLAGE = "^(BIN[[:space:]]*)?[0-9]+[[:space:]]*[-/][[:space:]]*[0-9]+$";
const PLACEHOLDER = "^(NOUVEAU|AUTO|DEFAUT|DEFAULT|TEST|TEMP|X+|-+|0+)$";

async function main() {
  const companyId = Number(arg("company"));
  if (!companyId) {
    console.error("Usage : node scripts/verify-061a.js --company=<id>");
    process.exit(1);
  }
  const attendu = {
    produits: Number(arg("produits", 247)),
    stock: Number(arg("stock", 151237)),
    fusions: Number(arg("fusions", 10)),
  };
  const q = async (sql, p = [companyId]) => (await pool.query(sql, p)).rows;
  const un = async (sql, p = [companyId]) => (await q(sql, p))[0];

  console.log("═".repeat(76));
  console.log("VÉRIFICATION POST-061a — LECTURE SEULE, AUCUNE ÉCRITURE");
  console.log(`entreprise ${companyId} · ${new Date().toLocaleString("fr-FR")}`);
  console.log("═".repeat(76));

  const hasCol = async (t, c) => (await un(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [t, c]
  )).n > 0;

  // ------------------------------------------------------------ §1 invariants
  console.log("\n── STOCK ET PRODUITS ──");
  const p = await un(
    `SELECT COUNT(*)::int AS produits,
            COALESCE(SUM(stock),0)::numeric AS stock,
            COUNT(*) FILTER (WHERE stock < 0)::int AS negatifs
       FROM products WHERE company_id=$1 AND COALESCE(is_active,TRUE)=TRUE`
  );
  chk(`produits = ${attendu.produits}`, Number(p.produits) === attendu.produits, `trouvé ${n(p.produits)}`);
  chk(`stock total = ${n(attendu.stock)}`, Number(p.stock) === attendu.stock, `trouvé ${n(p.stock)}`);
  chk("stocks négatifs = 0", Number(p.negatifs) === 0, `trouvé ${n(p.negatifs)}`);

  // ------------------------------------------------------------ §2 fusions
  console.log("\n── CONSOLIDATION ──");
  const aFusion = await hasCol("locations", "merged_into_location_id");
  chk("colonne merged_into_location_id présente", aFusion,
    aFusion ? "" : "061a n'a pas été appliquée");
  if (!aFusion) { await fin(); return; }

  const l = await un(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE merged_into_location_id IS NOT NULL)::int AS fusionnees,
            COUNT(*) FILTER (WHERE merged_into_location_id IS NULL)::int      AS vivantes
       FROM locations WHERE company_id=$1`
  );
  chk(`locations fusionnées = ${attendu.fusions}`, Number(l.fusionnees) === attendu.fusions,
    `trouvé ${n(l.fusionnees)} sur ${n(l.total)} emplacements`);

  const fusions = await q(
    `SELECT d.id AS doublon, d.merged_into_location_id AS canonique,
            COALESCE(c.full_code, c.emplacement_code) AS code,
            COALESCE(d.is_active, TRUE) AS doublon_actif
       FROM locations d LEFT JOIN locations c ON c.id = d.merged_into_location_id
      WHERE d.company_id=$1 AND d.merged_into_location_id IS NOT NULL
      ORDER BY d.id`
  );
  console.log(`\n  ${"DOUBLON".padEnd(10)}${"→".padEnd(4)}${"CANONIQUE".padEnd(12)}EMPLACEMENT`);
  fusions.forEach((f) => console.log(
    `  ${String(f.doublon).padEnd(10)}${"→".padEnd(4)}${String(f.canonique).padEnd(12)}${f.code || "—"}`));
  chk("tous les doublons sont désactivés",
    fusions.every((f) => f.doublon_actif === false), `${fusions.filter((f) => f.doublon_actif !== false).length} encore actif(s)`);
  chk("aucun canonique n'est lui-même fusionné",
    !fusions.some((f) => fusions.some((g) => g.doublon === f.canonique)));

  // ------------------------------------------------- §3 références orphelines
  console.log("\n── RÉFÉRENCES VERS LES DOUBLONS ──");
  const colonnes = await q(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_name=c.table_name AND t.table_schema=c.table_schema
      WHERE c.table_schema='public' AND t.table_type='BASE TABLE'
        AND c.column_name ~ '(^|_)location_id$' AND c.table_name <> 'locations'
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu ON kcu.constraint_name=tc.constraint_name
            JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name
           WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_name=c.table_name
             AND kcu.column_name=c.column_name AND ccu.table_name <> 'locations')
      ORDER BY 1,2`, []
  );
  let orphelines = 0;
  for (const c of colonnes) {
    const r = await un(
      `SELECT COUNT(*)::int AS n FROM "${c.table_name}" x
         JOIN locations l ON l.id = x."${c.column_name}"
        WHERE l.merged_into_location_id IS NOT NULL`, []
    );
    orphelines += r.n;
    if (r.n > 0) console.log(`    ${c.table_name}.${c.column_name} : ${r.n}`);
  }
  chk("aucune référence active vers un doublon", orphelines === 0,
    `${colonnes.length} colonne(s) inspectée(s), ${orphelines} référence(s)`);

  // ------------------------------------------------------ §4 groupes restants
  console.log("\n── DOUBLONS RESTANTS PARMI LES EMPLACEMENTS VIVANTS ──");
  const restants = await q(
    `WITH vivants AS (
       SELECT l.id, l.warehouse_id, l.bin_code,
              UPPER(TRIM(COALESCE(NULLIF(l.rayon_code,''), l.zone,    ''))) AS r,
              UPPER(TRIM(COALESCE(NULLIF(l.case_code, ''), l.rayon,   ''))) AS c,
              UPPER(TRIM(COALESCE(NULLIF(l.level_code,''), l.etagere, ''))) AS lv,
              ARRAY_TO_STRING(ARRAY[
                NULLIF(TRIM(COALESCE(l.warehouse_code,'')),''),
                NULLIF(TRIM(COALESCE(NULLIF(l.rayon_code,''), l.zone)),''),
                NULLIF(TRIM(COALESCE(NULLIF(l.case_code,''),  l.rayon)),''),
                NULLIF(TRIM(COALESCE(NULLIF(l.level_code,''), l.etagere)),''),
                NULLIF(TRIM(COALESCE(l.bin_code,'')),'')
              ], '-') AS fc
         FROM locations l
        WHERE l.company_id=$1 AND l.merged_into_location_id IS NULL
     )
     SELECT fc, COUNT(*)::int AS lignes, ARRAY_AGG(id ORDER BY id) AS ids,
            CASE
              WHEN BOOL_OR(fc ~* '${WRITE_OFF}' OR COALESCE(bin_code,'') ~* '${WRITE_OFF}')
                THEN 'WRITE_OFF_EXCLUDE'
              WHEN BOOL_AND(COALESCE(TRIM(bin_code),'') = '' OR bin_code ~* '${NON_PRECISE}')
                THEN 'LOCATION_UNRESOLVED'
              WHEN BOOL_OR(TRIM(COALESCE(bin_code,'')) ~* '${PLAGE}')
                THEN 'TO_REVIEW_BIN_STRUCTURE'
              WHEN BOOL_OR(r ~ '${PLACEHOLDER}') OR BOOL_OR(c ~ '${PLACEHOLDER}')
                THEN 'LEGACY_PLACEHOLDER'
              ELSE 'CONSOLIDATE'
            END AS classe
       FROM vivants GROUP BY fc HAVING COUNT(*) > 1 ORDER BY 4, 1`
  );
  const par = (k) => restants.filter((x) => x.classe === k);
  restants.forEach((g) => console.log(
    `  ${g.classe.padEnd(26)} ${String(g.fc).padEnd(38)} ${g.lignes} lignes (${g.ids.join(", ")})`));
  if (!restants.length) console.log("  aucun");

  console.log("");
  chk("0 groupe physique encore consolidable", par("CONSOLIDATE").length === 0,
    `${par("CONSOLIDATE").length} trouvé(s)`);
  chk("BIN2-3 reste TO_REVIEW_BIN_STRUCTURE", par("TO_REVIEW_BIN_STRUCTURE").length >= 1,
    par("TO_REVIEW_BIN_STRUCTURE").map((g) => g.fc).join(", ") || "aucun");
  chk("NOUVEAU/AUTO reste LEGACY_PLACEHOLDER", par("LEGACY_PLACEHOLDER").length >= 1,
    par("LEGACY_PLACEHOLDER").map((g) => g.fc).join(", ") || "aucun");
  chk("BIN-NON-PRECISE hors migration physique", par("LOCATION_UNRESOLVED").length >= 1,
    `${par("LOCATION_UNRESOLVED").length} groupe(s)`);
  chk("WRITE OFF hors migration physique", par("WRITE_OFF_EXCLUDE").length >= 1,
    `${par("WRITE_OFF_EXCLUDE").length} groupe(s)`);

  // ---------------------------------------------------------- §5 061 non faite
  console.log("\n── 061 NE DOIT PAS AVOIR ÉTÉ EXÉCUTÉE ──");
  const t = await un(
    `SELECT COUNT(*)::int AS n FROM pg_tables
      WHERE schemaname='public' AND tablename='stock_location_balances'`, []
  );
  chk("stock_location_balances absente", t.n === 0, t.n ? "PRÉSENTE — 061 a été exécutée" : "");

  await fin();
}

async function fin() {
  console.log("\n" + "═".repeat(76));
  console.log(`RÉSULTAT : ${ok} contrôle(s) OK, ${ko} en échec`);
  console.log("Aucune donnée modifiée. Aucune migration exécutée.");
  console.log("═".repeat(76));
  await pool.end();
  process.exit(ko ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
