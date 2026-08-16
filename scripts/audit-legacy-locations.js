"use strict";

/**
 * AUDIT DES EMPLACEMENTS HISTORIQUES — STRICTEMENT LECTURE SEULE.
 *
 * Ce script ne contient QUE des SELECT. Aucune balance créée, aucun
 * products.stock modifié, aucune plage transformée en bac précis.
 *
 *   node scripts/audit-legacy-locations.js --company=1 [--csv=fichier.csv]
 *
 * Beaucoup de produits ont un stock global et un ancien code d'emplacement,
 * mais aucune balance : la marchandise est rangée quelque part, le système ne
 * sait simplement plus où. Cet audit croise toutes les traces disponibles et
 * dit, produit par produit, ce que l'historique permet — ou ne permet pas — de
 * conclure. Il ne conclut jamais à la place d'un humain.
 */

require("dotenv").config();
const fs = require("fs");
const { Pool } = require("pg");
const rules = require("../services/location-rules");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
};
const n = (v) => Number(v || 0).toLocaleString("fr-FR");
const T = (v, w) => String(v ?? "—").slice(0, w).padEnd(w);
const clean = (v) => String(v ?? "").trim();

/* FULLBIN, plages, rebuts et placeholders viennent de la règle partagée :
   l'audit, le moteur et l'API doivent classer un emplacement à l'identique. */
const FULLBIN_RE = rules.FULLBIN_RE;

const CLASSES = {
  LEGACY_EXACT_LOCATION: "LEGACY_EXACT_LOCATION",
  LEGACY_RANGE_LOCATION: "LEGACY_RANGE_LOCATION",
  LEGACY_FULLBIN: "LEGACY_FULLBIN",
  LEGACY_PARTIAL_LOCATION: "LEGACY_PARTIAL_LOCATION",
  NO_LOCATION_HISTORY: "NO_LOCATION_HISTORY",
  CONFLICTING_HISTORY: "CONFLICTING_HISTORY",
  WRITE_OFF_EXCLUDE: "WRITE_OFF_EXCLUDE",
};

const SUGGESTION = {
  LEGACY_EXACT_LOCATION:
    "Proposer cet emplacement comme suggestion, à CONFIRMER par le magasinier avant répartition.",
  LEGACY_RANGE_LOCATION:
    "Plage : ne jamais choisir un bac à sa place. Afficher l'ancien code et demander le bac réel.",
  LEGACY_FULLBIN:
    "« FULLBIN » ne désigne aucun bac : afficher l'ancien code et demander le bac réel.",
  LEGACY_PARTIAL_LOCATION:
    "Information incomplète : préremplir ce qui est connu, demander les composantes manquantes.",
  NO_LOCATION_HISTORY:
    "Aucune trace : saisie manuelle complète de l'emplacement.",
  CONFLICTING_HISTORY:
    "Plusieurs emplacements incompatibles : afficher les candidats, laisser choisir.",
  WRITE_OFF_EXCLUDE:
    "Rebut : jamais un emplacement disponible. Le stock reste à localiser dans un vrai bac.",
};

