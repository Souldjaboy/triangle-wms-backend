"use strict";
/**
 * SEPTEMBRE 2026 — retrait de soumission, exception d'absences, override super admin.
 *
 * Tout passe par les vraies routes HTTP, contre le vrai serveur, sur une base
 * portant toutes les migrations. Aucun paiement n'est déclenché.
 */
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const BASE = "http://localhost:5050";
const SECRET = process.env.JWT_SECRET || "triangle_wms_secret_key";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let ok = 0, ko = 0;
const v = (n, c, d = "") => { if (c) { ok++; console.log(`  ✔ ${n}`); } else { ko++; console.log(`  ✘ ${n}${d ? `\n      → ${d}` : ""}`); } };
const jeton = (u) => jwt.sign({ ...u, tenant_id: "triangle" }, SECRET, { expiresIn: "1h" });
const q = async (s, p = []) => (await pool.query(s, p)).rows;
async function appel(m, chemin, { token, societe, corps } = {}) {
  const headers = { "x-tenant-id": "triangle" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (societe) headers["x-active-company-id"] = String(societe);
  if (corps !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(BASE + chemin, { method: m, headers, body: corps === undefined ? undefined : JSON.stringify(corps) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
const SUPER = { id: 900, fullname: "Super Triangle", role: "super_admin", company_id: 1, is_super_admin: true };
const COMPTA = { id: 903, fullname: "Comptable Triangle", role: "comptable", company_id: 1, is_super_admin: false };
const ligne = async (nom, periode = "2026-09") => (await q(
  `SELECT it.* FROM attendance_payroll_items_v2 it JOIN attendance_payroll_runs_v2 r ON r.id = it.payroll_run_id
    WHERE it.employee_name = $1 AND to_char(r.period_month,'YYYY-MM') = $2`, [nom, periode]))[0];
const run = async (periode = "2026-09") => (await q(
  `SELECT * FROM attendance_payroll_runs_v2 WHERE company_id=1 AND to_char(period_month,'YYYY-MM')=$1`, [periode]))[0];

(async () => {
  const tS = jeton(SUPER), tC = jeton(COMPTA);
  const MOTIF = "Régularisation exceptionnelle septembre 2026 — incidents du système de pointage — décision direction";

  console.log("\n① ÉTAT DE DÉPART : paie préparée puis soumise par le super admin");
  /* Le directeur ne perçoit volontairement aucun salaire. Sans cette
     déclaration sa ligne reste BLOCKED et la soumission refuse — ce qui est le
     comportement voulu : un salaire oublié doit bloquer la paie. On pose donc la
     décision métier d'abord, comme en production. */
  const directeur = (await q(`SELECT id FROM attendance_employees WHERE full_name='Mohamedou Diallo'`))[0]?.id;
  if (directeur) {
    await appel("POST", `/paie/salaries/${directeur}/non-remunere`, { token: tS, societe: 1, corps: {
      reason: "Directeur : ne percoit volontairement aucun salaire. Decision direction." }});
  }
  let r = await appel("POST", "/paie/periodes/2026-09/preparer", { token: tS, societe: 1, corps: {} });
  v("préparation", r.status === 200 || r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  const paie = await run();
  r = await appel("POST", `/paie/runs/${paie.id}/soumettre`, { token: tS, societe: 1, corps: {} });
  v("soumission", r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  v("la paie est EN_ATTENTE_DIRECTION", (await run()).status === "EN_ATTENTE_DIRECTION");

  console.log("\n② RETIRER LA SOUMISSION");
  r = await appel("POST", `/paie/runs/${paie.id}/retirer-soumission`, { token: tC, societe: 1, corps: {} });
  v("un autre utilisateur ne peut pas retirer la soumission d'autrui", r.status === 403, `${r.status} ${JSON.stringify(r.data)}`);
  r = await appel("POST", `/paie/runs/${paie.id}/retirer-soumission`, { token: tS, societe: 1, corps: { reason: "Paiement reporté à demain" } });
  v("l'auteur retire sa soumission", r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  v("la paie est revenue en DRAFT", (await run()).status === "DRAFT", (await run()).status);
  v("la période est revenue à PAIE_PREPAREE",
    (await q(`SELECT status FROM attendance_periods WHERE company_id=1 AND code='2026-09'`))[0]?.status === "PAIE_PREPAREE");
  const dem = await q(`SELECT status, decision_reason FROM payroll_requests WHERE payroll_run_id=$1 ORDER BY id DESC LIMIT 1`, [paie.id]);
  v("la demande est ANNULEE, pas supprimée", dem[0]?.status === "ANNULEE", JSON.stringify(dem[0]));
  v("le motif du retrait est tracé", String(dem[0]?.decision_reason||"").includes("retirée"), dem[0]?.decision_reason);
  v("aucun paiement enregistré",
    Number((await q(`SELECT count(*) c FROM attendance_payroll_items_v2 WHERE status='PAID'`))[0].c) === 0);

  console.log("\n③ ABSENCES AVANT EXCEPTION (état de référence)");
  const avant = {};
  for (const nom of ["Souleymane Diallo", "Hawa Diarra", "Malamine NDiaye", "Amary Zerbo", "Sans Avance"]) {
    const l = await ligne(nom); if (l) avant[nom] = { abs: Number(l.absence_days), ret: Number(l.absence_deduction), net: Number(l.net_salary) };
  }
  v("au moins un salarié a une retenue d'absence avant exception",
    Object.values(avant).some((x) => x.ret > 0), JSON.stringify(avant));

  console.log("\n④ POSER L'EXCEPTION D'ABSENCES SUR 2026-09");
  r = await appel("POST", "/paie/periodes/2026-09/exception-absences", { token: tC, societe: 1, corps: { reason: MOTIF } });
  v("un comptable ne peut pas poser l'exception", r.status === 403, `${r.status} ${JSON.stringify(r.data)}`);
  r = await appel("POST", "/paie/periodes/2026-09/exception-absences", { token: tS, societe: 1, corps: { reason: "court" } });
  v("un motif trop court est refusé (15 caractères exigés)", r.status === 400 && r.data?.code === "REASON_REQUIRED", `${r.status}`);
  r = await appel("POST", "/paie/periodes/2026-09/exception-absences", { token: tS, societe: 1, corps: { reason: MOTIF } });
  v("le super admin pose l'exception", r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  const per = (await q(`SELECT * FROM attendance_periods WHERE company_id=1 AND code='2026-09'`))[0];
  v("le drapeau est posé", per?.absences_non_retenues === true);
  v("le motif est enregistré", String(per?.absences_non_retenues_motif||"").includes("incidents du système"));
  v("l'auteur et la date sont enregistrés", Number(per?.absences_non_retenues_par) === 900 && Boolean(per?.absences_non_retenues_le));

  console.log("\n⑤ RECALCULER : aucune retenue d'absence, avances conservées");
  r = await appel("POST", "/paie/periodes/2026-09/preparer", { token: tS, societe: 1, corps: {} });
  v("nouvelle préparation", r.status === 200 || r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  let toutes = await q(`SELECT it.* FROM attendance_payroll_items_v2 it JOIN attendance_payroll_runs_v2 rr ON rr.id=it.payroll_run_id
                         WHERE rr.company_id=1 AND to_char(rr.period_month,'YYYY-MM')='2026-09' ORDER BY it.employee_name`);
  v("AUCUNE retenue d'absence sur toute la paie",
    toutes.every((l) => Number(l.absence_deduction) === 0),
    toutes.map((l)=>`${l.employee_name}:${l.absence_deduction}`).join(" "));
  v("les absences restent COMPTÉES et visibles",
    toutes.some((l) => Number(l.absence_days) > 0),
    toutes.map((l)=>`${l.employee_name}:${l.absence_days}j`).join(" "));
  v("ce que l'exception a coûté est chiffré",
    toutes.some((l) => Number(l.absence_deduction_annulee) > 0),
    toutes.map((l)=>`${l.employee_name}:${l.absence_deduction_annulee}`).join(" "));

  let l = await ligne("Souleymane Diallo");
  v("Diallo : salaire 150 000", Number(l?.monthly_salary) === 150000, `${l?.monthly_salary}`);
  v("Diallo : retenue absence 0", Number(l?.absence_deduction) === 0);
  v("Diallo : avance retenue 40 000", Number(l?.advance_deduction) === 40000, `${l?.advance_deduction}`);
  v("Diallo : net 110 000", Number(l?.net_salary) === 110000, `${l?.net_salary}`);

  console.log("\n⑥ AVANCES : rien n'est recréé");
  v("solde de Diallo inchangé (165 000)", Number((await q(`SELECT balance FROM salary_advances WHERE id=801`))[0]?.balance) === 165000);
  v("toujours 2 remboursements pour Diallo, aucun de plus",
    Number((await q(`SELECT count(*) c FROM salary_advance_repayments WHERE advance_id=801`))[0].c) === 2);
  v("aucune échéance en double",
    (await q(`SELECT advance_id, period_code FROM salary_advance_installments GROUP BY advance_id, period_code HAVING count(*)>1`)).length === 0);
  v("jamais plus d'une retenue par échéance",
    (await q(`SELECT installment_id FROM salary_advance_repayments WHERE origin='RETENUE_PAIE' AND installment_id IS NOT NULL
               GROUP BY installment_id HAVING count(*)>1`)).length === 0);
  l = await ligne("Malamine NDiaye");
  v("Malamine : échéancier cohérent, 15 000 retenus", Number(l?.advance_deduction) === 15000, `${l?.advance_deduction}`);
  l = await ligne("Amary Zerbo");
  v("Zerbo : retenue de 25 000 reprise du journal, non recréée", Number(l?.advance_deduction) === 25000, `${l?.advance_deduction}`);
  v("Zerbo : solde intact", Number((await q(`SELECT balance FROM salary_advances WHERE id=803`))[0]?.balance) === 25000);

  console.log("\n⑦ LA PÉRIODE SUIVANTE RESTE NORMALE");
  await pool.query(`INSERT INTO attendance_periods(id,company_id,code,date_debut,date_fin,status)
                    VALUES (7,1,'2026-10','2026-09-25','2026-10-24','POINTAGE_VALIDE') ON CONFLICT (id) DO NOTHING`);
  r = await appel("POST", "/paie/periodes/2026-10/preparer", { token: tS, societe: 1, corps: {} });
  v("octobre se prépare", r.status === 200 || r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  const oct = await q(`SELECT it.* FROM attendance_payroll_items_v2 it JOIN attendance_payroll_runs_v2 rr ON rr.id=it.payroll_run_id
                        WHERE rr.company_id=1 AND to_char(rr.period_month,'YYYY-MM')='2026-10'`);
  v("octobre n'a PAS l'exception",
    (await q(`SELECT absences_non_retenues a FROM attendance_periods WHERE company_id=1 AND code='2026-10'`))[0]?.a === false);
  v("octobre RETIENT ses absences normalement",
    oct.some((x) => Number(x.absence_deduction) > 0),
    oct.map((x)=>`${x.employee_name}:${x.absence_deduction}`).join(" "));
  v("septembre reste à 0 après le recalcul d'octobre",
    (await q(`SELECT it.absence_deduction d FROM attendance_payroll_items_v2 it JOIN attendance_payroll_runs_v2 rr ON rr.id=it.payroll_run_id
               WHERE rr.company_id=1 AND to_char(rr.period_month,'YYYY-MM')='2026-09'`)).every((x)=>Number(x.d)===0));

  console.log("\n⑧ OVERRIDE SUPER ADMIN — valider sa propre soumission");
  const paie9 = await run();
  r = await appel("POST", `/paie/runs/${paie9.id}/soumettre`, { token: tS, societe: 1, corps: {} });
  v("le super admin resoumet", r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  r = await appel("POST", `/paie/runs/${paie9.id}/decision`, { token: tS, societe: 1, corps: { decision: "VALIDEE" } });
  v("le super admin valide SA PROPRE soumission", r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  const d2 = (await q(`SELECT status, decision_reason FROM payroll_requests WHERE payroll_run_id=$1 ORDER BY id DESC LIMIT 1`, [paie9.id]))[0];
  v("l'auto-validation est tracée explicitement",
    String(d2?.decision_reason||"").includes("Auto-validation super administrateur"), d2?.decision_reason);
  v("la paie est AUTORISEE_AU_PAIEMENT, pas PAYÉE", (await run()).status === "AUTORISEE_AU_PAIEMENT", (await run()).status);
  v("aucune ligne n'est PAID",
    Number((await q(`SELECT count(*) c FROM attendance_payroll_items_v2 WHERE status='PAID'`))[0].c) === 0);

  console.log("\n⑨ UN UTILISATEUR ORDINAIRE NE CONTOURNE RIEN");
  await pool.query(`UPDATE attendance_payroll_runs_v2 SET status='DRAFT' WHERE id=$1`, [paie9.id]);
  await pool.query(`UPDATE payroll_requests SET status='ANNULEE' WHERE payroll_run_id=$1 AND status='EN_ATTENTE_DIRECTION'`, [paie9.id]);
  r = await appel("POST", `/paie/runs/${paie9.id}/soumettre`, { token: tC, societe: 1, corps: {} });
  v("le comptable soumet", r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  r = await appel("POST", `/paie/runs/${paie9.id}/decision`, { token: tC, societe: 1, corps: { decision: "VALIDEE" } });
  v("il ne peut PAS valider sa propre soumission",
    r.status === 403 && r.data?.code === "SELF_APPROVAL_FORBIDDEN", `${r.status} ${JSON.stringify(r.data)}`);
  const faux = jeton({ ...COMPTA, is_super_admin: true });
  r = await appel("POST", `/paie/runs/${paie9.id}/decision`, { token: faux, societe: 1, corps: { decision: "VALIDEE" } });
  v("un jeton prétendant is_super_admin ne suffit PAS (droit relu en base)",
    r.status === 403 && r.data?.code === "SELF_APPROVAL_FORBIDDEN", `${r.status} ${JSON.stringify(r.data)}`);

  console.log("\n⑩ AUCUNE AUTRE SOCIÉTÉ MODIFIÉE");
  v("FAT & MAT n'a pas d'exception d'absences",
    (await q(`SELECT count(*) c FROM attendance_periods WHERE company_id=2 AND absences_non_retenues`))[0].c === "0");
  v("aucune ligne de paie de FAT & MAT touchée par ces opérations",
    (await q(`SELECT it.id FROM attendance_payroll_items_v2 it JOIN attendance_payroll_runs_v2 rr ON rr.id=it.payroll_run_id
               WHERE rr.company_id=2 AND it.absence_deduction_annulee > 0`)).length === 0);

  console.log(`\n════════ ${ok} réussis, ${ko} échoués ════════`);
  await pool.end();
  process.exit(ko === 0 ? 0 : 1);
})().catch(async (e) => { console.error("ERREUR", e); await pool.end().catch(()=>{}); process.exit(1); });
