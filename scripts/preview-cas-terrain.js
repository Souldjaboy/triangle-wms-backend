"use strict";

/**
 * PREVIEW DES DEUX CAS TERRAIN RESTANTS — STRICTEMENT LECTURE SEULE.
 *
 * Ce script ne contient QUE des SELECT. Aucun emplacement créé, renommé ou
 * désactivé, aucun products.stock touché, aucune balance, aucune migration.
 *
 *   node scripts/preview-cas-terrain.js --company=<id> [--csv=fichier.csv]
 *
 * CAS 1 — un bin nommé « BIN2-3 » : un seul bac ainsi étiqueté, ou deux bacs
 *         voisins notés en raccourci ? La base ne permet pas de trancher.
 * CAS 2 — un emplacement « NOUVEAU / AUTO » : valeurs qui ressemblent à du
 *         remplissage automatique plutôt qu'à un repère de terrain.
 *
 * Pour chaque cas, le script montre l'existant puis ce que produirait CHACUNE
 * des décisions possibles. Il n'en applique aucune : c'est le terrain qui
 * tranche, pas la base.
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
const T = (v, w) => String(v ?? "—").slice(0, w).padEnd(w);

/* Repérage par MOTIF, jamais par identifiant en dur : les ids de production
   ne sont pas connus de ce dépôt, et un id recopié est un id faux. */
const MOTIF_PLAGE = "^(BIN[[:space:]]*)?[0-9]+[[:space:]]*[-/][[:space:]]*[0-9]+$";
const MOTIF_PLACEHOLDER = "^(NOUVEAU|AUTO|DEFAUT|DEFAULT|TEST|TEMP)$";

const COLONNES = `
  l.id, l.warehouse_id, l.warehouse_code, l.emplacement_code,
  COALESCE(NULLIF(l.rayon_code,''), l.zone)    AS row_code,
  COALESCE(NULLIF(l.case_code,''),  l.rayon)   AS loc_code,
  COALESCE(NULLIF(l.level_code,''), l.etagere) AS lvl_code,
  l.bin_code, l.product_id,
  p.name  AS produit,
  p.stock::numeric AS stock,
  p.reference AS reference`;

