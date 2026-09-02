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

  console.log("\n▸ BILAN");
  {
    verifier("le stock total est strictement identique au départ",
      (await stockTotal(TRIANGLE.id)) === stockAvant,
      `${stockAvant} → ${await stockTotal(TRIANGLE.id)}`);
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
