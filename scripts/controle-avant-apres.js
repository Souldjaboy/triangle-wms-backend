"use strict";

/**
 * PHOTOGRAPHIE DE LA BASE — LECTURE SEULE.
 *
 * À exécuter avant, puis après un déploiement, et à comparer. Un déploiement
 * qui se dit réussi sans que personne n'ait compté les stocks avant et après
 * n'a rien prouvé.
 *
 * La transaction est déclarée READ ONLY : PostgreSQL refusera lui-même toute
 * écriture, y compris une que ce script contiendrait par erreur.
 *
 *   node scripts/controle-avant-apres.js --sortie=avant.json
 *   node scripts/controle-avant-apres.js --sortie=apres.json
 *   node scripts/controle-avant-apres.js --comparer=avant.json:apres.json
 */

const fs = require("fs");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const arg = (nom, defaut = "") => {
  const t = process.argv.find((a) => a.startsWith(`--${nom}=`));
  return t ? t.split("=").slice(1).join("=") : defaut;
};

/* Ce dont la présence signale un vrai problème, et non une simple évolution. */
const CRITIQUES = [
  "stocks_negatifs", "balances_orphelines", "badges_dupliques",
  "utilisateurs_sans_entreprise", "badges_prefixe_etranger", "full_code_dupliques",
  "reservations_anormales",
];

const REQUETES = {
  entreprises: `SELECT count(*)::int AS n FROM companies`,

  utilisateurs_par_entreprise: `
    SELECT c.id, c.name, count(u.id)::int AS utilisateurs
      FROM companies c LEFT JOIN users u ON u.company_id = c.id
     GROUP BY c.id, c.name ORDER BY c.id`,

  badges_par_entreprise: `
    SELECT c.id, COALESCE(c.badge_prefix,'—') AS prefixe, c.badge_sequence,
           count(u.id) FILTER (WHERE COALESCE(u.badge_code,'') <> '')::int AS badges
      FROM companies c LEFT JOIN users u ON u.company_id = c.id
     GROUP BY c.id, c.badge_prefix, c.badge_sequence ORDER BY c.id`,

  badges_dupliques: `
    SELECT company_id, upper(badge_code) AS badge, count(*)::int AS n
      FROM users WHERE COALESCE(badge_code,'') <> ''
     GROUP BY 1,2 HAVING count(*) > 1`,

  utilisateurs_sans_entreprise: `
    SELECT id, fullname, COALESCE(role,'—') AS role FROM users WHERE company_id IS NULL`,

  /* Un badge qui ne porte pas le préfixe de sa société : le compte est chez
     l'une et son étiquette dit l'autre. */
  badges_prefixe_etranger: `
    SELECT u.id, u.fullname, u.badge_code, c.name AS entreprise,
           COALESCE(NULLIF(c.badge_prefix,''),'ENT'||c.id) AS prefixe_attendu
      FROM users u JOIN companies c ON c.id = u.company_id
     WHERE COALESCE(u.badge_code,'') <> ''
       AND upper(u.badge_code) NOT LIKE upper(COALESCE(NULLIF(c.badge_prefix,''),'ENT'||c.id)) || '%'`,

  produits_par_entreprise: `
    SELECT company_id, count(*)::int AS produits, COALESCE(sum(stock),0)::numeric AS stock_total
      FROM products GROUP BY company_id ORDER BY company_id`,

  stock_par_produit: `
    SELECT company_id, id, reference, COALESCE(stock,0)::numeric AS stock
      FROM products WHERE COALESCE(stock,0) <> 0 ORDER BY company_id, id`,

  stocks_negatifs: `
    SELECT id, company_id, reference, stock FROM products WHERE stock < 0`,

  /* Plus de réservé que de présent : le disponible deviendrait négatif. */
  reservations_anormales: `
    SELECT id, company_id, product_id, location_id, quantity, reserved_quantity
      FROM stock_location_balances
     WHERE reserved_quantity < 0 OR reserved_quantity > quantity`,

  emplacements_par_entreprise: `
    SELECT company_id, count(*)::int AS emplacements,
           count(*) FILTER (WHERE COALESCE(is_active,true))::int AS actifs
      FROM locations GROUP BY company_id ORDER BY company_id`,

  balances_par_entreprise: `
    SELECT company_id, count(*)::int AS balances,
           COALESCE(sum(quantity),0)::numeric AS quantite,
           COALESCE(sum(reserved_quantity),0)::numeric AS reserve
      FROM stock_location_balances GROUP BY company_id ORDER BY company_id`,

  balances_orphelines: `
    SELECT b.id, b.company_id, b.product_id, b.location_id
      FROM stock_location_balances b
     WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = b.location_id)
        OR NOT EXISTS (SELECT 1 FROM products p WHERE p.id = b.product_id)`,

  mouvements_par_entreprise: `
    SELECT company_id, count(*)::int AS mouvements FROM stock_movements
     GROUP BY company_id ORDER BY company_id`,

  documents_par_entreprise: `
    SELECT company_id, count(*)::int AS documents FROM documents
     GROUP BY company_id ORDER BY company_id`,

  permissions_par_entreprise: `
    SELECT company_id,
           count(*)::int AS exceptions,
           count(*) FILTER (WHERE effect='ALLOW')::int AS autorisations,
           count(*) FILTER (WHERE effect='DENY')::int AS refus
      FROM user_permission_overrides GROUP BY company_id ORDER BY company_id`,

  /* Codes hérités qu'on ne peut pas rattacher à un bac unique. */
  emplacements_ambigus: `
    SELECT id, company_id, COALESCE(full_code, emplacement_code) AS code, bin_code
      FROM locations
     WHERE COALESCE(bin_code,'') ~ '^[0-9]+([,-][0-9]+)+$'
        OR COALESCE(bin_code,'') ~* '^BIN[0-9]+-[0-9]+$'`,

  full_code_dupliques: `
    SELECT company_id, upper(full_code) AS code, count(*)::int AS n
      FROM locations WHERE COALESCE(full_code,'') <> ''
       AND COALESCE(merged_into_location_id,0) = 0
     GROUP BY 1,2 HAVING count(*) > 1`,
};

