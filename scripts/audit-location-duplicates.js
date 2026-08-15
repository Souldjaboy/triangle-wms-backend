"use strict";

/**
 * AUDIT DES CODES D'EMPLACEMENT EN DOUBLON — LECTURE SEULE.
 *
 * Ce script ne contient QUE des SELECT. Il ne fusionne rien, ne renomme rien,
 * ne désactive rien. Il DÉCRIT chaque groupe en doublon, le classe, et propose
 * une correction que seul un humain peut valider.
 *
 *   node scripts/audit-location-duplicates.js --company=<id> [--csv=fichier.csv]
 *
 * Les doublons sont bloquants : l'index unique de la migration 061 échouerait
 * tant qu'ils existent. C'est donc ce tableau qui conditionne le feu vert.
 */

require("dotenv").config();
const fs = require("fs");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
};
const n = (v) => Number(v || 0).toLocaleString("fr-FR");

/* ---------------------------------------------------------- classification */

/* Un emplacement de mise au rebut n'est pas un contenant physique : c'est un
   ÉTAT du produit. Il ne doit jamais être proposé comme destination. */
const WRITE_OFF_RE = /\bWRITE[\s_-]*OFF\b|\bREBUT\b|\bCASSE\b/i;
/* Un bin « non précisé » ne désigne aucun contenant : 37 produits qui le
   partagent ne sont pas dans le même bac, ils sont simplement non localisés. */
const NON_PRECISE_RE = /NON[\s_-]*PRECISE|NON[\s_-]*PRÉCIS|\bN\/?A\b|\bINCONNU\b|\bDIVERS\b|^-+$/i;

const CLASSES = {
  WRITE_OFF_LOCATION: "WRITE_OFF_LOCATION",
  BIN_NON_PRECISE: "BIN_NON_PRECISE",
  TRUE_DUPLICATE: "TRUE_DUPLICATE",
  SAME_PHYSICAL_BIN_DIFFERENT_PRODUCT: "SAME_PHYSICAL_BIN_DIFFERENT_PRODUCT",
  BAD_LEGACY_CODE: "BAD_LEGACY_CODE",
  TO_REVIEW: "TO_REVIEW",
};

/* Correction PROPOSÉE, jamais appliquée. */
const CORRECTION = {
  WRITE_OFF_LOCATION:
    "Exclure des emplacements physiques : is_active = FALSE, occupancy_status = INACTIVE, " +
    "aucun full_code. Le stock reste sur products.stock ; les produits concernés passent " +
    "TO_REVIEW_LOCATION jusqu'à ce qu'un bin réel leur soit affecté.",
  BIN_NON_PRECISE:
    "NE PAS créer un bin unique qui contiendrait tous ces produits — ils ne sont pas dans le " +
    "même bac. Conserver la ligne comme marqueur « à localiser », sans full_code ni balance. " +
    "Les produits rattachés passent TO_REVIEW_LOCATION.",
  TRUE_DUPLICATE:
    "Même bin physique, même produit (ou aucun) : une seule ligne doit survivre. Conserver " +
    "celle qui porte des mouvements ou des inventaires ; passer l'autre is_active = FALSE " +
    "sans la supprimer. Si les DEUX portent un historique, ne rien faire : TO_REVIEW.",
  SAME_PHYSICAL_BIN_DIFFERENT_PRODUCT:
    "Un bin peut légitimement contenir plusieurs produits — c'est précisément ce que les " +
    "balances permettent. Ces lignes sont un artefact du modèle « une ligne = un produit ». " +
    "Converger vers UNE seule ligne d'emplacement, puis une balance par produit. " +
    "La convergence doit être explicitement validée : elle change les rattachements.",
  BAD_LEGACY_CODE:
    "Composantes physiques incomplètes : la collision est accidentelle. Compléter " +
    "ROW / LOCATION / LEVEL / BIN pour rendre le code distinct. Ni fusion ni suppression.",
  TO_REVIEW:
    "Aucune règle ne tranche avec certitude. Décision humaine requise avant 061.",
};

const clean = (v) => String(v ?? "").trim();
const isWriteOff = (l) => [l.warehouse_code, l.row_code, l.loc_code, l.lvl_code, l.bin_code]
  .some((c) => WRITE_OFF_RE.test(clean(c)));
const isNonPrecise = (l) => !clean(l.bin_code) || NON_PRECISE_RE.test(clean(l.bin_code));

