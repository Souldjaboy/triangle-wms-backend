"use strict";

/**
 * PREVIEW DE CONSOLIDATION DES EMPLACEMENTS PHYSIQUES — LECTURE SEULE.
 *
 * Ce script ne contient QUE des SELECT. Il ne consolide rien, ne réaffecte
 * aucune FK, ne désactive aucune ligne, ne touche aucun stock.
 *
 *   node scripts/preview-location-consolidation.js --company=<id> [--csv=f.csv]
 *
 * Il répond à trois questions, dans cet ordre :
 *   1. quelles colonnes de TOUTE la base pointent vers locations.id ;
 *   2. pour chaque groupe de doublons physiques, quelle ligne conserver et
 *      combien de références seraient à déplacer ;
 *   3. quels groupes ne doivent PAS être consolidés faute de preuve.
 *
 * Un même BIN peut contenir plusieurs produits : le doublon vient du modèle
 * ancien « une ligne d'emplacement = un produit ». Consolider signifie garder
 * UN emplacement physique — jamais fusionner deux produits.
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
const clean = (v) => String(v ?? "").trim();

const WRITE_OFF_RE = /\bWRITE[\s_-]*OFF\b|\bREBUT\b|\bCASSE\b/i;
const NON_PRECISE_RE = /NON[\s_-]*PRECISE|NON[\s_-]*PRÉCIS|\bN\/?A\b|\bINCONNU\b|\bDIVERS\b/i;
/* Un bin nommé « BIN2-3 » peut désigner UN bac ainsi étiqueté, ou DEUX bacs
   voisins notés en raccourci. Rien dans la base ne permet de trancher. */
const BIN_RANGE_RE = /^\s*BIN\s*\d+\s*[-–\/]\s*\d+\s*$|^\s*\d+\s*[-–\/]\s*\d+\s*$/i;
/* Valeurs qui sentent le remplissage automatique plutôt que le terrain. */
const PLACEHOLDER_RE = /^\s*(NOUVEAU|AUTO|DEFAUT|DEFAULT|TEST|TEMP|X+|-+|0+)\s*$/i;

const DECISION = {
  CONSOLIDATE: "CONSOLIDATE",
  TO_REVIEW_BIN_STRUCTURE: "TO_REVIEW_BIN_STRUCTURE",
  LEGACY_PLACEHOLDER: "LEGACY_PLACEHOLDER",
  WRITE_OFF_EXCLUDE: "WRITE_OFF_EXCLUDE",
  LOCATION_UNRESOLVED: "LOCATION_UNRESOLVED",
  TO_REVIEW: "TO_REVIEW",
};

