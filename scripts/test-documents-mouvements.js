"use strict";

/**
 * DOCUMENTS ET MOUVEMENTS — contre le VRAI serveur.
 *
 * La question à laquelle cette suite répond : un bon de sortie peut-il, d'une
 * façon ou d'une autre, afficher 30 quand l'ancienne sortie valait 20 et la
 * nouvelle 10 ?
 *
 * Elle vérifie donc que l'ancien mouvement n'apparaît pas par défaut, qu'il
 * n'est jamais additionné au nouveau, que le bon porte exactement la quantité
 * de SON mouvement, et qu'une sortie donne un Bon de sortie et non un Bon de
 * livraison.
 *
 *   bash scripts/test-documents-mouvements.sh
 */

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

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

async function appel(methode, chemin, token, corps, entetes = {}) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json",
               ...(token ? { Authorization: `Bearer ${token}` } : {}), ...entetes },
    ...(corps ? { body: JSON.stringify(corps) } : {}),
  });
  return { statut: r.status, corps: await r.json().catch(() => ({})) };
}

let TRIANGLE, FATMAT, SUPER, OPERATEUR, LECTEUR, FATMAT_USER;
let ANCIEN_IMPORT, NOUVEL_IMPORT;
let MVT_ANCIENNE_SORTIE, MVT_NOUVELLE_SORTIE, MVT_ENTREE, MVT_TRANSFERT, MVT_BROUILLON;

/* ═══════════════════════════════════════════════════ JEU D'ESSAI ══ */

