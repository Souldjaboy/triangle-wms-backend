"use strict";

/**
 * CYCLE COMPLET D'UN DOCUMENT — contre le VRAI serveur.
 *
 *   bash scripts/test-documents-e2e.sh
 *
 * Pour chaque famille réelle de Triangle — entrée, sortie, transfert,
 * inventaire, réception — le même parcours de bout en bout :
 *
 *   créer le mouvement → générer le document → corriger la date affichée →
 *   vérifier que created_at n'a pas bougé → imprimer → vérifier printed_at et
 *   print_count → corriger APRÈS impression → vérifier la nouvelle révision →
 *   réimprimer → vérifier ce que porte le document IMPRIMABLE.
 *
 * Le dernier point est celui qui compte : une date juste dans l'interface et
 * fausse sur le bon ne vaut rien. On lit donc la charge servie à l'impression,
 * pas seulement la réponse de l'écran d'édition.
 */

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const D = require("../services/document-dates");

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

let ADMIN, ETRANGER;

async function appel(methode, chemin, token, corps) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(corps ? { body: JSON.stringify(corps) } : {}),
  });
  return { statut: r.status, corps: await r.json().catch(() => ({})) };
}

/* Les cinq familles telles qu'elles existent dans Triangle. */
const FAMILLES = [
  { mouvement: "Entrée",     document: "Bon d'entrée" },
  { mouvement: "Sortie",     document: "Bon de sortie" },
  { mouvement: "Transfert",  document: "Bon de transfert" },
  { mouvement: "Inventaire", document: "Bon d'inventaire" },
  { mouvement: "Réception",  document: "Bon de réception" },
];

/* L'opération a eu lieu le 22 août à 10 h 30 ; la saisie, le 25 à 14 h 07. */
const CREATION_TECHNIQUE = "2026-08-25T14:07:33Z";
const DATE_METIER = { date: "2026-08-22", time: "10:30", attendu: "22/08/2026 à 10:30" };
const APRES_IMPRESSION = { date: "2026-08-21", time: "16:45", attendu: "21/08/2026 à 16:45" };

async function semer() {
  await pool.query(`TRUNCATE document_date_revisions RESTART IDENTITY`);
  for (const t of ["document_items", "documents", "stock_movements", "role_permissions", "users", "companies"]) {
    await pool.query(`DELETE FROM ${t}`).catch(() => {});
  }
  await pool.query(`INSERT INTO companies (id,name,status) VALUES (1,'Triangle','active'),(2,'FAT & MAT','active')`);
  await pool.query(`SELECT setval('companies_id_seq',2,true)`);
  await pool.query(
    `INSERT INTO users (id,fullname,email,password,role,company_id,is_super_admin,is_active) VALUES
       (1,'Admin Triangle','admin@triangle.test','x','super_admin',1,true,true),
       (9,'Admin FAT','admin@fatmat.test','x','super_admin',2,true,true)`);
  await pool.query(`SELECT setval('users_id_seq',9,true)`);
  await pool.query(
    `INSERT INTO role_permissions (company_id, role, module_key, action, allowed)
     SELECT c.id, r.role, m.module_key, a.action, TRUE
       FROM companies c
       JOIN (SELECT DISTINCT company_id, lower(trim(role)) AS role FROM users) r ON r.company_id=c.id
       CROSS JOIN permission_modules m
       CROSS JOIN LATERAL unnest(m.actions) AS a(action)
     ON CONFLICT DO NOTHING`);
  ADMIN = jeton({ id: 1, email: "admin@triangle.test", role: "super_admin", company_id: 1, is_super_admin: true });
  ETRANGER = jeton({ id: 9, email: "admin@fatmat.test", role: "super_admin", company_id: 2, is_super_admin: true });
}

/** Crée un mouvement daté du 25 août, puis son bon. */
async function creerCouple(famille, index) {
  const mvt = await pool.query(
    `INSERT INTO stock_movements (type, product_reference, product_name, quantity,
                                  company_id, created_at, status, created_by_name)
     VALUES ($1,'REF-A','Faux plafond metallique D',$2,1,$3,'Validé','Administrateur')
     RETURNING id`,
    [famille.mouvement, 10 + index, CREATION_TECHNIQUE]);
  const doc = await pool.query(
    `INSERT INTO documents (document_type, document_number, company_id, created_at,
                            stock_movement_id, created_by, total_amount)
     VALUES ($1,$2,1,$3,$4,'Administrateur',150000) RETURNING id`,
    [famille.document, `DOC-${String(index + 1).padStart(3, "0")}`, CREATION_TECHNIQUE, mvt.rows[0].id]);
  await pool.query(
    `INSERT INTO document_items (document_id, product_reference, product_name, quantity, unit_price, total_price)
     VALUES ($1,'REF-A','Faux plafond metallique D',$2,15000,$3)`,
    [doc.rows[0].id, 10 + index, (10 + index) * 15000]).catch(() => {});
  return { movementId: mvt.rows[0].id, documentId: doc.rows[0].id };
}