async function main() {
  const companyId = Number(arg("company"));
  if (!companyId) {
    console.error("Usage : node scripts/audit-legacy-locations.js --company=<id>");
    process.exit(1);
  }
  const q = async (sql, p = [companyId]) => (await pool.query(sql, p)).rows;

  console.log("═".repeat(96));
  console.log("AUDIT DES EMPLACEMENTS HISTORIQUES — LECTURE SEULE, AUCUNE ÉCRITURE");
  console.log(`entreprise ${companyId} · ${new Date().toLocaleString("fr-FR")}`);
  console.log("═".repeat(96));

  /* Emplacements VIVANTS : un doublon déjà rattaché par 061a n'est plus une
     piste, mais son canonique l'est. */
  const locations = await q(
    `SELECT l.id, l.warehouse_code, l.emplacement_code, l.full_code, l.product_id,
            COALESCE(NULLIF(l.rayon_code,''), l.zone)    AS row_code,
            COALESCE(NULLIF(l.case_code,''),  l.rayon)   AS loc_code,
            COALESCE(NULLIF(l.level_code,''), l.etagere) AS lvl_code,
            l.bin_code, l.merged_into_location_id
       FROM locations l WHERE l.company_id = $1`);
  const parId = new Map(locations.map((l) => [l.id, l]));
  /* Un emplacement fusionné redirige vers son canonique : la trace historique
     reste valable, elle pointe simplement ailleurs maintenant. */
  const resoudre = (id) => {
    let l = parId.get(id);
    let garde = 0;
    while (l && l.merged_into_location_id && garde++ < 10) l = parId.get(l.merged_into_location_id);
    return l || null;
  };

  const parProduit = new Map();
  locations.forEach((l) => {
    if (!l.product_id) return;
    if (!parProduit.has(l.product_id)) parProduit.set(l.product_id, []);
    parProduit.get(l.product_id).push(l);
  });
  const norm = (s) => String(s || "").toUpperCase().replace(/\s+/g, " ").trim();
  const parCode = new Map();
  locations.forEach((l) => {
    const k = norm(l.emplacement_code);
    if (!k) return;
    if (!parCode.has(k)) parCode.set(k, []);
    parCode.get(k).push(l);
  });

  const mouvements = new Map();
  (await q(
    `SELECT product_id, location_id, COUNT(*)::int AS n, MAX(created_at) AS dernier
       FROM stock_movements
      WHERE company_id = $1 AND product_id IS NOT NULL AND location_id IS NOT NULL
      GROUP BY 1,2`)).forEach((r) => {
    if (!mouvements.has(r.product_id)) mouvements.set(r.product_id, []);
    mouvements.get(r.product_id).push(r);
  });

  /* Inventaires : ils référencent l'emplacement par son CODE. */
  const inventaires = new Map();
  (await q(
    `SELECT COALESCE(i.product_id, p.id) AS product_id, i.location_code, COUNT(*)::int AS n
       FROM inventory_history i
       LEFT JOIN products p ON p.company_id = i.company_id
                           AND UPPER(TRIM(p.name)) = UPPER(TRIM(i.product_name))
      WHERE i.company_id = $1 AND COALESCE(i.location_code,'') <> ''
      GROUP BY 1,2`)).forEach((r) => {
    if (!r.product_id) return;
    if (!inventaires.has(r.product_id)) inventaires.set(r.product_id, []);
    inventaires.get(r.product_id).push(r);
  });

  const balances = new Map();
  (await q(
    `SELECT product_id, COALESCE(SUM(quantity),0)::numeric AS q
       FROM stock_location_balances WHERE company_id = $1 GROUP BY 1`))
    .forEach((r) => balances.set(r.product_id, Number(r.q)));

  const produits = await q(
    `SELECT id, name, reference, stock::numeric AS stock, location_id, location_code, warehouse
       FROM products WHERE company_id = $1 AND COALESCE(is_active,TRUE) = TRUE ORDER BY name`);

  const lignes = [];
  for (const p of produits) {
    const stock = Number(p.stock || 0);
    const localise = balances.get(p.id) || 0;
    const preuves = [];
    const candidats = new Map();
    const ajouter = (loc, preuve) => {
      if (!loc) return;
      const cible = resoudre(loc.id);
      if (!cible) return;
      if (!candidats.has(cible.id)) candidats.set(cible.id, { loc: cible, preuves: [] });
      candidats.get(cible.id).preuves.push(preuve);
      preuves.push(preuve);
    };

    if (p.location_id && parId.has(p.location_id)) ajouter(parId.get(p.location_id), "products.location_id");
    (parProduit.get(p.id) || []).forEach((l) => ajouter(l, "locations.product_id"));
    if (p.location_code) {
      (parCode.get(norm(p.location_code)) || []).forEach((l) => ajouter(l, "products.location_code"));
    }
    (mouvements.get(p.id) || []).forEach((m) => ajouter(parId.get(m.location_id), `mouvements×${m.n}`));
    (inventaires.get(p.id) || []).forEach((i) => {
      (parCode.get(norm(i.location_code)) || []).forEach((l) => ajouter(l, `inventaire×${i.n}`));
    });

    const liste = [...candidats.values()];
    let classe, cible = null;

    if (liste.some(({ loc }) => rules.isWriteOff(loc)) && liste.length === 1) {
      classe = CLASSES.WRITE_OFF_EXCLUDE;
      cible = liste[0].loc;
    } else if (liste.length === 0) {
      classe = CLASSES.NO_LOCATION_HISTORY;
    } else if (liste.length > 1) {
      /* Plusieurs pistes : compatibles si elles désignent le MÊME bac. */
      const codes = new Set(liste.map(({ loc }) =>
        [loc.warehouse_code, loc.row_code, loc.loc_code, loc.lvl_code, loc.bin_code]
          .map(clean).join("|").toUpperCase()));
      if (codes.size === 1) { classe = null; cible = liste[0].loc; }
      else { classe = CLASSES.CONFLICTING_HISTORY; }
    } else {
      cible = liste[0].loc;
    }

    if (!classe && cible) {
      const bin = clean(cible.bin_code);
      if (rules.isWriteOff(cible))          classe = CLASSES.WRITE_OFF_EXCLUDE;
      else if (FULLBIN_RE.test(bin))        classe = CLASSES.LEGACY_FULLBIN;
      else if (rules.isRange(cible))        classe = CLASSES.LEGACY_RANGE_LOCATION;
      else if (rules.isPlaceholder(cible) || !bin
               || rules.NON_PRECISE_RE.test(bin)
               || !clean(cible.row_code) || !clean(cible.loc_code) || !clean(cible.lvl_code))
        classe = CLASSES.LEGACY_PARTIAL_LOCATION;
      else                                  classe = CLASSES.LEGACY_EXACT_LOCATION;
    }

    lignes.push({
      product_id: p.id, produit: p.name, reference: p.reference || "",
      stock_global: stock, stock_localise: localise,
      reste_a_localiser: stock - localise,
      ancien_location_code: p.location_code || "",
      location_id: cible ? cible.id : "",
      warehouse: cible ? clean(cible.warehouse_code) : "",
      rayon: cible ? clean(cible.row_code) : "",
      location: cible ? clean(cible.loc_code) : "",
      level: cible ? clean(cible.lvl_code) : "",
      bin: cible ? clean(cible.bin_code) : "",
      preuves: [...new Set(preuves)].join(" + ") || "aucune",
      classification: classe,
      suggestion: SUGGESTION[classe],
      candidats: liste.length,
    });
  }

  /* On ne rend compte que des produits qui ont encore quelque chose à localiser. */
  const aTraiter = lignes.filter((l) => l.reste_a_localiser > 0);
  const par = (c) => aTraiter.filter((l) => l.classification === c);
  const somme = (l) => l.reduce((s, x) => s + x.reste_a_localiser, 0);

  console.log(`\n  ${n(lignes.length)} produits actifs · ${n(aTraiter.length)} avec du stock à localiser`);

  for (const c of Object.values(CLASSES)) {
    const l = par(c);
    if (!l.length) continue;
    console.log("\n" + "─".repeat(96));
    console.log(`${c} — ${n(l.length)} produit(s), ${n(somme(l))} unité(s)`);
    console.log(`  ${SUGGESTION[c]}`);
    console.log(`\n  ${T("ID", 6)}${T("PRODUIT", 32)}${"STOCK".padStart(9)}${"LOCALISÉ".padStart(10)}` +
      `${"À LOCALISER".padStart(13)}  ${T("ANCIEN CODE", 20)}${T("EMPLACEMENT SUGGÉRÉ", 30)}PREUVES`);
    l.slice(0, 25).forEach((x) => console.log(
      `  ${T(x.product_id, 6)}${T(x.produit, 32)}${String(n(x.stock_global)).padStart(9)}` +
      `${String(n(x.stock_localise)).padStart(10)}${String(n(x.reste_a_localiser)).padStart(13)}  ` +
      `${T(x.ancien_location_code, 20)}` +
      `${T([x.warehouse, x.rayon, x.location, x.level, x.bin].filter(Boolean).join("-") || "—", 30)}${x.preuves}`));
    if (l.length > 25) console.log(`  … ${n(l.length - 25)} autre(s), voir le CSV`);
  }

  console.log("\n" + "═".repeat(96));
  console.log("TOTAUX");
  console.log("═".repeat(96));
  console.log(`  ${T("CLASSIFICATION", 30)}${"PRODUITS".padStart(10)}${"UNITÉS".padStart(14)}`);
  console.log("  " + "─".repeat(54));
  for (const c of Object.values(CLASSES)) {
    const l = par(c);
    console.log(`  ${T(c, 30)}${String(n(l.length)).padStart(10)}${String(n(somme(l))).padStart(14)}`);
  }
  console.log("  " + "─".repeat(54));
  console.log(`  ${T("TOTAL À LOCALISER", 30)}${String(n(aTraiter.length)).padStart(10)}${String(n(somme(aTraiter))).padStart(14)}`);

  const global = lignes.reduce((s, l) => s + l.stock_global, 0);
  const localise = lignes.reduce((s, l) => s + l.stock_localise, 0);
  console.log(`\n  stock global ${n(global)} = localisé ${n(localise)} + à localiser ${n(global - localise)}` +
    (localise + (global - localise) === global ? "   ✓" : "   ✗ ÉCART"));

  const csv = arg("csv");
  if (csv && lignes.length) {
    const head = Object.keys(lignes[0]);
    const esc = (v) => { const s = String(v ?? ""); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    fs.writeFileSync(csv, "﻿" + [head.join(","), ...lignes.map((r) => head.map((h) => esc(r[h])).join(","))].join("\n"));
    console.log(`\n  CSV écrit : ${csv}`);
  }

  console.log("\n" + "═".repeat(96));
  console.log("Aucune balance créée. Aucun stock modifié. Aucune plage convertie en bac.");
  console.log("═".repeat(96));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
