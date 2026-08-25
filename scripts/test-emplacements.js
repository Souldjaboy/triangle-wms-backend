"use strict";

/**
 * TESTS DES EMPLACEMENTS — bacs, niveaux, renommage, réorganisation.
 *
 * Monte les routeurs sur un Express minimal et les interroge en HTTP, contre
 * une vraie base PostgreSQL portant le schéma réel.
 *
 *   DATABASE_URL=… node scripts/test-emplacements.js
 *
 * La question à laquelle chaque test répond, in fine, est toujours la même :
 * « le stock est-il resté exactement là où il était ? »
 */

const express = require("express");
const { Pool } = require("pg");
const creerAdmin = require("../routes/locations-admin");
const creerStock = require("../routes/stock-locations");
const permissions = require("../services/permissions");
const H = require("../services/location-hierarchy");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = 5401;

let reussis = 0, echoues = 0;
const verifier = (nom, ok, detail = "") => {
  if (ok) { reussis += 1; console.log(`  ✓ ${nom}`); }
  else { echoues += 1; console.log(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`); }
};

const SUPER = 1, MAGASINIER = 2, ETRANGER = 9;

async function authenticateToken(req, res, next) {
  const id = Number(String(req.headers.authorization || "").replace("Bearer ", "")) || 0;
  if (!id) return res.status(401).json({ error: "Non authentifié." });
  const { rows } = await pool.query(
    `SELECT id, company_id, fullname, email, role, is_super_admin FROM users WHERE id=$1`, [id]
  );
  if (!rows[0]) return res.status(401).json({ error: "Non authentifié." });
  req.user = rows[0];
  next();
}
const getEffectiveCompanyId = (req, fallback) => req.user?.company_id || fallback || null;
const requirePermission = permissions.creerRequirePermission(pool);

const app = express();
app.use(express.json());
app.use("/", creerAdmin({ pool, authenticateToken, getEffectiveCompanyId, requirePermission }));
app.use("/", creerStock({ pool, authenticateToken, getEffectiveCompanyId, requirePermission }));
const serveur = app.listen(PORT);

const BASE = `http://127.0.0.1:${PORT}`;
async function appel(methode, chemin, jeton, corps) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) },
    ...(corps ? { body: JSON.stringify(corps) } : {}),
  });
  return { statut: r.status, corps: await r.json().catch(() => ({})) };
}

/** Le stock total d'une entreprise : le témoin de toutes les vérifications. */
const stockTotal = async (companyId = 1) =>
  Number((await pool.query(
    `SELECT COALESCE(SUM(quantity),0)::numeric AS q FROM stock_location_balances WHERE company_id=$1`,
    [companyId]
  )).rows[0].q);

const bacParCode = async (code, companyId = 1) =>
  (await pool.query(
    `SELECT * FROM locations WHERE company_id=$1 AND UPPER(COALESCE(full_code,emplacement_code,''))=UPPER($2)`,
    [companyId, code]
  )).rows[0];

/* ══════════════════════════════════════════════════ JEU DE DONNÉES ══ */

