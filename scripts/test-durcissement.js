"use strict";

/**
 * TESTS DE DURCISSEMENT — contre le VRAI serveur.
 *
 * Les routes historiques `/locations` et `/scan/resolve` sont déclarées
 * directement sur `app` dans server.js. Les monter sur un Express de test
 * éprouverait une copie, pas le code servi : ce script interroge donc le
 * serveur réel, démarré sur la base de test.
 *
 *   bash scripts/test-durcissement.sh
 *
 * Il vérifie quatre choses qu'on ne peut pas déduire du code :
 *   — une étiquette QR posée avant un renommage retrouve son bac ;
 *   — aucun emplacement historique ambigu ne disparaît en silence ;
 *   — une réorganisation se relit et se propose à l'envers, sans s'exécuter ;
 *   — l'ancienne API n'ouvre plus la porte d'à côté.
 */

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const H = require("../services/location-hierarchy");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const BASE = process.env.BASE_URL || "http://127.0.0.1:5050";
const SECRET = process.env.JWT_SECRET || "test-secret-durcissement";

let reussis = 0, echoues = 0;
const verifier = (nom, ok, detail = "") => {
  if (ok) { reussis += 1; console.log(`  ✓ ${nom}`); }
  else { echoues += 1; console.log(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`); }
};

const jeton = (u) => jwt.sign(
  { id: u.id, email: u.email, role: u.role, company_id: u.company_id, is_super_admin: u.is_super_admin },
  SECRET, { expiresIn: "1h" });

let TRIANGLE, MAGASINIER, FATMAT;

async function appel(methode, chemin, token, corps) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(corps ? { body: JSON.stringify(corps) } : {}),
  });
  return { statut: r.status, corps: await r.json().catch(() => ({})) };
}

const stockTotal = async (c = 1) => Number((await pool.query(
  `SELECT COALESCE(SUM(quantity),0)::numeric AS q FROM stock_location_balances WHERE company_id=$1`, [c]
)).rows[0].q);

const bacParCode = async (code, c = 1) => (await pool.query(
  `SELECT * FROM locations WHERE company_id=$1 AND UPPER(COALESCE(full_code,emplacement_code,''))=UPPER($2)`,
  [c, code])).rows[0];

/* ═══════════════════════════════════════════════ JEU DE DONNÉES ══ */

async function semer() {
  await pool.query(`TRUNCATE location_audit_log, document_date_revisions RESTART IDENTITY`);
  for (const t of ["document_items", "stock_reservations", "stock_location_balances",
                   "stock_movements", "documents", "locations", "products", "warehouses",
                   "role_permissions", "user_permissions", "users", "companies"]) {
    await pool.query(`DELETE FROM ${t}`).catch(() => {});
  }
  await pool.query(`INSERT INTO companies (id,name,status) VALUES (1,'Triangle','active'),(2,'FAT & MAT','active')`);
  await pool.query(`SELECT setval('companies_id_seq',2,true)`);
  await pool.query(
    `INSERT INTO users (id,fullname,email,password,role,company_id,is_super_admin,is_active) VALUES
       (1,'Admin Triangle','admin@triangle.test','x','super_admin',1,true,true),
       (2,'Magasinier','maga@triangle.test','x','magasinier',1,false,true),
       (9,'Admin FAT','admin@fatmat.test','x','super_admin',2,true,true)`);
  await pool.query(`SELECT setval('users_id_seq',9,true)`);
  await pool.query(
    `INSERT INTO warehouses (id,code,name,company_id) VALUES (1,'WH1','Triangle',1),(2,'WH2','FAT',2)`);
  await pool.query(`SELECT setval('warehouses_id_seq',2,true)`);
  await pool.query(
    `INSERT INTO products (id,reference,name,unit,stock,company_id,location_managed) VALUES
       (1,'REF-A','Faux plafond metallique D','unite',600,1,true),
       (2,'REF-B','Profile T24','unite',340,1,true),
       (3,'REF-C','Vis autoforeuse','boite',180,1,true),
       (4,'REF-Z','Produit FAT','unite',50,2,true)`);
  await pool.query(`SELECT setval('products_id_seq',4,true)`);

  /* Les cinq formes ambiguës citées par le terrain, plus de vrais bacs. */
  const bacs = [
    [1, 1, 'WH1', 'A', '1', '1', 'BIN1'],
    [2, 1, 'WH1', 'A', '1', '1', 'BIN2'],
    [3, 1, 'WH1', 'A', '1', 'TOP', 'BIN1'],
    [4, 1, 'WH1', 'B', '1', '1', 'BIN1'],
    [5, 1, 'WH1', 'C', '1', '1', '1,2,3'],    // composite
    [6, 1, 'WH1', 'C', '2', '1', '1,2'],      // composite partiel
    [7, 1, 'WH1', 'C', '3', '1', '2,3'],      // composite partiel
    [8, 1, 'WH1', 'D', '1', '1', 'BIN1-2'],   // plage
    [9, 1, 'WH1', 'D', '2', '1', 'BIN2-3'],   // plage
    [20, 2, 'WH2', 'Z', '1', '1', 'BIN1'],
  ];
  for (const [id, comp, wh, row, shelf, level, bin] of bacs) {
    const full = [wh, row, shelf, level, bin].join('-');
    const empl = [wh, row, shelf, level].join('-');
    await pool.query(
      `INSERT INTO locations (id,warehouse_id,warehouse_code,zone,rayon,etagere,emplacement_code,
         rayon_code,case_code,level_code,bin_code,status,company_id,full_code,is_active,
         occupancy_status,level_rank,bin_rank)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Disponible',$12,$13,TRUE,'EMPTY',$14,$15)`,
      [id, comp === 1 ? 1 : 2, wh, row, shelf, level, empl, row, shelf, level, bin,
       comp, full, H.levelRank(level), H.binRank(bin)]);
  }
  await pool.query(`SELECT setval('locations_id_seq',20,true)`);

  for (const [pid, lid, q, r] of [
    [1, 1, 600, 0], [2, 4, 140, 0],
    [3, 5, 180, 0],   // le composite « 1,2,3 » porte du stock : le cas qui fait mal
    [2, 6, 200, 40],  // un composite avec du réservé
  ]) {
    await pool.query(
      `INSERT INTO stock_location_balances (company_id,product_id,location_id,warehouse_id,quantity,reserved_quantity)
       VALUES (1,$1,$2,1,$3,$4)`, [pid, lid, q, r]);
  }
  await pool.query(
    `INSERT INTO stock_location_balances (company_id,product_id,location_id,warehouse_id,quantity,reserved_quantity)
     VALUES (2,4,20,2,50,0)`);

  await pool.query(
    `INSERT INTO role_permissions (company_id, role, module_key, action, allowed)
     SELECT c.id, r.role, m.module_key, a.action,
            r.role IN ('super_admin','admin','direction')
       FROM companies c
       JOIN (SELECT DISTINCT company_id, lower(trim(role)) AS role FROM users) r ON r.company_id=c.id
       CROSS JOIN permission_modules m
       CROSS JOIN LATERAL unnest(m.actions) AS a(action)
     ON CONFLICT DO NOTHING`);

  TRIANGLE = jeton({ id: 1, email: "admin@triangle.test", role: "super_admin", company_id: 1, is_super_admin: true });
  MAGASINIER = jeton({ id: 2, email: "maga@triangle.test", role: "magasinier", company_id: 1, is_super_admin: false });
  FATMAT = jeton({ id: 9, email: "admin@fatmat.test", role: "super_admin", company_id: 2, is_super_admin: true });
}

