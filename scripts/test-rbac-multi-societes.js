"use strict";

/**
 * LES DROITS SE LISENT DANS LA SOCIÉTÉ ACTIVE, PAS DANS CELLE DU COMPTE.
 *
 *   bash scripts/test-rbac-multi-societes.sh
 *
 * `chargerContexte()` lisait `user.company_id` — la société d'ORIGINE. Un
 * comptable habilité qui bascule sur FAT & MAT y était donc jugé selon ses
 * droits Triangle : il pouvait y faire ce que personne ne lui y avait accordé,
 * et se voir refuser ce qu'on lui y avait donné.
 *
 * Ce que la suite prouve :
 *
 *   • un ALLOW dans Triangle et un DENY dans FAT & MAT donnent bien deux
 *     verdicts différents, pour le même compte et la même action ;
 *   • une exception personnelle posée dans une société n'affecte pas l'autre ;
 *   • un en-tête de société non autorisé est REFUSÉ, pas ignoré ;
 *   • une révocation d'accès ferme la société dès la requête suivante ;
 *   • le comptable des deux sociétés y travaille avec les droits de chacune ;
 *   • le directeur des deux sociétés y valide de chaque côté ;
 *   • un compte cantonné à Triangle ne lit aucun salaire, y compris par l'API ;
 *   • aucun autre tenant n'est accessible.
 */

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const BASE = `http://127.0.0.1:${process.env.PORT || 5050}`;
const SECRET = process.env.JWT_SECRET || "test-secret-durcissement";
const URL_BASE = process.env.DATABASE_URL ||
  "postgresql://postgres:triangle_test_password@127.0.0.1:5433/triangle_wms";
const V = "\x1b[32m", R = "\x1b[31m", G = "\x1b[1m", Z = "\x1b[0m";
let reussis = 0, echoues = 0;
function verifier(titre, condition, detail = "") {
  if (condition) { reussis += 1; console.log(`${V}  ✓${Z} ${titre}`); }
  else { echoues += 1; console.log(`${R}  ✗ ${titre}${Z}${detail ? `  — ${detail}` : ""}`); }
}

const pool = new Pool({ connectionString: URL_BASE });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const jeton = (id, role, companyId, superAdmin = false, tenant = undefined) =>
  jwt.sign({ id, fullname: `Compte ${id}`, email: `m${id}@essai.test`, role,
             company_id: companyId, is_super_admin: superAdmin,
             ...(tenant ? { tenant_id: tenant } : {}) }, SECRET, { expiresIn: "3h" });

/** `societe` pose l'en-tête de bascule — le SEUL endroit intentionnel. */
async function appel(methode, chemin, token, corps, societe) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(societe ? { "x-active-company-id": String(societe) } : {}),
    },
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  let json; try { json = JSON.parse(texte); } catch { json = { brut: texte }; }
  return { statut: r.status, corps: json };
}

const TRIANGLE = 1, FATMAT = 2;
let SUPER = 0, FOFANA = 0, DIALLO = 0, AWA = 0;

