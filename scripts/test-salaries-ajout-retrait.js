"use strict";
/**
 * AJOUT ET RETRAIT D'UN SALARIÉ — tests contre le serveur réel.
 *
 * Rien n'est simulé : le serveur est celui de production, la base porte les
 * 107 migrations du snapshot, et les appels passent par HTTP comme ceux du
 * navigateur. Ce qui est vérifié n'est pas « la route répond 200 » mais
 * « la base dit ce que la réponse prétend » — et surtout, pour le retrait,
 * que RIEN n'a disparu.
 */
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const BASE = "http://localhost:5050";
const SECRET = process.env.JWT_SECRET || "triangle_wms_secret_key";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let reussis = 0, echoues = 0;
const ok = (nom, condition, detail = "") => {
  if (condition) { reussis++; console.log(`  ✔ ${nom}`); }
  else { echoues++; console.log(`  ✘ ${nom}${detail ? `\n      → ${detail}` : ""}`); }
};

const jeton = (u) => jwt.sign({
  id: u.id, fullname: u.fullname, role: u.role,
  company_id: u.company_id, is_super_admin: u.is_super_admin === true,
  tenant_id: "triangle",
}, SECRET, { expiresIn: "1h" });

async function appel(methode, chemin, { token, societe, corps } = {}) {
  const headers = { "x-tenant-id": "triangle" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (societe) headers["x-active-company-id"] = String(societe);
  if (corps !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(BASE + chemin, {
    method: methode, headers,
    body: corps === undefined ? undefined : JSON.stringify(corps),
  });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data };
}
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const SUPER_TRI = { id: 900, fullname: "Super Triangle", role: "super_admin", company_id: 1, is_super_admin: true };
const SUPER_FAT = { id: 901, fullname: "Super Fatemat", role: "super_admin", company_id: 2, is_super_admin: true };
const ADMIN_TRI = { id: 903, fullname: "Admin Simple", role: "admin", company_id: 1, is_super_admin: false };

(async () => {
  const tTri = jeton(SUPER_TRI), tFat = jeton(SUPER_FAT), tAdmin = jeton(ADMIN_TRI);

  /* ═══ ① TRIANGLE : AJOUTER UN SALARIÉ ═══ */
  console.log("\n① TRIANGLE — ajouter un salarié");
  let r = await appel("POST", "/attendance-v2/employees", { token: tTri, societe: 1, corps: {
    full_name: "Moussa Keita", job_title: "Magasinier", email: "moussa.keita@triangle.test",
    site_id: 1, schedule_id: 1, monthly_salary: 120000, daily_rate: 4000,
  }});
  ok("réponse 201", r.status === 201, `reçu ${r.status} ${JSON.stringify(r.data)}`);
  const idMoussa = r.data?.employee?.id;
  ok("fiche RH créée", Boolean(idMoussa));
  let l = await q(`SELECT e.*, u.email, u.role, u.is_active, u.company_id AS user_company, u.badge_code
                     FROM attendance_employees e LEFT JOIN users u ON u.id=e.user_id WHERE e.id=$1`, [idMoussa]);
  ok("rattachée à Triangle (company_id=1)", l[0]?.company_id === 1, `company_id=${l[0]?.company_id}`);
  ok("compte de connexion créé", Boolean(l[0]?.user_id));
  ok("compte dans Triangle aussi", l[0]?.user_company === 1);
  ok("rôle forcé à magasinier (pas le poste)", l[0]?.role === "magasinier", `rôle=${l[0]?.role}`);
  ok("badge attribué au compte", Boolean(l[0]?.badge_code), `badge=${l[0]?.badge_code}`);
  ok("site et horaire renseignés", l[0]?.site_id === 1 && l[0]?.schedule_id === 1);
  ok("actif à la création", l[0]?.active === true);
  let s = await q(`SELECT * FROM attendance_salary_settings_v2 WHERE employee_id=$1`, [idMoussa]);
  ok("salaire initial dans attendance_salary_settings_v2", s.length === 1);
  ok("salaire mensuel = 120000", Number(s[0]?.monthly_salary) === 120000);
  ok("effective_from = date d'entrée, pas une date en dur",
     String(s[0]?.effective_from).slice(0,10) === String(l[0]?.effective_from).slice(0,10),
     `salaire=${s[0]?.effective_from} entrée=${l[0]?.effective_from}`);
  ok("visible par la liste (JOIN site+horaire)",
     (await q(`SELECT 1 FROM attendance_employees e
                 JOIN attendance_work_sites st ON st.id=e.site_id AND st.company_id=e.company_id
                 JOIN attendance_work_schedules w ON w.id=e.schedule_id AND w.company_id=e.company_id
                WHERE e.id=$1 AND e.active=true`, [idMoussa])).length === 1);

  /* ═══ ①b rattacher un compte EXISTANT, sans en créer un second ═══ */
  console.log("\n①b TRIANGLE — rattacher un compte existant");
  const avantComptes = Number((await q(`SELECT count(*) c FROM users`))[0].c);
  r = await appel("POST", "/attendance-v2/employees", { token: tTri, societe: 1, corps: {
    full_name: "Compte A Rattacher", site_id: 1, schedule_id: 1, user_id: 904,
  }});
  ok("compte d'une AUTRE société refusé (904 est FAT & MAT)", r.status === 400, `reçu ${r.status}`);
  ok("code USER_NOT_IN_COMPANY", r.data?.code === "USER_NOT_IN_COMPANY", JSON.stringify(r.data));
  ok("aucun compte créé au passage", Number((await q(`SELECT count(*) c FROM users`))[0].c) === avantComptes);

  /* ═══ ①c les garde-fous ═══ */
  console.log("\n①c TRIANGLE — garde-fous de l'ajout");
  r = await appel("POST", "/attendance-v2/employees", { token: tAdmin, societe: 1, corps: {
    full_name: "Tentative Admin", site_id: 1, schedule_id: 1 }});
  ok("un admin non super-admin est refusé (403)", r.status === 403, `reçu ${r.status}`);
  r = await appel("POST", "/attendance-v2/employees", { token: tTri, societe: 1, corps: {
    full_name: "Sans Affectation" }});
  ok("site et horaire obligatoires (400)", r.status === 400 && r.data?.code === "SITE_AND_SCHEDULE_REQUIRED", JSON.stringify(r.data));
  r = await appel("POST", "/attendance-v2/employees", { token: tTri, societe: 1, corps: {
    full_name: "Site Etranger", site_id: 2, schedule_id: 1 }});
  ok("site de FAT & MAT refusé pour Triangle (400)", r.status === 400 && r.data?.code === "SITE_OR_SCHEDULE_NOT_IN_COMPANY", JSON.stringify(r.data));
  r = await appel("POST", "/attendance-v2/employees", { token: tTri, societe: 1, corps: {
    full_name: "Email Deja Pris", site_id: 1, schedule_id: 1, email: "moussa.keita@triangle.test" }});
  ok("email déjà utilisé refusé (409)", r.status === 409 && r.data?.code === "EMAIL_TAKEN", JSON.stringify(r.data));
  r = await appel("POST", "/attendance-v2/employees", { token: tTri, societe: 1, corps: {
    full_name: "Doublon Fiche", site_id: 1, schedule_id: 1, user_id: 902 }});
  ok("compte déjà salarié refusé (409)", r.status === 409 && r.data?.code === "EMPLOYEE_ALREADY_LINKED", JSON.stringify(r.data));
  ok("toujours une seule fiche pour le compte 902",
     Number((await q(`SELECT count(*) c FROM attendance_employees WHERE company_id=1 AND user_id=902`))[0].c) === 1);

  /* ═══ ② LE SALAIRE : PARTIEL, TOTAL, DATÉ OU NON ═══ */
  console.log("\n② modification de salaire");
  const aujourdHui = (await q("SELECT CURRENT_DATE::text AS j"))[0].j;
  const jour = (d) => String(d).slice(0, 10);
  const salaireA = async (date) => (await q(
    `SELECT monthly_salary, daily_rate FROM attendance_salary_settings_v2
      WHERE employee_id=$1 AND effective_from=$2`, [idMoussa, date]))[0];

  // ②a les deux montants, avec une date explicite
  r = await appel("PUT", `/attendance-v2/employees/${idMoussa}/salary`, { token: tTri, societe: 1, corps: {
    monthly_salary: 135000, daily_rate: 4500, effective_from: "2026-10-01" }});
  ok("②a les deux montants : 200", r.status === 200, `reçu ${r.status} ${JSON.stringify(r.data)}`);
  let v = await salaireA("2026-10-01");
  ok("②a mensuel = 135000", Number(v?.monthly_salary) === 135000, JSON.stringify(v));
  ok("②a journalier = 4500", Number(v?.daily_rate) === 4500, JSON.stringify(v));

  // ②b le mensuel SEUL : le journalier doit être repris, pas effacé
  r = await appel("PUT", `/attendance-v2/employees/${idMoussa}/salary`, { token: tTri, societe: 1, corps: {
    monthly_salary: 140000, effective_from: "2026-10-05" }});
  ok("②b mensuel seul : 200 (et non 400)", r.status === 200, `reçu ${r.status} ${JSON.stringify(r.data)}`);
  v = await salaireA("2026-10-05");
  ok("②b nouveau mensuel = 140000", Number(v?.monthly_salary) === 140000, JSON.stringify(v));
  ok("②b journalier REPRIS, pas effacé (4500)", Number(v?.daily_rate) === 4500, JSON.stringify(v));

  // ②c le journalier SEUL : le mensuel doit être repris
  r = await appel("PUT", `/attendance-v2/employees/${idMoussa}/salary`, { token: tTri, societe: 1, corps: {
    daily_rate: 5000, effective_from: "2026-10-10" }});
  ok("②c journalier seul : 200", r.status === 200, `reçu ${r.status} ${JSON.stringify(r.data)}`);
  v = await salaireA("2026-10-10");
  ok("②c nouveau journalier = 5000", Number(v?.daily_rate) === 5000, JSON.stringify(v));
  ok("②c mensuel REPRIS, pas effacé (140000)", Number(v?.monthly_salary) === 140000, JSON.stringify(v));

  // ②d AUCUNE date fournie : le serveur décide, c'est aujourd'hui
  r = await appel("PUT", `/attendance-v2/employees/${idMoussa}/salary`, { token: tTri, societe: 1, corps: {
    monthly_salary: 125000 }});
  ok("②d sans date d'effet : 200", r.status === 200, `reçu ${r.status} ${JSON.stringify(r.data)}`);
  ok("②d date d'effet = aujourd'hui (CURRENT_DATE serveur)",
     jour(r.data?.effective_from) === aujourdHui, `reçu ${jour(r.data?.effective_from)} attendu ${aujourdHui}`);
  ok("②d et surtout PAS la date en dur 2026-09-03", jour(r.data?.effective_from) !== "2026-09-03");
  v = await salaireA(aujourdHui);
  ok("②d journalier du jour repris (4000, celui de l'embauche)", Number(v?.daily_rate) === 4000, JSON.stringify(v));

  // ②e aucun des deux montants
  r = await appel("PUT", `/attendance-v2/employees/${idMoussa}/salary`, { token: tTri, societe: 1, corps: {
    effective_from: "2026-11-01" }});
  ok("②e aucun montant : 400", r.status === 400 && r.data?.code === "SALARY_FIELD_REQUIRED", JSON.stringify(r.data));

  // ②f date illisible : refusée, jamais remplacée en silence
  r = await appel("PUT", `/attendance-v2/employees/${idMoussa}/salary`, { token: tTri, societe: 1, corps: {
    monthly_salary: 1000, effective_from: "01/10/2026" }});
  ok("②f date illisible : 400", r.status === 400 && r.data?.code === "EFFECTIVE_FROM_INVALID", JSON.stringify(r.data));

  // ②g effacement EXPLICITE : dire null, c'est vouloir vider
  r = await appel("PUT", `/attendance-v2/employees/${idMoussa}/salary`, { token: tTri, societe: 1, corps: {
    daily_rate: null, effective_from: "2026-10-15" }});
  ok("②g effacement explicite : 200", r.status === 200, `reçu ${r.status}`);
  v = await salaireA("2026-10-15");
  ok("②g journalier vidé", v?.daily_rate === null, JSON.stringify(v));
  ok("②g mensuel conservé (140000)", Number(v?.monthly_salary) === 140000, JSON.stringify(v));

  // ②h l'historique : rien de ce qui précède n'a été réécrit
  const historique = await q(
    `SELECT effective_from::text AS d, monthly_salary, daily_rate FROM attendance_salary_settings_v2
      WHERE employee_id=$1 ORDER BY effective_from`, [idMoussa]);
  ok("②h 5 lignes datées dans l'historique", historique.length === 5,
     historique.map((x) => `${x.d}:${x.monthly_salary}/${x.daily_rate}`).join(" "));
  ok("②h la ligne du 2026-10-01 est intacte",
     Number(historique.find((x) => x.d === "2026-10-01")?.monthly_salary) === 135000
     && Number(historique.find((x) => x.d === "2026-10-01")?.daily_rate) === 4500);
  ok("②h la ligne du 2026-10-05 est intacte",
     Number(historique.find((x) => x.d === "2026-10-05")?.monthly_salary) === 140000);
  ok("②h aucune ligne n'a été supprimée", historique.length >= 5);

  // ②i réenregistrer à une date DÉJÀ présente corrige cette ligne, et elle seule
  r = await appel("PUT", `/attendance-v2/employees/${idMoussa}/salary`, { token: tTri, societe: 1, corps: {
    monthly_salary: 136000, effective_from: "2026-10-01" }});
  ok("②i correction d'une ligne existante : 200", r.status === 200, `reçu ${r.status}`);
  v = await salaireA("2026-10-01");
  ok("②i mensuel corrigé = 136000", Number(v?.monthly_salary) === 136000, JSON.stringify(v));
  ok("②i journalier de CETTE ligne conservé (4500)", Number(v?.daily_rate) === 4500, JSON.stringify(v));
  ok("②i toujours 5 lignes, aucune créée en double",
     (await q(`SELECT 1 FROM attendance_salary_settings_v2 WHERE employee_id=$1`, [idMoussa])).length === 5);

  /* ═══ ③ TRIANGLE : RETIRER LE SALARIÉ À HISTORIQUE COMPLET ═══ */
  console.log("\n③ TRIANGLE — retirer un salarié (historique complet)");
  const avant = (await q(`SELECT
      (SELECT count(*) FROM attendance_day_records_v2 WHERE employee_id=1) pointages,
      (SELECT count(*) FROM attendance_badges WHERE employee_id=1) badges,
      (SELECT count(*) FROM attendance_salary_settings_v2 WHERE employee_id=1) salaires,
      (SELECT count(*) FROM attendance_payroll_items_v2 WHERE employee_id=1) lignes,
      (SELECT count(*) FROM salary_advances WHERE employee_id=1) avances,
      (SELECT count(*) FROM salary_advance_installments i JOIN salary_advances a ON a.id=i.advance_id WHERE a.employee_id=1) echeances,
      (SELECT count(*) FROM salary_advance_repayments r JOIN salary_advances a ON a.id=r.advance_id WHERE a.employee_id=1) rembours,
      (SELECT balance FROM salary_advances WHERE id=1) solde`))[0];
  r = await appel("DELETE", "/attendance-v2/employees/1", { token: tTri, societe: 1, corps: { reason: "Fin de contrat" }});
  ok("réponse 200", r.status === 200, `reçu ${r.status} ${JSON.stringify(r.data)}`);
  l = await q(`SELECT * FROM attendance_employees WHERE id=1`);
  ok("la fiche RH EXISTE toujours (pas de suppression)", l.length === 1);
  ok("active = false", l[0]?.active === false);
  ok("effective_to renseignée", Boolean(l[0]?.effective_to), `effective_to=${l[0]?.effective_to}`);
  ok("effective_to >= effective_from", new Date(l[0]?.effective_to) >= new Date(l[0]?.effective_from));
  const u = await q(`SELECT is_active FROM users WHERE id=902`);
  ok("compte de connexion désactivé (pas supprimé)", u.length === 1 && u[0].is_active === false);
  const apres = (await q(`SELECT
      (SELECT count(*) FROM attendance_day_records_v2 WHERE employee_id=1) pointages,
      (SELECT count(*) FROM attendance_badges WHERE employee_id=1) badges,
      (SELECT count(*) FROM attendance_salary_settings_v2 WHERE employee_id=1) salaires,
      (SELECT count(*) FROM attendance_payroll_items_v2 WHERE employee_id=1) lignes,
      (SELECT count(*) FROM salary_advances WHERE employee_id=1) avances,
      (SELECT count(*) FROM salary_advance_installments i JOIN salary_advances a ON a.id=i.advance_id WHERE a.employee_id=1) echeances,
      (SELECT count(*) FROM salary_advance_repayments r JOIN salary_advances a ON a.id=r.advance_id WHERE a.employee_id=1) rembours,
      (SELECT balance FROM salary_advances WHERE id=1) solde`))[0];
  for (const cle of ["pointages","badges","salaires","lignes","avances","echeances","rembours"]) {
    ok(`${cle} conservés (${avant[cle]})`, String(avant[cle]) === String(apres[cle]), `avant=${avant[cle]} après=${apres[cle]}`);
  }
  ok(`solde d'avance intact (${avant.solde})`, String(avant.solde) === String(apres.solde));
  ok("paie close toujours au statut PAID",
     (await q(`SELECT status FROM attendance_payroll_items_v2 WHERE employee_id=1`))[0]?.status === "PAID");
  ok("la réponse annonce le solde restant dû", String(r.data?.message || "").includes("avance reste due"), r.data?.message);
  ok("le retrait est journalisé",
     Number((await q(`SELECT count(*) c FROM user_activities WHERE action='Retrait d''un salarié'`))[0].c) >= 1);
  ok("disparu de la liste active", (await q(`SELECT 1 FROM attendance_employees WHERE id=1 AND active=true`)).length === 0);

  /* ═══ ③b retrait idempotent et auto-retrait ═══ */
  console.log("\n③b TRIANGLE — retrait répété et auto-retrait");
  r = await appel("DELETE", "/attendance-v2/employees/1", { token: tTri, societe: 1 });
  ok("second retrait : signalé, pas une erreur", r.status === 200 && r.data?.deja_retire === true, JSON.stringify(r.data));
  const rSelf = await appel("POST", "/attendance-v2/employees", { token: tTri, societe: 1, corps: {
    full_name: "Super Triangle Fiche", site_id: 1, schedule_id: 1, user_id: 900 }});
  if (rSelf.status === 201) {
    r = await appel("DELETE", `/attendance-v2/employees/${rSelf.data.employee.id}`, { token: tTri, societe: 1 });
    ok("s'auto-retirer est refusé (409)", r.status === 409 && r.data?.code === "SELF_REMOVAL_FORBIDDEN", JSON.stringify(r.data));
  } else ok("fiche du super admin créée pour le test d'auto-retrait", false, JSON.stringify(rSelf.data));

  /* ═══ ④ FAT & MAT : ajouter puis retirer ═══ */
  console.log("\n④ FAT & MAT — ajouter puis retirer");
  r = await appel("POST", "/attendance-v2/employees", { token: tFat, societe: 2, corps: {
    full_name: "Aminata Traore", job_title: "Caissiere", phone: "76327799",
    site_id: 2, schedule_id: 2, monthly_salary: 110000 }});
  ok("ajout FAT & MAT : 201", r.status === 201, `reçu ${r.status} ${JSON.stringify(r.data)}`);
  const idAminata = r.data?.employee?.id;
  l = await q(`SELECT e.*, u.phone_normalise FROM attendance_employees e LEFT JOIN users u ON u.id=e.user_id WHERE e.id=$1`, [idAminata]);
  ok("rattachée à FAT & MAT (company_id=2)", l[0]?.company_id === 2, `company_id=${l[0]?.company_id}`);
  ok("compte créé avec le téléphone normalisé", l[0]?.phone_normalise === "+22376327799", `phone=${l[0]?.phone_normalise}`);
  ok("matricule propre à FAT & MAT (repart à 1)", Number(l[0]?.employee_number) === 1, `matricule=${l[0]?.employee_number}`);
  r = await appel("DELETE", `/attendance-v2/employees/${idAminata}`, { token: tFat, societe: 2, corps: { reason: "Départ volontaire" }});
  ok("retrait FAT & MAT : 200", r.status === 200, `reçu ${r.status}`);
  l = await q(`SELECT active, effective_to FROM attendance_employees WHERE id=$1`, [idAminata]);
  ok("désactivée, non supprimée", l.length === 1 && l[0].active === false && Boolean(l[0].effective_to));

  /* ═══ ⑤ ISOLATION MULTI-SOCIÉTÉ ═══ */
  console.log("\n⑤ isolation : aucune opération ne traverse la frontière");
  const etatFatAvant = await q(`SELECT id, active FROM attendance_employees WHERE company_id=2 ORDER BY id`);
  r = await appel("DELETE", `/attendance-v2/employees/${idMoussa}`, { token: tFat, societe: 2 });
  ok("FAT & MAT ne peut pas retirer un salarié Triangle (404)", r.status === 404 && r.data?.code === "EMPLOYEE_NOT_FOUND", JSON.stringify(r.data));
  l = await q(`SELECT active FROM attendance_employees WHERE id=$1`, [idMoussa]);
  ok("le salarié Triangle est resté actif", l[0]?.active === true);
  r = await appel("DELETE", `/attendance-v2/employees/${idAminata}`, { token: tTri, societe: 1 });
  ok("Triangle ne peut pas toucher un salarié FAT & MAT (404)", r.status === 404, `reçu ${r.status}`);
  const etatFatApres = await q(`SELECT id, active FROM attendance_employees WHERE company_id=2 ORDER BY id`);
  ok("effectif FAT & MAT inchangé par les tentatives Triangle",
     JSON.stringify(etatFatAvant) === JSON.stringify(etatFatApres));
  /* Les deux montants sont envoyés : la route existante valide les montants
     AVANT de regarder la société, et un seul champ suffirait à obtenir un 400
     qui ne prouverait rien sur l'isolation. */
  const salaireAvantTentative = JSON.stringify(await q(`SELECT effective_from::text AS d, monthly_salary, daily_rate
                                                          FROM attendance_salary_settings_v2 WHERE employee_id=$1
                                                         ORDER BY effective_from`, [idMoussa]));
  r = await appel("PUT", `/attendance-v2/employees/${idMoussa}/salary`, { token: tFat, societe: 2, corps: {
    monthly_salary: 1, daily_rate: 1 }});
  ok("FAT & MAT ne peut pas changer le salaire d'un Triangle (404)", r.status === 404, `reçu ${r.status} ${JSON.stringify(r.data)}`);
  ok("salaire Triangle inchangé",
     JSON.stringify(await q(`SELECT effective_from::text AS d, monthly_salary, daily_rate
                               FROM attendance_salary_settings_v2 WHERE employee_id=$1
                              ORDER BY effective_from`, [idMoussa])) === salaireAvantTentative);

  /* ═══ ⑥ AUCUN DOUBLON, AUCUNE IDENTITÉ PARALLÈLE ═══ */
  console.log("\n⑥ pas de doublon, pas de système parallèle");
  ok("aucun compte avec deux fiches RH dans la même société",
     (await q(`SELECT user_id FROM attendance_employees WHERE user_id IS NOT NULL
                GROUP BY company_id, user_id HAVING count(*) > 1`)).length === 0);
  ok("aucune fiche RH rattachée à un compte d'une autre société",
     (await q(`SELECT e.id FROM attendance_employees e JOIN users u ON u.id=e.user_id
                WHERE u.company_id IS DISTINCT FROM e.company_id`)).length === 0);
  ok("aucun matricule en double dans une société",
     (await q(`SELECT employee_number FROM attendance_employees
                GROUP BY company_id, employee_number HAVING count(*) > 1`)).length === 0);
  ok("aucune ligne écrite dans les tables legacy (attendance_settings intacte)",
     Number((await q(`SELECT count(*) c FROM attendance_settings`))[0].c) === 0,
     "le nouveau module n'alimente pas l'ancien moteur");

  console.log(`\n════════ ${reussis} réussis, ${echoues} échoués ════════`);
  await pool.end();
  process.exit(echoues === 0 ? 0 : 1);
})().catch(async (e) => { console.error("ERREUR", e); await pool.end().catch(()=>{}); process.exit(1); });
