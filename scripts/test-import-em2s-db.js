"use strict";

/**
 * IMPORT EM2S — tests contre le VRAI serveur et la VRAIE base.
 *
 * Les routes vivent sur un routeur monté dans server.js : les monter sur un
 * Express de test éprouverait une copie. Ce script parle donc au serveur réel.
 *
 *   bash scripts/test-import-em2s-db.sh
 *
 * Il vérifie ce qu'aucune lecture de code ne prouve : qu'un second passage du
 * même fichier n'écrit rien, qu'une réception ne bouge pas le stock, qu'une
 * ligne bloquée ne produit aucun mouvement, et qu'une entreprise ne voit pas
 * les lots de l'autre.
 */

const fs = require("fs");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const fixture = require("./fixture-em2s");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const BASE = process.env.BASE_URL || "http://127.0.0.1:5050";
const SECRET = process.env.JWT_SECRET || "test-secret-durcissement";

let reussis = 0, echoues = 0;
const verifier = (nom, ok, detail = "") => {
  if (ok) { reussis += 1; console.log(`  ✓ ${nom}`); }
  else { echoues += 1; console.log(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`); }
};

const jeton = (u) => jwt.sign(
  { id: u.id, email: u.email, role: u.role, company_id: u.company_id,
    is_super_admin: u.is_super_admin }, SECRET, { expiresIn: "1h" });

/** Envoi multipart écrit à la main : pas de dépendance de plus pour un test. */
function corpsMultipart(champs, fichier) {
  const limite = "----em2s" + Date.now();
  const morceaux = [];
  for (const [nom, valeur] of Object.entries(champs)) {
    morceaux.push(Buffer.from(
      `--${limite}\r\nContent-Disposition: form-data; name="${nom}"\r\n\r\n${valeur}\r\n`));
  }
  morceaux.push(Buffer.from(
    `--${limite}\r\nContent-Disposition: form-data; name="file"; filename="${fichier.nom}"\r\n`
    + "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n"));
  morceaux.push(fichier.contenu, Buffer.from(`\r\n--${limite}--\r\n`));
  return { corps: Buffer.concat(morceaux), type: `multipart/form-data; boundary=${limite}` };
}

async function envoyer(chemin, token, champs, fichier, entetes = {}) {
  const { corps, type } = corpsMultipart(champs, fichier);
  const r = await fetch(`${BASE}${chemin}`, {
    method: "POST",
    headers: { "Content-Type": type, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...entetes },
    body: corps,
  });
  return { statut: r.status, corps: await r.json().catch(() => ({})) };
}

async function appel(methode, chemin, token, corps, entetes = {}) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json",
               ...(token ? { Authorization: `Bearer ${token}` } : {}), ...entetes },
    ...(corps ? { body: JSON.stringify(corps) } : {}),
  });
  return { statut: r.status, corps: await r.json().catch(() => ({})) };
}

let TRIANGLE, FATMAT, SUPER, LECTEUR, IMPORTATEUR, FATMAT_SUPER, FATMAT_SIMPLE;
const CLASSEUR = { nom: "fixture-em2s.xlsx", contenu: fixture.construire() };

async function semer() {
  await pool.query(`DELETE FROM stock_import_anomalies`);
  await pool.query(`DELETE FROM stock_import_operations`);
  await pool.query(`DELETE FROM stock_reception_lines`);
  await pool.query(`DELETE FROM stock_receptions`);
  await pool.query(`DELETE FROM stock_import_batches`);
  await pool.query(`DELETE FROM users WHERE fullname LIKE 'Import %'`);
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('users','id'),
                   GREATEST((SELECT COALESCE(MAX(id),1) FROM users), 1))`);

  const soc = await pool.query(`SELECT id, name FROM companies ORDER BY id`);
  TRIANGLE = soc.rows.find((c) => /triangle/i.test(c.name));
  FATMAT = soc.rows.find((c) => /fat/i.test(c.name));

  const creer = async (nom, email, role, companyId, superAdmin) => (await pool.query(
    `INSERT INTO users (fullname, email, password, role, company_id, is_super_admin,
                        email_verified, verification_mode)
     VALUES ($1,$2,'$test$',$3,$4,$5,true,'none') RETURNING *`,
    [nom, email, role, companyId, superAdmin])).rows[0];

  SUPER = await creer("Import Super", "isuper@essai.test", "super_admin", TRIANGLE.id, true);
  LECTEUR = await creer("Import Lecteur", "ilect@essai.test", "employe", TRIANGLE.id, false);
  IMPORTATEUR = await creer("Import Chargé", "icharge@essai.test", "employe", TRIANGLE.id, false);
  FATMAT_SUPER = await creer("Import FatMat", "ifm@essai.test", "super_admin", FATMAT.id, true);
  /* Un compte ORDINAIRE de FAT & MAT : c'est lui qui éprouve la falsification.
     Un super administrateur est un rôle de plateforme, autorisé à passer d'une
     entreprise à l'autre — le tester lui ne prouverait rien. */
  FATMAT_SIMPLE = await creer("Import FatMat Simple", "ifms@essai.test", "employe", FATMAT.id, false);
  for (const a of ["visible", "view"]) {
    await pool.query(
      `INSERT INTO user_permission_overrides (user_id, company_id, module_key, action, effect)
       VALUES ($1,$2,'stock.import',$3,'ALLOW') ON CONFLICT DO NOTHING`,
      [FATMAT_SIMPLE.id, FATMAT.id, a]);
  }

  /* Le lecteur voit le module sans pouvoir écrire ; le chargé d'import a tout
     ce qu'il faut pour prévisualiser et écrire. */
  const droit = (userId, action, effet = "ALLOW") => pool.query(
    `INSERT INTO user_permission_overrides (user_id, company_id, module_key, action, effect)
     VALUES ($1,$2,'stock.import',$3,$4) ON CONFLICT DO NOTHING`,
    [userId, TRIANGLE.id, action, effet]);

  for (const a of ["visible", "view"]) { await droit(LECTEUR.id, a); await droit(IMPORTATEUR.id, a); }
  for (const a of ["import_preview", "import_execute", "import_resolve", "import_cancel"]) {
    await droit(IMPORTATEUR.id, a);
  }
}

const stockTotal = async (companyId) => Number((await pool.query(
  `SELECT COALESCE(SUM(quantity),0)::numeric AS q FROM stock_location_balances WHERE company_id=$1`,
  [companyId])).rows[0].q);

const nbMouvements = async (companyId) => Number((await pool.query(
  `SELECT count(*)::int AS n FROM stock_movements WHERE company_id=$1`, [companyId])).rows[0].n);

async function main() {
  await semer();
  const jSuper = jeton(SUPER), jLecteur = jeton(LECTEUR);
  const jImport = jeton(IMPORTATEUR), jFatMat = jeton(FATMAT_SUPER);
  const chezTriangle = { "x-active-company-id": String(TRIANGLE.id) };
  const chezFatMat = { "x-active-company-id": String(FATMAT.id) };

  const stockAvant = await stockTotal(TRIANGLE.id);
  const mouvementsAvant = await nbMouvements(TRIANGLE.id);

  console.log("\n▸ PERMISSIONS");
  {
    const sansDroit = await envoyer("/stock/import-em2s/preview", jLecteur, {}, CLASSEUR, chezTriangle);
    verifier("prévisualiser sans le droit est refusé",
      sansDroit.statut === 403 || sansDroit.statut === 404,
      `statut ${sansDroit.statut} ${sansDroit.corps.code || ""}`);

    const ecrireSansDroit = await envoyer("/stock/import-em2s/execute", jLecteur, {}, CLASSEUR, chezTriangle);
    verifier("exécuter sans le droit est refusé",
      ecrireSansDroit.statut === 403 || ecrireSansDroit.statut === 404,
      `statut ${ecrireSansDroit.statut}`);

    const sansJeton = await envoyer("/stock/import-em2s/preview", null, {}, CLASSEUR, chezTriangle);
    verifier("sans authentification, rien n'est lisible",
      sansJeton.statut === 401 || sansJeton.statut === 403, `statut ${sansJeton.statut}`);
  }

  console.log("\n▸ PRÉVISUALISATION");
  let apercu;
  {
    const r = await envoyer("/stock/import-em2s/preview", jImport, {}, CLASSEUR, chezTriangle);
    verifier("le classeur est lu", r.statut === 200, `statut ${r.statut} ${JSON.stringify(r.corps).slice(0,140)}`);
    apercu = r.corps;
    verifier("l'empreinte du fichier est rendue", /^[0-9a-f]{64}$/.test(apercu.fichier?.sha256 || ""));
    verifier("les neuf feuilles sont annoncées", (apercu.feuilles || []).length === 9,
      `${(apercu.feuilles || []).length}`);
    verifier("trois réceptions physiques, deux fusionnées",
      apercu.receptions.total === 3 && apercu.receptions.fusionnees === 2,
      JSON.stringify({ t: apercu.receptions.total, f: apercu.receptions.fusionnees }));
    verifier("aucune n'est encore importée", apercu.receptions.dejaImportees === 0);
    verifier("les mouvements bloqués sont comptés à part",
      apercu.mouvements.bloques > 0 && apercu.mouvements.importables >= 0,
      JSON.stringify(apercu.mouvements));
    verifier("les anomalies sont détaillées par type",
      apercu.anomalies.parType.MULTI_BIN === 3
        && apercu.anomalies.parType.DATES_MULTIPLES === 1
        && apercu.anomalies.parType.NEW_STOCK_INCOHERENT === 1,
      JSON.stringify(apercu.anomalies.parType));

    verifier("la prévisualisation n'écrit rien",
      (await stockTotal(TRIANGLE.id)) === stockAvant
        && (await nbMouvements(TRIANGLE.id)) === mouvementsAvant);
    const lots = await pool.query(`SELECT count(*)::int AS n FROM stock_import_batches`);
    verifier("aucun lot n'est créé par une prévisualisation", lots.rows[0].n === 0, `${lots.rows[0].n}`);
  }

  console.log("\n▸ EXÉCUTION");
  let batchId;
  {
    const changee = await envoyer("/stock/import-em2s/execute", jImport,
      { sha256: "0".repeat(64) }, CLASSEUR, chezTriangle);
    verifier("un fichier différent de celui validé est refusé",
      changee.statut === 409 && changee.corps.code === "FILE_CHANGED",
      `statut ${changee.statut} ${changee.corps.code}`);

    const r = await envoyer("/stock/import-em2s/execute", jImport,
      { sha256: apercu.fichier.sha256 }, CLASSEUR, chezTriangle);
    verifier("l'import s'exécute", r.statut === 201,
      `statut ${r.statut} ${JSON.stringify(r.corps).slice(0, 160)}`);
    batchId = r.corps.batchId;

    verifier("les trois réceptions sont créées",
      r.corps.receptions?.creees === 3, JSON.stringify(r.corps.receptions?.creees));
    verifier("les anomalies sont ouvertes", r.corps.anomalies?.ouvertes === 5,
      `${r.corps.anomalies?.ouvertes}`);
    verifier("aucun mouvement n'est écrit par l'import",
      r.corps.mouvements?.ecrits === 0, JSON.stringify(r.corps.mouvements));

    const lignes = await pool.query(
      `SELECT warehouse_code, count(*)::int AS n FROM stock_reception_lines
        WHERE company_id = $1 GROUP BY 1 ORDER BY 1`, [TRIANGLE.id]);
    verifier("chaque ligne garde son entrepôt",
      lignes.rows.length === 2 && lignes.rows.every((l) => l.warehouse_code),
      JSON.stringify(lignes.rows));

    const fusionnee = await pool.query(
      `SELECT r.container_number, r.warehouses,
              count(*) FILTER (WHERE l.warehouse_code = 'A')::int AS a,
              count(*) FILTER (WHERE l.warehouse_code = 'C')::int AS c
         FROM stock_receptions r JOIN stock_reception_lines l ON l.reception_id = r.id
        WHERE r.company_id = $1 AND r.container_number = 'MSNU 5745901/6'
        GROUP BY 1,2`, [TRIANGLE.id]);
    verifier("le conteneur commun est une seule réception à deux entrepôts",
      fusionnee.rows.length === 1 && fusionnee.rows[0].a === 3 && fusionnee.rows[0].c === 1,
      JSON.stringify(fusionnee.rows));
  }

  console.log("\n▸ UNE RÉCEPTION NE BOUGE PAS LE STOCK");
  {
    verifier("le stock total est inchangé",
      (await stockTotal(TRIANGLE.id)) === stockAvant,
      `avant ${stockAvant}, après ${await stockTotal(TRIANGLE.id)}`);
    verifier("aucun mouvement n'est apparu",
      (await nbMouvements(TRIANGLE.id)) === mouvementsAvant);
    const rangees = await pool.query(
      `SELECT COALESCE(SUM(quantity_putaway),0)::numeric AS q FROM stock_reception_lines
        WHERE company_id = $1`, [TRIANGLE.id]);
    verifier("rien n'est marqué rangé", Number(rangees.rows[0].q) === 0, `${rangees.rows[0].q}`);
    const statuts = await pool.query(
      `SELECT DISTINCT status FROM stock_receptions WHERE company_id = $1`, [TRIANGLE.id]);
    verifier("les réceptions attendent leur mise en stock",
      statuts.rows.every((s) => s.status === "RECEIVED_PENDING_PUTAWAY"),
      JSON.stringify(statuts.rows));
  }

  console.log("\n▸ SECONDE EXÉCUTION — RIEN NE DOIT SE CRÉER");
  {
    const avant = await pool.query(
      `SELECT (SELECT count(*)::int FROM stock_receptions WHERE company_id=$1) AS r,
              (SELECT count(*)::int FROM stock_reception_lines WHERE company_id=$1) AS l,
              (SELECT count(*)::int FROM stock_import_operations WHERE company_id=$1) AS o,
              (SELECT count(*)::int FROM stock_import_anomalies WHERE company_id=$1) AS a`,
      [TRIANGLE.id]);

    const r = await envoyer("/stock/import-em2s/execute", jImport,
      { sha256: apercu.fichier.sha256 }, CLASSEUR, chezTriangle);
    verifier("le second passage aboutit sans erreur", r.statut === 201, `statut ${r.statut}`);
    verifier("il annonce que tout est déjà présent",
      r.corps.receptions?.creees === 0 && r.corps.receptions?.dejaPresentes === 3,
      JSON.stringify(r.corps.receptions));

    const apres = await pool.query(
      `SELECT (SELECT count(*)::int FROM stock_receptions WHERE company_id=$1) AS r,
              (SELECT count(*)::int FROM stock_reception_lines WHERE company_id=$1) AS l,
              (SELECT count(*)::int FROM stock_import_operations WHERE company_id=$1) AS o,
              (SELECT count(*)::int FROM stock_import_anomalies WHERE company_id=$1) AS a`,
      [TRIANGLE.id]);

    verifier("aucune réception en double", apres.rows[0].r === avant.rows[0].r,
      `${avant.rows[0].r} → ${apres.rows[0].r}`);
    verifier("aucune ligne en double", apres.rows[0].l === avant.rows[0].l,
      `${avant.rows[0].l} → ${apres.rows[0].l}`);
    verifier("aucune opération en double", apres.rows[0].o === avant.rows[0].o,
      `${avant.rows[0].o} → ${apres.rows[0].o}`);
    verifier("aucune anomalie rouverte", apres.rows[0].a === avant.rows[0].a,
      `${avant.rows[0].a} → ${apres.rows[0].a}`);
    verifier("le stock n'a toujours pas bougé",
      (await stockTotal(TRIANGLE.id)) === stockAvant);
  }

  console.log("\n▸ LEVER UNE ANOMALIE");
  {
    const { rows } = await pool.query(
      `SELECT * FROM stock_import_anomalies
        WHERE company_id = $1 AND anomaly_type = 'MULTI_BIN' AND excel_row = 167`,
      [TRIANGLE.id]);
    const multiBin = rows[0];
    verifier("l'anomalie multi-bacs porte sa quantité attendue",
      multiBin && Number(multiBin.payload.quantiteAttendue) === 54,
      JSON.stringify(multiBin && multiBin.payload));

    const trop = await appel("POST", `/stock/import-em2s/anomalies/${multiBin.id}/resolve`,
      jImport, { resolution: { parBin: { BIN1: 30, BIN2: 30 } } }, chezTriangle);
    verifier("une répartition qui ne tombe pas juste est refusée",
      trop.statut === 400 && trop.corps.code === "ALLOCATION_MISMATCH",
      `statut ${trop.statut} ${trop.corps.code}`);

    const inconnu = await appel("POST", `/stock/import-em2s/anomalies/${multiBin.id}/resolve`,
      jImport, { resolution: { parBin: { BIN3: 54 } } }, chezTriangle);
    verifier("un bac étranger à la ligne est refusé",
      inconnu.statut === 400 && inconnu.corps.code === "BIN_UNKNOWN",
      `statut ${inconnu.statut} ${inconnu.corps.code}`);

    const negatif = await appel("POST", `/stock/import-em2s/anomalies/${multiBin.id}/resolve`,
      jImport, { resolution: { parBin: { BIN1: -6, BIN2: 60 } } }, chezTriangle);
    verifier("une quantité négative est refusée",
      negatif.statut === 400 && negatif.corps.code === "NEGATIVE",
      `statut ${negatif.statut} ${negatif.corps.code}`);

    const juste = await appel("POST", `/stock/import-em2s/anomalies/${multiBin.id}/resolve`,
      jImport, { resolution: { parBin: { BIN1: 30, BIN2: 24 } } }, chezTriangle);
    verifier("une répartition exacte est acceptée", juste.statut === 200,
      `statut ${juste.statut} ${juste.corps.code || ""}`);

    const rejeu = await appel("POST", `/stock/import-em2s/anomalies/${multiBin.id}/resolve`,
      jImport, { resolution: { parBin: { BIN1: 54, BIN2: 0 } } }, chezTriangle);
    verifier("une anomalie déjà tranchée ne se retranche pas",
      rejeu.statut === 409 && rejeu.corps.code === "ALREADY_RESOLVED",
      `statut ${rejeu.statut} ${rejeu.corps.code}`);

    verifier("résoudre une anomalie ne touche pas le stock",
      (await stockTotal(TRIANGLE.id)) === stockAvant);

    const { rows: dates } = await pool.query(
      `SELECT * FROM stock_import_anomalies
        WHERE company_id = $1 AND anomaly_type = 'DATES_MULTIPLES'`, [TRIANGLE.id]);
    const faux = await appel("POST", `/stock/import-em2s/anomalies/${dates[0].id}/resolve`,
      jImport, { resolution: { quantiteTotale: 25,
                               parDate: { "2026-08-19": 10, "2026-08-21": 10 } } }, chezTriangle);
    verifier("une ventilation par date incomplète est refusée",
      faux.statut === 400 && faux.corps.code === "DATE_SPLIT_MISMATCH",
      `statut ${faux.statut} ${faux.corps.code}`);

    const bon = await appel("POST", `/stock/import-em2s/anomalies/${dates[0].id}/resolve`,
      jImport, { resolution: { quantiteTotale: 25,
                               parDate: { "2026-08-19": 10, "2026-08-21": 10, "2026-08-25": 5 } } },
      chezTriangle);
    verifier("une ventilation exacte est acceptée", bon.statut === 200,
      `statut ${bon.statut} ${bon.corps.code || ""}`);

    const { rows: incoherente } = await pool.query(
      `SELECT * FROM stock_import_anomalies
        WHERE company_id = $1 AND anomaly_type = 'NEW_STOCK_INCOHERENT'`, [TRIANGLE.id]);
    const sansMotif = await appel("POST", `/stock/import-em2s/anomalies/${incoherente[0].id}/resolve`,
      jImport, { resolution: { valeurRetenue: "ATTENDU" } }, chezTriangle);
    verifier("corriger une incohérence exige un motif",
      sansMotif.statut === 400 && sansMotif.corps.code === "REASON_REQUIRED",
      `statut ${sansMotif.statut} ${sansMotif.corps.code}`);
  }

  console.log("\n▸ ISOLATION ENTRE ENTREPRISES");
  {
    const lots = await appel("GET", "/stock/import-em2s/batches", jFatMat, null, chezFatMat);
    verifier("FAT & MAT ne voit aucun lot de Triangle",
      lots.statut === 200 && (lots.corps.lots || []).length === 0,
      `${(lots.corps.lots || []).length} lot(s)`);

    const vol = await appel("GET", `/stock/import-em2s/batches/${batchId}`, jFatMat, null, chezFatMat);
    verifier("le lot de Triangle est introuvable depuis FAT & MAT",
      vol.statut === 404, `statut ${vol.statut}`);

    const anomalies = await appel("GET", "/stock/import-em2s/anomalies", jFatMat, null, chezFatMat);
    verifier("les anomalies de Triangle ne fuient pas",
      anomalies.statut === 200 && (anomalies.corps.anomalies || []).length === 0,
      `${(anomalies.corps.anomalies || []).length}`);

    /* Un en-tête falsifié ne doit pas ouvrir la porte : le serveur décide de
       l'entreprise, l'en-tête n'est qu'une demande. */
    const falsifie = await appel("GET", "/stock/import-em2s/batches", jeton(FATMAT_SIMPLE), null,
      { "x-active-company-id": String(TRIANGLE.id) });
    const fuite = (falsifie.corps.lots || []).length;
    verifier("un en-tête d'entreprise falsifié ne donne pas les lots d'autrui",
      falsifie.statut === 403 || fuite === 0, `statut ${falsifie.statut}, ${fuite} lot(s)`);

    /* Le super administrateur, lui, a bien le droit de changer d'entreprise :
       c'est un rôle de plateforme, pas une faille. */
    const legitime = await appel("GET", "/stock/import-em2s/batches", jFatMat, null,
      { "x-active-company-id": String(TRIANGLE.id) });
    verifier("un super administrateur peut légitimement changer d'entreprise",
      legitime.statut === 200, `statut ${legitime.statut}`);
  }

  console.log("\n▸ LOTS ET ANNULATION");
  {
    const lots = await appel("GET", "/stock/import-em2s/batches", jImport, null, chezTriangle);
    verifier("les lots de Triangle sont visibles",
      lots.statut === 200 && lots.corps.lots.length === 2, `${lots.corps.lots?.length}`);
    verifier("chaque lot annonce ses anomalies ouvertes",
      lots.corps.lots.every((l) => typeof l.anomalies_ouvertes === "number"));

    const detail = await appel("GET", `/stock/import-em2s/batches/${batchId}`, jImport, null, chezTriangle);
    verifier("le détail d'un lot montre ses réceptions",
      detail.statut === 200 && detail.corps.receptions.length === 3,
      `${detail.corps.receptions?.length}`);

    const annule = await appel("POST", `/stock/import-em2s/batches/${batchId}/cancel`,
      jImport, {}, chezTriangle);
    verifier("un lot s'annule", annule.statut === 200 && annule.corps.lot.status === "CANCELLED",
      `statut ${annule.statut}`);
    const receptionsApres = await pool.query(
      `SELECT count(*)::int AS n FROM stock_receptions WHERE company_id = $1`, [TRIANGLE.id]);
    verifier("annuler n'efface aucune réception déjà écrite",
      receptionsApres.rows[0].n === 3, `${receptionsApres.rows[0].n}`);
    verifier("annuler ne touche pas le stock", (await stockTotal(TRIANGLE.id)) === stockAvant);
  }

  console.log("\n▸ HIÉRARCHIE DES EMPLACEMENTS");
  let analyse;
  {
    const vide = await envoyer("/stock/import-em2s/locations/preview", jImport, {}, CLASSEUR, chezTriangle);
    verifier("la prévisualisation des emplacements répond", vide.statut === 200,
      `statut ${vide.statut} ${JSON.stringify(vide.corps).slice(0, 120)}`);
    analyse = vide.corps.emplacements;

    verifier("elle sépare racks et zones au sol",
      analyse.racks > 0 && analyse.zones > 0,
      JSON.stringify({ racks: analyse.racks, zones: analyse.zones }));
    verifier("sur base vide, tout est à créer",
      analyse.existants === 0 && analyse.aCreer === analyse.total,
      JSON.stringify({ e: analyse.existants, c: analyse.aCreer, t: analyse.total }));
    verifier("elle compte les produits concernés par emplacement",
      analyse.liste.every((l) => typeof l.nbProduits === "number"));

    const zones = analyse.liste.filter((l) => l.type === "ZONE");
    verifier("les zones au sol n'ont ni niveau ni bac",
      zones.length > 0 && zones.every((z) => z.niveau === null && z.bin === null),
      `${zones.length} zone(s)`);
    verifier("aucun niveau ne porte le nom d'une zone",
      !analyse.liste.some((l) => ["I", "R&I", "ALLE 3M", "PICKING AREA"].includes(l.niveau)));

    /* Le rayon I avec un vrai niveau reste un rack : c'est une allée, pas un
       stockage au sol. */
    const rackI = analyse.liste.filter((l) => l.type === "RACK" && l.rayon === "I");
    const zoneI = analyse.liste.filter((l) => l.type === "ZONE" && l.rayon === "I");
    verifier("le rayon I racké et la zone I sont distingués",
      rackI.length > 0 && rackI.every((l) => l.niveau && l.bin),
      `${rackI.length} rack(s) I, ${zoneI.length} zone(s) I`);

    const stockAvantEmpl = await stockTotal(TRIANGLE.id);
    const mvtAvantEmpl = await nbMouvements(TRIANGLE.id);

    const creation = await envoyer("/stock/import-em2s/locations", jImport,
      { sha256: apercu.fichier.sha256 }, CLASSEUR, chezTriangle);
    verifier("la création s'exécute", creation.statut === 201,
      `statut ${creation.statut} ${JSON.stringify(creation.corps).slice(0, 140)}`);
    verifier("elle crée exactement ce qui manquait",
      creation.corps.rapport.crees === analyse.aCreer,
      `${creation.corps.rapport.crees} / ${analyse.aCreer}`);

    verifier("créer des emplacements ne touche pas le stock",
      (await stockTotal(TRIANGLE.id)) === stockAvantEmpl);
    verifier("créer des emplacements ne crée aucun mouvement",
      (await nbMouvements(TRIANGLE.id)) === mvtAvantEmpl);

    const second = await envoyer("/stock/import-em2s/locations", jImport,
      { sha256: apercu.fichier.sha256 }, CLASSEUR, chezTriangle);
    verifier("le second passage ne crée rien",
      second.corps.rapport.crees === 0 && second.corps.rapport.dejaPresents === analyse.total,
      JSON.stringify(second.corps.rapport).slice(0, 120));

    const doublons = await pool.query(
      `SELECT count(*)::int AS n FROM (
         SELECT company_id, full_code FROM locations
          WHERE company_id = $1 AND COALESCE(full_code,'') <> ''
          GROUP BY 1,2 HAVING count(*) > 1) d`, [TRIANGLE.id]);
    verifier("aucun full_code en double", doublons.rows[0].n === 0, `${doublons.rows[0].n}`);

    /* Base partiellement peuplée : on retire un emplacement et on vérifie que
       seul celui-là est recréé. */
    const victime = (await pool.query(
      `SELECT id, full_code FROM locations WHERE company_id = $1 AND bin_code IS NOT NULL
        ORDER BY id LIMIT 1`, [TRIANGLE.id])).rows[0];
    await pool.query(`DELETE FROM locations WHERE id = $1`, [victime.id]);
    const partiel = await envoyer("/stock/import-em2s/locations", jImport,
      { sha256: apercu.fichier.sha256 }, CLASSEUR, chezTriangle);
    verifier("sur une base partielle, seul le manquant est créé",
      partiel.corps.rapport.crees === 1,
      `${partiel.corps.rapport.crees} créé(s)`);

    const fatmat = await pool.query(
      `SELECT count(*)::int AS n FROM locations WHERE company_id = $1`, [FATMAT.id]);
    verifier("aucun emplacement n'est créé chez FAT & MAT", fatmat.rows[0].n === 0,
      `${fatmat.rows[0].n}`);
  }

  console.log("\n▸ RÉPARTITION DU MOUVEMENT, DISTINCTE DE CELLE DU STOCK");
  {
    /* La quantité du stock et celle du mouvement diffèrent volontairement :
       c'est exactement la confusion qui faisait entrer 41 unités là où 3
       avaient bougé. */
    /* La ligne 297 porte 880 unités en stock et une sortie de 80 : deux
       nombres qu'il ne faut surtout pas confondre. */
    const a = (await pool.query(
      `SELECT * FROM stock_import_anomalies
        WHERE company_id = $1 AND anomaly_type = 'MULTI_BIN' AND excel_row = 297`,
      [TRIANGLE.id])).rows[0];

    verifier("la quantité attendue du stock n'est pas celle du mouvement",
      Number(a.payload.quantiteAttendue) === 880 && Number(a.payload.sorties) === 80,
      JSON.stringify({ stock: a.payload.quantiteAttendue, sortie: a.payload.sorties }));
    verifier("cette anomalie est encore ouverte", a.status === "OPEN", a.status);

    const mauvaise = await appel("POST", `/stock/import-em2s/anomalies/${a.id}/resolve`,
      jImport, { resolution: { parBin: { BIN1: 400, BIN2: 300, BIN3: 180 },
                               parBinMouvement: { BIN1: 400, BIN2: 300, BIN3: 180 },
                               quantiteMouvement: 80 } }, chezTriangle);
    verifier("une répartition de mouvement égale à celle du stock est refusée",
      mauvaise.statut === 400 && mauvaise.corps.code === "MOVE_ALLOCATION_MISMATCH",
      `statut ${mauvaise.statut} ${mauvaise.corps.code}`);

    const horsLigne = await appel("POST", `/stock/import-em2s/anomalies/${a.id}/resolve`,
      jImport, { resolution: { parBin: { BIN1: 400, BIN2: 300, BIN3: 180 },
                               parBinMouvement: { BIN9: 80 }, quantiteMouvement: 80 } },
      chezTriangle);
    verifier("un bac étranger dans la répartition du mouvement est refusé",
      horsLigne.statut === 400 && horsLigne.corps.code === "BIN_UNKNOWN",
      `statut ${horsLigne.statut} ${horsLigne.corps.code}`);

    const bonne = await appel("POST", `/stock/import-em2s/anomalies/${a.id}/resolve`,
      jImport, { resolution: { parBin: { BIN1: 400, BIN2: 300, BIN3: 180 },
                               parBinMouvement: { BIN1: 50, BIN3: 30 },
                               quantiteMouvement: 80 } }, chezTriangle);
    verifier("les deux répartitions cohabitent quand chacune tombe juste",
      bonne.statut === 200, `statut ${bonne.statut} ${bonne.corps.code || ""}`);

    const enregistree = (await pool.query(
      `SELECT resolution FROM stock_import_anomalies WHERE id = $1`, [a.id])).rows[0].resolution;
    verifier("les deux répartitions sont conservées séparément",
      enregistree.parBin && enregistree.parBinMouvement
        && Object.values(enregistree.parBin).reduce((s, q) => s + Number(q), 0) === 880
        && Object.values(enregistree.parBinMouvement).reduce((s, q) => s + Number(q), 0) === 80,
      JSON.stringify(enregistree));
  }

  console.log("\n▸ SAISIE EN MASSE DES RÉPARTITIONS");
  {
    const restantes = (await pool.query(
      `SELECT * FROM stock_import_anomalies
        WHERE company_id = $1 AND anomaly_type = 'MULTI_BIN' AND status = 'OPEN'
        ORDER BY excel_row`, [TRIANGLE.id])).rows;

    const juste = restantes.map((a) => {
      const bins = a.payload.bins || [];
      const total = Number(a.payload.quantiteAttendue || 0);
      const part = Math.floor(total / bins.length);
      const valeurs = Object.fromEntries(bins.map((b, i) =>
        [b, i === bins.length - 1 ? total - part * (bins.length - 1) : part]));
      return { id: a.id, resolution: { parBin: valeurs } };
    });

    if (juste.length > 0) {
      /* Une seule ligne fausse doit faire échouer TOUT le lot : une saisie à
         moitié enregistrée laisserait l'opérateur sans savoir où il en est. */
      const avecUneFausse = juste.map((x, i) => i === 0
        ? { ...x, resolution: { parBin: Object.fromEntries(
            Object.entries(x.resolution.parBin).map(([b], j) => [b, j === 0 ? 999999 : 0])) } }
        : x);
      const refus = await appel("POST", "/stock/import-em2s/anomalies/bulk-resolve",
        jImport, { resolutions: avecUneFausse }, chezTriangle);
      verifier("une seule ligne fausse fait échouer tout le lot",
        refus.statut === 400 && refus.corps.code === "ALLOCATION_MISMATCH",
        `statut ${refus.statut} ${refus.corps.code}`);

      const ouvertesApres = Number((await pool.query(
        `SELECT count(*)::int AS n FROM stock_import_anomalies
          WHERE company_id = $1 AND anomaly_type = 'MULTI_BIN' AND status = 'OPEN'`,
        [TRIANGLE.id])).rows[0].n);
      verifier("aucune ligne du lot refusé n'a été enregistrée",
        ouvertesApres === restantes.length, `${ouvertesApres} / ${restantes.length}`);

      const ok = await appel("POST", "/stock/import-em2s/anomalies/bulk-resolve",
        jImport, { resolutions: juste }, chezTriangle);
      verifier("un lot entièrement juste passe d'un coup",
        ok.statut === 200 && ok.corps.tranchees === juste.length,
        `statut ${ok.statut} ${ok.corps.tranchees}/${juste.length}`);
    }

    verifier("la saisie en masse ne touche pas le stock",
      (await stockTotal(TRIANGLE.id)) === stockAvant);
  }

  console.log("\n▸ ÉCRITURE DES MOUVEMENTS");
  {
    const incoherente = (await pool.query(
      `SELECT * FROM stock_import_anomalies
        WHERE company_id = $1 AND anomaly_type = 'NEW_STOCK_INCOHERENT' AND status = 'OPEN'`,
      [TRIANGLE.id])).rows[0];
    if (incoherente) {
      await appel("POST", `/stock/import-em2s/anomalies/${incoherente.id}/resolve`, jImport,
        { resolution: { valeurRetenue: "ATTENDU", motif: "Recomptage physique du 2 septembre." } },
        chezTriangle);
    }

    /* Sans produit, aucun mouvement ne peut s'écrire : on crée d'abord ceux
       que le classeur nomme et que la base ne connaît pas. */
    const produits = await envoyer("/stock/import-em2s/products", jImport,
      { sha256: apercu.fichier.sha256 }, CLASSEUR, chezTriangle);
    verifier("les produits manquants sont créés", produits.statut === 201 && produits.corps.crees > 0,
      `statut ${produits.statut} ${produits.corps.crees} créé(s)`);
    verifier("créer des produits ne touche pas le stock",
      (await stockTotal(TRIANGLE.id)) === stockAvant);
    const rejeuProduits = await envoyer("/stock/import-em2s/products", jImport,
      { sha256: apercu.fichier.sha256 }, CLASSEUR, chezTriangle);
    verifier("les recréer n'en ajoute aucun", rejeuProduits.corps.crees === 0,
      `${rejeuProduits.corps.crees}`);

    const simulation = await envoyer("/stock/import-em2s/movements", jImport,
      { sha256: apercu.fichier.sha256, simulation: "1" }, CLASSEUR, chezTriangle);
    verifier("la simulation rend un rapport", simulation.statut === 200 && simulation.corps.simulation === true,
      `statut ${simulation.statut}`);
    verifier("la simulation n'écrit rien",
      (await stockTotal(TRIANGLE.id)) === stockAvant,
      `${stockAvant} → ${await stockTotal(TRIANGLE.id)}`);

    const reel = await envoyer("/stock/import-em2s/movements", jImport,
      { sha256: apercu.fichier.sha256 }, CLASSEUR, chezTriangle);
    verifier("l'écriture des mouvements aboutit", reel.statut === 201,
      `statut ${reel.statut} ${JSON.stringify(reel.corps).slice(0, 160)}`);

    const rapport = reel.corps.rapport || {};
    verifier("le rapport distingue écrits, bloqués et ignorés",
      typeof rapport.ecrits === "number" && typeof rapport.bloques === "number",
      JSON.stringify({ e: rapport.ecrits, b: rapport.bloques, i: rapport.ignores }));
    verifier("les lignes encore bloquées n'ont rien écrit",
      (rapport.details || []).filter((d) => d.etat === "bloqué")
        .every((d) => d.quantite === undefined));

    const rejeu = await envoyer("/stock/import-em2s/movements", jImport,
      { sha256: apercu.fichier.sha256 }, CLASSEUR, chezTriangle);
    verifier("rejouer l'écriture n'ajoute aucun mouvement",
      rejeu.statut === 201 && (rejeu.corps.rapport?.ecrits || 0) === 0,
      `${rejeu.corps.rapport?.ecrits} écrit(s)`);
    verifier("le stock est le même après le rejeu",
      Number(rejeu.corps.stockAvant) === Number(rejeu.corps.stockApres),
      `${rejeu.corps.stockAvant} → ${rejeu.corps.stockApres}`);

    verifier("la réconciliation constate sans corriger",
      reel.corps.reconciliation && typeof reel.corps.reconciliation.ecarts === "number",
      JSON.stringify(reel.corps.reconciliation?.ecarts));

    const negatifs = Number((await pool.query(
      `SELECT count(*)::int AS n FROM stock_location_balances WHERE quantity < 0`)).rows[0].n);
    verifier("aucune balance négative", negatifs === 0, `${negatifs}`);

    /* Des entrées ont réellement eu lieu : c'est ce qui prouve que la chaîne
       emplacements → produits → mouvements aboutit. */
    verifier("des mouvements ont bien été écrits", (rapport.ecrits || 0) > 0,
      `${rapport.ecrits} écrit(s)`);
    verifier("les entrées sont réparties dans les bacs demandés",
      (rapport.details || []).some((d) => d.etat === "écrit" && d.bac),
      JSON.stringify((rapport.details || []).filter((d) => d.etat === "écrit").slice(0, 2)));

    /* Une sortie qui dépasse le disponible est refusée ligne par ligne, sans
       faire tomber les autres. */
    const refuses = (rapport.details || []).filter((d) => d.etat === "refusé");
    verifier("une sortie sans stock est refusée sans annuler le lot",
      rapport.refuses === undefined || rapport.refuses === refuses.length,
      `${rapport.refuses} refus`);
    if (refuses.length) {
      verifier("le refus dit pourquoi",
        refuses.every((d) => d.motif && d.code), JSON.stringify(refuses[0]).slice(0, 140));
    }

    const mouvementsEnBase = await pool.query(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE operation_effective_at IS NOT NULL)::int AS datees
         FROM stock_movements WHERE company_id = $1`, [TRIANGLE.id]);
    verifier("les mouvements écrits portent leur date métier",
      mouvementsEnBase.rows[0].n === 0 || mouvementsEnBase.rows[0].datees > 0,
      JSON.stringify(mouvementsEnBase.rows[0]));
  }

  console.log("\n▸ CORRIGER UNE DATE APRÈS IMPRESSION");
  {
    const { rows } = await pool.query(
      `SELECT * FROM stock_receptions WHERE company_id = $1 ORDER BY id LIMIT 1`, [TRIANGLE.id]);
    const rec = rows[0];
    const creationAvant = rec.created_at;

    const avant = await appel("PATCH", `/stock/receptions/${rec.id}/dates`, jSuper,
      { document_datetime: "2026-06-20T09:00:00Z" }, chezTriangle);
    verifier("avant impression, la date se corrige sans motif", avant.statut === 200,
      `statut ${avant.statut} ${avant.corps.code || ""}`);

    await appel("GET", `/stock/receptions/${rec.id}/print`, jSuper, null, chezTriangle);

    const sansMotif = await appel("PATCH", `/stock/receptions/${rec.id}/dates`, jSuper,
      { document_datetime: "2026-06-21T09:00:00Z" }, chezTriangle);
    verifier("après impression, le motif devient obligatoire",
      sansMotif.statut === 400 && sansMotif.corps.code === "REASON_REQUIRED",
      `statut ${sansMotif.statut} ${sansMotif.corps.code}`);

    const avecMotif = await appel("PATCH", `/stock/receptions/${rec.id}/dates`, jSuper,
      { document_datetime: "2026-06-21T09:00:00Z", reason: "Bon de transport reçu après coup." },
      chezTriangle);
    verifier("avec motif, la correction passe et crée une révision",
      avecMotif.statut === 200 && avecMotif.corps.revision >= 2,
      `statut ${avecMotif.statut} révision ${avecMotif.corps.revision}`);

    const revisions = await appel("GET", `/stock/receptions/${rec.id}/date-revisions`,
      jSuper, null, chezTriangle);
    verifier("l'historique garde l'ancienne valeur",
      revisions.statut === 200 && revisions.corps.revisions.length >= 2
        && revisions.corps.revisions.some((r) => r.after_print === true && r.reason),
      `${revisions.corps.revisions?.length} révision(s)`);

    const apres = await pool.query(
      `SELECT created_at, document_datetime, print_count FROM stock_receptions WHERE id = $1`, [rec.id]);
    verifier("created_at n'a pas bougé",
      new Date(apres.rows[0].created_at).getTime() === new Date(creationAvant).getTime());
    verifier("print_count a bien été incrémenté par l'impression",
      Number(apres.rows[0].print_count) >= 1, `${apres.rows[0].print_count}`);
  }

  console.log("\n▸ BILAN");
  {
    /* Le stock a pu bouger — c'est le but de l'écriture des mouvements. Ce
       qui doit rester vrai, c'est qu'il n'a bougé QUE par des mouvements
       tracés : autant de quantité écrite que de quantité constatée. */
    const parMouvements = Number((await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN movement_kind = 'Entrée' THEN quantity
                                ELSE -quantity END), 0)::numeric AS q
         FROM stock_import_operations
        WHERE company_id = $1 AND kind = 'MOVEMENT' AND movement_id IS NOT NULL`,
      [TRIANGLE.id])).rows[0].q);
    verifier("le stock n'a bougé que par des mouvements tracés",
      (await stockTotal(TRIANGLE.id)) === stockAvant + parMouvements,
      `${stockAvant} + ${parMouvements} ≠ ${await stockTotal(TRIANGLE.id)}`);
    verifier("aucun stock négatif n'est apparu",
      Number((await pool.query(
        `SELECT count(*)::int AS n FROM stock_location_balances WHERE quantity < 0`)).rows[0].n) === 0);
    const doublons = await pool.query(
      `SELECT count(*)::int AS n FROM (
         SELECT company_id, idempotency_key FROM stock_import_operations
          GROUP BY 1,2 HAVING count(*) > 1) d`);
    verifier("aucune clé d'idempotence en double", doublons.rows[0].n === 0, `${doublons.rows[0].n}`);
  }

  console.log(`\n${reussis} réussis, ${echoues} échoués`);
  await pool.end();
  process.exit(echoues === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(`\nÉCHEC : ${e.stack || e.message}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