async function main() {
  await semer();

  for (const [i, famille] of FAMILLES.entries()) {
    console.log(`\n▸ ${famille.document.toUpperCase()}`);
    const { movementId, documentId } = await creerCouple(famille, i);
    const creationAvant = (await pool.query(
      `SELECT created_at FROM documents WHERE id=$1`, [documentId])).rows[0].created_at;

    // ── 3. corriger la date affichée
    const corrige = await appel("PUT", `/documents/${documentId}/dates`, ADMIN,
      { ...DATE_METIER, reason: "Impression différée" });
    verifier("date corrigée", corrige.statut === 200, JSON.stringify(corrige.corps).slice(0, 140));
    verifier(`le document affiche ${DATE_METIER.attendu}`,
      corrige.corps.dates?.document_affiche?.affichage === DATE_METIER.attendu,
      corrige.corps.dates?.document_affiche?.affichage);

    // ── 4. created_at intact
    const creationApres = (await pool.query(
      `SELECT created_at FROM documents WHERE id=$1`, [documentId])).rows[0].created_at;
    verifier("created_at n'a pas bougé",
      new Date(creationApres).toISOString() === new Date(creationAvant).toISOString(),
      `${creationAvant} → ${creationApres}`);
    verifier("le mouvement porte la même date de terrain",
      (await pool.query(`SELECT operation_effective_at FROM stock_movements WHERE id=$1`, [movementId]))
        .rows[0].operation_effective_at?.toISOString() === "2026-08-22T10:30:00.000Z");

    // ── 5-6. imprimer
    const impression = await appel("POST", `/documents/${documentId}/printed`, ADMIN, {});
    verifier("impression enregistrée", impression.statut === 200 && impression.corps.print_count === 1,
      `count ${impression.corps.print_count}`);
    verifier("printed_at est renseignée", Boolean(impression.corps.dates?.derniere_impression?.iso));
    verifier("printed_at diffère de la date du document",
      impression.corps.dates.derniere_impression.iso !== impression.corps.dates.document_affiche.iso);

    // ── 7-8. corriger APRÈS impression
    const sansMotif = await appel("PUT", `/documents/${documentId}/dates`, ADMIN, APRES_IMPRESSION);
    verifier("après impression, le motif devient obligatoire",
      sansMotif.statut === 400 && sansMotif.corps.code === "REASON_REQUIRED");
    const revision = await appel("PUT", `/documents/${documentId}/dates`, ADMIN,
      { ...APRES_IMPRESSION, reason: "Correction de date de mouvement" });
    verifier("la correction après impression passe avec motif", revision.statut === 200);
    verifier("une nouvelle révision est créée", revision.corps.revision === 3, `${revision.corps.revision}`);
    verifier("l'historique conserve les deux valeurs",
      (await appel("GET", `/documents/${documentId}/revisions`, ADMIN)).corps.entries.length === 2);

    // ── 9. réimprimer
    const reimpression = await appel("POST", `/documents/${documentId}/printed`, ADMIN, {});
    verifier("réimpression comptée", reimpression.corps.print_count === 2, `${reimpression.corps.print_count}`);

    // ── 10. ce que porte réellement le document IMPRIMABLE
    const lot = await appel("GET", `/documents/print/batch?ids=${documentId}`, ADMIN);
    verifier("le document imprimable est servi", lot.statut === 200, JSON.stringify(lot.corps).slice(0, 140));
    const imprime = (lot.corps.documents || [])[0];
    verifier("LE BON IMPRIMÉ PORTE LA DATE MÉTIER, PAS created_at",
      imprime?.date_affichee?.affichage === APRES_IMPRESSION.attendu,
      `imprimé « ${imprime?.date_affichee?.affichage} », attendu « ${APRES_IMPRESSION.attendu} »`);
    verifier("il annonce son fuseau", imprime?.fuseau === "Africa/Bamako", imprime?.fuseau);
    verifier("la date imprimée vient bien du métier",
      imprime?.source_date_affichee === "document", imprime?.source_date_affichee);
    verifier("la date technique reste disponible à côté",
      new Date(imprime?.created_at).toISOString() === new Date(CREATION_TECHNIQUE).toISOString());
    verifier("les lignes du bon sont intactes", (imprime?.items || []).length >= 1);

    // ── cloisonnement
    const intrusion = await appel("GET", `/documents/${documentId}/dates`, ETRANGER);
    verifier("une autre société ne lit pas ce document", intrusion.statut === 404, `statut ${intrusion.statut}`);
  }

  console.log("\n▸ FUSEAU — le serveur ne dépend d'aucun navigateur");
  {
    /* On force le fuseau du PROCESSUS : si la conversion dépendait de
       l'environnement, ces trois calculs donneraient trois résultats. */
    const instantAttendu = "2026-08-22T10:30:00.000Z";
    for (const tz of ["Africa/Bamako", "Europe/Paris", "UTC", "Pacific/Kiritimati"]) {
      const avant = process.env.TZ;
      process.env.TZ = tz;
      const instant = D.versInstant({ date: "2026-08-22", time: "10:30" });
      const local = D.versLocal(instant);
      verifier(`TZ=${tz} : 10:30 Bamako reste ${instantAttendu}`,
        instant.toISOString() === instantAttendu, instant.toISOString());
      verifier(`TZ=${tz} : le bon affiche « 22/08/2026 à 10:30 »`,
        local.affichage === "22/08/2026 à 10:30", local.affichage);
      process.env.TZ = avant;
    }
  }

  console.log("\n▸ BILAN");
  {
    const docs = await pool.query(`SELECT COUNT(*)::int AS n FROM documents WHERE company_id=1`);
    verifier("les cinq documents existent toujours", docs.rows[0].n === 5, `${docs.rows[0].n}`);
    const mvts = await pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(quantity),0)::int AS q FROM stock_movements WHERE company_id=1`);
    verifier("les cinq mouvements et leurs quantités sont intacts",
      mvts.rows[0].n === 5 && mvts.rows[0].q === 60, JSON.stringify(mvts.rows[0]));
    const intactes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM documents
        WHERE company_id=1 AND created_at <> $1::timestamptz`, [CREATION_TECHNIQUE]);
    verifier("AUCUN created_at n'a été réécrit", intactes.rows[0].n === 0, `${intactes.rows[0].n} altéré(s)`);
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