async function semer() {
  await pool.query(`DELETE FROM document_content_revisions`);
  await pool.query(`DELETE FROM document_items WHERE document_id IN
                      (SELECT id FROM documents WHERE observation LIKE '%mouvement stock ID%')`);
  await pool.query(`DELETE FROM documents WHERE observation LIKE '%mouvement stock ID%'
                       OR observation LIKE 'Remplace %'`);
  await pool.query(`DELETE FROM stock_movements WHERE product_name LIKE 'ESSAI DOC%'`);
  await pool.query(`DELETE FROM inventory_imports WHERE file_name LIKE 'essai-%'`);
  await pool.query(`DELETE FROM users WHERE fullname LIKE 'Doc %'`);
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('users','id'),
                   GREATEST((SELECT COALESCE(MAX(id),1) FROM users), 1))`);

  const soc = await pool.query(`SELECT id, name FROM companies ORDER BY id`);
  TRIANGLE = soc.rows.find((c) => /triangle/i.test(c.name));
  FATMAT = soc.rows.find((c) => /fat/i.test(c.name));

  const creer = async (nom, email, role, companyId, superAdmin) => (await pool.query(
    `INSERT INTO users (fullname, email, password, role, company_id, is_super_admin,
                        email_verified, verification_mode)
     VALUES ($1,$2,'$non-utilisable$',$3,$4,$5,true,'none') RETURNING *`,
    [nom, email, role, companyId, superAdmin])).rows[0];

  SUPER = await creer("Doc Super", "docsuper@essai.test", "super_admin", TRIANGLE.id, true);
  OPERATEUR = await creer("Doc Opérateur", "docop@essai.test", "employe", TRIANGLE.id, false);
  LECTEUR = await creer("Doc Lecteur", "doclect@essai.test", "employe", TRIANGLE.id, false);
  FATMAT_USER = await creer("Doc FatMat", "docfm@essai.test", "admin", FATMAT.id, false);

  const droit = (userId, companyId, action) => pool.query(
    `INSERT INTO user_permission_overrides (user_id, company_id, module_key, action, effect)
     VALUES ($1,$2,'document',$3,'ALLOW') ON CONFLICT DO NOTHING`,
    [userId, companyId, action]);

  for (const a of ["visible", "view"]) {
    await droit(LECTEUR.id, TRIANGLE.id, a);
    await droit(OPERATEUR.id, TRIANGLE.id, a);
    await droit(FATMAT_USER.id, FATMAT.id, a);
  }
  for (const a of ["create", "update"]) {
    await droit(OPERATEUR.id, TRIANGLE.id, a);
    await droit(FATMAT_USER.id, FATMAT.id, a);
  }

  /* Deux imports : l'ancien porte la sortie de 20 (rouge clair dans le
     classeur), le nouveau celle de 10 (rouge foncé). C'est exactement la
     situation qui faisait lire « 30 ». */
  /* `file_hash` est NOT NULL : c'est l'empreinte qui identifie un classeur,
     et deux imports du même fichier doivent se reconnaître. On en fabrique une
     distincte par nom d'essai. */
  const imp = async (nom) => (await pool.query(
    `INSERT INTO inventory_imports (company_id, file_name, file_hash, status, created_at)
     VALUES ($1,$2,$3,'done', now()) RETURNING *`,
    [TRIANGLE.id, nom, require("crypto").createHash("sha256").update(nom).digest("hex")]
  )).rows[0];
  ANCIEN_IMPORT = await imp("essai-ancien.xlsx");
  NOUVEL_IMPORT = await imp("essai-nouveau.xlsx");

  const mvt = async (type, quantite, importId, statut = "Validé", nom = "ESSAI DOC CIMENT") =>
    (await pool.query(
      `INSERT INTO stock_movements
         (company_id, type, product_name, product_reference, quantity, status,
          import_id, created_by_name, created_at)
       VALUES ($1,$2,$3,'ESSAI-REF',$4,$5,$6,'Essai', now()) RETURNING *`,
      [TRIANGLE.id, type, nom, quantite, statut, importId])).rows[0];

  MVT_ANCIENNE_SORTIE = await mvt("Sortie", 20, ANCIEN_IMPORT.id);
  MVT_NOUVELLE_SORTIE = await mvt("Sortie", 10, NOUVEL_IMPORT.id);
  MVT_ENTREE = await mvt("Entrée", 7, NOUVEL_IMPORT.id, "Validé", "ESSAI DOC FER");
  MVT_TRANSFERT = await mvt("Transfert", 3, NOUVEL_IMPORT.id, "Validé", "ESSAI DOC SABLE");
  MVT_BROUILLON = await mvt("Sortie", 99, NOUVEL_IMPORT.id, "Brouillon", "ESSAI DOC BROUILLON");
}

const stockProduit = async () => (await pool.query(
  `SELECT COALESCE(SUM(stock),0)::numeric AS q FROM products WHERE company_id = $1`,
  [TRIANGLE.id])).rows[0].q;

const balancesTotal = async () => (await pool.query(
  `SELECT COALESCE(SUM(quantity),0)::numeric AS q FROM stock_location_balances
    WHERE company_id = $1`, [TRIANGLE.id])).rows[0].q;

async function main() {
  await semer();
  const jSuper = jeton(SUPER), jOp = jeton(OPERATEUR);
  const jLecteur = jeton(LECTEUR), jFatMat = jeton(FATMAT_USER);
  const chezTriangle = { "x-active-company-id": String(TRIANGLE.id) };
  const chezFatMat = { "x-active-company-id": String(FATMAT.id) };

  const stockAvant = await stockProduit();
  const balancesAvant = await balancesTotal();

  console.log("\n▸ SÉPARATION ANCIEN / NOUVEAU");
  {
    const r = await appel("GET", "/documents/pending-movements", jOp, null, chezTriangle);
    verifier("la liste répond", r.statut === 200, `statut ${r.statut} ${r.corps.error || ""}`);

    const ids = (r.corps.mouvements || []).map((m) => m.id);
    verifier("le dernier import est celui annoncé",
      r.corps.dernierImport?.id === NOUVEL_IMPORT.id,
      `${r.corps.dernierImport?.id} vs ${NOUVEL_IMPORT.id}`);
    verifier("la nouvelle sortie est proposée", ids.includes(MVT_NOUVELLE_SORTIE.id));
    verifier("l'ancienne sortie est ABSENTE par défaut",
      !ids.includes(MVT_ANCIENNE_SORTIE.id),
      ids.includes(MVT_ANCIENNE_SORTIE.id) ? "elle apparaît encore" : "");
    verifier("un mouvement non validé n'est pas proposé",
      !ids.includes(MVT_BROUILLON.id));

    const quantites = (r.corps.mouvements || [])
      .filter((m) => m.id === MVT_NOUVELLE_SORTIE.id).map((m) => Number(m.quantity));
    verifier("la nouvelle sortie porte 10, pas 30",
      quantites.length === 1 && quantites[0] === 10, JSON.stringify(quantites));

    const avecHistorique = await appel("GET",
      "/documents/pending-movements?historique=1", jOp, null, chezTriangle);
    const idsH = (avecHistorique.corps.mouvements || []).map((m) => m.id);
    verifier("l'option historique fait apparaître l'ancienne sortie",
      idsH.includes(MVT_ANCIENNE_SORTIE.id) && idsH.includes(MVT_NOUVELLE_SORTIE.id));
    verifier("chaque mouvement dit de quel import il vient",
      (avecHistorique.corps.mouvements || []).every((m) => "import_id" in m));

    /* Les deux restent deux lignes distinctes : rien ne les additionne. */
    const sorties = (avecHistorique.corps.mouvements || [])
      .filter((m) => m.type === "Sortie" && m.product_name === "ESSAI DOC CIMENT")
      .map((m) => Number(m.quantity)).sort((a, b) => a - b);
    verifier("ancienne et nouvelle restent séparées, jamais cumulées",
      JSON.stringify(sorties) === JSON.stringify([10, 20]), JSON.stringify(sorties));
  }

  console.log("\n▸ UNE SORTIE DONNE UN BON DE SORTIE");
  let docSortie;
  {
    const r = await appel("POST", "/documents/from-movements", jOp,
      { movement_ids: [MVT_NOUVELLE_SORTIE.id] }, chezTriangle);
    verifier("la génération aboutit", r.statut === 201,
      `statut ${r.statut} ${JSON.stringify(r.corps).slice(0, 140)}`);
    docSortie = (r.corps.documents || [])[0];
    verifier("le type est « Bon de sortie »", docSortie?.type === "Bon de sortie",
      docSortie?.type);
    verifier("le numéro commence par BS", String(docSortie?.numero || "").startsWith("BS-"),
      docSortie?.numero);
    verifier("jamais « Bon de livraison »", docSortie?.type !== "Bon de livraison");

    const { rows: lignes } = await pool.query(
      `SELECT quantity FROM document_items WHERE document_id = $1`, [docSortie.documentId]);
    verifier("le bon porte exactement 10, jamais 30",
      lignes.length === 1 && Number(lignes[0].quantity) === 10,
      JSON.stringify(lignes.map((l) => Number(l.quantity))));
  }

  console.log("\n▸ GÉNÉRATION GROUPÉE");
  {
    const r = await appel("POST", "/documents/from-movements", jOp,
      { movement_ids: [MVT_ENTREE.id, MVT_TRANSFERT.id] }, chezTriangle);
    verifier("un lot mixte aboutit", r.statut === 201 && r.corps.crees === 2,
      `${r.corps.crees} créé(s)`);
    const types = (r.corps.documents || []).map((d) => d.type).sort();
    verifier("entrée → Bon de réception, transfert → Bon de transfert",
      JSON.stringify(types) === JSON.stringify(["Bon de réception", "Bon de transfert"]),
      JSON.stringify(types));
    const prefixes = (r.corps.documents || []).map((d) => d.numero.split("-")[0]).sort();
    verifier("préfixes BR et BT", JSON.stringify(prefixes) === JSON.stringify(["BR", "BT"]),
      JSON.stringify(prefixes));

    const rejeu = await appel("POST", "/documents/from-movements", jOp,
      { movement_ids: [MVT_ENTREE.id, MVT_TRANSFERT.id] }, chezTriangle);
    verifier("rejouer le même lot ne crée aucun doublon",
      rejeu.corps.crees === 0 && rejeu.corps.refuses === 2,
      `${rejeu.corps.crees} créé(s), ${rejeu.corps.refuses} refusé(s)`);
    verifier("le refus dit qu'un document existe déjà",
      (rejeu.corps.mouvementsRefuses || []).every((m) => /existe déjà/.test(m.motif)));

    const brouillon = await appel("POST", "/documents/from-movements", jOp,
      { movement_ids: [MVT_BROUILLON.id] }, chezTriangle);
    verifier("un mouvement non validé est refusé, pas documenté",
      brouillon.corps.crees === 0 && brouillon.corps.refuses === 1,
      JSON.stringify(brouillon.corps.mouvementsRefuses));

    const vide = await appel("POST", "/documents/from-movements", jOp,
      { movement_ids: [] }, chezTriangle);
    verifier("un lot vide est refusé", vide.statut === 400 && vide.corps.code === "EMPTY");

    const trop = await appel("POST", "/documents/from-movements", jOp,
      { movement_ids: Array.from({ length: 501 }, (_, i) => i + 1) }, chezTriangle);
    verifier("un lot démesuré est refusé",
      trop.statut === 400 && trop.corps.code === "TOO_MANY");
  }

  console.log("\n▸ ATOMICITÉ ET CONCURRENCE");
  {
    /* Un identifiant inexistant au milieu du lot : les autres passent, il est
       signalé — mais si une écriture échoue vraiment, rien ne reste. */
    const mixte = await appel("POST", "/documents/from-movements", jOp,
      { movement_ids: [MVT_ANCIENNE_SORTIE.id, 999999999] }, chezTriangle);
    verifier("un identifiant inconnu est signalé sans bloquer le reste",
      mixte.statut === 201
        && (mixte.corps.mouvementsRefuses || []).some((m) => m.id === 999999999),
      JSON.stringify(mixte.corps.mouvementsRefuses));

    const avant = Number((await pool.query(
      `SELECT count(*)::int AS n FROM documents WHERE company_id = $1`,
      [TRIANGLE.id])).rows[0].n);

    /* Une panne technique au milieu de l'écriture : aucun document du lot ne
       doit survivre. Le déclencheur vit le temps du test. */
    const { rows: libres } = await pool.query(
      `INSERT INTO stock_movements
         (company_id, type, product_name, product_reference, quantity, status, import_id, created_at)
       SELECT $1, 'Sortie', 'ESSAI DOC PANNE ' || g, 'ESSAI-REF', g, 'Validé', $2, now()
         FROM generate_series(1, 3) g
       RETURNING id`, [TRIANGLE.id, NOUVEL_IMPORT.id]);
    const idsPanne = libres.map((r) => r.id);

    /* Le déclencheur fait échouer la DEUXIÈME insertion de document de la
       transaction : la première a donc bien eu lieu, et c'est elle qui doit
       disparaître. Le compteur vit dans une table temporaire au sens propre —
       il est remis à zéro juste avant. */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS essai_compteur_doc (n INTEGER NOT NULL DEFAULT 0)`);
    await pool.query(`DELETE FROM essai_compteur_doc`);
    await pool.query(`INSERT INTO essai_compteur_doc (n) VALUES (0)`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION essai_panne_document() RETURNS trigger AS $$
      DECLARE compte INTEGER;
      BEGIN
        UPDATE essai_compteur_doc SET n = n + 1 RETURNING n INTO compte;
        IF compte >= 2 THEN
          RAISE EXCEPTION 'panne technique simulée sur le document %', compte;
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;`);
    await pool.query(`DROP TRIGGER IF EXISTS essai_panne_doc_trg ON documents`);
    await pool.query(
      `CREATE TRIGGER essai_panne_doc_trg BEFORE INSERT ON documents
         FOR EACH ROW EXECUTE FUNCTION essai_panne_document()`);

    const panne = await appel("POST", "/documents/from-movements", jOp,
      { movement_ids: idsPanne }, chezTriangle);

    await pool.query(`DROP TRIGGER IF EXISTS essai_panne_doc_trg ON documents`);
    await pool.query(`DROP FUNCTION IF EXISTS essai_panne_document()`);
    await pool.query(`DROP TABLE IF EXISTS essai_compteur_doc`);

    const apres = Number((await pool.query(
      `SELECT count(*)::int AS n FROM documents WHERE company_id = $1`,
      [TRIANGLE.id])).rows[0].n);

    verifier("une panne au milieu du lot fait échouer la requête", panne.statut >= 400,
      `statut ${panne.statut}`);
    verifier("aucun document du lot interrompu ne survit", apres === avant,
      `${avant} → ${apres}`);

    /* Deux requêtes simultanées sur le même mouvement : un seul document. */
    const cible = idsPanne[0];
    const [a, b] = await Promise.all([
      appel("POST", "/documents/from-movements", jOp, { movement_ids: [cible] }, chezTriangle),
      appel("POST", "/documents/from-movements", jOp, { movement_ids: [cible] }, chezTriangle),
    ]);
    const total = Number((await pool.query(
      `SELECT count(*)::int AS n FROM documents
        WHERE company_id = $1 AND stock_movement_id = $2 AND cancelled_at IS NULL`,
      [TRIANGLE.id, cible])).rows[0].n);
    verifier("deux requêtes simultanées ne produisent qu'un document", total === 1,
      `${total} document(s) — statuts ${a.statut}/${b.statut}`);
  }

  console.log("\n▸ CORRIGER LE CONTENU SANS TOUCHER AU STOCK");
  {
    const { rows: lignes } = await pool.query(
      `SELECT id, quantity FROM document_items WHERE document_id = $1 ORDER BY id`,
      [docSortie.documentId]);

    const sansMotif = await appel("PATCH", `/documents/${docSortie.documentId}/content`, jOp,
      { document_number: docSortie.numero, items: [{ id: lignes[0].id, quantity: 12 }] },
      chezTriangle);
    verifier("un motif est obligatoire",
      sansMotif.statut === 400 && sansMotif.corps.code === "REASON_REQUIRED",
      `statut ${sansMotif.statut} ${sansMotif.corps.code}`);

    const sansNumero = await appel("PATCH", `/documents/${docSortie.documentId}/content`, jOp,
      { document_number: "", reason: "essai", items: [{ id: lignes[0].id, quantity: 12 }] },
      chezTriangle);
    verifier("le numéro est obligatoire",
      sansNumero.statut === 400 && sansNumero.corps.code === "NUMBER_REQUIRED");

    const negative = await appel("PATCH", `/documents/${docSortie.documentId}/content`, jOp,
      { document_number: docSortie.numero, reason: "essai",
        items: [{ id: lignes[0].id, quantity: 0 }] }, chezTriangle);
    verifier("une quantité nulle ou négative est refusée",
      negative.statut === 400 && negative.corps.code === "QUANTITY_INVALID");

    const { rows: autre } = await pool.query(
      `SELECT document_number FROM documents
        WHERE company_id = $1 AND id <> $2 AND document_number IS NOT NULL LIMIT 1`,
      [TRIANGLE.id, docSortie.documentId]);
    if (autre[0]) {
      const collision = await appel("PATCH", `/documents/${docSortie.documentId}/content`, jOp,
        { document_number: autre[0].document_number, reason: "essai",
          items: [{ id: lignes[0].id, quantity: 12 }] }, chezTriangle);
      verifier("un numéro déjà pris est refusé",
        collision.statut === 409 && collision.corps.code === "NUMBER_TAKEN",
        `statut ${collision.statut} ${collision.corps.code}`);
    }

    const mvtAvant = (await pool.query(
      `SELECT quantity FROM stock_movements WHERE id = $1`,
      [MVT_NOUVELLE_SORTIE.id])).rows[0].quantity;

    const ok = await appel("PATCH", `/documents/${docSortie.documentId}/content`, jOp,
      { document_number: `${docSortie.numero}-R`, reason: "Quantité mal recopiée du classeur.",
        items: [{ id: lignes[0].id, quantity: 12 }] }, chezTriangle);
    verifier("une correction complète passe", ok.statut === 200,
      `statut ${ok.statut} ${ok.corps.code || ""}`);
    verifier("la révision est incrémentée", Number(ok.corps.document?.document_revision) >= 1,
      `${ok.corps.document?.document_revision}`);

    const { rows: apresLignes } = await pool.query(
      `SELECT quantity FROM document_items WHERE document_id = $1`, [docSortie.documentId]);
    verifier("la quantité imprimée a changé", Number(apresLignes[0].quantity) === 12,
      `${apresLignes[0].quantity}`);

    const mvtApres = (await pool.query(
      `SELECT quantity FROM stock_movements WHERE id = $1`,
      [MVT_NOUVELLE_SORTIE.id])).rows[0].quantity;
    verifier("le mouvement n'a PAS bougé", Number(mvtApres) === Number(mvtAvant),
      `${mvtAvant} → ${mvtApres}`);
    verifier("products.stock n'a pas bougé",
      Number(await stockProduit()) === Number(stockAvant),
      `${stockAvant} → ${await stockProduit()}`);
    verifier("les balances d'emplacement n'ont pas bougé",
      Number(await balancesTotal()) === Number(balancesAvant),
      `${balancesAvant} → ${await balancesTotal()}`);

    const journal = await appel("GET",
      `/documents/${docSortie.documentId}/content-revisions`, jOp, null, chezTriangle);
    const revisions = journal.corps.revisions || [];
    verifier("le journal garde l'avant et l'après",
      revisions.length === 1
        && revisions[0].old_document_number === docSortie.numero
        && Number(revisions[0].old_items[0].quantity) === 10
        && Number(revisions[0].new_items[0].quantity) === 12,
      JSON.stringify(revisions[0] || {}).slice(0, 160));
    verifier("il dit qui a corrigé, quand et pourquoi",
      revisions[0]?.reason && revisions[0]?.changed_at && revisions[0]?.changed_by_name);
  }

  console.log("\n▸ CORRIGER UN DOCUMENT DÉJÀ IMPRIMÉ");
  {
    await pool.query(
      `UPDATE documents SET print_count = 1, printed_at = now() WHERE id = $1`,
      [docSortie.documentId]);

    const { rows: lignes } = await pool.query(
      `SELECT id FROM document_items WHERE document_id = $1 ORDER BY id`,
      [docSortie.documentId]);

    const sansDroit = await appel("PATCH", `/documents/${docSortie.documentId}/content`, jOp,
      { document_number: `${docSortie.numero}-R2`, reason: "Nouvelle correction.",
        items: [{ id: lignes[0].id, quantity: 13 }] }, chezTriangle);
    verifier("sans droit de réimpression, corriger un bon imprimé est refusé",
      sansDroit.statut === 403 && sansDroit.corps.code === "REPRINT_REQUIRED",
      `statut ${sansDroit.statut} ${sansDroit.corps.code}`);

    await pool.query(
      `INSERT INTO user_permission_overrides (user_id, company_id, module_key, action, effect)
       VALUES ($1,$2,'document','reprint','ALLOW') ON CONFLICT DO NOTHING`,
      [OPERATEUR.id, TRIANGLE.id]);

    const avecDroit = await appel("PATCH", `/documents/${docSortie.documentId}/content`, jOp,
      { document_number: `${docSortie.numero}-R2`, reason: "Nouvelle correction.",
        items: [{ id: lignes[0].id, quantity: 13 }] }, chezTriangle);
    verifier("avec le droit, la correction passe et note qu'il était imprimé",
      avecDroit.statut === 200 && avecDroit.corps.apresImpression === true,
      `statut ${avecDroit.statut}`);
  }

  console.log("\n▸ ANNULER EN REMPLAÇANT");
  {
    const sansMotif = await appel("POST",
      `/documents/${docSortie.documentId}/cancel-replace`, jOp, {}, chezTriangle);
    verifier("annuler sans motif est refusé",
      sansMotif.statut === 400 && sansMotif.corps.code === "REASON_REQUIRED");

    const r = await appel("POST", `/documents/${docSortie.documentId}/cancel-replace`, jOp,
      { reason: "Bon émis avec le mauvais type." }, chezTriangle);
    verifier("l'annulation aboutit et crée un remplaçant",
      r.statut === 200 && r.corps.remplacant?.id, `statut ${r.statut}`);
    verifier("le remplaçant est un Bon de sortie",
      r.corps.remplacant?.type === "Bon de sortie", r.corps.remplacant?.type);

    const { rows: ancien } = await pool.query(
      `SELECT document_number, cancelled_at, cancellation_reason, cancelled_by_name,
              replaced_by_document_id, status
         FROM documents WHERE id = $1`, [docSortie.documentId]);
    verifier("l'ancien document garde son numéro et ses lignes",
      ancien[0].document_number && Number((await pool.query(
        `SELECT count(*)::int AS n FROM document_items WHERE document_id = $1`,
        [docSortie.documentId])).rows[0].n) > 0);
    verifier("il porte la date, le motif et l'auteur de l'annulation",
      ancien[0].cancelled_at && ancien[0].cancellation_reason && ancien[0].cancelled_by_name);
    verifier("il pointe vers son remplaçant",
      ancien[0].replaced_by_document_id === r.corps.remplacant.id);

    /* Le remplaçant reprend la quantité du MOUVEMENT, pas celle du document
       corrigé : recopier un bon faux reproduirait l'erreur. */
    const { rows: nouvelles } = await pool.query(
      `SELECT quantity FROM document_items WHERE document_id = $1`,
      [r.corps.remplacant.id]);
    verifier("le remplaçant reprend la quantité du mouvement, soit 10",
      Number(nouvelles[0].quantity) === 10, `${nouvelles[0].quantity}`);

    const deux = await appel("POST", `/documents/${docSortie.documentId}/cancel-replace`, jOp,
      { reason: "encore" }, chezTriangle);
    verifier("un document déjà annulé ne se réannule pas",
      deux.statut === 409 && deux.corps.code === "ALREADY_CANCELLED");
  }

  console.log("\n▸ PERMISSIONS ET ISOLATION");
  {
    const sansCreer = await appel("POST", "/documents/from-movements", jLecteur,
      { movement_ids: [MVT_ANCIENNE_SORTIE.id] }, chezTriangle);
    verifier("sans le droit de créer, la génération est refusée",
      sansCreer.statut === 403 || sansCreer.statut === 404, `statut ${sansCreer.statut}`);

    const chezVoisin = await appel("POST", "/documents/from-movements", jFatMat,
      { movement_ids: [MVT_NOUVELLE_SORTIE.id] }, chezFatMat);
    verifier("FAT & MAT ne documente pas un mouvement de Triangle",
      chezVoisin.statut === 201 && chezVoisin.corps.crees === 0,
      `${chezVoisin.corps.crees} créé(s)`);
    verifier("le refus ne révèle pas l'existence du mouvement",
      (chezVoisin.corps.mouvementsRefuses || [])
        .every((m) => /introuvable dans cette entreprise/.test(m.motif)));

    const listeVoisine = await appel("GET", "/documents/pending-movements",
      jFatMat, null, chezFatMat);
    verifier("la liste de FAT & MAT ne contient aucun mouvement de Triangle",
      (listeVoisine.corps.mouvements || [])
        .every((m) => m.id !== MVT_NOUVELLE_SORTIE.id && m.id !== MVT_ANCIENNE_SORTIE.id));

    /* Le super administrateur travaille dans l'entreprise active, pas dans
       toutes à la fois. */
    const superChezTriangle = await appel("GET", "/documents/pending-movements",
      jSuper, null, chezTriangle);
    verifier("le super administrateur voit l'entreprise active",
      superChezTriangle.statut === 200, `statut ${superChezTriangle.statut}`);
    const superChezFatMat = await appel("GET", "/documents/pending-movements",
      jSuper, null, chezFatMat);
    verifier("et rien de Triangle quand il bascule sur FAT & MAT",
      (superChezFatMat.corps.mouvements || [])
        .every((m) => m.id !== MVT_NOUVELLE_SORTIE.id));
  }

  console.log("\n▸ BILAN");
  {
    verifier("products.stock est identique au départ",
      Number(await stockProduit()) === Number(stockAvant),
      `${stockAvant} → ${await stockProduit()}`);
    verifier("les balances sont identiques au départ",
      Number(await balancesTotal()) === Number(balancesAvant));
    const mvts = await pool.query(
      `SELECT quantity FROM stock_movements WHERE id IN ($1, $2) ORDER BY id`,
      [MVT_ANCIENNE_SORTIE.id, MVT_NOUVELLE_SORTIE.id]);
    verifier("les deux sorties valent toujours 20 et 10",
      mvts.rows.map((r) => Number(r.quantity)).join(",") === "20,10",
      mvts.rows.map((r) => Number(r.quantity)).join(","));
    const bl = await pool.query(
      `SELECT count(*)::int AS n FROM documents
        WHERE company_id = $1 AND document_type = 'Bon de livraison'
          AND observation LIKE '%mouvement stock ID%'`, [TRIANGLE.id]);
    verifier("aucun bon de livraison n'a été généré depuis un mouvement",
      bl.rows[0].n === 0, `${bl.rows[0].n}`);
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
