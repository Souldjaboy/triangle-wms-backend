"use strict";

/**
 * AUDIT DU STOCK ET DES EMPLACEMENTS — LECTURE SEULE.
 *
 * Ce script ne contient QUE des SELECT. Il n'écrit rien, ne crée rien, ne
 * modifie aucun stock. Il peut être lancé sur la production sans risque.
 *
 *   node scripts/audit-stock-locations.js --company=<id>
 *
 * Il répond aux questions de la partie D du cahier des charges : combien
 * d'entrepôts, d'emplacements, de bins, d'emplacements vides ; combien de
 * produits mono-emplacement, multi-emplacements, sans emplacement, ambigus ;
 * et quelle est la somme de stock réellement en base.
 */

require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
};
const n = (v) => Number(v || 0).toLocaleString("fr-FR");

/* Le code physique complet d'un emplacement : entrepôt + ROW + LOCATION +
   LEVEL + BIN. `emplacement_code` ne contient PAS le bin — deux bins d'un même
   niveau partagent le même code — d'où cette reconstruction. */
const FULL_CODE_SQL = `
  NULLIF(ARRAY_TO_STRING(ARRAY[
    NULLIF(TRIM(COALESCE(l.warehouse_code,'')),''),
    NULLIF(TRIM(COALESCE(NULLIF(l.rayon_code,''), l.zone)),''),
    NULLIF(TRIM(COALESCE(NULLIF(l.case_code,''),  l.rayon)),''),
    NULLIF(TRIM(COALESCE(NULLIF(l.level_code,''), l.etagere)),''),
    NULLIF(TRIM(COALESCE(l.bin_code,'')),'')
  ], '-'), '')`;

