"use strict";
/**
 * PRIMES, HEURES SUPPLÉMENTAIRES, NON RÉMUNÉRÉ — et surtout : le recalcul.
 *
 * Le point à prouver est celui qui a coûté le plus cher : un élément de paie
 * doit SURVIVRE au recalcul, avec son motif et son auteur. C'est toute la
 * raison d'être de la table payroll_elements.
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
const ligne = async (nom) => (await q(
  `SELECT it.* FROM attendance_payroll_items_v2 it JOIN attendance_payroll_runs_v2 r ON r.id = it.payroll_run_id
    WHERE it.employee_name = $1 AND to_char(r.period_month,'YYYY-MM') = '2026-09'`, [nom]))[0];
const empId = async (nom) => (await q(`SELECT id FROM attendance_employees WHERE full_name = $1`, [nom]))[0]?.id;

(async () => {
  const tS = jeton(SUPER), tC = jeton(COMPTA);

  console.log("\n① LE CATALOGUE VIENT DE LA BASE");
  let r = await appel("GET", "/paie/elements/types", { token: tS, societe: 1 });
  v("réponse 200", r.status === 200, `${r.status}`);
  const types = (r.data?.types || []).map((t) => t.type_key);
  v("les 8 primes et la retenue sont servies", types.length === 9, types.join(", "));
  v("heures supplémentaires utilise une quantité",
    r.data.types.find((t) => t.type_key === "HEURES_SUP")?.uses_quantity === true);
  v("« autre prime » exige une description",
    r.data.types.find((t) => t.type_key === "PRIME_AUTRE")?.requires_label === true);
  v("la retenue porte un signe négatif",
    Number(r.data.types.find((t) => t.type_key === "RETENUE_AUTRE")?.sign) === -1);

  console.log("\n② HEURES SUPPLÉMENTAIRES : 8 h × 1 500 = 12 000, calculé par le serveur");
  const zerbo = await empId("Amary Zerbo");
  r = await appel("POST", "/paie/periodes/2026-09/elements", { token: tS, societe: 1, corps: {
    employee_id: zerbo, type_key: "HEURES_SUP", quantity: 8, unit_amount: 1500,
    reason: "Inventaire de fin de periode, samedi 19/09" }});
  v("réponse 201", r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  v("montant calculé = 12 000", Number(r.data?.element?.amount) === 12000, `${r.data?.element?.amount}`);
  v("la quantité et le taux sont conservés",
    Number(r.data?.element?.quantity) === 8 && Number(r.data?.element?.unit_amount) === 1500);

  console.log("\n③ GARDE-FOUS DE LA SAISIE");
  r = await appel("POST", "/paie/periodes/2026-09/elements", { token: tS, societe: 1, corps: {
    employee_id: zerbo, type_key: "HEURES_SUP", quantity: 0, unit_amount: 1500, reason: "test invalide" }});
  v("zéro heure refusé", r.status === 400 && r.data?.code === "QUANTITY_REQUIRED", `${r.status} ${JSON.stringify(r.data)}`);
  r = await appel("POST", "/paie/periodes/2026-09/elements", { token: tS, societe: 1, corps: {
    employee_id: zerbo, type_key: "PRIME_AUTRE", amount: 5000, reason: "prime diverse" }});
  v("« autre prime » sans description refusée", r.status === 400 && r.data?.code === "LABEL_REQUIRED", `${r.status}`);
  r = await appel("POST", "/paie/periodes/2026-09/elements", { token: tS, societe: 1, corps: {
    employee_id: zerbo, type_key: "PRIME_MERITE", amount: 5000, reason: "ok" }});
  v("motif trop court refusé", r.status === 400 && r.data?.code === "REASON_REQUIRED", `${r.status}`);
  r = await appel("POST", "/paie/periodes/2026-09/elements", { token: tS, societe: 1, corps: {
    employee_id: zerbo, type_key: "TYPE_INEXISTANT", amount: 5000, reason: "motif valable" }});
  v("type inconnu refusé", r.status === 400 && r.data?.code === "TYPE_UNKNOWN", `${r.status}`);
  const fatemat = await empId("Salarie Fatemat");
  r = await appel("POST", "/paie/periodes/2026-09/elements", { token: tS, societe: 1, corps: {
    employee_id: fatemat, type_key: "PRIME_MERITE", amount: 5000, reason: "tentative inter-societe" }});
  v("un salarié d'une AUTRE société est refusé",
    r.status === 400 && r.data?.code === "EMPLOYEE_NOT_IN_COMPANY", `${r.status} ${JSON.stringify(r.data)}`);

  console.log("\n④ PRIME DE MÉRITE + RETENUE AUTORISÉE");
  r = await appel("POST", "/paie/periodes/2026-09/elements", { token: tS, societe: 1, corps: {
    employee_id: zerbo, type_key: "PRIME_MERITE", amount: 20000,
    reason: "Objectifs de la periode depasses" }});
  v("prime de mérite enregistrée", r.status === 201 && Number(r.data?.element?.amount) === 20000, `${r.status}`);
  r = await appel("POST", "/paie/periodes/2026-09/elements", { token: tS, societe: 1, corps: {
    employee_id: zerbo, type_key: "RETENUE_AUTRE", amount: 3000, label: "Casse de materiel",
    reason: "Bris d une palette signale le 12/09" }});
  v("retenue autorisée enregistrée", r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);

  console.log("\n⑤ LA FORMULE EST EXPLICABLE");
  r = await appel("POST", "/paie/periodes/2026-09/preparer", { token: tS, societe: 1, corps: {} });
  v("préparation", r.status === 200 || r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  let l = await ligne("Amary Zerbo");
  v("salaire de base 100 000", Number(l?.monthly_salary) === 100000, `${l?.monthly_salary}`);
  v("primes = 20 000", Number(l?.primes_total) === 20000, `${l?.primes_total}`);
  v("heures supplémentaires = 12 000", Number(l?.heures_sup_total) === 12000, `${l?.heures_sup_total}`);
  v("heures = 8", Number(l?.heures_sup_heures) === 8, `${l?.heures_sup_heures}`);
  v("autres retenues = 3 000", Number(l?.retenues_autres_total) === 3000, `${l?.retenues_autres_total}`);
  v("net = 100 000 + 20 000 + 12 000 − 3 000 − 25 000 (avance) = 104 000",
    Number(l?.net_salary) === 104000, `${l?.net_salary}`);

  console.log("\n⑥ ⚠ LE POINT CENTRAL : LES ÉLÉMENTS SURVIVENT AU RECALCUL");
  const avantElements = await q(`SELECT id, amount, reason, created_by_name FROM payroll_elements ORDER BY id`);
  for (let i = 0; i < 3; i++) {
    r = await appel("POST", "/paie/periodes/2026-09/preparer", { token: tS, societe: 1, corps: {} });
    if (r.status !== 200 && r.status !== 201) { v(`recalcul ${i + 2}`, false, `${r.status}`); break; }
  }
  const apresElements = await q(`SELECT id, amount, reason, created_by_name FROM payroll_elements ORDER BY id`);
  v("aucun élément perdu après 4 préparations",
    JSON.stringify(avantElements) === JSON.stringify(apresElements),
    `avant ${avantElements.length} après ${apresElements.length}`);
  v("les motifs sont intacts", apresElements.every((e) => String(e.reason || "").length >= 5));
  v("les auteurs sont intacts", apresElements.every((e) => e.created_by_name === "Super Triangle"));
  l = await ligne("Amary Zerbo");
  v("net toujours 104 000, jamais doublé", Number(l?.net_salary) === 104000, `${l?.net_salary}`);
  v("primes toujours 20 000, jamais 80 000", Number(l?.primes_total) === 20000, `${l?.primes_total}`);
  v("heures sup toujours 12 000", Number(l?.heures_sup_total) === 12000, `${l?.heures_sup_total}`);
  v("aucun élément en double", Number((await q(`SELECT count(*) c FROM payroll_elements WHERE status='ACTIF'`))[0].c) === 3);

  console.log("\n⑦ ANNULER UN ÉLÉMENT — sans l'effacer");
  const prime = apresElements.find((e) => Number(e.amount) === 20000);
  r = await appel("POST", `/paie/elements/${prime.id}/annuler`, { token: tS, societe: 1, corps: {} });
  v("annulation sans motif refusée", r.status === 400 && r.data?.code === "REASON_REQUIRED", `${r.status}`);
  r = await appel("POST", `/paie/elements/${prime.id}/annuler`, { token: tS, societe: 1, corps: {
    reason: "Objectifs finalement non atteints, decision direction" }});
  v("annulation acceptée", r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  const annule = (await q(`SELECT * FROM payroll_elements WHERE id=$1`, [prime.id]))[0];
  v("la ligne EXISTE toujours", Boolean(annule));
  v("statut ANNULE", annule?.status === "ANNULE");
  v("motif d'annulation et auteur conservés",
    String(annule?.cancel_reason || "").includes("non atteints") && annule?.cancelled_by_name === "Super Triangle");
  await appel("POST", "/paie/periodes/2026-09/preparer", { token: tS, societe: 1, corps: {} });
  l = await ligne("Amary Zerbo");
  v("après recalcul : primes = 0, net = 84 000",
    Number(l?.primes_total) === 0 && Number(l?.net_salary) === 84000,
    `primes=${l?.primes_total} net=${l?.net_salary}`);

  console.log("\n⑧ NON RÉMUNÉRÉ VOLONTAIREMENT — A ne devient jamais B tout seul");
  const mohamedou = await empId("Mohamedou Diallo");
  l = await ligne("Mohamedou Diallo");
  v("sans salaire ET sans drapeau : ligne BLOCKED (anomalie visible)",
    l?.status === "BLOCKED" && l?.net_salary === null, `statut=${l?.status} net=${l?.net_salary}`);
  r = await appel("POST", `/paie/salaries/${mohamedou}/non-remunere`, { token: tC, societe: 1, corps: {
    reason: "Directeur non remunere volontairement" }});
  v("un comptable ne peut pas le déclarer", r.status === 403, `${r.status} ${JSON.stringify(r.data)}`);
  r = await appel("POST", `/paie/salaries/${mohamedou}/non-remunere`, { token: tS, societe: 1, corps: { reason: "court" }});
  v("motif trop court refusé", r.status === 400 && r.data?.code === "REASON_REQUIRED", `${r.status}`);
  r = await appel("POST", `/paie/salaries/${mohamedou}/non-remunere`, { token: tS, societe: 1, corps: {
    reason: "Directeur : ne percoit volontairement aucun salaire, decision direction" }});
  v("le super admin le déclare", r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  const fiche = (await q(`SELECT * FROM attendance_employees WHERE id=$1`, [mohamedou]))[0];
  v("drapeau posé, motif, auteur et date enregistrés",
    fiche?.non_remunere === true && String(fiche?.non_remunere_motif).includes("volontairement")
    && Number(fiche?.non_remunere_par) === 900 && Boolean(fiche?.non_remunere_le));
  r = await appel("POST", "/paie/periodes/2026-09/preparer", { token: tS, societe: 1, corps: {} });
  v("la préparation aboutit", r.status === 200 || r.status === 201, `${r.status}`);
  l = await ligne("Mohamedou Diallo");
  v("sa ligne est payable à 0 FCFA, plus BLOCKED",
    l?.status === "TO_PAY" && Number(l?.net_salary) === 0, `statut=${l?.status} net=${l?.net_salary}`);
  v("la ligne dit qu'il est non rémunéré", l?.non_remunere === true);
  v("aucune ligne BLOCKED ne subsiste : la soumission n'est plus bloquée",
    Number((await q(`SELECT count(*) c FROM attendance_payroll_items_v2 it
                      JOIN attendance_payroll_runs_v2 rr ON rr.id=it.payroll_run_id
                     WHERE rr.company_id=1 AND it.status='BLOCKED'`))[0].c) === 0);

  console.log("\n⑨ CORRECTION MANUELLE DU NET — durcie, marquée, avertie");
  l = await ligne("Sans Avance");
  r = await appel("POST", `/paie/lignes/${l.id}/ajuster`, { token: tS, societe: 1, corps: {
    net_salary: 80000, reason: "trop court" }});
  v("motif court refusé (15 caractères désormais)", r.status === 400, `${r.status} ${JSON.stringify(r.data)}`);
  r = await appel("POST", `/paie/lignes/${l.id}/ajuster`, { token: tS, societe: 1, corps: {
    net_salary: 80000, reason: "Correction exceptionnelle validee par la direction" }});
  v("correction acceptée", r.status === 200, `${r.status}`);
  v("la réponse AVERTIT qu'elle ne survivra pas au recalcul",
    r.data?.avertissement === "NON_DURABLE" && String(r.data?.message).includes("NE SURVIT PAS"));
  l = await ligne("Sans Avance");
  v("la ligne est marquée corrigée à la main", l?.net_corrige_manuellement === true);
  v("le journal d'activité en garde la trace",
    (await q(`SELECT 1 FROM user_activities WHERE action='Correction manuelle d''un net de paie'`)).length >= 1);

  console.log("\n⑩ AUCUNE AUTRE SOCIÉTÉ TOUCHÉE");
  v("aucun élément de paie sur FAT & MAT",
    Number((await q(`SELECT count(*) c FROM payroll_elements WHERE company_id=2`))[0].c) === 0);
  v("aucun salarié FAT & MAT déclaré non rémunéré",
    Number((await q(`SELECT count(*) c FROM attendance_employees WHERE company_id=2 AND non_remunere`))[0].c) === 0);

  console.log("\n⑪ AVANCES : AUCUN REMBOURSEMENT DOUBLÉ après tous ces recalculs");
  v("solde de Diallo toujours 165 000",
    Number((await q(`SELECT balance FROM salary_advances WHERE id=801`))[0]?.balance) === 165000);
  v("toujours exactement 2 remboursements pour Diallo",
    Number((await q(`SELECT count(*) c FROM salary_advance_repayments WHERE advance_id=801`))[0].c) === 2);
  v("jamais plus d'une retenue par échéance",
    (await q(`SELECT installment_id FROM salary_advance_repayments WHERE origin='RETENUE_PAIE'
               AND installment_id IS NOT NULL GROUP BY installment_id HAVING count(*)>1`)).length === 0);
  v("aucune ligne PAID : rien n'a été payé",
    Number((await q(`SELECT count(*) c FROM attendance_payroll_items_v2 WHERE status='PAID'`))[0].c) === 0);

  console.log(`\n════════ ${ok} réussis, ${ko} échoués ════════`);
  await pool.end();
  process.exit(ko === 0 ? 0 : 1);
})().catch(async (e) => { console.error("ERREUR", e); await pool.end().catch(()=>{}); process.exit(1); });
