"use strict";
/**
 * SIMULATION DE SEPTEMBRE 2026 AVEC LES DÉCISIONS MÉTIER DÉFINITIVES.
 *
 * Tout passe par les vraies routes. Aucun net n'est écrit à la main : les
 * salaires se corrigent sur la fiche, l'exception d'absences porte sur la
 * période, le non-rémunéré est déclaré, les retenues d'avance existantes sont
 * affichées sans être recréées.
 *
 * Produit le tableau avant/après et le total. Ne paie rien.
 */
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const BASE = "http://localhost:5050";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const tS = jwt.sign({ id:900, fullname:"Super Triangle", role:"super_admin", company_id:1,
                      is_super_admin:true, tenant_id:"triangle" }, process.env.JWT_SECRET, { expiresIn:"1h" });
const q = async (s,p=[]) => (await pool.query(s,p)).rows;
async function appel(m, chemin, corps) {
  const r = await fetch(BASE + chemin, { method:m, headers:{ Authorization:"Bearer "+tS,
    "x-tenant-id":"triangle", "x-active-company-id":"1", "Content-Type":"application/json" },
    body: corps===undefined?undefined:JSON.stringify(corps) });
  return { status:r.status, data: await r.json().catch(()=>null) };
}
const fcfa = (n) => Number(n ?? 0).toLocaleString("fr-FR");
const empId = async (nom) => (await q(`SELECT id FROM attendance_employees WHERE full_name=$1 AND company_id=1`,[nom]))[0]?.id;
const tableau = async (titre) => {
  const rows = await q(
    `SELECT it.employee_name AS nom, it.monthly_salary AS salaire, it.absence_days AS abs,
            it.late_minutes AS retard, it.absence_deduction AS ret_abs,
            it.absence_deduction_annulee AS abs_non_retenue,
            it.advance_deduction AS avance, it.advance_deduction_externe AS av_hist,
            it.primes_total AS primes, it.heures_sup_total AS hsup,
            it.retenues_autres_total AS ret_autres, it.adjustments AS ajust,
            it.net_salary AS net, it.status AS statut, it.non_remunere AS non_rem,
            it.net_corrige_manuellement AS corrige
       FROM attendance_payroll_items_v2 it
       JOIN attendance_payroll_runs_v2 r ON r.id = it.payroll_run_id
      WHERE r.company_id = 1 AND to_char(r.period_month,'YYYY-MM') = '2026-09'
      ORDER BY it.employee_name`);
  console.log(`\n${titre}`);
  console.log("  " + "Nom".padEnd(20) + "Salaire".padStart(10) + "Abs".padStart(5) + "RetAbs".padStart(9)
    + "Avance".padStart(9) + "Primes".padStart(9) + "HSup".padStart(8) + "Net".padStart(10) + "  Statut");
  for (const r of rows) {
    console.log("  " + String(r.nom).padEnd(20) + fcfa(r.salaire).padStart(10)
      + String(r.abs).padStart(5) + fcfa(r.ret_abs).padStart(9) + fcfa(r.avance).padStart(9)
      + fcfa(r.primes).padStart(9) + fcfa(r.hsup).padStart(8) + fcfa(r.net).padStart(10)
      + "  " + r.statut + (r.non_rem ? " (non rémunéré)" : "") + (r.corrige ? " (net corrigé main)" : ""));
  }
  const t = rows.reduce((s,r)=>s+Number(r.net||0),0);
  console.log("  " + "".padEnd(20) + "".padStart(60) + ("TOTAL " + fcfa(t)).padStart(18));
  return { rows, total: t };
};