async function main() {
  const companyId = arg("company");
  const where = companyId ? "= $1" : "IS NOT NULL";
  const params = companyId ? [Number(companyId)] : [];
  const q = (sql) => pool.query(sql, params).then((r) => r.rows);

  console.log("═".repeat(70));
  console.log("AUDIT STOCK ET EMPLACEMENTS — LECTURE SEULE, AUCUNE ÉCRITURE");
  console.log(`entreprise : ${companyId || "toutes"}`);
  console.log("═".repeat(70));

  // ---------------------------------------------------------------- produits
  const [prod] = await q(`
    SELECT COUNT(*)::int AS produits,
           COALESCE(SUM(stock),0)::numeric AS stock_global,
           COUNT(*) FILTER (WHERE stock < 0)::int AS stock_negatif,
           COUNT(*) FILTER (WHERE COALESCE(location_code,'') = '' AND location_id IS NULL)::int AS sans_emplacement,
           COUNT(*) FILTER (WHERE location_id IS NOT NULL)::int AS avec_location_id,
           COUNT(*) FILTER (WHERE COALESCE(location_code,'') <> '')::int AS avec_location_code
      FROM products
     WHERE company_id ${where} AND COALESCE(is_active,TRUE) = TRUE`);

  console.log("\n── PRODUITS ──");
  console.log(`  produits actifs            ${n(prod.produits)}`);
  console.log(`  STOCK GLOBAL               ${n(prod.stock_global)}`);
  console.log(`  stock négatif              ${n(prod.stock_negatif)}`);
  console.log(`  avec location_id           ${n(prod.avec_location_id)}`);
  console.log(`  avec location_code         ${n(prod.avec_location_code)}`);
  console.log(`  sans aucun emplacement     ${n(prod.sans_emplacement)}`);

  // -------------------------------------------------------------- entrepôts
  const warehouses = await q(`
    SELECT w.code, w.name, w.status,
           COUNT(l.id)::int AS emplacements
      FROM warehouses w
      LEFT JOIN locations l ON l.warehouse_id = w.id AND l.company_id = w.company_id
     WHERE w.company_id ${where}
     GROUP BY w.id, w.code, w.name, w.status
     ORDER BY w.code`);

  console.log("\n── ENTREPÔTS ──");
  console.log(`  total ${warehouses.length}`);
  warehouses.forEach((w) =>
    console.log(`  ${String(w.code).padEnd(12)} ${String(w.name || "").padEnd(24)} ${String(w.status || "").padEnd(10)} ${n(w.emplacements)} emplacement(s)`));

  // ------------------------------------------------------------ emplacements
  const [loc] = await q(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE COALESCE(l.bin_code,'') <> '')::int AS avec_bin,
           COUNT(*) FILTER (WHERE COALESCE(l.bin_code,'') =  '')::int AS sans_bin,
           COUNT(*) FILTER (WHERE l.product_id IS NULL)::int AS sans_produit,
           COUNT(*) FILTER (WHERE l.product_id IS NOT NULL)::int AS avec_produit,
           COUNT(DISTINCT COALESCE(NULLIF(l.rayon_code,''), l.zone))::int  AS rayons,
           COUNT(DISTINCT COALESCE(NULLIF(l.case_code,''),  l.rayon))::int AS locations_c,
           COUNT(DISTINCT COALESCE(NULLIF(l.level_code,''), l.etagere))::int AS levels,
           COUNT(DISTINCT NULLIF(l.bin_code,''))::int AS bins_distincts
      FROM locations l WHERE l.company_id ${where}`);

  console.log("\n── EMPLACEMENTS ──");
  console.log(`  emplacements en base       ${n(loc.total)}`);
  console.log(`  avec un BIN renseigné      ${n(loc.avec_bin)}`);
  console.log(`  SANS bin                   ${n(loc.sans_bin)}`);
  console.log(`  rattachés à un produit     ${n(loc.avec_produit)}`);
  console.log(`  libres (aucun produit)     ${n(loc.sans_produit)}`);
  console.log(`  rayons / locations / levels / bins distincts : ` +
    `${n(loc.rayons)} / ${n(loc.locations_c)} / ${n(loc.levels)} / ${n(loc.bins_distincts)}`);

  /* Doublons de code complet : ils feraient ÉCHOUER l'index unique de la
     migration 061. À connaître AVANT de l'exécuter. */
  const dupes = await q(`
    SELECT ${FULL_CODE_SQL} AS full_code, COUNT(*)::int AS n
      FROM locations l WHERE l.company_id ${where}
     GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY 2 DESC LIMIT 20`);
  console.log(`\n  doublons de code complet   ${dupes.length}` +
    (dupes.length ? "  ← BLOQUANT pour l'index unique de 061" : "  ← aucun, index unique applicable"));
  dupes.forEach((d) => console.log(`    ${d.full_code} × ${d.n}`));

  /* Emplacements dont le code ne peut pas être reconstitué : ils resteront
     hors de l'index unique et devront être complétés à la main. */
  const [incomplet] = await q(`
    SELECT COUNT(*)::int AS n FROM locations l
     WHERE l.company_id ${where} AND ${FULL_CODE_SQL} IS NULL`);
  console.log(`  code incomplet             ${n(incomplet.n)}`);

  // -------------------------------------------- répartition produit/emplacement
  /* Combien de produits sont déjà connus sur PLUSIEURS emplacements ? C'est la
     question qui décide si la migration peut affecter tout le stock à un seul
     bin (A26) ou doit passer en TO_REVIEW_LOCATION. */
  const repartition = await q(`
    WITH liens AS (
      SELECT p.id AS product_id, l.id AS location_id
        FROM products p
        JOIN locations l ON l.company_id = p.company_id
                        AND (l.product_id = p.id
                             OR (COALESCE(p.location_code,'') <> ''
                                 AND UPPER(TRIM(l.emplacement_code)) = UPPER(TRIM(p.location_code))))
       WHERE p.company_id ${where} AND COALESCE(p.is_active,TRUE) = TRUE
       GROUP BY 1,2
    )
    SELECT CASE WHEN c = 0 THEN 'sans emplacement'
                WHEN c = 1 THEN 'mono-emplacement'
                ELSE 'multi-emplacements' END AS classe,
           COUNT(*)::int AS produits
      FROM (
        SELECT p.id, COUNT(liens.location_id)::int AS c
          FROM products p LEFT JOIN liens ON liens.product_id = p.id
         WHERE p.company_id ${where} AND COALESCE(p.is_active,TRUE) = TRUE
         GROUP BY p.id
      ) t GROUP BY 1 ORDER BY 1`);

  console.log("\n── RÉPARTITION PRODUIT → EMPLACEMENT ──");
  repartition.forEach((r) => console.log(`  ${String(r.classe).padEnd(22)} ${n(r.produits)}`));

  // ------------------------------------------------------------- mouvements
  const mouvements = await q(`
    SELECT type, status, COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE location_id IS NOT NULL)::int AS avec_location
      FROM stock_movements WHERE company_id ${where}
     GROUP BY 1,2 ORDER BY 3 DESC LIMIT 15`);
  console.log("\n── MOUVEMENTS ──");
  mouvements.forEach((m) =>
    console.log(`  ${String(m.type).padEnd(14)} ${String(m.status).padEnd(12)} ${String(n(m.n)).padStart(8)}  dont ${n(m.avec_location)} avec emplacement`));

  // ------------------------------------------------------------- inventaires
  const [inv] = await q(`
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE COALESCE(location_code,'') <> '')::int AS avec_location
      FROM inventory_history WHERE company_id ${where}`);
  console.log(`\n── INVENTAIRES ──\n  lignes ${n(inv.n)}, dont ${n(inv.avec_location)} avec un emplacement`);

  // ------------------------------------------------- balances déjà présentes ?
  const [{ exists }] = await pool.query(
    `SELECT COUNT(*)::int AS exists FROM pg_tables
      WHERE schemaname='public' AND tablename='stock_location_balances'`
  ).then((r) => r.rows);
  console.log(`\n── TABLE stock_location_balances ──\n  ${exists ? "DÉJÀ PRÉSENTE" : "absente — migration 061 nécessaire"}`);

  console.log("\n" + "═".repeat(70));
  console.log("Aucune écriture effectuée. Aucun stock modifié.");
  console.log("═".repeat(70));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
