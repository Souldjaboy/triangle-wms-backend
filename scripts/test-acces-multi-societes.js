"use strict";

/**
 * UN COMPTE, PLUSIEURS SOCIÉTÉS — SANS SECOND COMPTE (migration 079).
 *
 *   bash scripts/test-acces-multi-societes.sh
 *
 * Ce que la suite prouve, dans l'ordre où un défaut coûterait le plus cher :
 *
 *   1. sans habilitation, rien ne change — un compte reste enfermé dans sa
 *      société, même en envoyant l'en-tête de bascule ;
 *   2. avec habilitation, la bascule fonctionne ;
 *   3. la bascule ne s'obtient QUE par l'en-tête ou l'URL : un `company_id`
 *      posé dans le CORPS d'une requête ne fait pas changer de société —
 *      c'est un champ de donnée, pas une commande ;
 *   4. une société non habilitée reste refusée, même explicitement demandée ;
 *   5. révoquer reprend l'accès, et l'historique le conserve ;
 *   6. accorder ou révoquer exige le droit `utilisateur.acces_societes|manage`
 *      et un motif ;
 *   7. l'habilitation n'accorde AUCUN droit métier dans la société d'accueil.
 */

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const BASE = `http://127.0.0.1:${process.env.PORT || 5050}`;
const SECRET = process.env.JWT_SECRET || "test-secret-durcissement";
const V = "\x1b[32m", R = "\x1b[31m", G = "\x1b[1m", Z = "\x1b[0m";
let reussis = 0, echoues = 0;
function verifier(titre, condition, detail = "") {
  if (condition) { reussis += 1; console.log(`${V}  ✓${Z} ${titre}`); }
  else { echoues += 1; console.log(`${R}  ✗ ${titre}${Z}${detail ? `  — ${detail}` : ""}`); }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    "postgresql://postgres:triangle_test_password@127.0.0.1:5433/triangle_wms",
});

const jeton = (id, role, companyId, superAdmin = false) =>
  jwt.sign({ id, fullname: `Compte ${id}`, email: "x@x.test", role, company_id: companyId, is_super_admin: superAdmin },
           SECRET, { expiresIn: "3h" });

async function appel(methode, chemin, token, corps, entetes = {}) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...entetes },
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  let json; try { json = JSON.parse(texte); } catch { json = { brut: texte }; }
  return { statut: r.status, corps: json };
}

const TRIANGLE = 1, FATMAT = 2;

/* La suite crée SES propres comptes plutôt que de compter sur ceux du socle :
   les autres suites remplacent les comptes fixtures, et un identifiant écrit
   en dur ici ferait échouer celle-ci selon l'ordre d'exécution — pour une
   raison sans aucun rapport avec ce qu'elle vérifie. */
let COMPTABLE = 0, SUPER = 0, EMPLOYE = 0;

async function poserLesComptes() {
  await pool.query(`DELETE FROM users WHERE email LIKE 'acces079-%@essai.test'`);
  const creer = async (email, nom, role, companyId, superAdmin = false) => (await pool.query(
    `INSERT INTO users (company_id, fullname, email, password, role, is_super_admin, is_active)
     VALUES ($1,$2,$3,'$non-utilisable$',$4,$5,true) RETURNING id`,
    [companyId, nom, email, role, superAdmin])).rows[0].id;

  SUPER     = await creer("acces079-super@essai.test",     "Essai 079 Super",     "super_admin", TRIANGLE, true);
  COMPTABLE = await creer("acces079-comptable@essai.test", "Essai 079 Comptable", "comptable",   TRIANGLE);
  EMPLOYE   = await creer("acces079-employe@essai.test",   "Essai 079 Employé",   "employe",     TRIANGLE);
}