async function main() {
  const companyId = Number(arg("company"));
  if (!companyId) {
    console.error("Usage : node scripts/preview-cas-terrain.js --company=<id>");
    process.exit(1);
  }
  const q = async (sql, p = [companyId]) => (await pool.query(sql, p)).rows;

  const hasCol = async (t, c) => (await q(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [t, c]
  ))[0].n > 0;
  const aFusion = await hasCol("locations", "merged_into_location_id");
  /* Après 061a, on ne regarde que les emplacements VIVANTS : un doublon déjà
     rattaché n'est plus un cas à traiter. */
  const vivants = aFusion ? "AND l.merged_into_location_id IS NULL" : "";

  /* Toutes les colonnes qui référencent un emplacement, découvertes plutôt que
     supposées — celles de 061 n'existent pas encore. */
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
  const refsDe = async (id) => {
    const detail = [];
    let total = 0;
    for (const c of colonnes) {
      const r = await q(`SELECT COUNT(*)::int AS n FROM "${c.table_name}" WHERE "${c.column_name}" = $1`, [id]);
      if (r[0].n > 0) { detail.push(`${c.table_name}.${c.column_name}=${r[0].n}`); total += r[0].n; }
    }
    return { total, detail: detail.join(", ") || "aucune" };
  };

  const exportRows = [];

  const afficher = async (titre, lignes) => {
    console.log(`\n  ${T("LOC_ID", 8)}${T("ENTREPÔT", 11)}${T("ROW", 10)}${T("LOC", 10)}${T("LEVEL", 8)}` +
      `${T("BIN", 12)}${T("PROD_ID", 9)}${T("PRODUIT", 30)}${"STOCK".padStart(8)}${"RÉFS".padStart(6)}`);
    console.log("  " + "─".repeat(112));
    let stockTotal = 0, avecStock = 0;
    for (const l of lignes) {
      const r = await refsDe(l.id);
      const s = Number(l.stock || 0);
      if (l.product_id) { stockTotal += s; if (s > 0) avecStock += 1; }
      console.log(`  ${T(l.id, 8)}${T(l.warehouse_code, 11)}${T(l.row_code, 10)}${T(l.loc_code, 10)}` +
        `${T(l.lvl_code, 8)}${T(l.bin_code, 12)}${T(l.product_id, 9)}${T(l.produit, 30)}` +
        `${String(l.product_id ? n(s) : "—").padStart(8)}${String(r.total).padStart(6)}`);
      exportRows.push({
        cas: titre, location_id: l.id, warehouse: l.warehouse_code, row: l.row_code,
        location: l.loc_code, level: l.lvl_code, bin: l.bin_code,
        product_id: l.product_id ?? "", produit: l.produit ?? "",
        reference: l.reference ?? "", stock: l.product_id ? s : "",
        references: r.total, detail_references: r.detail,
      });
    }
    return { lignes: lignes.length, stockTotal, avecStock };
  };

  console.log("═".repeat(80));
  console.log("PREVIEW DES CAS TERRAIN — LECTURE SEULE, AUCUNE ÉCRITURE");
  console.log(`entreprise ${companyId} · ${new Date().toLocaleString("fr-FR")}`);
  console.log("═".repeat(80));

  // ══════════════════════════════════════════════════════════ CAS 1 — BIN2-3
  console.log("\n" + "═".repeat(80));
  console.log("CAS 1 — BIN NOMMÉ SOUS FORME DE PLAGE (« BIN2-3 »)");
  console.log("═".repeat(80));

  const cas1 = await q(
    `SELECT ${COLONNES}
       FROM locations l
       LEFT JOIN products p ON p.id = l.product_id AND p.company_id = l.company_id
      WHERE l.company_id = $1 ${vivants}
        AND TRIM(COALESCE(l.bin_code,'')) ~* '${MOTIF_PLAGE}'
      ORDER BY l.warehouse_code, l.bin_code, l.id`
  );
  if (!cas1.length) {
    console.log("\n  Aucun emplacement de ce type. Rien à décider.");
  } else {
    const bins = [...new Set(cas1.map((l) => `${l.warehouse_code} / ${l.row_code} / ${l.loc_code} / ${l.lvl_code} / ${l.bin_code}`))];
    console.log(`\n  ${cas1.length} ligne(s) sur ${bins.length} emplacement(s) :`);
    bins.forEach((b) => console.log(`    ${b}`));
    const s1 = await afficher("BIN2-3", cas1);
    const produits = [...new Set(cas1.map((l) => l.product_id).filter(Boolean))];

    console.log(`\n  ${n(s1.lignes)} ligne(s) · ${n(produits.length)} produit(s) distinct(s) · ` +
      `${n(s1.stockTotal)} unité(s) au total · ${n(s1.avecStock)} produit(s) avec du stock`);

    console.log("\n  ── SI DÉCISION A : UN SEUL emplacement physique nommé BIN2-3 ──");
    console.log(`     Conserver 1 emplacement canonique, rattacher les ${s1.lignes - 1} autres`);
    console.log("     lignes par merged_into_location_id, exactement comme 061a.");
    console.log(`     Les ${produits.length} produits restent DISTINCTS : aucune fusion de produit.`);
    console.log("     Aucun stock déplacé — chaque produit gardera sa quantité,");
    console.log("     et recevra sa propre balance en 061.");
    console.log("     Effet sur products.stock : AUCUN.");

    console.log("\n  ── SI DÉCISION B : DEUX emplacements distincts BIN2 et BIN3 ──");
    console.log("     Créer deux emplacements physiques BIN2 et BIN3 sous le même");
    console.log(`     ${cas1[0].warehouse_code} / ${cas1[0].row_code} / ${cas1[0].loc_code} / ${cas1[0].lvl_code}.`);
    console.log("     AUCUNE répartition automatique : rien ne dit lequel des deux bacs");
    console.log("     contient quoi. Les lignes actuelles deviennent un emplacement");
    console.log("     historique non résolu, et les produits ci-dessous passent en");
    console.log("     répartition manuelle, produit par produit :");
    const aRepartir = cas1.filter((l) => l.product_id && Number(l.stock) > 0);
    if (!aRepartir.length) console.log("       aucun produit avec du stock — rien à répartir");
    aRepartir.forEach((l) => console.log(
      `       ${T(l.produit, 34)} ${String(n(l.stock)).padStart(8)} unité(s)  → BIN2 ? BIN3 ?`));
    console.log(`     ${n(aRepartir.reduce((s, l) => s + Number(l.stock), 0))} unité(s) concernées.`);
    console.log("     Effet sur products.stock : AUCUN. La répartition dira OÙ,");
    console.log("     jamais COMBIEN — la somme saisie devra égaler le stock existant.");
  }

  // ═══════════════════════════════════════════════════ CAS 2 — NOUVEAU / AUTO
  console.log("\n" + "═".repeat(80));
  console.log("CAS 2 — EMPLACEMENT AUX COMPOSANTES GÉNÉRÉES (« NOUVEAU / AUTO »)");
  console.log("═".repeat(80));

  const cas2 = await q(
    `SELECT ${COLONNES}
       FROM locations l
       LEFT JOIN products p ON p.id = l.product_id AND p.company_id = l.company_id
      WHERE l.company_id = $1 ${vivants}
        AND (UPPER(TRIM(COALESCE(NULLIF(l.rayon_code,''), l.zone,  ''))) ~ '${MOTIF_PLACEHOLDER}'
          OR UPPER(TRIM(COALESCE(NULLIF(l.case_code,''),  l.rayon, ''))) ~ '${MOTIF_PLACEHOLDER}')
      ORDER BY l.warehouse_code, l.id`
  );
  if (!cas2.length) {
    console.log("\n  Aucun emplacement de ce type. Rien à décider.");
  } else {
    const s2 = await afficher("NOUVEAU/AUTO", cas2);
    const produits2 = [...new Set(cas2.map((l) => l.product_id).filter(Boolean))];
    console.log(`\n  ${n(s2.lignes)} ligne(s) · ${n(produits2.length)} produit(s) · ${n(s2.stockTotal)} unité(s)`);

    console.log("\n  ── SI DÉCISION A : c'est un VRAI emplacement physique ──");
    console.log("     Renseigner les vraies composantes (entrepôt / rayon / location /");
    console.log("     level / bin) : les lignes sont renommées, pas recréées, donc tout");
    console.log("     l'historique reste attaché. Puis consolidation normale si doublon.");
    console.log("     Effet sur products.stock : AUCUN.");

    console.log("\n  ── SI DÉCISION B : ancien placeholder ──");
    console.log("     Marquer l'emplacement non résolu : is_active = FALSE,");
    console.log("     occupancy_status = INACTIVE, full_code = NULL. Il sort de l'index");
    console.log("     unique de 061 et n'est jamais proposé comme destination.");
    console.log("     AUCUNE balance ne lui est créée.");
    const encoreEnStock = cas2.filter((l) => l.product_id && Number(l.stock) > 0);
    if (encoreEnStock.length) {
      console.log("\n     ATTENTION — ces produits ont encore du stock. Il n'est PAS mis à");
      console.log("     zéro : ils deviennent simplement non localisés, donc");
      console.log("     TO_REVIEW_LOCATION jusqu'à ce qu'un vrai bac leur soit attribué :");
      encoreEnStock.forEach((l) => console.log(
        `       ${T(l.produit, 34)} ${String(n(l.stock)).padStart(8)} unité(s) — à localiser`));
      console.log(`     ${n(encoreEnStock.reduce((s, l) => s + Number(l.stock), 0))} unité(s) à relocaliser manuellement.`);
    } else {
      console.log("\n     Aucun produit rattaché n'a de stock : rien à relocaliser.");
    }
  }

  // ───────────────────────────────────────────────────────────── invariants
  const inv = (await q(
    `SELECT COUNT(*)::int AS produits, COALESCE(SUM(stock),0)::numeric AS stock,
            COUNT(*) FILTER (WHERE stock < 0)::int AS negatifs
       FROM products WHERE company_id=$1 AND COALESCE(is_active,TRUE)=TRUE`
  ))[0];
  console.log("\n" + "═".repeat(80));
  console.log(`ÉTAT ACTUEL — produits ${n(inv.produits)} · stock ${n(inv.stock)} · négatifs ${n(inv.negatifs)}`);
  console.log("Aucune des deux décisions ne modifie products.stock, quelle qu'elle soit.");
  console.log("═".repeat(80));

  const csv = arg("csv");
  if (csv && exportRows.length) {
    const head = Object.keys(exportRows[0]);
    const esc = (v) => { const s = String(v ?? ""); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    fs.writeFileSync(csv, "﻿" + [head.join(","), ...exportRows.map((r) => head.map((h) => esc(r[h])).join(","))].join("\n"));
    console.log(`\nCSV écrit : ${csv}`);
  }
  console.log("\nAucun emplacement modifié. Aucun stock touché. Aucune migration exécutée.");
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