async function main() {
  const companyId = Number(arg("company"));
  if (!companyId) {
    console.error("Usage : node scripts/preview-location-consolidation.js --company=<id>");
    process.exit(1);
  }

  console.log("═".repeat(80));
  console.log("PREVIEW DE CONSOLIDATION — LECTURE SEULE, AUCUNE ÉCRITURE");
  console.log("═".repeat(80));

  /* ------------------------------------------------------------------ §10 FK
     On ne suppose RIEN : toutes les colonnes qui référencent locations.id sont
     découvertes dans le catalogue, plus celles qui portent un nom d'emplacement
     sans contrainte déclarée — elles existent et casseraient tout autant. */
  const fkDeclarees = (await pool.query(
    `SELECT tc.table_name, kcu.column_name, tc.constraint_name, rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = 'locations' AND ccu.column_name = 'id'
      ORDER BY tc.table_name, kcu.column_name`
  )).rows;

  const colonnesImplicites = (await pool.query(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.column_name ~ '(^|_)location_id$'
      ORDER BY c.table_name, c.column_name`
  )).rows;

  /* Une colonne nommée *_location_id ne pointe PAS forcément vers `locations`.
     travel_routes.origin_location_id référence geo_locations : la réaffecter
     par similitude de nom corromprait un autre produit. On classe donc :
       SÛRE      FK déclarée vers locations.id
       EXCLUE    FK déclarée vers une AUTRE table
       À VALIDER aucune FK — ne sera réaffectée qu'après vérification humaine */
  const fkAilleurs = (await pool.query(
    `SELECT tc.table_name, kcu.column_name, ccu.table_name AS cible
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name <> 'locations'
        AND kcu.column_name ~ '(^|_)location_id$'`
  )).rows;

  console.log("\n── §10 — COLONNES NOMMÉES *_location_id DANS TOUTE LA BASE ──\n");
  console.log(`  ${"TABLE".padEnd(28)}${"COLONNE".padEnd(26)}${"STATUT".padEnd(12)}RÉFÉRENCE RÉELLE`);
  console.log("  " + "─".repeat(92));
  const cibles = [], aValider = [], exclues = [];
  for (const c of colonnesImplicites) {
    const key = `${c.table_name}.${c.column_name}`;
    const fk = fkDeclarees.find((f) => `${f.table_name}.${f.column_name}` === key);
    const ailleurs = fkAilleurs.find((f) => `${f.table_name}.${f.column_name}` === key);
    let statut, ref;
    if (fk) { statut = "SÛRE"; ref = `locations.id (ON DELETE ${fk.delete_rule})`; cibles.push({ table: c.table_name, column: c.column_name }); }
    else if (ailleurs) { statut = "EXCLUE"; ref = `${ailleurs.cible} — PAS locations`; exclues.push(key); }
    else {
      statut = "À VALIDER"; ref = "aucune FK déclarée";
      aValider.push({ table: c.table_name, column: c.column_name });
    }
    console.log(`  ${c.table_name.padEnd(28)}${c.column_name.padEnd(26)}${statut.padEnd(12)}${ref}`);
  }

  /* Pour chaque colonne sans FK, on regarde si ses valeurs recoupent réellement
     des emplacements de cette entreprise : c'est ce qui la rend pertinente. */
  console.log("\n  Recoupement réel des colonnes « À VALIDER » :");
  for (const c of aValider) {
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM "${c.table}" x
          WHERE x."${c.column}" IN (SELECT id FROM locations WHERE company_id = $1)`, [companyId]
      );
      const pertinent = rows[0].n > 0;
      if (pertinent) cibles.push({ table: c.table, column: c.column, aValider: true });
      console.log(`    ${(c.table + "." + c.column).padEnd(46)} ${rows[0].n} ligne(s)` +
        (pertinent ? "  → à réaffecter" : "  → sans objet ici"));
    } catch (e) {
      console.log(`    ${(c.table + "." + c.column).padEnd(46)} illisible : ${e.message}`);
    }
  }

  console.log(`\n  ${colonnesImplicites.length} colonne(s) portent ce nom.`);
  console.log(`  ${cibles.length} à réaffecter, ${exclues.length} exclue(s) car pointant ailleurs.`);
  if (exclues.length) console.log(`  Exclues : ${exclues.join(", ")}`);

  /* ------------------------------------------------- groupes de doublons */
  const lignes = (await pool.query(
    `WITH codes AS (
       SELECT l.id, l.company_id, l.warehouse_id, l.warehouse_code, l.zone, l.rayon,
              l.etagere, l.bin_code, l.emplacement_code, l.product_id, l.created_at,
              COALESCE(NULLIF(l.rayon_code,''), l.zone)    AS row_code,
              COALESCE(NULLIF(l.case_code,''),  l.rayon)   AS loc_code,
              COALESCE(NULLIF(l.level_code,''), l.etagere) AS lvl_code,
              ARRAY_TO_STRING(ARRAY[
                NULLIF(TRIM(COALESCE(l.warehouse_code,'')),''),
                NULLIF(TRIM(COALESCE(NULLIF(l.rayon_code,''), l.zone)),''),
                NULLIF(TRIM(COALESCE(NULLIF(l.case_code,''),  l.rayon)),''),
                NULLIF(TRIM(COALESCE(NULLIF(l.level_code,''), l.etagere)),''),
                NULLIF(TRIM(COALESCE(l.bin_code,'')),'')
              ], '-') AS full_code
         FROM locations l WHERE l.company_id = $1
     )
     SELECT c.id, c.warehouse_id, c.warehouse_code, c.row_code, c.loc_code,
            c.lvl_code, c.bin_code, c.emplacement_code, c.full_code,
            c.product_id, c.created_at,
            p.name AS product_name, p.stock::numeric AS product_stock,
            p.location_id AS product_points_here
       FROM codes c
       LEFT JOIN products p ON p.id = c.product_id AND p.company_id = c.company_id
      WHERE c.full_code IN (SELECT full_code FROM codes GROUP BY full_code HAVING COUNT(*) > 1)
      ORDER BY c.full_code, c.id`,
    [companyId]
  )).rows;

  /* Compte, pour un emplacement, toutes les références de toutes les colonnes
     découvertes — y compris celles sans FK déclarée. */
  const refsPour = async (locationId) => {
    const detail = {};
    let total = 0;
    for (const c of cibles) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM "${c.table}" WHERE "${c.column}" = $1`, [locationId]
      );
      if (rows[0].n > 0) { detail[`${c.table}.${c.column}`] = rows[0].n; total += rows[0].n; }
    }
    const { rows: inv } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM inventory_history i
        JOIN locations l ON l.id = $1
       WHERE i.company_id = $2
         AND UPPER(TRIM(COALESCE(i.location_code,''))) = UPPER(TRIM(COALESCE(l.emplacement_code,'')))
         AND COALESCE(l.emplacement_code,'') <> ''`, [locationId, companyId]
    );
    if (inv[0].n > 0) { detail["inventory_history.location_code"] = inv[0].n; total += inv[0].n; }
    return { detail, total };
  };

  const groupes = new Map();
  lignes.forEach((l) => {
    if (!groupes.has(l.full_code)) groupes.set(l.full_code, []);
    groupes.get(l.full_code).push(l);
  });

  console.log("\n" + "═".repeat(80));
  console.log(`§3 — PLAN DE CONSOLIDATION : ${groupes.size} groupe(s)`);
  console.log("═".repeat(80));

  const exportRows = [];
  const parDecision = {};
  let i = 0;

  for (const [code, l] of groupes) {
    i += 1;
    const composantes = (x) => [x.warehouse_code, x.row_code, x.loc_code, x.lvl_code, x.bin_code];
    const estRebut = l.some((x) => composantes(x).some((c) => WRITE_OFF_RE.test(clean(c))));
    const estNonPrecise = l.every((x) => !clean(x.bin_code) || NON_PRECISE_RE.test(clean(x.bin_code)));
    const estPlage = l.some((x) => BIN_RANGE_RE.test(clean(x.bin_code)));
    const estPlaceholder = l.some((x) =>
      [x.row_code, x.loc_code].some((c) => PLACEHOLDER_RE.test(clean(c))));

    /* Références par ligne — c'est ce qui départage la ligne canonique. */
    for (const x of l) { const r = await refsPour(x.id); x._refs = r.total; x._detail = r.detail; }

    /* Ligne canonique : la plus ancienne, SAUF si une autre porte plus
       d'historique. Déterministe, donc rejouable à l'identique. */
    const canonique = [...l].sort(
      (a, b) => b._refs - a._refs || a.id - b.id
    )[0];
    const autres = l.filter((x) => x.id !== canonique.id);
    const refsADeplacer = autres.reduce((s, x) => s + x._refs, 0);
    const produits = [...new Set(l.map((x) => x.product_id).filter(Boolean))];

    let decision, motif;
    if (estRebut) {
      decision = DECISION.WRITE_OFF_EXCLUDE;
      motif = "mise au rebut : ce n'est pas un emplacement physique, aucune consolidation";
    } else if (estNonPrecise) {
      decision = DECISION.LOCATION_UNRESOLVED;
      motif = "bin non précisé : reste hors migration physique, aucun full_code";
    } else if (estPlage) {
      decision = DECISION.TO_REVIEW_BIN_STRUCTURE;
      motif = `« ${clean(l[0].bin_code)} » peut désigner UN bac ou DEUX bacs voisins — aucune preuve en base`;
    } else if (estPlaceholder) {
      decision = DECISION.LEGACY_PLACEHOLDER;
      motif = "composantes générées automatiquement (NOUVEAU / AUTO) : emplacement réel non prouvé";
    } else if (autres.some((x) => x._refs > 0) && canonique._refs === 0) {
      decision = DECISION.TO_REVIEW;
      motif = "aucune ligne canonique évidente : l'historique est réparti sans dominante";
    } else {
      decision = DECISION.CONSOLIDATE;
      motif = produits.length > 1
        ? `${produits.length} produits dans le même bac — 1 emplacement, ${produits.length} balances à terme`
        : "même bac, même produit : doublon du modèle ancien";
    }
    parDecision[decision] = (parDecision[decision] || 0) + 1;

    console.log("\n" + "─".repeat(80));
    console.log(`GROUPE ${i}/${groupes.size}  ${code}`);
    console.log(`  décision : ${decision}`);
    console.log(`  motif    : ${motif}`);
    console.log(`\n  ${"LOC_ID".padEnd(8)}${"CANON".padEnd(7)}${"PROD_ID".padEnd(9)}${"PRODUIT".padEnd(30)}` +
      `${"STOCK".padStart(9)}${"RÉFS".padStart(7)}  DÉTAIL DES RÉFÉRENCES`);
    for (const x of l) {
      console.log(`  ${String(x.id).padEnd(8)}${(x.id === canonique.id ? "GARDER" : "—").padEnd(7)}` +
        `${String(x.product_id ?? "—").padEnd(9)}${clean(x.product_name || "—").slice(0, 28).padEnd(30)}` +
        `${String(x.product_stock == null ? "—" : n(x.product_stock)).padStart(9)}` +
        `${String(x._refs).padStart(7)}  ` +
        `${Object.entries(x._detail).map(([k, v]) => `${k}=${v}`).join(", ") || "aucune"}`);
      exportRows.push({
        groupe: i, full_code: code, decision,
        location_id: x.id, canonique: x.id === canonique.id ? "OUI" : "non",
        warehouse: x.warehouse_code, row: x.row_code, location: x.loc_code,
        level: x.lvl_code, bin: x.bin_code,
        product_id: x.product_id ?? "", product_name: x.product_name || "",
        products_stock: x.product_stock ?? "",
        references: x._refs, detail: Object.entries(x._detail).map(([k, v]) => `${k}=${v}`).join(" | "),
      });
    }
    if (decision === DECISION.CONSOLIDATE) {
      console.log(`\n  → conserver ${canonique.id}, rattacher ${autres.map((x) => x.id).join(", ")}`);
      console.log(`  → ${n(refsADeplacer)} référence(s) à réaffecter vers ${canonique.id}`);
      const pointeurs = l.filter((x) => x.product_points_here === x.id).map((x) => x.product_id);
      if (pointeurs.length) {
        console.log(`  → products.location_id à réaffecter pour : ${pointeurs.join(", ")}`);
      }
      console.log(`  → AUCUN produit fusionné : ${produits.length} produit(s) restent distincts`);
      console.log(`\n  Paire validée à reporter dans 061a :  (${canonique.id}, ARRAY[${autres.map((x) => x.id).join(",")}])`);
    } else {
      console.log(`\n  → NON consolidé. Aucune ligne touchée tant que la preuve manque.`);
    }
  }

  console.log("\n" + "═".repeat(80));
  console.log("RÉCAPITULATIF");
  console.log("═".repeat(80));
  Object.entries(parDecision).sort((a, b) => b[1] - a[1])
    .forEach(([d, k]) => console.log(`  ${d.padEnd(30)} ${String(k).padStart(3)} groupe(s)`));
  const consolidables = parDecision[DECISION.CONSOLIDATE] || 0;
  console.log(`\n  Consolidables sans ambiguïté : ${consolidables}`);
  console.log(`  Restant bloquants après consolidation : ${groupes.size - consolidables
    - (parDecision[DECISION.WRITE_OFF_EXCLUDE] || 0)
    - (parDecision[DECISION.LOCATION_UNRESOLVED] || 0)}`);

  const csv = arg("csv");
  if (csv && exportRows.length) {
    const head = Object.keys(exportRows[0]);
    const esc = (v) => { const s = String(v ?? ""); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    fs.writeFileSync(csv, "﻿" + [head.join(","), ...exportRows.map((r) => head.map((h) => esc(r[h])).join(","))].join("\n"));
    console.log(`\n  CSV écrit : ${csv}`);
  }

  console.log("\n" + "═".repeat(80));
  console.log("Aucun emplacement consolidé. Aucune FK réaffectée. Aucun stock modifié.");
  console.log("═".repeat(80));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