function classify(lignes) {
  if (lignes.some(isWriteOff)) return CLASSES.WRITE_OFF_LOCATION;
  if (lignes.every(isNonPrecise)) return CLASSES.BIN_NON_PRECISE;

  /* Composantes manquantes : le code entre en collision faute de précision. */
  const incomplet = lignes.some(
    (l) => !clean(l.row_code) || !clean(l.loc_code) || !clean(l.lvl_code)
  );
  if (incomplet) return CLASSES.BAD_LEGACY_CODE;

  const produits = new Set(lignes.map((l) => l.product_id).filter(Boolean));
  if (produits.size > 1) return CLASSES.SAME_PHYSICAL_BIN_DIFFERENT_PRODUCT;
  if (produits.size <= 1) return CLASSES.TRUE_DUPLICATE;
  return CLASSES.TO_REVIEW;
}

/* --------------------------------------------------------------------- main */

async function main() {
  const companyId = Number(arg("company"));
  if (!companyId) {
    console.error("Usage : node scripts/audit-location-duplicates.js --company=<id>");
    process.exit(1);
  }

  console.log("═".repeat(78));
  console.log("AUDIT DES DOUBLONS D'EMPLACEMENT — LECTURE SEULE, AUCUNE FUSION");
  console.log("═".repeat(78));

  const lignes = (await pool.query(
    `WITH codes AS (
       SELECT l.id, l.company_id, l.warehouse_id, l.warehouse_code,
              COALESCE(NULLIF(l.rayon_code,''), l.zone)    AS row_code,
              COALESCE(NULLIF(l.case_code,''),  l.rayon)   AS loc_code,
              COALESCE(NULLIF(l.level_code,''), l.etagere) AS lvl_code,
              l.bin_code, l.emplacement_code, l.status, l.product_id,
              l.product_reference, l.product_name AS location_product_name,
              ARRAY_TO_STRING(ARRAY[
                NULLIF(TRIM(COALESCE(l.warehouse_code,'')),''),
                NULLIF(TRIM(COALESCE(NULLIF(l.rayon_code,''), l.zone)),''),
                NULLIF(TRIM(COALESCE(NULLIF(l.case_code,''),  l.rayon)),''),
                NULLIF(TRIM(COALESCE(NULLIF(l.level_code,''), l.etagere)),''),
                NULLIF(TRIM(COALESCE(l.bin_code,'')),'')
              ], '-') AS full_code
         FROM locations l WHERE l.company_id = $1
     )
     SELECT c.*,
            p.name  AS product_name,
            p.stock::numeric AS product_stock,
            (SELECT COUNT(*)::int FROM stock_movements m
              WHERE m.company_id = c.company_id AND m.location_id = c.id) AS mouvements,
            (SELECT COUNT(*)::int FROM inventory_history i
              WHERE i.company_id = c.company_id
                AND UPPER(TRIM(COALESCE(i.location_code,''))) = UPPER(TRIM(COALESCE(c.emplacement_code,'')))
                AND COALESCE(c.emplacement_code,'') <> '') AS inventaires
       FROM codes c
       LEFT JOIN products p ON p.id = c.product_id AND p.company_id = c.company_id
      WHERE c.full_code IN (
              SELECT full_code FROM codes GROUP BY full_code HAVING COUNT(*) > 1)
      ORDER BY c.full_code, c.id`,
    [companyId]
  )).rows;

  if (!lignes.length) {
    console.log("\n  Aucun doublon de code complet. L'index unique de 061 peut être créé.");
    await pool.end();
    return;
  }

  const groupes = new Map();
  lignes.forEach((l) => {
    if (!groupes.has(l.full_code)) groupes.set(l.full_code, []);
    groupes.get(l.full_code).push(l);
  });

  console.log(`\n  ${groupes.size} groupe(s), ${lignes.length} ligne(s) d'emplacement concernées.`);
  console.log("  AUCUNE fusion, AUCUN renommage, AUCUNE désactivation n'est appliquée.\n");

  const parClasse = {};
  const exportRows = [];
  let i = 0;

  for (const [code, l] of groupes) {
    i += 1;
    const classe = classify(l);
    parClasse[classe] = (parClasse[classe] || 0) + 1;

    /* Ligne à conserver en priorité : celle qui porte le plus d'historique.
       PROPOSITION seulement — aucune ligne n'est touchée. */
    const trie = [...l].sort(
      (a, b) => (b.mouvements + b.inventaires) - (a.mouvements + a.inventaires) || a.id - b.id
    );
    const garder = trie[0];
    const avecHistorique = l.filter((x) => x.mouvements + x.inventaires > 0).length;

    console.log("─".repeat(78));
    console.log(`GROUPE ${i}/${groupes.size}  ${code}`);
    console.log(`  classe : ${classe}${avecHistorique > 1 ? "  ⚠ plusieurs lignes portent un historique" : ""}`);
    console.log(`  ${"LOC_ID".padEnd(8)}${"ENTREPÔT".padEnd(12)}${"ROW".padEnd(8)}${"LOC".padEnd(8)}` +
      `${"LEVEL".padEnd(8)}${"BIN".padEnd(16)}${"PROD_ID".padEnd(9)}${"PRODUIT".padEnd(26)}` +
      `${"STOCK".padStart(9)}${"MVTS".padStart(7)}${"INV".padStart(6)}`);
    for (const x of l) {
      console.log(`  ${String(x.id).padEnd(8)}${clean(x.warehouse_code).padEnd(12)}` +
        `${clean(x.row_code).slice(0, 7).padEnd(8)}${clean(x.loc_code).slice(0, 7).padEnd(8)}` +
        `${clean(x.lvl_code).slice(0, 7).padEnd(8)}${(clean(x.bin_code) || "— vide —").slice(0, 15).padEnd(16)}` +
        `${String(x.product_id ?? "—").padEnd(9)}${clean(x.product_name || x.location_product_name || "—").slice(0, 24).padEnd(26)}` +
        `${String(x.product_stock == null ? "—" : n(x.product_stock)).padStart(9)}` +
        `${String(x.mouvements).padStart(7)}${String(x.inventaires).padStart(6)}`);
      exportRows.push({
        groupe: i, full_code: code, classe,
        location_id: x.id, warehouse: x.warehouse_code, row: x.row_code,
        location: x.loc_code, level: x.lvl_code, bin: x.bin_code,
        emplacement_code: x.emplacement_code,
        product_id: x.product_id ?? "", product_name: x.product_name || x.location_product_name || "",
        products_stock: x.product_stock ?? "", location_product_id: x.product_id ?? "",
        mouvements: x.mouvements, inventaires: x.inventaires,
        conserver_propose: x.id === garder.id ? "OUI" : "non",
      });
    }
    console.log(`\n  CORRECTION PROPOSÉE — ${CORRECTION[classe]}`);
    if (classe === CLASSES.TRUE_DUPLICATE) {
      console.log(avecHistorique > 1
        ? `  ⚠ ${avecHistorique} lignes portent un historique : ne rien faire, passer ce groupe en TO_REVIEW.`
        : `  Ligne à conserver : ${garder.id} (${garder.mouvements} mvt, ${garder.inventaires} inv).`);
    }
    console.log("");
  }

  console.log("═".repeat(78));
  console.log("RÉCAPITULATIF PAR CLASSE");
  console.log("═".repeat(78));
  Object.entries(parClasse)
    .sort((a, b) => b[1] - a[1])
    .forEach(([c, k]) => console.log(`  ${c.padEnd(40)} ${String(k).padStart(3)} groupe(s)`));

  const bloquants = Object.entries(parClasse)
    .filter(([c]) => c !== CLASSES.WRITE_OFF_LOCATION && c !== CLASSES.BIN_NON_PRECISE)
    .reduce((s, [, k]) => s + k, 0);
  console.log(`\n  Groupes restant bloquants pour l'index unique : ${bloquants}`);
  console.log("  (WRITE_OFF et BIN_NON_PRECISE cessent de l'être une fois exclus");
  console.log("   des emplacements physiques : sans full_code, ils sortent de l'index.)");

  const csv = arg("csv");
  if (csv && exportRows.length) {
    const head = Object.keys(exportRows[0]);
    const esc = (v) => { const s = String(v ?? ""); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    fs.writeFileSync(csv, "﻿" + [head.join(","), ...exportRows.map((r) => head.map((h) => esc(r[h])).join(","))].join("\n"));
    console.log(`\n  CSV écrit : ${csv}  (fichier local, aucune donnée modifiée)`);
  }

  console.log("\n" + "═".repeat(78));
  console.log("Aucun emplacement fusionné, renommé ou désactivé. Aucune écriture.");
  console.log("═".repeat(78));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