(async () => {
  console.log("══════ SIMULATION SEPTEMBRE 2026 — DÉCISIONS MÉTIER DÉFINITIVES ══════");

  console.log("\n── état de départ : préparation sur la configuration actuelle");
  let r = await appel("POST","/paie/periodes/2026-09/preparer",{});
  console.log("   préparation :", r.status);
  const avant = await tableau("AVANT (configuration actuelle, sans les décisions)");

  console.log("\n── DÉCISION 1 : Mohamedou Diallo, directeur non rémunéré volontairement");
  r = await appel("POST", `/paie/salaries/${await empId("Mohamedou Diallo")}/non-remunere`,
    { reason: "Directeur : ne percoit volontairement aucun salaire. Decision direction." });
  console.log("   ", r.status, r.data?.message?.slice(0,90));

  console.log("\n── DÉCISION 2 : Mohamed Sangaré, vrai salaire 50 000 (100 000 était incorrect)");
  r = await appel("PUT", `/attendance-v2/employees/${await empId("Mohamed Sangare")}/salary`,
    { monthly_salary: 50000, daily_rate: 1667, effective_from: "2026-08-25" });
  console.log("   ", r.status, r.data?.monthly_salary ?? JSON.stringify(r.data).slice(0,80));

  console.log("\n── DÉCISION 3 : Oumar Sangaré, vrai salaire 50 000");
  r = await appel("PUT", `/attendance-v2/employees/${await empId("Oumar Sangare")}/salary`,
    { monthly_salary: 50000, daily_rate: 1667, effective_from: "2026-08-25" });
  console.log("   ", r.status, r.data?.monthly_salary ?? "");

  console.log("\n── DÉCISION 4 : Hawa Diarra, vrai salaire 100 000 (75 000 était incorrect)");
  r = await appel("PUT", `/attendance-v2/employees/${await empId("Hawa Diarra")}/salary`,
    { monthly_salary: 100000, daily_rate: 3333, effective_from: "2026-08-25" });
  console.log("   ", r.status, r.data?.monthly_salary ?? "");

  console.log("\n── DÉCISION 5 : septembre 2026, aucune absence ni retard ne réduit le salaire");
  r = await appel("POST","/paie/periodes/2026-09/exception-absences",
    { actif: true, reason: "Regularisation exceptionnelle septembre 2026 — incidents du systeme de pointage — decision direction" });
  console.log("   ", r.status, r.data?.message?.slice(0,90));

  console.log("\n── RECALCUL");
  r = await appel("POST","/paie/periodes/2026-09/preparer",{});
  console.log("   préparation :", r.status);
  const apres = await tableau("APRÈS (décisions appliquées)");

  console.log("\n── IDEMPOTENCE : trois recalculs de plus");
  const soldes1 = await q(`SELECT id, balance FROM salary_advances ORDER BY id`);
  const rembours1 = Number((await q(`SELECT count(*) c FROM salary_advance_repayments`))[0].c);
  for (let i=0;i<3;i++) await appel("POST","/paie/periodes/2026-09/preparer",{});
  const soldes2 = await q(`SELECT id, balance FROM salary_advances ORDER BY id`);
  const rembours2 = Number((await q(`SELECT count(*) c FROM salary_advance_repayments`))[0].c);
  const apres2 = await tableau("APRÈS 4 RECALCULS (doit être identique)");
  console.log("\n  soldes d'avances inchangés      :", JSON.stringify(soldes1) === JSON.stringify(soldes2) ? "OUI" : "NON");
  console.log("  nombre de remboursements        :", rembours1, "->", rembours2, rembours1===rembours2 ? "(inchangé)" : "(⚠ CHANGÉ)");
  console.log("  total net identique             :", apres.total === apres2.total ? "OUI" : `NON (${apres.total} vs ${apres2.total})`);

  console.log("\n── CONTRÔLES DE SÉCURITÉ");
  const paid = Number((await q(`SELECT count(*) c FROM attendance_payroll_items_v2 WHERE status='PAID'`))[0].c);
  console.log("  lignes payées                   :", paid, paid===0?"(aucun paiement)":"(⚠)");
  const fat = await q(`SELECT it.employee_name, it.net_salary FROM attendance_payroll_items_v2 it
                        JOIN attendance_payroll_runs_v2 rr ON rr.id=it.payroll_run_id WHERE rr.company_id=2`);
  console.log("  lignes de paie FAT & MAT touchées:", fat.length === 0 ? "aucune" : JSON.stringify(fat));
  const dbl = await q(`SELECT installment_id FROM salary_advance_repayments WHERE origin='RETENUE_PAIE'
                        AND installment_id IS NOT NULL GROUP BY installment_id HAVING count(*)>1`);
  console.log("  échéances retenues deux fois    :", dbl.length === 0 ? "aucune" : JSON.stringify(dbl));
  const hist = await q(`SELECT count(*) c FROM salary_advance_repayments WHERE payroll_item_id IS NULL AND origin='RETENUE_PAIE'`);
  console.log("  remboursements historiques       :", hist[0].c, "(conservés, jamais recréés)");

  console.log("\n══════ TOTAL NET ATTENDU SEPTEMBRE 2026 :", fcfa(apres2.total), "FCFA ══════");
  await pool.end();
})();