async function photographier() {
  const client = await pool.connect();
  const rapport = { pris_le: new Date().toISOString(), donnees: {} };
  try {
    /* READ ONLY : la base elle-même refuse toute écriture. */
    await client.query("BEGIN TRANSACTION READ ONLY");
    for (const [nom, sql] of Object.entries(REQUETES)) {
      try {
        const { rows } = await client.query(sql);
        rapport.donnees[nom] = rows;
      } catch (e) {
        rapport.donnees[nom] = { erreur: e.message };
      }
    }
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  return rapport;
}

function anomalies(rapport) {
  const trouvees = [];
  for (const cle of CRITIQUES) {
    const v = rapport.donnees[cle];
    if (Array.isArray(v) && v.length) trouvees.push({ controle: cle, occurrences: v.length, exemples: v.slice(0, 3) });
  }
  return trouvees;
}

function afficher(rapport) {
  const d = rapport.donnees;
  const n = (x) => (Array.isArray(x) ? x.length : 0);
  console.log(`\nPHOTOGRAPHIE — ${rapport.pris_le}`);
  console.log(`  entreprises : ${d.entreprises?.[0]?.n ?? "?"}`);

  console.log("\n  PAR ENTREPRISE");
  (d.utilisateurs_par_entreprise || []).forEach((c) => {
    const b = (d.badges_par_entreprise || []).find((x) => x.id === c.id) || {};
    const p = (d.produits_par_entreprise || []).find((x) => x.company_id === c.id) || {};
    const e = (d.emplacements_par_entreprise || []).find((x) => x.company_id === c.id) || {};
    const bal = (d.balances_par_entreprise || []).find((x) => x.company_id === c.id) || {};
    const m = (d.mouvements_par_entreprise || []).find((x) => x.company_id === c.id) || {};
    const doc = (d.documents_par_entreprise || []).find((x) => x.company_id === c.id) || {};
    const perm = (d.permissions_par_entreprise || []).find((x) => x.company_id === c.id) || {};
    console.log(
      `    #${c.id} ${String(c.name).slice(0, 34)}\n` +
      `       utilisateurs ${c.utilisateurs} · badges ${b.badges ?? 0} (préfixe ${b.prefixe ?? "—"}, séquence ${b.badge_sequence ?? "—"})\n` +
      `       produits ${p.produits ?? 0} · stock ${p.stock_total ?? 0}\n` +
      `       emplacements ${e.emplacements ?? 0} (${e.actifs ?? 0} actifs) · balances ${bal.balances ?? 0} = ${bal.quantite ?? 0} dont ${bal.reserve ?? 0} réservé\n` +
      `       mouvements ${m.mouvements ?? 0} · documents ${doc.documents ?? 0} · exceptions ${perm.exceptions ?? 0}`
    );
  });

  console.log("\n  CONTRÔLES");
  for (const cle of CRITIQUES) {
    const c = n(d[cle]);
    console.log(`    ${c === 0 ? "✓" : "✗"} ${cle.replace(/_/g, " ")} : ${c}`);
  }
  console.log(`    · emplacements ambigus : ${n(d.emplacements_ambigus)} (signalés, non bloquants)`);
}

/** Ce qui a changé entre deux photographies. */
function comparer(avant, apres) {
  console.log(`\nCOMPARAISON  ${avant.pris_le}  →  ${apres.pris_le}`);
  let ecarts = 0;

  const cle = (r) => (r.company_id ?? r.id);
  const total = (liste, champ) =>
    Object.fromEntries((liste || []).map((r) => [cle(r), Number(r[champ] || 0)]));

  const suivi = [
    ["stock par entreprise", "produits_par_entreprise", "stock_total"],
    ["produits par entreprise", "produits_par_entreprise", "produits"],
    ["utilisateurs par entreprise", "utilisateurs_par_entreprise", "utilisateurs"],
    ["balances par entreprise", "balances_par_entreprise", "quantite"],
    ["mouvements par entreprise", "mouvements_par_entreprise", "mouvements"],
    ["emplacements par entreprise", "emplacements_par_entreprise", "emplacements"],
  ];

  for (const [libelle, source, champ] of suivi) {
    const a = total(avant.donnees[source], champ);
    const b = total(apres.donnees[source], champ);
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const va = a[k] ?? 0;
      const vb = b[k] ?? 0;
      if (va !== vb) {
        ecarts += 1;
        console.log(`  ~ ${libelle} #${k} : ${va} → ${vb}  (${vb > va ? "+" : ""}${vb - va})`);
      }
    }
  }
  if (!ecarts) console.log("  aucun écart sur les totaux suivis.");

  console.log("\n  ANOMALIES");
  const aA = anomalies(avant);
  const aB = anomalies(apres);
  const nouvelles = aB.filter((x) => !aA.some((y) => y.controle === x.controle));
  aA.forEach((x) => console.log(`    · déjà présente avant : ${x.controle} (${x.occurrences})`));
  nouvelles.forEach((x) => console.log(`    ✗ APPARUE : ${x.controle} (${x.occurrences})`));
  if (!aA.length && !aB.length) console.log("    aucune, ni avant ni après.");
  return nouvelles.length;
}