/* ══════════════════════════════════════════════════════ TESTS ══ */

async function main() {
  await semer();
  const stockDepart = await stockTotal(1);

  console.log("\n① ANCIENNES ÉTIQUETTES QR APRÈS RENOMMAGE");
  {
    const actuel = await appel("GET", "/scan/resolve/WH1-A-1-1-BIN1", TRIANGLE);
    verifier("un QR au code actuel résout", actuel.statut === 200 && actuel.corps.type === "location",
      `statut ${actuel.statut}`);
    verifier("il n'est pas signalé comme ancien", actuel.corps.ancienne_etiquette === false);
    verifier("il indique le code actuel", actuel.corps.code_actuel === "WH1-A-1-1-BIN1",
      actuel.corps.code_actuel);
    const idAvant = actuel.corps.location?.id;

    /* On renomme le rayon A en E : toutes les étiquettes de A deviennent périmées. */
    const reorg = await appel("POST", "/stock/locations/reorganize/apply", TRIANGLE, {
      mappings: [{ scope: "ROW", warehouse: "WH1", from: "A", to: "E" }],
      reason: "Test des anciennes étiquettes",
    });
    verifier("le rayon A est renommé en E", reorg.statut === 200, JSON.stringify(reorg.corps).slice(0, 150));

    const ancien = await appel("GET", "/scan/resolve/WH1-A-1-1-BIN1", TRIANGLE);
    verifier("UNE ANCIENNE ÉTIQUETTE RETROUVE SON BAC", ancien.statut === 200,
      `statut ${ancien.statut} — ${JSON.stringify(ancien.corps).slice(0, 120)}`);
    verifier("c'est LE MÊME locations.id", ancien.corps.location?.id === idAvant,
      `${idAvant} → ${ancien.corps.location?.id}`);
    verifier("elle est signalée comme ancienne", ancien.corps.ancienne_etiquette === true);
    verifier("l'ancien code utilisé est rendu", ancien.corps.ancien_code_utilise === "WH1-A-1-1-BIN1",
      ancien.corps.ancien_code_utilise);
    verifier("le code actuel est rendu", ancien.corps.code_actuel === "WH1-E-1-1-BIN1",
      ancien.corps.code_actuel);
    verifier("un avertissement explicite accompagne la réponse",
      String(ancien.corps.avertissement || "").includes("Ancienne étiquette"),
      ancien.corps.avertissement);
    verifier("la résolution dit par quelle piste elle est passée",
      ancien.corps.resolu_par === "previous_full_code", ancien.corps.resolu_par);

    const nouveau = await appel("GET", "/scan/resolve/WH1-E-1-1-BIN1", TRIANGLE);
    verifier("le nouveau code résout aussi, sans avertissement",
      nouveau.statut === 200 && nouveau.corps.ancienne_etiquette === false);

    const inconnu = await appel("GET", "/scan/resolve/WH1-Z-9-9-BINX", TRIANGLE);
    verifier("un code inconnu répond 404", inconnu.statut === 404, `statut ${inconnu.statut}`);

    const chezLautre = await appel("GET", "/scan/resolve/WH1-A-1-1-BIN1", FATMAT);
    verifier("l'ancien code d'une autre entreprise est refusé", chezLautre.statut === 404,
      `statut ${chezLautre.statut}`);
    const actuelChezLautre = await appel("GET", "/scan/resolve/WH1-E-1-1-BIN1", FATMAT);
    verifier("le code actuel d'une autre entreprise aussi", actuelChezLautre.statut === 404);

    /* Deux bacs portant le MÊME ancien code : la base peut le produire par
       deux renommages successifs. On refuse plutôt que d'en désigner un. */
    await pool.query(
      `UPDATE locations SET previous_full_code='WH1-DOUBLON' WHERE id IN (1,2) AND company_id=1`);
    const ambigu = await appel("GET", "/scan/resolve/WH1-DOUBLON", TRIANGLE);
    verifier("un ancien code partagé par deux bacs est refusé, pas deviné",
      ambigu.statut === 409 && ambigu.corps.code === "AMBIGUOUS_CODE", `statut ${ambigu.statut}`);
    verifier("le refus nomme les emplacements en cause",
      (ambigu.corps.details?.emplacements || []).length === 2,
      JSON.stringify(ambigu.corps.details));
    await pool.query(
      `UPDATE locations SET previous_full_code=NULL WHERE id=2 AND company_id=1`);
    await pool.query(
      `UPDATE locations SET previous_full_code='WH1-A-1-1-BIN1' WHERE id=1 AND company_id=1`);
  }

  console.log("\n② EMPLACEMENTS HISTORIQUES AMBIGUS — visibles, jamais silencieux");
  {
    const r = await appel("GET", "/stock/locations/inventory", TRIANGLE);
    const bins = r.corps.bins || [];
    const formes = ["1,2,3", "1,2", "2,3", "BIN1-2", "BIN2-3"];
    for (const forme of formes) {
      const b = bins.find((x) => x.bin_code === forme);
      verifier(`« ${forme} » apparaît dans l'administration`, Boolean(b));
      verifier(`« ${forme} » porte le statut « à régulariser »`,
        b?.statut === "A_REGULARISER" && b?.statut_libelle === "Emplacement historique à régulariser",
        `${b?.statut} / ${b?.statut_libelle}`);
      verifier(`« ${forme} » explique son ambiguïté`, Boolean(b?.motif_libelle) || b?.composite === true,
        `motif ${b?.motif} composite ${b?.composite}`);
      verifier(`« ${forme} » propose les bacs réels`, (b?.bins_suggeres || []).length >= 2,
        JSON.stringify(b?.bins_suggeres));
      verifier(`« ${forme} » situe son rayon, son étagère et son niveau`,
        Boolean(b?.row_code && b?.shelf_code && b?.level_code));
    }
    verifier("le compteur dédié les dénombre", r.corps.compteurs.A_REGULARISER === 5,
      `${r.corps.compteurs.A_REGULARISER}`);

    const avecStock = bins.find((x) => x.bin_code === "1,2,3");
    verifier("un ambigu occupé annonce son produit et sa quantité",
      avecStock?.quantity === 180 && avecStock?.contenu?.[0]?.name === "Vis autoforeuse",
      `${avecStock?.quantity} / ${JSON.stringify(avecStock?.contenu)}`);
    const avecReserve = bins.find((x) => x.bin_code === "1,2");
    verifier("il annonce aussi le réservé",
      avecReserve?.reserved === 40 && avecReserve?.available === 160,
      `réservé ${avecReserve?.reserved} dispo ${avecReserve?.available}`);
  }

  console.log("\n③ RÉGULARISATION — répartition manuelle, jamais automatique");
  {
    const source = await bacParCode("WH1-C-1-1-1,2,3");
    const stockAvant = await stockTotal(1);

    const sansMotif = await appel("POST", `/stock/locations/bins/${source.id}/regulariser`, TRIANGLE,
      { repartitions: [{ product_id: 3, bin: "BIN1", quantity: 180 }] });
    verifier("sans motif : refusé", sansMotif.statut === 400 && sansMotif.corps.code === "REASON_REQUIRED");

    const faux = await appel("POST", `/stock/locations/bins/${source.id}/regulariser`, TRIANGLE, {
      reason: "test", repartitions: [{ product_id: 3, bin: "BIN1", quantity: 100 }],
    });
    verifier("une somme différente de la source est refusée",
      faux.statut === 400 && faux.corps.code === "ALLOCATION_MISMATCH", `statut ${faux.statut}`);
    verifier("le refus dit exactement ce qui manque",
      String(faux.corps.error).includes("180"), faux.corps.error);
    verifier("rien n'a été écrit", (await stockTotal(1)) === stockAvant);

    const tropDeBins = await appel("POST", `/stock/locations/bins/${source.id}/regulariser`, TRIANGLE, {
      reason: "test", repartitions: [{ product_id: 3, bin: "REBUT", quantity: 180 }],
    });
    verifier("un bac destination invalide est refusé", tropDeBins.statut === 409, `statut ${tropDeBins.statut}`);

    /* La bonne répartition : 100 en BIN1, 50 en BIN2, 30 laissés sur place. */
    const ok = await appel("POST", `/stock/locations/bins/${source.id}/regulariser`, TRIANGLE, {
      reason: "Comptage physique du 22/08",
      repartitions: [
        { product_id: 3, bin: "BIN1", quantity: 100 },
        { product_id: 3, bin: "BIN2", quantity: 50 },
      ],
      reliquats: { 3: 30 },
    });
    verifier("la régularisation avec reliquat explicite passe", ok.statut === 201,
      JSON.stringify(ok.corps).slice(0, 200));
    verifier("deux vrais bacs sont créés", ok.corps.bins_crees.length === 2);
    verifier("deux vrais mouvements de transfert sont écrits",
      ok.corps.mouvements.length === 2 && ok.corps.mouvements.every((m) => m.movement_id),
      JSON.stringify(ok.corps.mouvements));
    verifier("LE STOCK TOTAL EST INCHANGÉ", (await stockTotal(1)) === stockAvant,
      `${stockAvant} → ${await stockTotal(1)}`);
    verifier("le reliquat reste sur l'origine", ok.corps.reliquat_total === 30, `${ok.corps.reliquat_total}`);
    verifier("l'origine n'est PAS archivée tant qu'elle contient quelque chose",
      ok.corps.archivee === false);

    const mvts = await pool.query(
      `SELECT type, quantity FROM stock_movements WHERE company_id=1 AND type='Transfert' ORDER BY id DESC LIMIT 2`);
    verifier("les mouvements sont bien de type Transfert",
      mvts.rows.length === 2 && mvts.rows.every((m) => m.type === "Transfert"));

    /* On solde le reliquat : l'origine se vide et s'archive. */
    const solde = await appel("POST", `/stock/locations/bins/${source.id}/regulariser`, TRIANGLE, {
      reason: "Solde du reliquat",
      repartitions: [{ product_id: 3, bin: "BIN3", quantity: 30 }],
      reliquats: { 3: 0 },
    });
    verifier("le solde du reliquat passe", solde.statut === 201, JSON.stringify(solde.corps).slice(0, 150));
    verifier("l'origine est alors archivée", solde.corps.archivee === true);

    const apres = await pool.query(`SELECT * FROM locations WHERE id=$1`, [source.id]);
    verifier("l'origine EXISTE TOUJOURS en base", apres.rows.length === 1);
    verifier("elle garde son ancien code", apres.rows[0].previous_full_code === "WH1-C-1-1-1,2,3",
      apres.rows[0].previous_full_code);
    const journal = await pool.query(
      `SELECT COUNT(*)::int AS n FROM location_audit_log WHERE location_id=$1`, [source.id]);
    verifier("son historique est conservé", journal.rows[0].n >= 2, `${journal.rows[0].n} entrée(s)`);
    verifier("le stock total est toujours identique", (await stockTotal(1)) === stockAvant);

    /* Le réservé bloque : on ne déplace pas ce qui est immobilisé. */
    const reserve = await bacParCode("WH1-C-2-1-1,2");
    const refusReserve = await appel("POST", `/stock/locations/bins/${reserve.id}/regulariser`, TRIANGLE, {
      reason: "test réservé",
      repartitions: [{ product_id: 2, bin: "BIN1", quantity: 200 }],
      reliquats: { 2: 0 },
    });
    verifier("on ne déplace pas du stock réservé",
      refusReserve.statut === 409 && refusReserve.corps.code === "RESERVED_STOCK",
      `statut ${refusReserve.statut}`);
  }

  console.log("\n④ RÉORGANISATION — relecture et plan inverse, sans exécution");
  {
    const stockAvant = await stockTotal(1);
    const r = await appel("POST", "/stock/locations/reorganize/apply", TRIANGLE, {
      mappings: [
        { scope: "ROW", warehouse: "WH1", from: "B", to: "X" },
      ],
      reason: "Réorganisation à annuler",
    });
    verifier("la réorganisation s'applique", r.statut === 200, JSON.stringify(r.corps).slice(0, 150));
    verifier("elle rend d'emblée le plan inverse",
      (r.corps.mappings_inverse || []).length === 1
      && r.corps.mappings_inverse[0].from === "X" && r.corps.mappings_inverse[0].to === "B",
      JSON.stringify(r.corps.mappings_inverse));

    const relecture = await appel("GET", `/stock/locations/reorganize/${r.corps.batchId}`, TRIANGLE);
    verifier("le lot se relit", relecture.statut === 200, JSON.stringify(relecture.corps).slice(0, 150));
    verifier("il rend le plan appliqué bac par bac",
      (relecture.corps.plan_applique || []).length === r.corps.bins);
    verifier("il rend les correspondances d'origine",
      relecture.corps.mappings?.[0]?.from === "B" && relecture.corps.mappings?.[0]?.to === "X");
    verifier("il rend le plan inverse",
      relecture.corps.mappings_inverse?.[0]?.from === "X"
      && relecture.corps.mappings_inverse?.[0]?.to === "B");
    verifier("il rend l'aperçu du retour arrière",
      relecture.corps.apercu_retour?.applicable === true,
      JSON.stringify(relecture.corps.apercu_retour?.resume));
    verifier("il dit que RIEN n'est exécuté",
      String(relecture.corps.avertissement).includes("n'est pas exécuté"));
    verifier("relire ne change rien", Boolean(await bacParCode("WH1-X-1-1-BIN1")));
    verifier("le motif et l'auteur sont conservés",
      relecture.corps.motif === "Réorganisation à annuler" && Boolean(relecture.corps.applique_par));

    /* Le retour arrière passe par le circuit ordinaire : aperçu, motif, apply. */
    const apercuRetour = await appel("POST", "/stock/locations/reorganize/preview", TRIANGLE,
      { mappings: relecture.corps.mappings_inverse });
    verifier("le plan inverse se prévisualise comme n'importe quel plan",
      apercuRetour.statut === 200 && apercuRetour.corps.applicable === true);

    const sansMotif = await appel("POST", "/stock/locations/reorganize/apply", TRIANGLE,
      { mappings: relecture.corps.mappings_inverse });
    verifier("le retour arrière exige lui aussi un motif",
      sansMotif.statut === 400 && sansMotif.corps.code === "REASON_REQUIRED");

    const retour = await appel("POST", "/stock/locations/reorganize/apply", TRIANGLE, {
      mappings: relecture.corps.mappings_inverse, reason: "Annulation de la réorganisation précédente",
    });
    verifier("le retour arrière s'applique après confirmation", retour.statut === 200);
    verifier("le rayon est revenu à son nom d'origine", Boolean(await bacParCode("WH1-B-1-1-BIN1")));
    verifier("le stock total n'a pas bougé de l'aller-retour",
      (await stockTotal(1)) === stockAvant, `${stockAvant} → ${await stockTotal(1)}`);

    const inexistant = await appel("GET", "/stock/locations/reorganize/PAS-UN-LOT", TRIANGLE);
    verifier("un lot inconnu répond 404", inexistant.statut === 404);
  }

  console.log("\n⑤ ANCIENNE API /locations — verrouillée");
  {
    const sansDroit = await appel("GET", "/locations", MAGASINIER);
    verifier("GET /locations exige une permission",
      sansDroit.statut === 403 || sansDroit.statut === 404, `statut ${sansDroit.statut}`);

    const triangle = await appel("GET", "/locations", TRIANGLE);
    verifier("Triangle lit ses emplacements", triangle.statut === 200 && Array.isArray(triangle.corps));
    verifier("il ne voit AUCUN emplacement d'une autre société",
      triangle.corps.every((l) => Number(l.company_id) === 1),
      `sociétés vues : ${[...new Set(triangle.corps.map((l) => l.company_id))].join(",")}`);
    const fat = await appel("GET", "/locations", FATMAT);
    verifier("FAT & MAT ne voit que les siens",
      fat.corps.every((l) => Number(l.company_id) === 2),
      `sociétés vues : ${[...new Set(fat.corps.map((l) => l.company_id))].join(",")}`);

    const creation = await appel("POST", "/locations", MAGASINIER,
      { warehouse_id: 1, zone: "Z", rayon: "1", etagere: "1", bin_code: "BIN9" });
    verifier("POST /locations exige une permission",
      creation.statut === 403 || creation.statut === 404, `statut ${creation.statut}`);

    /* Le company_id du CORPS ne doit plus rien décider.
       Il en décidait : getEffectiveCompanyId accepte req.body.company_id, si
       bien qu'un corps décrivant un emplacement redirigeait l'écriture vers
       la société qu'il nommait. */
    const injection = await appel("POST", "/locations", TRIANGLE, {
      warehouse_id: 2, company_id: 2,
      zone: "PIRATE", rayon: "1", etagere: "1", bin_code: "BIN1",
    });
    verifier("l'entrepôt d'une autre société reste introuvable malgré company_id dans le corps",
      injection.statut === 404, `statut ${injection.statut}`);
    const fuite = await pool.query(
      `SELECT COUNT(*)::int AS n FROM locations WHERE company_id=2 AND UPPER(COALESCE(zone,''))='PIRATE'`);
    verifier("rien n'a été écrit chez l'autre société", fuite.rows[0].n === 0);

    const injection2 = await appel("POST", "/locations", TRIANGLE, {
      warehouse_id: 1, company_id: 2,
      zone: "F", rayon: "1", etagere: "1", bin_code: "BIN1",
    });
    verifier("un company_id injecté dans le corps est ignoré", injection2.statut === 201,
      `statut ${injection2.statut} — ${JSON.stringify(injection2.corps).slice(0, 120)}`);
    verifier("l'emplacement est créé dans la société de SESSION",
      Number(injection2.corps.crees?.[0]?.company_id) === 1,
      `company_id ${injection2.corps.crees?.[0]?.company_id}`);

    /* La bascule d'entreprise reste possible pour un super admin, mais par
       l'en-tête prévu pour cela — un geste explicite, pas un champ de données. */
    const parEntete = await fetch(`${BASE}/locations`, {
      headers: { Authorization: `Bearer ${TRIANGLE}`, "x-active-company-id": "2" },
    });
    const vues = await parEntete.json().catch(() => []);
    verifier("un super admin bascule encore d'entreprise par l'en-tête dédié",
      parEntete.status === 200 && vues.every((l) => Number(l.company_id) === 2),
      `sociétés vues : ${[...new Set((vues || []).map((l) => l.company_id))].join(",")}`);

    /* Le défaut d'origine : « Full Bin » ne crée plus un seul bac. */
    const fullbin = await appel("POST", "/locations", TRIANGLE, {
      warehouse_id: 1, zone: "G", rayon: "1", etagere: "1", bin_code: "1,2,3",
    });
    verifier("un code « 1,2,3 » crée TROIS bacs, plus un seul",
      fullbin.statut === 201 && fullbin.corps.bins_crees === 3, `${fullbin.corps.bins_crees}`);
    verifier("ils portent chacun leur numéro",
      JSON.stringify(fullbin.corps.crees.map((c) => c.bin_code)) === JSON.stringify(["1", "2", "3"]),
      JSON.stringify(fullbin.corps.crees?.map((c) => c.bin_code)));
    verifier("aucun stock n'y est placé", fullbin.corps.stockImpact === 0);

    /* Suppression : archivage, jamais destruction. */
    const cible = fullbin.corps.crees[0];
    const suppression = await appel("DELETE", `/locations/${cible.id}`, TRIANGLE, { reason: "test" });
    verifier("DELETE /locations archive au lieu de supprimer",
      suppression.statut === 200 && suppression.corps.archived === true, `statut ${suppression.statut}`);
    const encoreLa = await pool.query(`SELECT id, archived_at FROM locations WHERE id=$1`, [cible.id]);
    verifier("la ligne EXISTE toujours en base", encoreLa.rows.length === 1);
    verifier("elle porte une date d'archivage", Boolean(encoreLa.rows[0].archived_at));

    const occupe = await bacParCode("WH1-E-1-1-BIN1");
    const refus = await appel("DELETE", `/locations/${occupe.id}`, TRIANGLE, {});
    verifier("un emplacement OCCUPÉ ne peut pas être archivé",
      refus.statut === 409 && refus.corps.code === "LOCATION_NOT_EMPTY", `statut ${refus.statut}`);
    verifier("il est toujours là avec son stock",
      Number((await pool.query(
        `SELECT COALESCE(SUM(quantity),0)::numeric AS q FROM stock_location_balances WHERE location_id=$1`,
        [occupe.id])).rows[0].q) === 600);

    const intrusion = await appel("DELETE", `/locations/20`, TRIANGLE, {});
    verifier("un emplacement d'une autre société est introuvable", intrusion.statut === 404,
      `statut ${intrusion.statut}`);
    const sansDroitSuppr = await appel("DELETE", `/locations/${cible.id}`, MAGASINIER, {});
    verifier("DELETE exige une permission",
      sansDroitSuppr.statut === 403 || sansDroitSuppr.statut === 404);
  }

  console.log("\n⑥ BILAN");
  {
    const fin = await stockTotal(1);
    verifier("le stock Triangle est identique au départ", fin === stockDepart,
      `${stockDepart} → ${fin}`);
    verifier("le stock FAT & MAT n'a jamais été touché", (await stockTotal(2)) === 50);
    const negatifs = await pool.query(`SELECT COUNT(*)::int AS n FROM stock_location_balances WHERE quantity<0`);
    verifier("aucune balance négative", negatifs.rows[0].n === 0);
    const orphelines = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stock_location_balances b
        WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.id=b.location_id)`);
    verifier("aucune balance orpheline", orphelines.rows[0].n === 0);
  }

  await pool.end();
  console.log(`\n${reussis} réussis, ${echoues} échoués\n`);
  process.exit(echoues ? 1 : 0);
}

main().catch(async (e) => {
  console.error("ÉCHEC :", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