async function poserLeJeu() {
  await pool.query(`DELETE FROM user_company_access_log WHERE reason LIKE 'ESSAI089%'`);
  await pool.query(`DELETE FROM user_company_access WHERE reason LIKE 'ESSAI089%'`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'rbac089-%@essai.test'`);

  const creer = async (email, nom, role, companyId, superAdmin = false) => (await pool.query(
    `INSERT INTO users (company_id, fullname, email, password, role, is_super_admin, is_active)
     VALUES ($1,$2,$3,'$non-utilisable$',$4,$5,true) RETURNING id`,
    [companyId, nom, email, role, superAdmin])).rows[0].id;

  SUPER  = await creer("rbac089-super@essai.test", "Essai 089 Super", "super_admin", TRIANGLE, true);
  /* Le comptable des deux sociétés, et le directeur des deux — les deux cas
     réels que la migration 079 devait rendre possibles. */
  FOFANA = await creer("rbac089-comptable@essai.test", "Essai 089 Comptable deux sociétés", "comptable", TRIANGLE);
  DIALLO = await creer("rbac089-directeur@essai.test", "Essai 089 Directeur deux sociétés", "direction", TRIANGLE);
  /* Le bureau, cantonné à Triangle : jamais habilité ailleurs. */
  AWA    = await creer("rbac089-bureau@essai.test", "Essai 089 Bureau Triangle", "employe", TRIANGLE);

  await pool.query(
    `DELETE FROM user_permission_overrides WHERE user_id = ANY($1::int[])`,
    [[FOFANA, DIALLO, AWA]]);
}

const droit = (companyId, userId, module, action, effet) => pool.query(
  `INSERT INTO user_permission_overrides (company_id, user_id, module_key, action, effect)
   VALUES ($1,$2,$3,$4,$5)
   ON CONFLICT (company_id, user_id, module_key, action) DO UPDATE SET effect = EXCLUDED.effect`,
  [companyId, userId, module, action, effet]);

async function main() {
  console.log(`\n${G}RBAC MULTI-SOCIÉTÉS — LA SOCIÉTÉ ACTIVE DÉCIDE${Z}`);
  await poserLeJeu();

  const tSuper = jeton(SUPER, "super_admin", TRIANGLE, true);
  const tFofana = jeton(FOFANA, "comptable", TRIANGLE);
  const tDiallo = jeton(DIALLO, "direction", TRIANGLE);
  const tAwa = jeton(AWA, "employe", TRIANGLE);

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}HABILITER LES DEUX COMPTES SUR FAT & MAT${Z}`);
  {
    for (const [id, nom] of [[FOFANA, "comptable"], [DIALLO, "directeur"]]) {
      const r = await appel("POST", "/acces-societes", tSuper,
        { user_id: id, company_id: FATMAT, reason: `ESSAI089 ${nom} des deux sociétés` });
      verifier(`le ${nom} est habilité sur FAT & MAT`, r.statut === 201, JSON.stringify(r.corps).slice(0, 120));
    }
    const mes = await appel("GET", "/acces-societes/mes-societes", tFofana);
    verifier("le comptable voit les deux sociétés",
      (mes.corps.societes || []).length === 2, JSON.stringify((mes.corps.societes || []).map((s) => s.id)));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}UN ALLOW ICI, UN DENY LÀ — DEUX VERDICTS DIFFÉRENTS${Z}`);
  {
    /* Le même compte, la même action, deux réponses : c'est exactement ce que
       l'ancien moteur ne savait pas faire. */
    await droit(TRIANGLE, FOFANA, "paie", "visible", "ALLOW");
    await droit(TRIANGLE, FOFANA, "paie", "view", "ALLOW");
    await droit(TRIANGLE, FOFANA, "paie", "prepare", "ALLOW");
    await droit(FATMAT,   FOFANA, "paie", "visible", "ALLOW");
    await droit(FATMAT,   FOFANA, "paie", "view", "ALLOW");
    await droit(FATMAT,   FOFANA, "paie", "prepare", "DENY");

    const chezTriangle = await appel("GET", "/permissions/me", tFofana, undefined, TRIANGLE);
    const chezFatmat   = await appel("GET", "/permissions/me", tFofana, undefined, FATMAT);

    verifier("les droits Triangle sont calculés pour Triangle",
      Number(chezTriangle.corps.company_id_effectif) === TRIANGLE,
      String(chezTriangle.corps.company_id_effectif));
    verifier("les droits FAT & MAT sont calculés pour FAT & MAT",
      Number(chezFatmat.corps.company_id_effectif) === FATMAT,
      String(chezFatmat.corps.company_id_effectif));

    verifier("préparer la paie est AUTORISÉ chez Triangle",
      chezTriangle.corps.permissions?.paie?.prepare === true,
      JSON.stringify(chezTriangle.corps.permissions?.paie));
    verifier("et REFUSÉ chez FAT & MAT, pour le même compte",
      chezFatmat.corps.permissions?.paie?.prepare === false,
      JSON.stringify(chezFatmat.corps.permissions?.paie));

    verifier("la société d'origine du compte n'a PAS été réécrite",
      Number(chezFatmat.corps.company_id) === TRIANGLE, String(chezFatmat.corps.company_id));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LE VERDICT DE L'API SUIT CELUI DES DROITS${Z}`);
  {
    /* Un droit affiché qui ne correspond pas à ce que la route fait vaut moins
       que rien : on éprouve donc la ROUTE, pas seulement /permissions/me. */
    await appel("POST", "/paie/periodes/2026-05/ouvrir", tSuper, undefined, TRIANGLE);
    await appel("POST", "/paie/periodes/2026-05/ouvrir", tSuper, undefined, FATMAT);

    const t = await appel("POST", "/paie/periodes/2026-05/preparer", tFofana, {}, TRIANGLE);
    verifier("chez Triangle, la route de préparation n'est pas refusée pour un motif de droit",
      t.statut !== 403 && t.corps.code !== "PERMISSION_DENIED", `${t.statut} ${t.corps.code || ""}`);

    const f = await appel("POST", "/paie/periodes/2026-05/preparer", tFofana, {}, FATMAT);
    verifier("chez FAT & MAT, elle est refusée par le droit",
      f.statut === 403 || f.statut === 404, `${f.statut} ${f.corps.code || ""}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}UNE EXCEPTION POSÉE D'UN CÔTÉ N'AFFECTE PAS L'AUTRE${Z}`);
  {
    await droit(FATMAT, DIALLO, "paie", "visible", "ALLOW");
    await droit(FATMAT, DIALLO, "paie", "view", "ALLOW");
    await droit(FATMAT, DIALLO, "paie", "validate", "ALLOW");
    await droit(TRIANGLE, DIALLO, "paie", "validate", "DENY");

    const chezTriangle = await appel("GET", "/permissions/me", tDiallo, undefined, TRIANGLE);
    const chezFatmat   = await appel("GET", "/permissions/me", tDiallo, undefined, FATMAT);
    verifier("le directeur valide chez FAT & MAT",
      chezFatmat.corps.permissions?.paie?.validate === true,
      JSON.stringify(chezFatmat.corps.permissions?.paie?.validate));
    verifier("et ne valide pas chez Triangle, où on le lui a refusé",
      chezTriangle.corps.permissions?.paie?.validate === false,
      JSON.stringify(chezTriangle.corps.permissions?.paie?.validate));

    /* On lève le refus côté Triangle : le directeur doit alors valider des
       deux côtés, ce qui est le cas réel visé. */
    await droit(TRIANGLE, DIALLO, "paie", "validate", "ALLOW");
    await droit(TRIANGLE, DIALLO, "paie", "visible", "ALLOW");
    const apres = await appel("GET", "/permissions/me", tDiallo, undefined, TRIANGLE);
    verifier("une fois accordé, il valide des DEUX côtés",
      apres.corps.permissions?.paie?.validate === true,
      JSON.stringify(apres.corps.permissions?.paie?.validate));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}UN EN-TÊTE DE SOCIÉTÉ NON AUTORISÉ EST REFUSÉ${Z}`);
  {
    /* Awa n'est habilitée nulle part : elle ne doit pas pouvoir désigner
       FAT & MAT, et surtout pas être servie en silence avec Triangle. */
    const r = await appel("GET", "/permissions/me", tAwa, undefined, FATMAT);
    verifier("l'en-tête falsifié est refusé, pas ignoré",
      r.statut === 403 && r.corps.code === "COMPANY_NOT_ALLOWED", JSON.stringify(r.corps));

    const inexistante = await appel("GET", "/permissions/me", tAwa, undefined, 999999);
    verifier("une société inexistante est refusée aussi",
      inexistante.statut === 403, `statut ${inexistante.statut}`);

    const sienne = await appel("GET", "/permissions/me", tAwa, undefined, TRIANGLE);
    verifier("mais sa propre société reste accessible", sienne.statut === 200, `statut ${sienne.statut}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}AWA NE LIT AUCUN SALAIRE, Y COMPRIS PAR L'API${Z}`);
  {
    const paie = await appel("GET", "/attendance-v2/payroll?month=2026-05", tAwa, undefined, TRIANGLE);
    verifier("la route de paie lui est refusée",
      paie.statut === 403 || paie.statut === 404, `statut ${paie.statut}`);

    const droits = await appel("GET", "/permissions/me", tAwa, undefined, TRIANGLE);
    verifier("et ses droits ne portent aucune permission de paie",
      droits.corps.permissions?.paie?.view !== true,
      JSON.stringify(droits.corps.permissions?.paie));

    const avances = await appel("GET", "/avances", tAwa, undefined, TRIANGLE);
    verifier("les avances sur salaire lui sont refusées",
      avances.statut === 403 || avances.statut === 404, `statut ${avances.statut}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}UNE RÉVOCATION FERME LA SOCIÉTÉ DÈS LA REQUÊTE SUIVANTE${Z}`);
  {
    const avant = await appel("GET", "/permissions/me", tFofana, undefined, FATMAT);
    verifier("le comptable atteint encore FAT & MAT", avant.statut === 200, `statut ${avant.statut}`);

    const r = await appel("DELETE", `/acces-societes/${FOFANA}/${FATMAT}`, tSuper,
      { reason: "ESSAI089 fin de mission" });
    verifier("l'accès est révoqué", r.statut === 200, JSON.stringify(r.corps));

    /* Le cache d'habilitations vit trente secondes ; la révocation passe par
       l'API, qui l'invalide. La requête suivante doit donc déjà être fermée. */
    const apres = await appel("GET", "/permissions/me", tFofana, undefined, FATMAT);
    verifier("FAT & MAT lui est immédiatement fermée",
      apres.statut === 403 && apres.corps.code === "COMPANY_NOT_ALLOWED", JSON.stringify(apres.corps));

    const sienne = await appel("GET", "/permissions/me", tFofana, undefined, TRIANGLE);
    verifier("sa propre société reste ouverte", sienne.statut === 200, `statut ${sienne.statut}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}AUCUN AUTRE TENANT N'EST ACCESSIBLE${Z}`);
  {
    const tAutreTenant = jeton(FOFANA, "comptable", TRIANGLE, false, "malilink");
    const r = await appel("GET", "/permissions/me", tAutreTenant);
    verifier("un jeton d'un autre tenant est refusé",
      r.statut === 403, `statut ${r.statut} ${JSON.stringify(r.corps).slice(0, 90)}`);
  }

  await pool.query(`DELETE FROM user_company_access_log WHERE reason LIKE 'ESSAI089%'`);
  await pool.query(`DELETE FROM user_company_access WHERE reason LIKE 'ESSAI089%'`);

  console.log(`\n${G}BILAN${Z}`);
  console.log(`  ${reussis} réussis, ${echoues} échoués\n`);
  await pool.end();
  process.exit(echoues > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`${R}ÉCHEC : ${e.message}${Z}`); console.error(e.stack);
  await pool.end().catch(() => {});
  process.exit(1);
});