async function main() {
  const aComparer = arg("comparer");
  if (aComparer) {
    const [f1, f2] = aComparer.split(":");
    const nouvelles = comparer(
      JSON.parse(fs.readFileSync(f1, "utf8")),
      JSON.parse(fs.readFileSync(f2, "utf8"))
    );
    await pool.end();
    process.exit(nouvelles ? 1 : 0);
  }

  const rapport = await photographier();
  afficher(rapport);
  const trouvees = anomalies(rapport);
  if (trouvees.length) {
    console.log("\n  DÉTAIL DES ANOMALIES");
    trouvees.forEach((a) => {
      console.log(`    ${a.controle} — ${a.occurrences}`);
      a.exemples.forEach((e) => console.log(`      ${JSON.stringify(e)}`));
    });
  }

  const sortie = arg("sortie");
  if (sortie) {
    fs.writeFileSync(sortie, JSON.stringify(rapport, null, 2));
    console.log(`\n  écrit dans ${sortie}`);
  }

  await pool.end();
  console.log(`\n${trouvees.length ? trouvees.length + " anomalie(s) critique(s)" : "Aucune anomalie critique"}\n`);
  process.exit(trouvees.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("ÉCHEC :", e.message || e);
  await pool.end().catch(() => {});
  process.exit(2);
});