async function semer() {
  await pool.query(`TRUNCATE location_audit_log, document_date_revisions RESTART IDENTITY`);
  await pool.query(`DELETE FROM stock_location_balances`);
  await pool.query(`DELETE FROM stock_movements`);
  await pool.query(`DELETE FROM documents`);
  await pool.query(`DELETE FROM locations`);
  await pool.query(`DELETE FROM products`);
  await pool.query(`DELETE FROM warehouses`);
  await pool.query(`DELETE FROM role_permissions`);
  await pool.query(`DELETE FROM users`);
  await pool.query(`DELETE FROM companies`);

  await pool.query(
    `INSERT INTO companies (id, name, status) VALUES (1,'Triangle','active'), (2,'FAT & MAT','active')`);
  await pool.query(`SELECT setval('companies_id_seq', 2, true)`);
  await pool.query(
    `INSERT INTO users (id, fullname, email, password, role, company_id, is_super_admin, is_active) VALUES
       (1,'Super Admin','super@triangle.test','x','super_admin',1,true,true),
       (2,'Magasinier','maga@triangle.test','x','magasinier',1,false,true),
       (9,'Admin FAT','admin@fatmat.test','x','super_admin',2,true,true)`);
  await pool.query(`SELECT setval('users_id_seq', 9, true)`);
  await pool.query(
    `INSERT INTO warehouses (id, code, name, company_id) VALUES
       (1,'WH1','Entrepot Triangle',1), (2,'WH2','Entrepot FAT',2)`);
  await pool.query(`SELECT setval('warehouses_id_seq', 2, true)`);
  await pool.query(
    `INSERT INTO products (id, reference, name, unit, stock, company_id, location_managed) VALUES
       (1,'REF-A','Faux plafond metallique D','unite',600,1,true),
       (2,'REF-B','Profile T24','unite',340,1,true),
       (3,'REF-C','Vis autoforeuse','boite',120,1,true),
       (4,'REF-Z','Produit FAT','unite',50,2,true)`);
  await pool.query(`SELECT setval('products_id_seq', 4, true)`);

  /* Les emplacements reproduisent la réalité de production :
       - de vrais bacs ;
       - un bac COMPOSITE « 1,2,3 » né du « Full Bin » de l'ancien écran ;
       - une PLAGE « BIN1-2 » héritée d'un import ;
       - un niveau TOP ;
       - un rayon B qui devra devenir C. */
  const bacs = [
    // id, wh, row, shelf, level, bin
    [1, 'WH1', 'A', '1', '1', 'BIN1'],
    [2, 'WH1', 'A', '1', '1', 'BIN2'],
    [3, 'WH1', 'A', '1', '2', 'BIN1'],
    [4, 'WH1', 'A', '1', '3', 'BIN1'],
    [5, 'WH1', 'A', '1', 'TOP', 'BIN1'],
    [6, 'WH1', 'A', '2', '1', '1,2,3'],      // composite : le défaut à réparer
    [7, 'WH1', 'A', '3', '1', 'BIN1-2'],     // plage historique
    [8, 'WH1', 'B', '1', '1', 'BIN1'],
    [9, 'WH1', 'B', '1', '1', 'BIN2'],
    [10, 'WH1', 'B', '1', 'TOP', 'BIN1'],
  ];
  for (const [id, wh, row, shelf, level, bin] of bacs) {
    const full = [wh, row, shelf, level, bin].join('-');
    const empl = [wh, row, shelf, level].join('-');
    /* zone/rayon/etagere sont en varchar et rayon_code/case_code/level_code en
       text : réutiliser le même paramètre pour les deux empêche Postgres d'en
       déduire un type. On les passe donc séparément. */
    await pool.query(
      `INSERT INTO locations (id, warehouse_id, warehouse_code, zone, rayon, etagere,
         emplacement_code, rayon_code, case_code, level_code, bin_code, status, company_id,
         full_code, is_active, occupancy_status, level_rank, bin_rank)
       VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Disponible',1,$11,TRUE,'EMPTY',$12,$13)`,
      [id, wh, row, shelf, level, empl, row, shelf, level, bin, full,
       H.levelRank(level), H.binRank(bin)]
    );
  }
  /* Un bac chez FAT & MAT : il ne doit JAMAIS apparaître côté Triangle. */
  await pool.query(
    `INSERT INTO locations (id, warehouse_id, warehouse_code, zone, rayon, etagere,
       emplacement_code, rayon_code, case_code, level_code, bin_code, status, company_id,
       full_code, is_active, occupancy_status, level_rank, bin_rank)
     VALUES (20,2,'WH2','Z','1','1','WH2-Z-1-1','Z','1','1','BIN1','Disponible',2,'WH2-Z-1-1-BIN1',TRUE,'EMPTY',1,1)`);
  await pool.query(`SELECT setval('locations_id_seq', 20, true)`);

  /* Du stock, y compris dans le composite : c'est le cas qui fait mal. */
  const balances = [
    [1, 1, 600, 0],    // produit 1 dans WH1-A-1-1-BIN1
    [2, 2, 200, 50],   // produit 2 dans BIN2, dont 50 réservés → PARTIAL
    [2, 8, 140, 0],    // produit 2 aussi en rayon B
    [3, 6, 120, 0],    // produit 3 dans le COMPOSITE « 1,2,3 »
  ];
  for (const [productId, locationId, q, r] of balances) {
    await pool.query(
      `INSERT INTO stock_location_balances (company_id, product_id, location_id, warehouse_id, quantity, reserved_quantity)
       VALUES (1,$1,$2,1,$3,$4)`, [productId, locationId, q, r]
    );
  }
  await pool.query(
    `INSERT INTO stock_location_balances (company_id, product_id, location_id, warehouse_id, quantity, reserved_quantity)
     VALUES (2,4,20,2,50,0)`);

  /* Droits par rôle : le magasinier n'administre pas les emplacements. */
  await pool.query(
    `INSERT INTO role_permissions (company_id, role, module_key, action, allowed)
     SELECT c.id, r.role, m.module_key, a.action,
            r.role IN ('super_admin','admin','direction')
       FROM companies c
       JOIN (SELECT DISTINCT company_id, lower(trim(role)) AS role FROM users) r ON r.company_id=c.id
       CROSS JOIN permission_modules m
       CROSS JOIN LATERAL unnest(m.actions) AS a(action)
     ON CONFLICT DO NOTHING`);
}

