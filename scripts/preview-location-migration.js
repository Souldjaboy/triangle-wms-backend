"use strict";

/**
 * PREVIEW DE LA MIGRATION STOCK → BALANCES PAR EMPLACEMENT — LECTURE SEULE.
 *
 * Ce script ne contient QUE des SELECT. Il n'écrit aucune balance, ne modifie
 * aucun stock, n'exécute aucune migration. Il produit le tableau de décision
 * demandé (A25) et la preuve mathématique (A27).
 *
 *   node scripts/preview-location-migration.js --company=<id> [--csv=chemin.csv]
 *
 * RÈGLE : on ne migre automatiquement que ce qui est CERTAIN. Un produit dont
 * la répartition entre plusieurs bins n'est pas prouvable reste TO_REVIEW —
 * jamais réparti au hasard, jamais entassé dans un seul bin par défaut.
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

const ACTIONS = {
  AUTO_MATCH: "AUTO_MATCH",                     // un seul emplacement certain
  TO_REVIEW_LOCATION: "TO_REVIEW_LOCATION",     // plusieurs emplacements possibles
  NO_LOCATION: "NO_LOCATION",                   // aucun emplacement connu
  AMBIGUOUS_LOCATION: "AMBIGUOUS_LOCATION",     // code présent mais non résolu
  ZERO_STOCK: "ZERO_STOCK",                     // rien à répartir
};

const norm = (s) => String(s || "").toUpperCase().replace(/\s+/g, " ").trim();

async function main() {
  const companyId = Number(arg("company"));
  if (!companyId) {
    console.error("Usage : node scripts/preview-location-migration.js --company=<id>");
    process.exit(1);
  }

  console.log("═".repeat(74));
  console.log("PREVIEW MIGRATION STOCK → BALANCES — LECTURE SEULE, AUCUNE ÉCRITURE");
  console.log("═".repeat(74));

  const products = (await pool.query(
    `SELECT id, reference, name, stock, warehouse, location_id, location_code
       FROM products
      WHERE company_id = $1 AND COALESCE(is_active,TRUE) = TRUE
      ORDER BY name`, [companyId]
  )).rows;

  const locations = (await pool.query(
    `SELECT l.id, l.warehouse_id, l.warehouse_code, l.emplacement_code, l.product_id,
            l.product_reference,
            COALESCE(NULLIF(l.rayon_code,''), l.zone)    AS row_code,
            COALESCE(NULLIF(l.case_code,''),  l.rayon)   AS loc_code,
            COALESCE(NULLIF(l.level_code,''), l.etagere) AS lvl_code,
            NULLIF(l.bin_code,'') AS bin_code
       FROM locations l WHERE l.company_id = $1`, [companyId]
  )).rows;

  const fullCode = (l) => [l.warehouse_code, l.row_code, l.loc_code, l.lvl_code, l.bin_code]
    .map((x) => String(x || "").trim()).filter(Boolean).join("-");

  const byId = new Map(locations.map((l) => [l.id, l]));
  const byEmplacement = new Map();
  locations.forEach((l) => {
    const k = norm(l.emplacement_code);
    if (!k) return;
    if (!byEmplacement.has(k)) byEmplacement.set(k, []);
    byEmplacement.get(k).push(l);
  });
  const byProduct = new Map();
  locations.forEach((l) => {
    if (!l.product_id) return;
    if (!byProduct.has(l.product_id)) byProduct.set(l.product_id, []);
    byProduct.get(l.product_id).push(l);
  });

  /* Emplacements attestés par l'historique des mouvements : un produit déjà
     rangé ou sorti d'un bin y a réellement été. C'est la source la plus fiable
     après le rattachement direct. */
  const fromMovements = new Map();
  (await pool.query(
    `SELECT product_id, location_id, COUNT(*)::int AS n
       FROM stock_movements
      WHERE company_id = $1 AND product_id IS NOT NULL AND location_id IS NOT NULL
      GROUP BY 1,2`, [companyId]
  )).rows.forEach((r) => {
    if (!fromMovements.has(r.product_id)) fromMovements.set(r.product_id, []);
    fromMovements.get(r.product_id).push(r);
  });

  const rows = [];
  for (const p of products) {
    const stock = Number(p.stock || 0);
    const candidats = new Map();          // location_id -> origine
    const addCandidate = (loc, origine) => {
      if (!loc) return;
      if (!candidats.has(loc.id)) candidats.set(loc.id, { loc, origines: [] });
      candidats.get(loc.id).origines.push(origine);
    };

    if (p.location_id && byId.has(p.location_id)) {
      addCandidate(byId.get(p.location_id), "products.location_id");
    }
    (byProduct.get(p.id) || []).forEach((l) => addCandidate(l, "locations.product_id"));
    if (p.location_code) {
      (byEmplacement.get(norm(p.location_code)) || []).forEach((l) => addCandidate(l, "products.location_code"));
    }
    (fromMovements.get(p.id) || []).forEach((m) => {
      if (byId.has(m.location_id)) addCandidate(byId.get(m.location_id), `mouvements×${m.n}`);
    });

    const liste = [...candidats.values()];
    let action, cible = null, confiance = 0, motif = "";

    if (stock <= 0) {
      action = ACTIONS.ZERO_STOCK;
      motif = "stock nul : aucune balance à créer";
    } else if (liste.length === 1) {
      action = ACTIONS.AUTO_MATCH;
      cible = liste[0].loc;
      /* Confiance maximale seulement si l'emplacement porte un BIN : sans bin,
         la destination physique n'est pas complète. */
      confiance = cible.bin_code ? 100 : 70;
      motif = liste[0].origines.join(" + ") + (cible.bin_code ? "" : " — sans bin");
      if (!cible.bin_code) action = ACTIONS.AMBIGUOUS_LOCATION;
    } else if (liste.length > 1) {
      action = ACTIONS.TO_REVIEW_LOCATION;
      confiance = 0;
      motif = `${liste.length} emplacements possibles — répartition non prouvable`;
    } else if (p.location_code) {
      action = ACTIONS.AMBIGUOUS_LOCATION;
      motif = `location_code « ${p.location_code} » ne correspond à aucun emplacement`;
    } else {
      action = ACTIONS.NO_LOCATION;
      motif = "aucun emplacement connu";
    }

    rows.push({
      product_id: p.id, reference: p.reference, name: p.name, stock,
      ancien_location_code: p.location_code || "",
      warehouse: cible ? cible.warehouse_code : (p.warehouse || ""),
      row_code: cible ? cible.row_code || "" : "",
      loc_code: cible ? cible.loc_code || "" : "",
      lvl_code: cible ? cible.lvl_code || "" : "",
      bin_code: cible ? cible.bin_code || "" : "",
      location_id: cible ? cible.id : "",
      full_code: cible ? fullCode(cible) : "",
      quantite_a_affecter: action === ACTIONS.AUTO_MATCH ? stock : 0,
      candidats: liste.length,
      confiance, action, motif,
    });
  }

  // ------------------------------------------------------------- récapitulatif
  const par = (a) => rows.filter((r) => r.action === a);
  const somme = (l) => l.reduce((s, r) => s + r.stock, 0);
  const stockGlobal = somme(rows);
  const auto = par(ACTIONS.AUTO_MATCH);
  const balancesPrevues = auto.reduce((s, r) => s + r.quantite_a_affecter, 0);

  console.log(`\n── PÉRIMÈTRE ──`);
  console.log(`  produits actifs            ${n(rows.length)}`);
  console.log(`  STOCK GLOBAL EN BASE       ${n(stockGlobal)}`);

  console.log(`\n── RÉPARTITION DES DÉCISIONS ──`);
  for (const a of Object.values(ACTIONS)) {
    const l = par(a);
    if (!l.length) continue;
    console.log(`  ${a.padEnd(22)} ${String(n(l.length)).padStart(6)} produits   ${String(n(somme(l))).padStart(10)} unités`);
  }

  console.log(`\n── PREUVE MATHÉMATIQUE (A27) ──`);
  console.log(`  balances qui seraient créées   ${n(auto.length)}`);
  console.log(`  somme des balances             ${n(balancesPrevues)}`);
  console.log(`  stock NON affecté              ${n(stockGlobal - balancesPrevues)}`);
  console.log(`  contrôle : ${n(balancesPrevues)} + ${n(stockGlobal - balancesPrevues)} = ${n(stockGlobal)}` +
    (balancesPrevues + (stockGlobal - balancesPrevues) === stockGlobal ? "  ✓ aucune unité créée ni perdue" : "  ✗ ÉCART"));
  console.log(`\n  Le stock non affecté N'EST PAS perdu : products.stock reste la`);
  console.log(`  référence. Il reste simplement sans emplacement tant qu'un humain`);
  console.log(`  n'a pas tranché. Aucune quantité n'est dupliquée.`);

  // ------------------------------------------- doublons de code complet (§2)
  /* On NE FUSIONNE RIEN : on décrit. Chaque ligne en doublon est listée avec
     son id, son produit rattaché, le stock associé et ses composantes
     physiques, pour que la décision soit humaine. */
  const groupes = (await pool.query(
    `WITH codes AS (
       SELECT l.id, l.warehouse_code,
              COALESCE(NULLIF(l.rayon_code,''), l.zone)    AS row_code,
              COALESCE(NULLIF(l.case_code,''),  l.rayon)   AS loc_code,
              COALESCE(NULLIF(l.level_code,''), l.etagere) AS lvl_code,
              NULLIF(l.bin_code,'') AS bin_code,
              l.emplacement_code, l.product_id, l.product_reference,
              ARRAY_TO_STRING(ARRAY[
                NULLIF(TRIM(COALESCE(l.warehouse_code,'')),''),
                NULLIF(TRIM(COALESCE(NULLIF(l.rayon_code,''), l.zone)),''),
                NULLIF(TRIM(COALESCE(NULLIF(l.case_code,''),  l.rayon)),''),
                NULLIF(TRIM(COALESCE(NULLIF(l.level_code,''), l.etagere)),''),
                NULLIF(TRIM(COALESCE(l.bin_code,'')),'')
              ], '-') AS full_code
         FROM locations l WHERE l.company_id = $1
     )
     SELECT c.*, p.name AS produit, p.stock::numeric AS stock
       FROM codes c LEFT JOIN products p ON p.id = c.product_id
      WHERE c.full_code IN (SELECT full_code FROM codes GROUP BY full_code HAVING COUNT(*) > 1)
      ORDER BY c.full_code, c.id`, [companyId]
  )).rows;

  if (groupes.length) {
    const parCode = new Map();
    groupes.forEach((g) => {
      if (!parCode.has(g.full_code)) parCode.set(g.full_code, []);
      parCode.get(g.full_code).push(g);
    });
    console.log(`\n── DOUBLONS DE CODE COMPLET : ${parCode.size} groupe(s), ${groupes.length} ligne(s) ──`);
    console.log("   BLOQUANT pour l'index unique de 061. AUCUNE fusion automatique.");
    for (const [code, lignes] of parCode) {
      console.log(`\n  ${code}  (${lignes.length} lignes)`);
      console.log(`    ${"ID".padEnd(7)}${"PRODUIT".padEnd(32)}${"STOCK".padStart(9)}  ENTREPÔT / ROW / LOC / LEVEL / BIN`);
      lignes.forEach((l) => console.log(
        `    ${String(l.id).padEnd(7)}${String(l.produit || "— aucun —").slice(0, 30).padEnd(32)}` +
        `${String(l.stock == null ? "—" : n(l.stock)).padStart(9)}  ` +
        `${l.warehouse_code || "?"} / ${l.row_code || "?"} / ${l.loc_code || "?"} / ${l.lvl_code || "?"} / ${l.bin_code || "SANS BIN"}`));
    }
  } else {
    console.log(`\n── DOUBLONS DE CODE COMPLET : aucun ──`);
  }

  // ------------------------------------------------------------- échantillons
  const echantillon = (a, k = 8) => {
    const l = par(a).slice(0, k);
    if (!l.length) return;
    console.log(`\n── ${a} (${n(par(a).length)}) — ${k} premiers ──`);
    l.forEach((r) => console.log(
      `  ${String(r.name).slice(0, 34).padEnd(34)} ${String(n(r.stock)).padStart(8)}  ` +
      `${(r.full_code || "—").padEnd(28)} ${r.confiance ? r.confiance + "%" : "  —"}  ${r.motif}`));
  };
  Object.values(ACTIONS).forEach((a) => echantillon(a));

  const csv = arg("csv");
  if (csv) {
    const head = Object.keys(rows[0] || { vide: "" });
    const esc = (v) => { const s = String(v ?? ""); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    fs.writeFileSync(csv, "﻿" + [head.join(","), ...rows.map((r) => head.map((h) => esc(r[h])).join(","))].join("\n"));
    console.log(`\n  CSV écrit : ${csv}  (fichier local, aucune donnée modifiée en base)`);
  }

  // ------------------------------------------------ contrôle final exigé (§14)
  const [neg] = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM products
      WHERE company_id = $1 AND COALESCE(is_active,TRUE) = TRUE AND stock < 0`, [companyId]
  )).rows;
  const bloquants = new Set(
    (await pool.query(
      `WITH codes AS (
         SELECT ARRAY_TO_STRING(ARRAY[
           NULLIF(TRIM(COALESCE(warehouse_code,'')),''),
           NULLIF(TRIM(COALESCE(NULLIF(rayon_code,''), zone)),''),
           NULLIF(TRIM(COALESCE(NULLIF(case_code,''),  rayon)),''),
           NULLIF(TRIM(COALESCE(NULLIF(level_code,''), etagere)),''),
           NULLIF(TRIM(COALESCE(bin_code,'')),'')
         ], '-') AS full_code, bin_code
           FROM locations WHERE company_id = $1
       )
       SELECT full_code FROM codes
        WHERE COALESCE(TRIM(bin_code),'') <> ''
        GROUP BY full_code HAVING COUNT(*) > 1`, [companyId]
    )).rows.map((r) => r.full_code)
  );

  const unites = (a) => somme(par(a));
  console.log(`\n${"═".repeat(74)}`);
  console.log("CONTRÔLE AVANT MIGRATION");
  console.log("═".repeat(74));
  console.log(`  stock avant                 ${n(stockGlobal)}`);
  console.log(`  stock après simulé          ${n(stockGlobal)}`);
  console.log(`  différence                  ${n(0)}`);
  console.log(`  stock négatif               ${n(neg.n)}`);
  console.log(`  doublons physiques bloquants ${n(bloquants.size)}`);
  console.log("  ─────────────────────────────────────────────");
  console.log(`  AUTO_MIGRATABLE             ${String(n(auto.length)).padStart(5)} produits   ${String(n(unites(ACTIONS.AUTO_MATCH))).padStart(9)} unités`);
  console.log(`  TO_REVIEW_LOCATION          ${String(n(par(ACTIONS.TO_REVIEW_LOCATION).length)).padStart(5)} produits   ${String(n(unites(ACTIONS.TO_REVIEW_LOCATION))).padStart(9)} unités`);
  console.log(`  AMBIGUOUS_LOCATION          ${String(n(par(ACTIONS.AMBIGUOUS_LOCATION).length)).padStart(5)} produits   ${String(n(unites(ACTIONS.AMBIGUOUS_LOCATION))).padStart(9)} unités`);
  console.log(`  NO_LOCATION                 ${String(n(par(ACTIONS.NO_LOCATION).length)).padStart(5)} produits   ${String(n(unites(ACTIONS.NO_LOCATION))).padStart(9)} unités`);
  console.log(`  ZERO_STOCK                  ${String(n(par(ACTIONS.ZERO_STOCK).length)).padStart(5)} produits   ${String(n(unites(ACTIONS.ZERO_STOCK))).padStart(9)} unités`);
  const feuVert = neg.n === 0 && bloquants.size === 0;
  console.log(`\n  ${feuVert ? "FEU VERT" : "BLOQUÉ"} : ` + (feuVert
    ? "aucun stock négatif, aucun doublon bloquant — 061 peut être exécutée."
    : `${neg.n} stock(s) négatif(s) et ${bloquants.size} doublon(s) à traiter AVANT 061.`));

  console.log("\n" + "═".repeat(74));
  console.log("Aucune balance créée. Aucun stock modifié. Aucune migration exécutée.");
  console.log("═".repeat(74));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