async function nettoyer() {
  await pool.query(`DELETE FROM user_company_access_log WHERE reason LIKE 'ESSAI079%'`);
  await pool.query(`DELETE FROM user_company_access WHERE reason LIKE 'ESSAI079%'`);
  await pool.query(`DELETE FROM user_permission_overrides WHERE module_key = 'utilisateur.acces_societes'`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'acces079-%@essai.test'`);
}

/* Le cache d'habilitations vit 30 s. Les tests écrivent en base directement
   ou par l'API ; dans les deux cas on force le serveur à relire en attendant
   l'expiration serait absurde — on passe donc TOUJOURS par l'API pour les
   écritures, qui invalide le cache du processus serveur. */

async function main() {
  console.log(`\n${G}ACCÈS MULTI-SOCIÉTÉS (079)${Z}`);
  await nettoyer();
  await poserLesComptes();

  const tSuper = jeton(SUPER, "super_admin", TRIANGLE, true);
  const tComptable = jeton(COMPTABLE, "comptable", TRIANGLE);
  const tEmploye = jeton(EMPLOYE, "employe", TRIANGLE);

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}SANS HABILITATION, RIEN NE CHANGE${Z}`);
  {
    const mes = await appel("GET", "/acces-societes/mes-societes", tComptable);
    verifier("le comptable ne voit que sa société d'origine",
      mes.statut === 200 && mes.corps.societes?.length === 1
        && Number(mes.corps.societes[0].id) === TRIANGLE,
      JSON.stringify(mes.corps));

    /* La bascule demandée sans habilitation doit être ignorée, pas honorée. */
    const bascule = await appel("GET", "/acces-societes/mes-societes", tComptable, undefined,
      { "x-active-company-id": String(FATMAT) });
    verifier("demander FAT & MAT sans habilitation ne donne pas FAT & MAT",
      bascule.statut === 200 && bascule.corps.societes?.length === 1
        && Number(bascule.corps.societes[0].id) === TRIANGLE,
      JSON.stringify(bascule.corps.societes));
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}ACCORDER EXIGE LE DROIT ET UN MOTIF${Z}`);
  {
    /* Le refus vaut 403 OU 404 : `requirePermission` répond volontairement
       « introuvable » quand le module entier est masqué pour ce rôle, plutôt
       que « interdit » — dire « interdit » apprendrait déjà que l'écran
       existe. Ce qui compte ici est que l'accès ne soit pas accordé. */
    const sansDroit = await appel("POST", "/acces-societes", tEmploye,
      { user_id: COMPTABLE, company_id: FATMAT, reason: "ESSAI079 tentative" });
    verifier("un employé ne peut pas s'accorder d'accès",
      sansDroit.statut === 403 || sansDroit.statut === 404, `statut ${sansDroit.statut}`);
    const { rows: aucun } = await pool.query(
      `SELECT count(*)::int AS n FROM user_company_access WHERE user_id=$1 AND company_id=$2`,
      [COMPTABLE, FATMAT]);
    verifier("et rien n'a été créé en base", aucun[0].n === 0, `${aucun[0].n} ligne(s)`);

    const sansMotif = await appel("POST", "/acces-societes", tSuper,
      { user_id: COMPTABLE, company_id: FATMAT });
    verifier("accorder sans motif est refusé",
      sansMotif.statut === 400 && sansMotif.corps.code === "REASON_REQUIRED",
      JSON.stringify(sansMotif.corps));

    const societeOrigine = await appel("POST", "/acces-societes", tSuper,
      { user_id: COMPTABLE, company_id: TRIANGLE, reason: "ESSAI079 société d'origine" });
    verifier("habiliter un compte sur sa PROPRE société est refusé (elle lui est acquise)",
      societeOrigine.statut === 409 && societeOrigine.corps.code === "ALREADY_HOME_COMPANY",
      JSON.stringify(societeOrigine.corps));

    const inconnue = await appel("POST", "/acces-societes", tSuper,
      { user_id: COMPTABLE, company_id: 99999, reason: "ESSAI079 société inexistante" });
    verifier("une société inexistante est refusée", inconnue.statut === 404, `statut ${inconnue.statut}`);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}AVEC HABILITATION, LA BASCULE FONCTIONNE${Z}`);
  {
    const accorde = await appel("POST", "/acces-societes", tSuper,
      { user_id: COMPTABLE, company_id: FATMAT, reason: "ESSAI079 comptable des deux sociétés" });
    verifier("l'habilitation est accordée", accorde.statut === 201 && accorde.corps.ok === true,
      JSON.stringify(accorde.corps));

    const mes = await appel("GET", "/acces-societes/mes-societes", tComptable);
    const ids = (mes.corps.societes || []).map((s) => Number(s.id)).sort();
    verifier("le comptable voit désormais les deux sociétés",
      ids.length === 2 && ids[0] === TRIANGLE && ids[1] === FATMAT, JSON.stringify(ids));

    /* Rejouer l'habilitation ne doit pas créer de doublon. */
    await appel("POST", "/acces-societes", tSuper,
      { user_id: COMPTABLE, company_id: FATMAT, reason: "ESSAI079 rejeu" });
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM user_company_access WHERE user_id=$1 AND company_id=$2`,
      [COMPTABLE, FATMAT]);
    verifier("accorder deux fois ne crée qu'une seule ligne", rows[0].n === 1, `${rows[0].n} ligne(s)`);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}LE CORPS DE LA REQUÊTE NE FAIT PAS BASCULER${Z}`);
  {
    /* `company_id` est un nom de champ de donnée avant d'être une commande.
       Un corps qui décrit un employé et porte company_id: 2 ne demande pas à
       changer de société. C'est le piège déjà documenté sur
       getEffectiveCompanyIdStrict, qui doit valoir aussi pour un habilité. */
    const parEntete = await appel("GET", "/acces-societes/mes-societes", tComptable, undefined,
      { "x-active-company-id": String(FATMAT) });
    verifier("l'en-tête reste accepté (bascule intentionnelle)",
      parEntete.statut === 200 && (parEntete.corps.societes || []).length === 2);

    const { rows: avant } = await pool.query(
      `SELECT count(*)::int AS n FROM user_company_access WHERE user_id=$1 AND active`, [COMPTABLE]);
    verifier("l'habilitation reste unique après ces appels", avant[0].n === 1, `${avant[0].n}`);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}UNE HABILITATION N'EST PAS UN PASSE-DROIT${Z}`);
  {
    /* Le comptable est habilité sur FAT & MAT, mais rien ne lui a donné le
       droit d'administrer les habilitations. Il ne doit pas pouvoir en
       accorder, ni dans l'une ni dans l'autre société. */
    const tentative = await appel("POST", "/acces-societes", tComptable,
      { user_id: EMPLOYE, company_id: FATMAT, reason: "ESSAI079 escalade" },
      { "x-active-company-id": String(FATMAT) });
    verifier("le comptable habilité ne peut pas accorder d'accès à un tiers",
      tentative.statut === 403 || tentative.statut === 404, `statut ${tentative.statut}`);
    const { rows: tiers } = await pool.query(
      `SELECT count(*)::int AS n FROM user_company_access WHERE user_id=$1`, [EMPLOYE]);
    verifier("l'employé visé n'a reçu aucune habilitation", tiers[0].n === 0, `${tiers[0].n}`);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}RÉVOCATION ET HISTORIQUE${Z}`);
  {
    const sansMotif = await appel("DELETE", `/acces-societes/${COMPTABLE}/${FATMAT}`, tSuper, {});
    verifier("révoquer sans motif est refusé",
      sansMotif.statut === 400 && sansMotif.corps.code === "REASON_REQUIRED",
      JSON.stringify(sansMotif.corps));

    const retire = await appel("DELETE", `/acces-societes/${COMPTABLE}/${FATMAT}`, tSuper,
      { reason: "ESSAI079 fin de mission" });
    verifier("l'accès est révoqué", retire.statut === 200 && retire.corps.ok === true,
      JSON.stringify(retire.corps));

    const mes = await appel("GET", "/acces-societes/mes-societes", tComptable);
    verifier("le comptable est revenu à sa seule société",
      (mes.corps.societes || []).length === 1, JSON.stringify(mes.corps.societes));

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM user_company_access WHERE user_id=$1 AND company_id=$2`,
      [COMPTABLE, FATMAT]);
    verifier("la ligne n'est pas effacée, seulement désactivée", rows[0].n === 1, `${rows[0].n}`);

    const journal = await appel("GET", `/acces-societes/${COMPTABLE}/journal`, tSuper);
    const actions = (journal.corps.journal || []).map((l) => l.action);
    verifier("le journal conserve l'octroi, le rejeu et la révocation",
      actions.includes("accorde") && actions.includes("revoque"), JSON.stringify(actions));

    const encore = await appel("DELETE", `/acces-societes/${COMPTABLE}/${FATMAT}`, tSuper,
      { reason: "ESSAI079 seconde révocation" });
    verifier("révoquer deux fois signale qu'il n'y a plus rien à révoquer",
      encore.statut === 404, `statut ${encore.statut}`);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}RÉACTIVATION${Z}`);
  {
    const reactive = await appel("POST", "/acces-societes", tSuper,
      { user_id: COMPTABLE, company_id: FATMAT, reason: "ESSAI079 reprise de mission" });
    verifier("un accès révoqué peut être rendu", reactive.statut === 201 && reactive.corps.ok === true);
    verifier("la reprise est signalée comme réactivation, pas comme création",
      reactive.corps.cree === false, JSON.stringify(reactive.corps));

    const { rows } = await pool.query(
      `SELECT action FROM user_company_access_log
        WHERE user_id=$1 AND company_id=$2 ORDER BY id DESC LIMIT 1`, [COMPTABLE, FATMAT]);
    verifier("le journal l'enregistre comme « reactive »", rows[0]?.action === "reactive",
      JSON.stringify(rows[0]));
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}SUPER ADMIN : COMPORTEMENT INCHANGÉ${Z}`);
  {
    const mes = await appel("GET", "/acces-societes/mes-societes", tSuper);
    verifier("le super admin atteint toujours toutes les sociétés",
      (mes.corps.societes || []).length >= 2, JSON.stringify((mes.corps.societes || []).length));
  }

  await nettoyer();
  console.log(`\n${G}BILAN${Z}`);
  console.log(`  ${reussis} réussis, ${echoues} échoués\n`);
  await pool.end();
  process.exit(echoues > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`${R}ÉCHEC : ${e.message}${Z}`); console.error(e.stack);
  await nettoyer().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
