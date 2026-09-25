"use strict";
/**
 * LA RETENUE D'AVANCE SUR LA PAIE — tests contre le serveur réel.
 *
 * Reproduit la situation constatée en production : une avance historique dont
 * les remboursements ne désignent aucune ligne de paie. Avant correction, la
 * paie affichait un tiret et un net complet alors que le solde avait bien
 * baissé. On vérifie ici que la paie reflète le journal, sans jamais créer un
 * second remboursement.
 */
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const BASE = "http://localhost:5050";
const SECRET = process.env.JWT_SECRET || "triangle_wms_secret_key";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let ok = 0, ko = 0;
const v = (nom, cond, detail = "") => {
  if (cond) { ok++; console.log(`  ✔ ${nom}`); }
  else { ko++; console.log(`  ✘ ${nom}${detail ? `\n      → ${detail}` : ""}`); }
};
const jeton = (u) => jwt.sign({ ...u, tenant_id: "triangle" }, SECRET, { expiresIn: "1h" });
const q = async (s, p = []) => (await pool.query(s, p)).rows;

async function appel(methode, chemin, { token, societe, corps } = {}) {
  const headers = { "x-tenant-id": "triangle" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (societe) headers["x-active-company-id"] = String(societe);
  if (corps !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(BASE + chemin, { method: methode, headers,
    body: corps === undefined ? undefined : JSON.stringify(corps) });
  let data = null; try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data };
}

const T = { id: 900, fullname: "Super Triangle", role: "super_admin", company_id: 1, is_super_admin: true };
const F = { id: 901, fullname: "Super Fatemat", role: "super_admin", company_id: 2, is_super_admin: true };

const ligneDe = async (nom) => (await q(
  `SELECT it.* FROM attendance_payroll_items_v2 it
     JOIN attendance_payroll_runs_v2 r ON r.id = it.payroll_run_id
    WHERE it.employee_name = $1 AND to_char(r.period_month,'YYYY-MM') = '2026-09'`, [nom]))[0];

(async () => {
  const tT = jeton(T), tF = jeton(F);

  console.log("\n① PRÉPARATION DE LA PAIE DE SEPTEMBRE (Triangle)");
  let r = await appel("POST", "/paie/periodes/2026-09/preparer", { token: tT, societe: 1, corps: {} });
  v("la préparation aboutit", r.status === 200 || r.status === 201, `reçu ${r.status} ${JSON.stringify(r.data)}`);

  console.log("\n② DIALLO — retenue enregistrée hors paie, désormais reflétée");
  let l = await ligneDe("Souleymane Diallo");
  v("la ligne existe", Boolean(l));
  v("avance retenue = 40 000 (et non 0)", Number(l?.advance_deduction) === 40000, `reçu ${l?.advance_deduction}`);
  v("dont 40 000 identifiés comme enregistrés hors paie",
    Number(l?.advance_deduction_externe) === 40000, `reçu ${l?.advance_deduction_externe}`);
  /* L'invariant plutôt qu'un nombre : le net est le salaire, moins les
     absences retenues, plus les ajustements, moins l'avance. Un jeu d'essai qui
     change d'absences ne doit pas faire échouer un test sur les avances. */
  const netAttendu = (x) => Math.max(0, Number(x.monthly_salary) - Number(x.absence_deduction)
    + Number(x.adjustments) - Number(x.advance_deduction));
  v(`net = ${netAttendu(l)} (salaire − absences + ajustements − avance)`,
    Number(l?.net_salary) === netAttendu(l),
    `net=${l?.net_salary} salaire=${l?.monthly_salary} absence=${l?.absence_deduction} ajust=${l?.adjustments} avance=${l?.advance_deduction}`);
  let av = (await q(`SELECT balance, status FROM salary_advances WHERE id=801`))[0];
  v("solde de l'avance INCHANGÉ (165 000)", Number(av?.balance) === 165000, `reçu ${av?.balance}`);
  v("AUCUN remboursement créé pour Diallo",
    Number((await q(`SELECT count(*) c FROM salary_advance_repayments WHERE advance_id=801`))[0].c) === 2,
    "il doit rester exactement les 2 remboursements historiques");
  v("les remboursements historiques restent orphelins (non rattachés)",
    Number((await q(`SELECT count(*) c FROM salary_advance_repayments WHERE advance_id=801 AND payroll_item_id IS NOT NULL`))[0].c) === 0);
  v("l'échéance de septembre reste RETENUE",
    (await q(`SELECT status FROM salary_advance_installments WHERE id=802`))[0]?.status === "RETENUE");

  console.log("\n③ MALAMINE — échéance À VENIR : la paie la prélève normalement");
  l = await ligneDe("Malamine NDiaye");
  v("avance retenue = 15 000", Number(l?.advance_deduction) === 15000, `reçu ${l?.advance_deduction}`);
  v("part externe = 0", Number(l?.advance_deduction_externe) === 0, `reçu ${l?.advance_deduction_externe}`);
  v(`net = ${netAttendu(l)} (invariant)`, Number(l?.net_salary) === netAttendu(l),
    `net=${l?.net_salary} salaire=${l?.monthly_salary} absence=${l?.absence_deduction} avance=${l?.advance_deduction}`);
  av = (await q(`SELECT balance FROM salary_advances WHERE id=802`))[0];
  v("solde passé de 45 000 à 30 000", Number(av?.balance) === 30000, `reçu ${av?.balance}`);
  v("le remboursement créé EST rattaché à la ligne de paie",
    Number((await q(`SELECT count(*) c FROM salary_advance_repayments WHERE advance_id=802 AND payroll_item_id=$1`, [l.id]))[0].c) === 1);
  v("l'échéance de septembre est passée à RETENUE",
    (await q(`SELECT status FROM salary_advance_installments WHERE id=811`))[0]?.status === "RETENUE");

  console.log("\n④ ZERBO — échéance en octobre : rien ne doit être retenu en septembre");
  l = await ligneDe("Amary Zerbo");
  v("avance retenue = 0", Number(l?.advance_deduction) === 0, `reçu ${l?.advance_deduction}`);
  v("net = salaire moins absences, aucune avance déduite",
    Number(l?.net_salary) === netAttendu(l) && Number(l?.advance_deduction) === 0,
    `net=${l?.net_salary} attendu=${netAttendu(l)}`);
  v("solde intact (25 000)", Number((await q(`SELECT balance FROM salary_advances WHERE id=803`))[0]?.balance) === 25000);

  console.log("\n⑤ SANS AVANCE — la ligne reste intacte");
  l = await ligneDe("Sans Avance");
  v("avance retenue = 0", Number(l?.advance_deduction) === 0);
  v("net conforme à l'invariant", Number(l?.net_salary) === netAttendu(l), `net=${l?.net_salary} attendu=${netAttendu(l)}`);

  console.log("\n⑥ ANTI-DOUBLE-RETENUE — préparer deux fois de suite");
  const avantSoldes = await q(`SELECT id, balance FROM salary_advances ORDER BY id`);
  const avantRembours = Number((await q(`SELECT count(*) c FROM salary_advance_repayments`))[0].c);
  r = await appel("POST", "/paie/periodes/2026-09/preparer", { token: tT, societe: 1, corps: {} });
  v("la seconde préparation aboutit", r.status === 200 || r.status === 201, `reçu ${r.status}`);
  const apresSoldes = await q(`SELECT id, balance FROM salary_advances ORDER BY id`);
  v("aucun solde n'a bougé", JSON.stringify(avantSoldes) === JSON.stringify(apresSoldes),
    `${JSON.stringify(avantSoldes)} vs ${JSON.stringify(apresSoldes)}`);
  v("aucun remboursement supplémentaire",
    Number((await q(`SELECT count(*) c FROM salary_advance_repayments`))[0].c) === avantRembours,
    `avant ${avantRembours}`);
  l = await ligneDe("Souleymane Diallo");
  v("Diallo affiche toujours 40 000, pas 80 000", Number(l?.advance_deduction) === 40000, `reçu ${l?.advance_deduction}`);
  v("le net de Diallo respecte toujours l'invariant", Number(l?.net_salary) === netAttendu(l),
    `net=${l?.net_salary} attendu=${netAttendu(l)}`);
  l = await ligneDe("Malamine NDiaye");
  v("Malamine affiche toujours 15 000, pas 30 000", Number(l?.advance_deduction) === 15000, `reçu ${l?.advance_deduction}`);
  v("solde de Malamine toujours 30 000, pas 15 000",
    Number((await q(`SELECT balance FROM salary_advances WHERE id=802`))[0]?.balance) === 30000);
  v("jamais plus d'un remboursement par échéance",
    (await q(`SELECT installment_id FROM salary_advance_repayments WHERE origin='RETENUE_PAIE'
               GROUP BY installment_id HAVING count(*) > 1`)).length === 0);
  v("jamais retenu au-delà du dû sur une échéance",
    (await q(`SELECT i.id FROM salary_advance_installments i
                JOIN salary_advance_repayments rp ON rp.installment_id = i.id AND rp.origin='RETENUE_PAIE'
               GROUP BY i.id, i.amount_due HAVING sum(rp.amount) > i.amount_due`)).length === 0);

  console.log("\n⑦ ISOLATION — FAT & MAT préparée séparément");
  const soldeTriangleAvant = await q(`SELECT id, balance FROM salary_advances WHERE company_id=1 ORDER BY id`);
  r = await appel("POST", "/paie/periodes/2026-09/preparer", { token: tF, societe: 2, corps: {} });
  v("la préparation FAT & MAT aboutit", r.status === 200 || r.status === 201, `reçu ${r.status} ${JSON.stringify(r.data)}`);
  l = await ligneDe("Salarie Fatemat");
  v("FAT & MAT : avance retenue = 30 000", Number(l?.advance_deduction) === 30000, `reçu ${l?.advance_deduction}`);
  v("FAT & MAT : part externe = 30 000", Number(l?.advance_deduction_externe) === 30000);
  v("FAT & MAT : net conforme à l'invariant", Number(l?.net_salary) === netAttendu(l), `net=${l?.net_salary} attendu=${netAttendu(l)}`);
  v("les soldes de Triangle n'ont pas bougé",
    JSON.stringify(await q(`SELECT id, balance FROM salary_advances WHERE company_id=1 ORDER BY id`)) === JSON.stringify(soldeTriangleAvant));
  v("aucune ligne de paie Triangle dans la paie FAT & MAT",
    (await q(`SELECT it.id FROM attendance_payroll_items_v2 it
                JOIN attendance_payroll_runs_v2 rr ON rr.id = it.payroll_run_id
               WHERE rr.company_id = 2 AND it.employee_id IN (801,802,803,804)`)).length === 0);

  console.log("\n⑧ COHÉRENCE : la paie est bien la projection du journal");
  const ecarts = await q(
    `WITH journal AS (
       SELECT a.employee_id, sum(rp.amount) AS retenu
         FROM salary_advance_repayments rp
         JOIN salary_advances a ON a.id = rp.advance_id
         JOIN salary_advance_installments i ON i.id = rp.installment_id
        WHERE rp.origin='RETENUE_PAIE' AND i.period_code='2026-09'
        GROUP BY a.employee_id)
     SELECT it.employee_name, it.advance_deduction, COALESCE(j.retenu,0) AS journal
       FROM attendance_payroll_items_v2 it
       JOIN attendance_payroll_runs_v2 rr ON rr.id = it.payroll_run_id
       LEFT JOIN journal j ON j.employee_id = it.employee_id
      WHERE to_char(rr.period_month,'YYYY-MM')='2026-09'
        AND COALESCE(it.advance_deduction,0) <> COALESCE(j.retenu,0)`);
  v("aucun écart entre le journal et les lignes de paie", ecarts.length === 0,
    JSON.stringify(ecarts));

  console.log(`\n════════ ${ok} réussis, ${ko} échoués ════════`);
  await pool.end();
  process.exit(ko === 0 ? 0 : 1);
})().catch(async (e) => { console.error("ERREUR", e); await pool.end().catch(()=>{}); process.exit(1); });