/* ═══════════════════════════════════════════════════════ TESTS ══ */

async function main() {
  await semer();
  const stockDepart = await stockTotal(1);

  console.log("\nTOUS LES BINS SONT VISIBLES");
  {
    const r = await appel("GET", "/stock/locations/inventory", SUPER);
    verifier("la liste répond", r.statut === 200, JSON.stringify(r.corps).slice(0, 200));
    const bins = r.corps.bins || [];
    verifier("les 10 bacs Triangle sont là", bins.length === 10, `${bins.length}`);
    verifier("aucun bac de FAT & MAT n'apparaît",
      !bins.some((b) => String(b.warehouse_code) === "WH2"));

    const occupe = bins.find((b) => b.code === "WH1-A-1-1-BIN1");
    verifier("un bac occupé reste dans la liste", Boolean(occupe));
    verifier("il annonce sa quantité", occupe?.quantity === 600, `${occupe?.quantity}`);
    verifier("il nomme son produit",
      occupe?.contenu?.[0]?.name === "Faux plafond metallique D",
      JSON.stringify(occupe?.contenu));

    const partiel = bins.find((b) => b.code === "WH1-A-1-1-BIN2");
    verifier("un bac partiellement réservé est signalé", partiel?.statut === "PARTIAL", partiel?.statut);
    verifier("et distingue disponible et réservé",
      partiel?.available === 150 && partiel?.reserved === 50,
      `dispo ${partiel?.available} / réservé ${partiel?.reserved}`);

    const composite = bins.find((b) => b.bin_code === "1,2,3");
    verifier("le bac composite « 1,2,3 » est visible, pas caché", Boolean(composite));
    verifier("il est signalé comme composite", composite?.composite === true);
    verifier("il propose les bacs qu'il aurait dû être",
      JSON.stringify(composite?.bins_suggeres) === JSON.stringify(["1", "2", "3"]),
      JSON.stringify(composite?.bins_suggeres));

    const plage = bins.find((b) => b.bin_code === "BIN1-2");
    verifier("la plage « BIN1-2 » est visible avec son motif",
      plage && plage.exploitable === false && plage.motif === "LOCATION_UNRESOLVED_RANGE",
      `${plage?.motif}`);

    verifier("les compteurs couvrent tous les statuts",
      r.corps.compteurs.OCCUPIED >= 1 && r.corps.compteurs.PARTIAL === 1
      && r.corps.compteurs.EMPTY >= 1, JSON.stringify(r.corps.compteurs));
  }

  console.log("\nFILTRES ET RECHERCHE");
  {
    const libres = await appel("GET", "/stock/locations/inventory?statut=EMPTY", SUPER);
    verifier("filtre « Libres »", (libres.corps.bins || []).every((b) => b.quantity === 0));
    const occupes = await appel("GET", "/stock/locations/inventory?statut=OCCUPIED", SUPER);
    verifier("filtre « Occupés »", (occupes.corps.bins || []).every((b) => b.quantity > 0));
    verifier("le filtre ne fausse pas les compteurs",
      occupes.corps.compteurs.TOUS === 10, `${occupes.corps.compteurs.TOUS}`);

    const parProduit = await appel("GET", "/stock/locations/inventory?q=Faux%20plafond", SUPER);
    verifier("recherche par nom de produit",
      (parProduit.corps.bins || []).some((b) => b.code === "WH1-A-1-1-BIN1"),
      `${(parProduit.corps.bins || []).length} résultat(s)`);
    const parRef = await appel("GET", "/stock/locations/inventory?q=REF-B", SUPER);
    verifier("recherche par référence", (parRef.corps.bins || []).length >= 2);
    const parCode = await appel("GET", "/stock/locations/inventory?q=BIN2", SUPER);
    verifier("recherche par code de bac", (parCode.corps.bins || []).length >= 2);
  }

  console.log("\nNIVEAUX — 3 + TOP, puis 4 + TOP");
  {
    const r = await appel("GET", "/stock/locations/levels?warehouse=WH1&row=A&shelf=1", SUPER);
    const niveaux = r.corps.levels || [];
    verifier("l'étagère A-1 porte 3 niveaux + Top", niveaux.length === 4, `${niveaux.length}`);
    verifier("Top est reconnu comme tel",
      niveaux.find((n) => n.level_code === "TOP")?.is_top === true);
    verifier("Top se range EN DERNIER, pas entre 3 et 4",
      niveaux[niveaux.length - 1].level_code === "TOP",
      niveaux.map((n) => n.level_code).join(" < "));

    /* On ajoute Level 4 : il doit s'insérer AVANT Top sans le déplacer. */
    const ajout = await appel("POST", "/stock/locations/bins/bulk", SUPER, {
      warehouse: "WH1", row: "A", shelf: "1", level: "4",
      prefix: "BIN", start: 1, end: 2,
    });
    verifier("Level 4 se crée sans développement supplémentaire", ajout.statut === 201, JSON.stringify(ajout.corps).slice(0, 150));

    const apres = await appel("GET", "/stock/locations/levels?warehouse=WH1&row=A&shelf=1", SUPER);
    const codes = (apres.corps.levels || []).map((n) => n.level_code);
    verifier("l'étagère porte maintenant 4 niveaux + Top", codes.length === 5, codes.join(","));
    verifier("l'ordre reste 1 < 2 < 3 < 4 < TOP",
      JSON.stringify(codes) === JSON.stringify(["1", "2", "3", "4", "TOP"]), codes.join(" < "));
    verifier("un niveau vide est archivable, un niveau occupé non",
      apres.corps.levels.find((n) => n.level_code === "4")?.archivable === true
      && apres.corps.levels.find((n) => n.level_code === "1")?.archivable === false);
  }

  console.log("\nCRÉATION DE BINS EN SÉRIE");
  {
    const apercu = await appel("POST", "/stock/locations/bins/bulk?preview=1", SUPER, {
      warehouse: "WH1", row: "A", shelf: "4", level: "1",
      prefix: "BIN-", start: 1, end: 10, padding: 2,
    });
    verifier("l'aperçu ne crée rien", apercu.statut === 200 && apercu.corps.preview === true);
    verifier("il annonce 10 bacs", apercu.corps.resume.a_creer === 10, JSON.stringify(apercu.corps.resume));
    verifier("les codes sont formatés BIN-01 … BIN-10",
      apercu.corps.plan[0].bin === "BIN-01" && apercu.corps.plan[9].bin === "BIN-10",
      `${apercu.corps.plan[0].bin} … ${apercu.corps.plan[9].bin}`);
    const avantCreation = await pool.query(`SELECT COUNT(*)::int AS n FROM locations WHERE company_id=1`);

    const cree = await appel("POST", "/stock/locations/bins/bulk", SUPER, {
      warehouse: "WH1", row: "A", shelf: "4", level: "1",
      prefix: "BIN-", start: 1, end: 10, padding: 2,
    });
    verifier("la création répond 201", cree.statut === 201);
    verifier("10 bacs sont créés", cree.corps.crees.length === 10, `${cree.corps.crees.length}`);
    verifier("aucun stock n'est placé", cree.corps.stockImpact === 0);
    const apresCreation = await pool.query(`SELECT COUNT(*)::int AS n FROM locations WHERE company_id=1`);
    verifier("la base compte bien 10 lignes de plus",
      apresCreation.rows[0].n - avantCreation.rows[0].n === 10);

    /* Rejouer la même série ne doit pas créer de doublon. */
    const rejeu = await appel("POST", "/stock/locations/bins/bulk", SUPER, {
      warehouse: "WH1", row: "A", shelf: "4", level: "1",
      prefix: "BIN-", start: 1, end: 10, padding: 2,
    });
    verifier("les doublons sont refusés avant validation", rejeu.statut === 409, `statut ${rejeu.statut}`);

    const trop = await appel("POST", "/stock/locations/bins/bulk", SUPER, {
      warehouse: "WH1", row: "A", shelf: "9", level: "1", prefix: "B", start: 1, end: 5000,
    });
    verifier("une série démesurée est refusée", trop.statut === 400 && trop.corps.code === "RANGE_TOO_LARGE");
  }

  console.log("\nDÉCOUPAGE DU COMPOSITE « 1,2,3 » — la cause des bins manquants");
  {
    const avant = await stockTotal(1);
    const composite = await bacParCode("WH1-A-2-1-1,2,3");
    const r = await appel("POST", `/stock/locations/bins/${composite.id}/split`, SUPER, {});
    verifier("le découpage répond 201", r.statut === 201, JSON.stringify(r.corps).slice(0, 150));
    verifier("trois vrais bacs sont créés", r.corps.crees.length === 3, `${r.corps.crees.length}`);
    verifier("ils s'appellent 1, 2 et 3",
      JSON.stringify(r.corps.crees.map((c) => c.bin_code)) === JSON.stringify(["1", "2", "3"]),
      JSON.stringify(r.corps.crees.map((c) => c.bin_code)));
    verifier("les bacs créés sont VIDES", r.corps.stockImpact === 0);
    verifier("le stock du composite n'a pas bougé",
      Number(r.corps.composite.quantite) === 120, `${r.corps.composite.quantite}`);
    verifier("le stock total est inchangé", (await stockTotal(1)) === avant, `${avant} → ${await stockTotal(1)}`);
    verifier("le composite existe toujours (rien n'est supprimé)",
      Boolean(await bacParCode("WH1-A-2-1-1,2,3")));

    const listeApres = await appel("GET", "/stock/locations/inventory?q=WH1-A-2-1", SUPER);
    verifier("Bin 1, Bin 2 et Bin 3 apparaissent enfin dans la liste",
      ["1", "2", "3"].every((b) =>
        (listeApres.corps.bins || []).some((x) => x.bin_code === b)),
      (listeApres.corps.bins || []).map((x) => x.bin_code).join(","));
  }

  console.log("\nRENOMMAGE D'UN BAC");
  {
    const avant = await stockTotal(1);
    const libre = await bacParCode("WH1-A-1-3-BIN1");
    const r1 = await appel("PATCH", `/stock/locations/bins/${libre.id}`, SUPER,
      { bin: "BIN9", reason: "Réétiquetage" });
    verifier("un bac libre se renomme", r1.statut === 200 && r1.corps.renamed === true);
    const apresLibre = await pool.query(`SELECT id, full_code FROM locations WHERE id=$1`, [libre.id]);
    verifier("son id n'a pas changé", apresLibre.rows[0].id === libre.id);
    verifier("son code a changé", apresLibre.rows[0].full_code === "WH1-A-1-3-BIN9");

    const occupe = await bacParCode("WH1-A-1-1-BIN1");
    const qAvant = Number((await pool.query(
      `SELECT SUM(quantity)::numeric AS q FROM stock_location_balances WHERE location_id=$1`, [occupe.id]
    )).rows[0].q);
    const r2 = await appel("PATCH", `/stock/locations/bins/${occupe.id}`, SUPER,
      { bin: "BIN01", reason: "Harmonisation des étiquettes" });
    verifier("un bac OCCUPÉ se renomme aussi", r2.statut === 200, JSON.stringify(r2.corps).slice(0, 150));
    const qApres = Number((await pool.query(
      `SELECT SUM(quantity)::numeric AS q FROM stock_location_balances WHERE location_id=$1`, [occupe.id]
    )).rows[0].q);
    verifier("son stock n'a pas bougé d'une unité", qApres === qAvant, `${qAvant} → ${qApres}`);
    verifier("le stock total est inchangé", (await stockTotal(1)) === avant);
    verifier("l'ancien code reste consultable",
      (await pool.query(`SELECT previous_full_code FROM locations WHERE id=$1`, [occupe.id]))
        .rows[0].previous_full_code === "WH1-A-1-1-BIN1");

    const collision = await appel("PATCH", `/stock/locations/bins/${occupe.id}`, SUPER,
      { bin: "BIN2", reason: "test" });
    verifier("renommer vers un code déjà pris est refusé",
      collision.statut === 409 && collision.corps.code === "CODE_ALREADY_USED", `statut ${collision.statut}`);
  }

  console.log("\nARCHIVAGE — jamais de suppression");
  {
    const occupe = await bacParCode("WH1-A-1-1-BIN2");
    const refus = await appel("PATCH", `/stock/locations/bins/${occupe.id}`, SUPER,
      { archive: true, reason: "test" });
    verifier("un bac occupé ne s'archive pas",
      refus.statut === 409 && refus.corps.code === "BIN_NOT_EMPTY", `statut ${refus.statut}`);

    const vide = await bacParCode("WH1-A-1-TOP-BIN1");
    const ok = await appel("PATCH", `/stock/locations/bins/${vide.id}`, SUPER,
      { archive: true, reason: "Étagère démontée" });
    verifier("un bac vide s'archive", ok.statut === 200 && ok.corps.archived === true);
    const ligne = await pool.query(`SELECT id, archived_at FROM locations WHERE id=$1`, [vide.id]);
    verifier("la ligne existe toujours en base", ligne.rows.length === 1);
    verifier("elle porte une date d'archivage", Boolean(ligne.rows[0].archived_at));
    const liste = await appel("GET", "/stock/locations/inventory", SUPER);
    verifier("elle sort de la liste courante",
      !(liste.corps.bins || []).some((b) => b.id === vide.id));
    const avecArchives = await appel("GET", "/stock/locations/inventory?archived=1&statut=ARCHIVED", SUPER);
    verifier("un filtre dédié la retrouve",
      (avecArchives.corps.bins || []).some((b) => b.id === vide.id));
  }

  console.log("\nRÉORGANISATION — A reste A, le nouveau devient B, l'ancien B devient C");
  {
    /* Le rayon physique inséré entre A et B. On le nomme « D » : « NOUVEAU »
       est refusé par la règle des placeholders — et c'est voulu, un rayon ne
       s'appelle pas « nouveau ». */
    const creationD = await appel("POST", "/stock/locations/bins/bulk", SUPER, {
      warehouse: "WH1", row: "D", shelf: "1", level: "1",
      prefix: "BIN", start: 1, end: 2,
    });
    verifier("le nouveau rayon physique est créé", creationD.statut === 201,
      JSON.stringify(creationD.corps).slice(0, 150));
    const refusPlaceholder = await appel("POST", "/stock/locations/bins/bulk?preview=1", SUPER, {
      warehouse: "WH1", row: "NOUVEAU", shelf: "1", level: "1",
      prefix: "BIN", start: 1, end: 1,
    });
    verifier("un rayon nommé « NOUVEAU » est refusé par la règle",
      refusPlaceholder.corps.resume?.refuses === 1,
      JSON.stringify(refusPlaceholder.corps.resume));
    const stockAvant = await stockTotal(1);
    const bAvant = await bacParCode("WH1-B-1-1-BIN1");
    const qBAvant = Number((await pool.query(
      `SELECT COALESCE(SUM(quantity),0)::numeric AS q FROM stock_location_balances WHERE location_id=$1`,
      [bAvant.id]
    )).rows[0].q);

    const mappings = [
      { scope: "ROW", warehouse: "WH1", from: "A", to: "A" },
      { scope: "ROW", warehouse: "WH1", from: "B", to: "C" },
      { scope: "ROW", warehouse: "WH1", from: "D", to: "B" },
    ];

    const apercu = await appel("POST", "/stock/locations/reorganize/preview", SUPER, { mappings });
    verifier("l'aperçu répond", apercu.statut === 200, JSON.stringify(apercu.corps).slice(0, 200));
    verifier("il chiffre les bacs concernés", apercu.corps.resume.bins > 0, JSON.stringify(apercu.corps.resume));
    verifier("il annonce un stock identique avant et après",
      apercu.corps.resume.quantiteAvant === apercu.corps.resume.quantiteApres);
    verifier("il déclare le plan applicable malgré B→C avec C inexistant",
      apercu.corps.applicable === true,
      `collisions ${JSON.stringify(apercu.corps.collisions)}`);

    const sansMotif = await appel("POST", "/stock/locations/reorganize/apply", SUPER, { mappings });
    verifier("appliquer sans motif est refusé",
      sansMotif.statut === 400 && sansMotif.corps.code === "REASON_REQUIRED");

    const r = await appel("POST", "/stock/locations/reorganize/apply", SUPER,
      { mappings, reason: "Nouveau rayon physique inséré entre A et B" });
    verifier("la réorganisation s'applique", r.statut === 200, JSON.stringify(r.corps).slice(0, 200));

    verifier("le rayon A est resté A", Boolean(await bacParCode("WH1-A-1-1-BIN01")));
    verifier("l'ancien rayon B est devenu C", Boolean(await bacParCode("WH1-C-1-1-BIN1")));
    verifier("le nouveau rayon est devenu B", Boolean(await bacParCode("WH1-B-1-1-BIN1")));

    const bApres = await pool.query(`SELECT id, full_code FROM locations WHERE id=$1`, [bAvant.id]);
    verifier("l'id interne du bac déplacé n'a pas changé", bApres.rows[0].id === bAvant.id);
    verifier("il porte le nouveau code", bApres.rows[0].full_code === "WH1-C-1-1-BIN1", bApres.rows[0].full_code);
    const qBApres = Number((await pool.query(
      `SELECT COALESCE(SUM(quantity),0)::numeric AS q FROM stock_location_balances WHERE location_id=$1`,
      [bAvant.id]
    )).rows[0].q);
    verifier("son stock est intact", qBApres === qBAvant, `${qBAvant} → ${qBApres}`);
    verifier("LE STOCK TOTAL EST STRICTEMENT IDENTIQUE",
      (await stockTotal(1)) === stockAvant, `${stockAvant} → ${await stockTotal(1)}`);

    const negatifs = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stock_location_balances WHERE quantity < 0`);
    verifier("aucun stock négatif", negatifs.rows[0].n === 0);

    const journal = await appel("GET", `/stock/locations/audit?batch_id=${r.corps.batchId}`, SUPER);
    verifier("chaque renommage est journalisé",
      (journal.corps.entries || []).length === r.corps.bins,
      `${(journal.corps.entries || []).length} / ${r.corps.bins}`);
    verifier("le journal porte l'ancien et le nouveau code",
      journal.corps.entries.every((e) => e.old_value && e.new_value));
    verifier("il porte le motif",
      journal.corps.entries.every((e) => e.reason.includes("Nouveau rayon")));
  }

  console.log("\nCOLLISION ET ANNULATION");
  {
    const stockAvant = await stockTotal(1);
    /* C existe désormais : renommer A → C sans renommer C est impossible. */
    const collision = await appel("POST", "/stock/locations/reorganize/preview", SUPER,
      { mappings: [{ scope: "ROW", warehouse: "WH1", from: "A", to: "C" }] });
    verifier("une vraie collision est détectée à l'aperçu",
      collision.corps.applicable === false && collision.corps.collisions.length > 0,
      JSON.stringify(collision.corps.collisions).slice(0, 120));

    const refus = await appel("POST", "/stock/locations/reorganize/apply", SUPER,
      { mappings: [{ scope: "ROW", warehouse: "WH1", from: "A", to: "C" }], reason: "test collision" });
    verifier("l'application est refusée", refus.statut === 409, `statut ${refus.statut}`);
    verifier("rien n'a été renommé", Boolean(await bacParCode("WH1-A-1-1-BIN01")));
    verifier("le stock est intact après le refus", (await stockTotal(1)) === stockAvant);

    const vide = await appel("POST", "/stock/locations/reorganize/apply", SUPER,
      { mappings: [{ scope: "ROW", warehouse: "WH1", from: "INEXISTANT", to: "X" }], reason: "test" });
    verifier("un plan qui ne vise rien est refusé", vide.statut === 409 && vide.corps.code === "PLAN_EMPTY");
  }

  console.log("\nTRANSFERT ENTRE BINS");
  {
    const stockAvant = await stockTotal(1);
    const source = await bacParCode("WH1-A-1-1-BIN01");
    const destination = await bacParCode("WH1-A-1-2-BIN1");

    const partiel = await appel("POST", "/stock/locations/transfer", SUPER, {
      productId: 1, sourceLocationId: source.id, destinationLocationId: destination.id,
      quantity: 100, reason: "Transfert partiel",
    });
    /* 201 : un transfert CRÉE un mouvement, il ne se contente pas de répondre. */
    verifier("transfert partiel accepté", partiel.statut === 201, `statut ${partiel.statut}`);
    verifier("il crée un vrai mouvement de transfert",
      partiel.corps.movement?.type === "Transfert", partiel.corps.movement?.type);
    verifier("le stock global du produit est inchangé",
      Number(partiel.corps.stockBefore) === Number(partiel.corps.stockAfter),
      `${partiel.corps.stockBefore} → ${partiel.corps.stockAfter}`);
    verifier("le stock total ne bouge pas", (await stockTotal(1)) === stockAvant);

    const trop = await appel("POST", "/stock/locations/transfer", SUPER, {
      productId: 1, sourceLocationId: source.id, destinationLocationId: destination.id,
      quantity: 999999,
    });
    verifier("quantité supérieure au disponible refusée", trop.statut === 409, `statut ${trop.statut}`);

    const memeBac = await appel("POST", "/stock/locations/transfer", SUPER, {
      productId: 1, sourceLocationId: source.id, destinationLocationId: source.id, quantity: 1,
    });
    verifier("source = destination refusé", memeBac.statut === 400, `statut ${memeBac.statut}`);

    const negatif = await appel("POST", "/stock/locations/transfer", SUPER, {
      productId: 1, sourceLocationId: source.id, destinationLocationId: destination.id, quantity: -5,
    });
    verifier("quantité négative refusée", negatif.statut === 400);

    const versPlage = await bacParCode("WH1-A-3-1-BIN1-2");
    const refusPlage = await appel("POST", "/stock/locations/transfer", SUPER, {
      productId: 1, sourceLocationId: source.id, destinationLocationId: versPlage.id, quantity: 1,
    });
    verifier("une plage « BIN1-2 » n'est jamais destination", refusPlage.statut === 409, `statut ${refusPlage.statut}`);
    verifier("le stock total est inchangé après tous les refus",
      (await stockTotal(1)) === stockAvant, `${stockAvant} → ${await stockTotal(1)}`);
  }

  console.log("\nDROITS ET CLOISONNEMENT");
  {
    const sans = await appel("GET", "/stock/locations/inventory", MAGASINIER);
    verifier("un magasinier sans droit est refusé", sans.statut === 403 || sans.statut === 404, `statut ${sans.statut}`);
    const ecriture = await appel("POST", "/stock/locations/bins/bulk", MAGASINIER,
      { warehouse: "WH1", row: "Z", shelf: "1", level: "1", prefix: "B", start: 1, end: 1 });
    verifier("il ne peut pas créer de bac", ecriture.statut === 403 || ecriture.statut === 404);
    const reorg = await appel("POST", "/stock/locations/reorganize/apply", MAGASINIER,
      { mappings: [{ scope: "ROW", from: "A", to: "Z" }], reason: "tentative" });
    verifier("il ne peut pas réorganiser", reorg.statut === 403 || reorg.statut === 404);

    const etranger = await appel("GET", "/stock/locations/inventory", ETRANGER);
    verifier("FAT & MAT ne voit que ses propres bacs",
      (etranger.corps.bins || []).every((b) => b.warehouse_code === "WH2"),
      `${(etranger.corps.bins || []).length} bac(s)`);
    const cible = await bacParCode("WH1-A-1-1-BIN01");
    const intrusion = await appel("PATCH", `/stock/locations/bins/${cible.id}`, ETRANGER,
      { bin: "PIRATE", reason: "tentative" });
    verifier("il ne peut pas renommer un bac Triangle", intrusion.statut === 404, `statut ${intrusion.statut}`);
    verifier("le bac Triangle est intact", Boolean(await bacParCode("WH1-A-1-1-BIN01")));
  }

  console.log("\nBILAN DU STOCK");
  {
    const fin = await stockTotal(1);
    verifier("le stock total Triangle est identique au départ",
      fin === stockDepart, `${stockDepart} au départ → ${fin} à l'arrivée`);
    const fat = await stockTotal(2);
    verifier("le stock FAT & MAT n'a jamais été touché", fat === 50, `${fat}`);
  }

  serveur.close();
  await pool.end();
  console.log(`\n${reussis} réussis, ${echoues} échoués\n`);
  process.exit(echoues ? 1 : 0);
}

main().catch(async (e) => {
  console.error("ÉCHEC :", e);
  serveur.close();
  await pool.end().catch(() => {});
  process.exit(1);
});
