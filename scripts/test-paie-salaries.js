"use strict";

/**
 * TESTS — AJOUT ET RETRAIT D'UN SALARIÉ DEPUIS LA PAIE.
 *
 *   bash scripts/test-paie-salaries.sh
 *
 * Interroge le vrai serveur. Deux entreprises sont en jeu du début à la fin :
 * chaque écriture faite dans l'une est vérifiée comme n'ayant rien changé
 * dans l'autre.
 */

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const BASE = process.env.BASE_URL || "http://127.0.0.1:5050";
const SECRET = process.env.JWT_SECRET || "test-secret-paie";

let reussis = 0, echoues = 0;
const verifier = (nom, ok, detail = "") => {
  if (ok) { reussis += 1; console.log(`  ✓ ${nom}`); }
  else { echoues += 1; console.log(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`); }
};

const jeton = (u) => jwt.sign(
  { id: u.id, email: u.email, role: u.role, company_id: u.company_id, is_super_admin: !!u.is_super_admin },
  SECRET, { expiresIn: "1h" });

const TRIANGLE = 1, FATEMAT = 2;
let ADMIN_T, ADMIN_F, MAGASINIER, DIRECTION_T, SUPER;

async function appel(methode, chemin, token, corps, entetes = {}) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...entetes,
               ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(corps ? { body: JSON.stringify(corps) } : {}),
  });
  return { statut: r.status, corps: await r.json().catch(() => ({})) };
}

const compter = async (companyId) => Number((await pool.query(
  `SELECT COUNT(*)::int AS n FROM users WHERE company_id=$1`, [companyId])).rows[0].n);
const actifs = async (companyId) => Number((await pool.query(
  `SELECT COUNT(*)::int AS n FROM users WHERE company_id=$1 AND is_active IS NOT FALSE`,
  [companyId])).rows[0].n);

async function semer() {
  for (const t of ["payroll_items", "payroll_runs", "attendance_history", "attendance_records",
                   "attendance_settings", "users", "companies"]) {
    await pool.query(`DELETE FROM ${t}`).catch(() => {});
  }
  await pool.query(
    `INSERT INTO companies (id,name,status) VALUES (1,'Triangle','active'),(2,'Fatemat','active')`);
  await pool.query(`SELECT setval('companies_id_seq',2,true)`);
  await pool.query(
    `INSERT INTO users (id,fullname,email,password,role,company_id,is_super_admin,is_active) VALUES
       (1,'Admin Triangle','admin@triangle.test','x','admin',1,false,true),
       (2,'Magasinier','maga@triangle.test','x','magasinier',1,false,true),
       (3,'Admin Fatemat','admin@fatemat.test','x','admin',2,false,true),
       (4,'Salarie Fatemat','sf@fatemat.test','x','magasinier',2,false,true),
       (5,'Directrice Triangle','dir@triangle.test','x','direction',1,false,true),
       (6,'Super Admin','super@triangle.test','x','super_admin',1,true,true)`);
  await pool.query(`SELECT setval('users_id_seq',6,true)`);
  await pool.query(
    `INSERT INTO attendance_settings (user_id, salary_type, monthly_salary)
     VALUES (4,'mensuel',111111) ON CONFLICT (user_id) DO NOTHING`);
  ADMIN_T = jeton({ id: 1, email: "admin@triangle.test", role: "admin", company_id: 1 });
  MAGASINIER = jeton({ id: 2, email: "maga@triangle.test", role: "magasinier", company_id: 1 });
  ADMIN_F = jeton({ id: 3, email: "admin@fatemat.test", role: "admin", company_id: 2 });
  /* Seuls « direction » et « super_admin » voient et modifient les salaires
     (canViewAllSalaries) : c'est la règle existante, on ne la change pas. */
  DIRECTION_T = jeton({ id: 5, email: "dir@triangle.test", role: "direction", company_id: 1 });
  SUPER = jeton({ id: 6, email: "super@triangle.test", role: "super_admin", company_id: 1, is_super_admin: true });
}

async function main() {
  await semer();
  const tDepart = await compter(TRIANGLE), fDepart = await compter(FATEMAT);

  console.log("\n① TRIANGLE — AJOUTER UN SALARIÉ");
  let moussa;
  {
    /* On embauche depuis un compte qui a le droit de fixer un salaire : c'est
       le cas courant de l'écran de paie. */
    const r = await appel("POST", "/payroll/employees", SUPER, {
      nom: "Traoré", prenom: "Moussa", fonction: "Magasinier livreur",
      salaire_mensuel: 175000, telephone: "+223 70 00 00 00", date_entree: "2026-03-01",
    });
    verifier("le salarié est ajouté", r.statut === 201, JSON.stringify(r.corps).slice(0, 160));
    moussa = r.corps.employee;
    verifier("son nom complet est composé", moussa?.fullname === "Moussa Traoré", moussa?.fullname);
    verifier("il appartient à Triangle", Number(moussa?.company_id) === TRIANGLE);
    verifier("sa fonction est enregistrée", moussa?.job_title === "Magasinier livreur", moussa?.job_title);
    verifier("sa date d'entrée est enregistrée",
      String(moussa?.hire_date || "").startsWith("2026-03-01"), String(moussa?.hire_date));
    verifier("son téléphone est enregistré", moussa?.phone === "+223 70 00 00 00");
    verifier("son salaire mensuel est celui saisi", Number(moussa?.monthly_salary) === 175000);

    /* Ce n'est pas qu'une ligne d'écran : c'est bien un salarié en base. */
    const enBase = (await pool.query(
      `SELECT u.id, u.company_id, u.is_active, u.role, u.badge_code, s.monthly_salary, s.salary_type
         FROM users u LEFT JOIN attendance_settings s ON s.user_id=u.id WHERE u.id=$1`,
      [moussa.id])).rows[0];
    verifier("il existe réellement dans users", Boolean(enBase));
    verifier("il est actif", enBase.is_active === true);
    verifier("il porte un badge, comme tout salarié", Boolean(enBase.badge_code), enBase.badge_code);
    verifier("son salaire est dans attendance_settings, là où la paie le lit",
      Number(enBase.monthly_salary) === 175000 && enBase.salary_type === "mensuel",
      `${enBase.monthly_salary} / ${enBase.salary_type}`);
    verifier("son RÔLE applicatif reste le rôle par défaut, pas sa fonction",
      enBase.role === "magasinier", enBase.role);

    /* Il doit apparaître là où les salariés apparaissent. */
    const liste = await appel("GET", "/payroll/employees", ADMIN_T);
    verifier("il apparaît dans la liste de paie",
      (liste.corps.employees || []).some((e) => e.id === moussa.id));
    const users = await appel("GET", "/users", ADMIN_T);
    verifier("il apparaît aussi dans les utilisateurs de l'entreprise",
      (users.corps || []).some((e) => e.id === moussa.id));
    verifier("Fatemat n'a pas bougé", (await compter(FATEMAT)) === fDepart);
  }

  console.log("\n① bis — GARDE-FOUS DE L'AJOUT");
  {
    /* Un admin peut embaucher, mais pas fixer une rémunération : même règle
       que l'éditeur de salaire existant, pas de chemin détourné. */
    const parAdmin = await appel("POST", "/payroll/employees", ADMIN_T, {
      nom: "Diarra", prenom: "Fanta", salaire_mensuel: 999999,
    });
    verifier("un admin peut ajouter un salarié", parAdmin.statut === 201, `statut ${parAdmin.statut}`);
    verifier("mais il ne fixe PAS le salaire", parAdmin.corps.salaire_applique === false);
    verifier("et l'écran est prévenu", String(parAdmin.corps.message).includes("reste à fixer"));
    const pose = await pool.query(
      `SELECT monthly_salary FROM attendance_settings WHERE user_id=$1`, [parAdmin.corps.employee.id]);
    verifier("aucun montant n'a été posé en base", Number(pose.rows[0].monthly_salary) === 0,
      String(pose.rows[0].monthly_salary));

    const avantDoublon = await compter(TRIANGLE);
    const doublon = await appel("POST", "/payroll/employees", ADMIN_T, {
      nom: "TRAORE", prenom: "moussa", salaire_mensuel: 200000,
    });
    verifier("pas de seconde fiche pour la même personne",
      doublon.statut === 409 && doublon.corps.code === "EMPLOYEE_ALREADY_EXISTS",
      `statut ${doublon.statut}`);
    verifier("le refus nomme la fiche existante", doublon.corps.employee?.id === moussa.id);
    verifier("aucun compte n'a été créé", (await compter(TRIANGLE)) === avantDoublon);

    const avantRefus = await compter(TRIANGLE);
    const sansNom = await appel("POST", "/payroll/employees", ADMIN_T, { salaire_mensuel: 100 });
    verifier("un salarié sans nom est refusé", sansNom.statut === 400 && sansNom.corps.code === "MISSING_NAME");
    const negatif = await appel("POST", "/payroll/employees", ADMIN_T,
      { nom: "Test", prenom: "Salaire", salaire_mensuel: -5 });
    verifier("un salaire négatif est refusé", negatif.statut === 400 && negatif.corps.code === "INVALID_SALARY");
    const mauvaiseDate = await appel("POST", "/payroll/employees", ADMIN_T,
      { nom: "Test", prenom: "Date", salaire_mensuel: 100, date_entree: "01/03/2026" });
    verifier("une date mal formée est refusée", mauvaiseDate.statut === 400 && mauvaiseDate.corps.code === "INVALID_DATE");

    const sansDroit = await appel("POST", "/payroll/employees", MAGASINIER,
      { nom: "Tentative", prenom: "Sans", salaire_mensuel: 100 });
    verifier("un magasinier ne peut pas ajouter de salarié", sansDroit.statut === 403, `statut ${sansDroit.statut}`);
    verifier("aucun des refus n'a créé de compte", (await compter(TRIANGLE)) === avantRefus);
  }

  console.log("\n② TRIANGLE — RETIRER UN SALARIÉ");
  {
    /* On lui donne une paie close et des heures : elles doivent survivre. */
    const run = await pool.query(
      `INSERT INTO payroll_runs (company_id, payroll_number, status, net_amount)
       VALUES (1,'PAIE-2026-08','payée',175000) RETURNING id`);
    await pool.query(
      `INSERT INTO payroll_items (company_id, payroll_run_id, user_id, employee_name,
                                  gross_salary, net_salary, status)
       VALUES (1,$1,$2,'Moussa Traoré',175000,175000,'payé')`, [run.rows[0].id, moussa.id]);
    await pool.query(
      `INSERT INTO attendance_records (user_id, work_date, status) VALUES ($1, CURRENT_DATE, 'Présent')`,
      [moussa.id]).catch(() => {});

    const actifsAvant = await actifs(TRIANGLE);
    const r = await appel("DELETE", `/payroll/employees/${moussa.id}`, ADMIN_T, {});
    verifier("le retrait répond", r.statut === 200, JSON.stringify(r.corps).slice(0, 140));
    verifier("le message nomme le salarié", String(r.corps.message).includes("Moussa Traoré"), r.corps.message);
    verifier("il annonce que l'historique est conservé", r.corps.historique_conserve === true);

    const apres = (await pool.query(`SELECT id, is_active FROM users WHERE id=$1`, [moussa.id])).rows[0];
    verifier("LE COMPTE EXISTE TOUJOURS", Boolean(apres));
    verifier("il est désactivé, pas supprimé", apres.is_active === false);
    verifier("il sort des salariés actifs", (await actifs(TRIANGLE)) === actifsAvant - 1);

    const paie = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payroll_items WHERE user_id=$1`, [moussa.id]);
    verifier("SA PAIE CLOSE EST INTACTE", paie.rows[0].n === 1);
    const heures = await pool.query(
      `SELECT COUNT(*)::int AS n FROM attendance_records WHERE user_id=$1`, [moussa.id]);
    verifier("ses heures pointées sont intactes", heures.rows[0].n === 1);
    const salaire = await pool.query(
      `SELECT monthly_salary FROM attendance_settings WHERE user_id=$1`, [moussa.id]);
    verifier("sa fiche de salaire est intacte", Number(salaire.rows[0]?.monthly_salary) === 175000);
    verifier("Fatemat n'a toujours pas bougé", (await compter(FATEMAT)) === fDepart);

    const soi = await appel("DELETE", `/payroll/employees/1`, ADMIN_T, {});
    verifier("on ne peut pas se retirer soi-même", soi.statut === 400 && soi.corps.code === "CANNOT_REMOVE_SELF");
    const sansDroit = await appel("DELETE", `/payroll/employees/2`, MAGASINIER, {});
    verifier("un magasinier ne peut pas retirer un salarié", sansDroit.statut === 403);
  }

  console.log("\n③ FATEMAT — AJOUTER UN SALARIÉ");
  let awa;
  {
    const superF = jeton({ id: 3, email: "admin@fatemat.test", role: "super_admin",
                           company_id: 2, is_super_admin: true });
    const r = await appel("POST", "/payroll/employees", superF, {
      nom: "Coulibaly", prenom: "Awa", fonction: "Comptable", salaire_mensuel: 250000,
    });
    verifier("le salarié est ajouté chez Fatemat", r.statut === 201, JSON.stringify(r.corps).slice(0, 140));
    awa = r.corps.employee;
    verifier("il appartient à Fatemat", Number(awa?.company_id) === FATEMAT, String(awa?.company_id));
    verifier("son salaire est celui saisi", Number(awa?.monthly_salary) === 250000);

    const listeF = await appel("GET", "/payroll/employees", ADMIN_F);
    verifier("il apparaît dans la paie Fatemat",
      (listeF.corps.employees || []).some((e) => e.id === awa.id));
    verifier("la liste Fatemat ne contient QUE des salariés Fatemat",
      (listeF.corps.employees || []).length === fDepart + 1,
      `${(listeF.corps.employees || []).length} salarié(s)`);

    const listeT = await appel("GET", "/payroll/employees", ADMIN_T);
    verifier("il n'apparaît PAS dans la paie Triangle",
      !(listeT.corps.employees || []).some((e) => e.id === awa.id));
    verifier("Triangle compte toujours ses seuls salariés",
      (listeT.corps.employees || []).length === (await compter(TRIANGLE)),
      `${(listeT.corps.employees || []).length} servis / ${await compter(TRIANGLE)} en base`);

    /* Un homonyme est possible d'une entreprise à l'autre. */
    const homonyme = await appel("POST", "/payroll/employees", ADMIN_F, {
      nom: "Traoré", prenom: "Moussa", salaire_mensuel: 90000,
    });
    verifier("un homonyme d'une autre entreprise peut être embauché", homonyme.statut === 201,
      `statut ${homonyme.statut}`);
    verifier("il est bien chez Fatemat", Number(homonyme.corps.employee?.company_id) === FATEMAT);
  }

  console.log("\n④ FATEMAT — RETIRER UN SALARIÉ");
  {
    const avantTriangle = await actifs(TRIANGLE);
    const r = await appel("DELETE", `/payroll/employees/${awa.id}`, ADMIN_F, {});
    verifier("le retrait répond", r.statut === 200);
    const apres = (await pool.query(`SELECT is_active FROM users WHERE id=$1`, [awa.id])).rows[0];
    verifier("le compte Fatemat est désactivé, pas supprimé", apres.is_active === false);
    verifier("AUCUN SALARIÉ TRIANGLE N'A ÉTÉ TOUCHÉ", (await actifs(TRIANGLE)) === avantTriangle);
  }

  console.log("\n⑤ ISOLATION CROISÉE");
  {
    const t = (await pool.query(`SELECT id FROM users WHERE company_id=1 ORDER BY id`)).rows.map((r) => r.id);
    const f = (await pool.query(`SELECT id FROM users WHERE company_id=2 ORDER BY id`)).rows.map((r) => r.id);

    const intrusion = await appel("DELETE", `/payroll/employees/${f[0]}`, ADMIN_T, {});
    verifier("Triangle ne peut pas retirer un salarié Fatemat",
      intrusion.statut === 404 && intrusion.corps.code === "EMPLOYEE_NOT_FOUND", `statut ${intrusion.statut}`);
    const intactF = (await pool.query(`SELECT is_active FROM users WHERE id=$1`, [f[0]])).rows[0];
    verifier("le salarié Fatemat reste actif", intactF.is_active !== false);

    const inverse = await appel("DELETE", `/payroll/employees/${t[1]}`, ADMIN_F, {});
    verifier("Fatemat ne peut pas retirer un salarié Triangle", inverse.statut === 404);
    const intactT = (await pool.query(`SELECT is_active FROM users WHERE id=$1`, [t[1]])).rows[0];
    verifier("le salarié Triangle reste actif", intactT.is_active !== false);

    /* Un company_id glissé dans le corps ne doit rien déplacer. */
    const injection = await appel("POST", "/payroll/employees", ADMIN_T, {
      nom: "Injection", prenom: "Test", salaire_mensuel: 1000, company_id: FATEMAT,
    });
    verifier("un company_id dans le corps est ignoré", injection.statut === 201);
    verifier("le salarié est créé dans l'entreprise de SESSION",
      Number(injection.corps.employee?.company_id) === TRIANGLE,
      `company_id ${injection.corps.employee?.company_id}`);
  }

  console.log("\n⑥ LE SALAIRE, AVANT ET APRÈS");
  {
    /* Le droit de voir les salaires est distinct du droit d'administrer : un
       « admin » ajoute un salarié mais ne voit pas les rémunérations. */
    const vueAdmin = await appel("GET", "/payroll/employees", ADMIN_T);
    /* Chacun voit SON propre salaire : stripSalaryFields l'autorise. On juge
       donc sur les autres. */
    verifier("un admin sans droit salaire ne reçoit pas les montants d'autrui",
      vueAdmin.corps.peut_voir_les_salaires === false
      && (vueAdmin.corps.employees || [])
           .filter((e) => e.id !== 1)
           .every((e) => e.monthly_salary === undefined),
      JSON.stringify((vueAdmin.corps.employees || []).map((e) => [e.id, e.monthly_salary])).slice(0, 120));
    const vueDirection = await appel("GET", "/payroll/employees", DIRECTION_T);
    verifier("la direction, elle, les reçoit",
      vueDirection.corps.peut_voir_les_salaires === true
      && (vueDirection.corps.employees || []).some((e) => e.monthly_salary !== undefined));

    /* L'édition de salaire existante ne doit pas avoir bougé. */
    const cible = (await pool.query(
      `SELECT id FROM users WHERE company_id=1 AND fullname='Moussa Traoré'`)).rows[0];
    /* Seul un super admin peut réellement écrire un salaire : le garde de la
       route admet « admin », mais le drapeau d'écriture exige
       canViewAllSalaries. C'est l'état du code existant, inchangé ici. */
    const r = await appel("PUT", `/attendance/settings/users/${cible.id}`, SUPER, {
      salary_type: "mensuel", hourly_rate: 0, daily_rate: 0, monthly_salary: 190000,
    });
    verifier("l'édition de salaire existante fonctionne toujours", r.statut === 200,
      `statut ${r.statut} — ${JSON.stringify(r.corps).slice(0, 120)}`);
    const relu = await pool.query(
      `SELECT monthly_salary FROM attendance_settings WHERE user_id=$1`, [cible.id]);
    verifier("le nouveau salaire est enregistré", Number(relu.rows[0].monthly_salary) === 190000,
      String(relu.rows[0].monthly_salary));

    const liste = await appel("GET", "/payroll/employees", DIRECTION_T);
    const vu = (liste.corps.employees || []).find((e) => e.id === cible.id);
    verifier("la préparation de la paie affiche CE salaire",
      Number(vu?.monthly_salary) === 190000, String(vu?.monthly_salary));
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
