"use strict";
/**
 * MISSION A — SEPTEMBRE 2026 : ZÉRO ABSENCE OFFICIELLE.
 *
 * La décision est administrative, pas technique : les pointages ne sont pas
 * touchés, aucune présence n'est affirmée, et le brut reste lisible à côté de
 * l'officiel. Ce que ces tests vérifient, c'est exactement cela — que le
 * rapport officiel et la paie disent tous deux zéro, et que la matière de
 * l'audit est intacte au octet près.
 *
 * Aucun salaire n'est payé.
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
const MOTIF = "Régularisation exceptionnelle septembre 2026 — incidents du système de pointage — décision direction";

const run = async (p = "2026-09") => (await q(
  `SELECT * FROM attendance_payroll_runs_v2 WHERE company_id=1 AND to_char(period_month,'YYYY-MM')=$1`, [p]))[0];
const ligne = async (nom, p = "2026-09") => (await q(
  `SELECT it.* FROM attendance_payroll_items_v2 it
     JOIN attendance_payroll_runs_v2 r ON r.id = it.payroll_run_id
    WHERE it.employee_name = $1 AND to_char(r.period_month,'YYYY-MM') = $2`, [nom, p]))[0];
/* L'EMPREINTE DES DONNÉES BRUTES. Si elle change, c'est qu'un pointage a été
   touché — et c'est précisément ce qui est interdit. */
const empreinte = async () => (await q(
  `SELECT count(*)::int AS lignes,
          COALESCE(md5(string_agg(
            employee_id || '|' || work_date || '|' || COALESCE(check_in::text,'-')
            || '|' || COALESCE(check_out::text,'-') || '|' || COALESCE(late_minutes::text,'-'),
            ',' ORDER BY employee_id, work_date)), 'vide') AS signature,
          (SELECT count(*)::int FROM attendance_regularizations WHERE company_id=1) AS regularisations
     FROM attendance_day_records_v2 WHERE company_id=1`))[0];
const rapport = async (token, p = "2026-09") =>
  (await appel("GET", `/pointage/rapports/global?periode=${p}`, { token, societe: 1 })).data;

(async () => {
  const tS = jeton(SUPER);

  console.log("\n⓿ ÉTAT DE DÉPART");
  const directeur = (await q(`SELECT id FROM attendance_employees WHERE full_name='Mohamedou Diallo'`))[0]?.id;
  if (directeur) {
    await appel("POST", `/paie/salaries/${directeur}/non-remunere`, { token: tS, societe: 1, corps: {
      reason: "Directeur : ne percoit volontairement aucun salaire. Decision direction." } });
  }
  /* LES DÉCISIONS DÉJÀ PRISES PAR LA DIRECTION, posées par les VRAIES routes —
     jamais par SQL. C'est le chemin qu'emprunterait l'administration, et c'est
     donc celui qu'on éprouve. Le jeu d'essai porte volontairement les valeurs
     d'AVANT ces décisions. */
  const salaires = { "Hawa Diarra": 100000, "Amary Zerbo": 150000,
                     "Mohamed Sangare": 50000, "Oumar Sangare": 50000,
                     "Souleymane Diallo": 150000 };
  for (const [nom, montant] of Object.entries(salaires)) {
    const id = (await q(`SELECT id FROM attendance_employees WHERE full_name=$1 AND company_id=1`, [nom]))[0]?.id;
    if (!id) continue;
    await appel("PUT", `/attendance-v2/employees/${id}/salary`, { token: tS, societe: 1, corps: {
      monthly_salary: montant, daily_rate: Math.round(montant / 25),
      /* La date d'effet doit précéder la période, sinon le salaire n'est pas
         celui de septembre : le moteur retient la configuration en vigueur à la
         fin de la période, et un salaire daté d'aujourd'hui — le 25 — tombe
         dans la période SUIVANTE. */
      effective_from: "2026-08-01",
      reason: `Salaire reel confirme par la direction : ${montant} FCFA.` } });
  }

  const brutAvant = await empreinte();
  v("des pointages existent au départ", brutAvant.lignes > 0, JSON.stringify(brutAvant));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n① PÉRIODE NORMALE — les absences se comptent comme d'habitude");
  await q(`UPDATE attendance_periods SET absences_non_retenues=false, absences_non_retenues_motif='',
           absences_non_retenues_par=NULL, absences_non_retenues_le=NULL,
           retards_non_retenus=false, retards_non_retenus_motif='',
           retards_non_retenus_par=NULL, retards_non_retenus_le=NULL
           WHERE company_id=1 AND code='2026-09'`);
  let r = await appel("POST", "/paie/periodes/2026-09/preparer", { token: tS, societe: 1, corps: {} });
  v("la paie se prépare", r.status === 200 || r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  const rap0 = await rapport(tS);
  const absencesNormales = Number(rap0?.totaux_generaux?.absences || 0);
  v("le rapport compte des absences", absencesNormales > 0, String(absencesNormales));
  const retenuesNormales = Number((await q(
    `SELECT COALESCE(sum(absence_deduction),0) AS s FROM attendance_payroll_items_v2 i
       JOIN attendance_payroll_runs_v2 r ON r.id=i.payroll_run_id
      WHERE r.company_id=1 AND to_char(r.period_month,'YYYY-MM')='2026-09'`))[0].s);
  v("et la paie retient quelque chose", retenuesNormales > 0, String(retenuesNormales));
  v("aucune mention de régularisation n'est affichée",
    !rap0?.totaux_generaux?.regularisation?.mention, rap0?.totaux_generaux?.regularisation?.mention);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n② EXCEPTION POSÉE — le rapport officiel annonce zéro absence");
  r = await appel("POST", "/paie/periodes/2026-09/exception-absences",
    { token: tS, societe: 1, corps: { actif: true, reason: MOTIF, retards_aussi: true } });
  v("l'exception est posée", r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  const per = (await q(`SELECT * FROM attendance_periods WHERE company_id=1 AND code='2026-09'`))[0];
  v("la période porte la décision", per.absences_non_retenues === true);
  v("le motif officiel est enregistré", String(per.absences_non_retenues_motif).includes("incidents du système de pointage"),
    per.absences_non_retenues_motif);
  v("les retards sont aussi neutralisés, car demandé explicitement", per.retards_non_retenus === true);

  const rap1 = await rapport(tS);
  v("RAPPORT OFFICIEL : Absences = 0", Number(rap1.totaux_generaux.absences) === 0,
    String(rap1.totaux_generaux.absences));
  v("les absences BRUTES restent visibles pour l'audit",
    Number(rap1.totaux_generaux.absences_brutes) === absencesNormales,
    `${rap1.totaux_generaux.absences_brutes} vs ${absencesNormales}`);
  v("ce qui a été neutralisé est chiffré",
    Number(rap1.totaux_generaux.absences_neutralisees) === absencesNormales,
    String(rap1.totaux_generaux.absences_neutralisees));
  v("la mention de régularisation est affichée",
    /Régularisation exceptionnelle du pointage/.test(rap1.totaux_generaux.regularisation.mention || ""),
    rap1.totaux_generaux.regularisation.mention);
  v("les retards officiels sont à zéro", Number(rap1.totaux_generaux.retards) === 0,
    String(rap1.totaux_generaux.retards));
  v("les retards bruts restent lisibles",
    rap1.totaux_generaux.minutes_retard_brutes !== undefined);
  v("les jours travaillés n'ont PAS été gonflés",
    Number(rap1.totaux_generaux.jours_travailles) === Number(rap0.totaux_generaux.jours_travailles),
    `${rap0.totaux_generaux.jours_travailles} → ${rap1.totaux_generaux.jours_travailles}`);
  v("l'effectif est inchangé", rap1.effectif === rap0.effectif, `${rap0.effectif} → ${rap1.effectif}`);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n③ CHAQUE SALARIÉ — absences officielles à zéro, brut conservé");
  const avecAbsences = rap1.employes.filter((e) => Number(e.totaux.absences_brutes) > 0);
  v("des salariés avaient des absences brutes", avecAbsences.length > 0, String(avecAbsences.length));
  v("aucun salarié n'affiche d'absence officielle",
    rap1.employes.every((e) => Number(e.totaux.absences) === 0),
    JSON.stringify(rap1.employes.filter((e) => Number(e.totaux.absences) !== 0).map((e) => e.nom)));
  v("chacun conserve ses absences brutes",
    avecAbsences.every((e) => Number(e.totaux.absences_brutes) > 0));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n④ DONNÉES BRUTES — strictement conservées");
  r = await appel("POST", "/paie/periodes/2026-09/preparer", { token: tS, societe: 1, corps: {} });
  v("la paie est recalculée avec l'exception", r.status === 200 || r.status === 201, `${r.status}`);
  const brutApres = await empreinte();
  v("aucun pointage ajouté ni supprimé", brutApres.lignes === brutAvant.lignes,
    `${brutAvant.lignes} → ${brutApres.lignes}`);
  v("aucun check-in ni check-out modifié", brutApres.signature === brutAvant.signature);
  v("aucune fausse régularisation créée", brutApres.regularisations === brutAvant.regularisations,
    `${brutAvant.regularisations} → ${brutApres.regularisations}`);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑤ PAIE — aucune retenue d'absence, et rien d'autre n'a bougé");
  const lignes = await q(
    `SELECT i.* FROM attendance_payroll_items_v2 i
       JOIN attendance_payroll_runs_v2 r ON r.id=i.payroll_run_id
      WHERE r.company_id=1 AND to_char(r.period_month,'YYYY-MM')='2026-09'`);
  v("absence_deduction = 0 pour tous", lignes.every((l) => Number(l.absence_deduction) === 0),
    JSON.stringify(lignes.filter((l) => Number(l.absence_deduction) !== 0).map((l) => l.employee_name)));
  v("absence_days_officiel = 0 pour tous", lignes.every((l) => Number(l.absence_days_officiel) === 0));
  v("absence_days_brut conserve le compte réel", lignes.some((l) => Number(l.absence_days_brut) > 0));
  v("ce que l'exception a coûté est chiffré", lignes.some((l) => Number(l.absence_deduction_annulee) > 0));
  v("late_minutes_brut est conservé", lignes.every((l) => l.late_minutes_brut !== null));

  const attendus = {
    "Hawa Diarra": 60000, "Souleymane Diallo": 110000, "Amary Zerbo": 125000,
    "Mohamed Sangare": 50000, "Oumar Sangare": 50000, "Mohamedou Diallo": 0,
  };
  for (const [nom, net] of Object.entries(attendus)) {
    const l = await ligne(nom);
    v(`${nom} : net ${net.toLocaleString("fr-FR")}`, Number(l?.net_salary) === net,
      `${l?.net_salary} (salaire ${l?.monthly_salary}, avance ${l?.advance_deduction}, absence ${l?.absence_deduction})`);
  }
  v("les avances sont TOUJOURS retenues — zéro absence n'est pas zéro retenue",
    lignes.some((l) => Number(l.advance_deduction) > 0),
    String(lignes.reduce((s, l) => s + Number(l.advance_deduction || 0), 0)));
  v("aucune prime n'a été inventée pour compenser",
    lignes.every((l) => Number(l.primes_total || 0) === 0),
    JSON.stringify(lignes.filter((l) => Number(l.primes_total) > 0).map((l) => l.employee_name)));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑥ PLUSIEURS RECALCULS — toujours aucune retenue d'absence");
  const soldeAvant = Number((await q(
    `SELECT COALESCE(sum(balance),0) AS s FROM salary_advances WHERE company_id=1`))[0].s);
  for (let i = 0; i < 3; i += 1) {
    await appel("POST", "/paie/periodes/2026-09/preparer", { token: tS, societe: 1, corps: {} });
  }
  const apres3 = await q(
    `SELECT i.* FROM attendance_payroll_items_v2 i
       JOIN attendance_payroll_runs_v2 r ON r.id=i.payroll_run_id
      WHERE r.company_id=1 AND to_char(r.period_month,'YYYY-MM')='2026-09'`);
  v("toujours aucune retenue d'absence", apres3.every((l) => Number(l.absence_deduction) === 0));
  v("les nets sont stables", (await ligne("Hawa Diarra"))?.net_salary === "60000.00",
    (await ligne("Hawa Diarra"))?.net_salary);
  v("aucun remboursement d'avance dupliqué",
    Number((await q(`SELECT COALESCE(sum(balance),0) AS s FROM salary_advances WHERE company_id=1`))[0].s) === soldeAvant,
    `${soldeAvant} → ${(await q(`SELECT COALESCE(sum(balance),0) AS s FROM salary_advances WHERE company_id=1`))[0].s}`);
  const brutFin = await empreinte();
  v("les données brutes sont toujours intactes après trois recalculs",
    brutFin.signature === brutAvant.signature);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑦ PÉRIODE SUIVANTE — retour automatique aux règles normales");
  await appel("POST", "/paie/periodes/2026-10/ouvrir", { token: tS, societe: 1, corps: {} });
  await appel("POST", "/paie/periodes/2026-10/valider-pointage",
    { token: tS, societe: 1, corps: { reason: "Pointage octobre controle pour ce test." } });
  r = await appel("POST", "/paie/periodes/2026-10/preparer", { token: tS, societe: 1, corps: {} });
  v("octobre se prépare", r.status === 200 || r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  const oct = (await q(`SELECT * FROM attendance_periods WHERE company_id=1 AND code='2026-10'`))[0];
  v("octobre n'a PAS hérité de l'exception d'absences", oct.absences_non_retenues === false);
  v("octobre n'a PAS hérité de l'exception de retards", oct.retards_non_retenus === false);
  const rapOct = await rapport(tS, "2026-10");
  v("le rapport d'octobre n'affiche aucune mention de régularisation",
    !rapOct?.totaux_generaux?.regularisation?.mention, rapOct?.totaux_generaux?.regularisation?.mention);
  v("septembre reste à zéro après le calcul d'octobre",
    (await ligne("Hawa Diarra"))?.absence_deduction === "0.00");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑧ AUTRE SOCIÉTÉ — aucune contamination");
  const fat = (await q(`SELECT * FROM attendance_periods WHERE company_id=2 AND code='2026-09'`))[0];
  v("FAT & MAT n'a pas d'exception d'absences", !fat || fat.absences_non_retenues === false);
  v("FAT & MAT n'a pas d'exception de retards", !fat || fat.retards_non_retenus === false);
  v("aucune ligne de paie FAT & MAT modifiée par ces opérations",
    (await q(`SELECT count(*)::int AS n FROM attendance_payroll_items_v2
               WHERE company_id=2 AND absence_deduction_annulee > 0`))[0].n === 0);
  v("aucun salarié FAT & MAT payé",
    (await q(`SELECT count(*)::int AS n FROM attendance_payroll_items_v2 WHERE company_id=2 AND status='PAID'`))[0].n === 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑨ IMPRESSION — zéro absence officielle et la mention");
  const indiv = (await appel("GET",
    `/pointage/rapports/employe/${(await q(`SELECT id FROM attendance_employees WHERE full_name='Hawa Diarra'`))[0].id}?periode=2026-09`,
    { token: tS, societe: 1 })).data;
  v("le rapport individuel annonce 0 absence", Number(indiv?.totaux?.absences) === 0,
    String(indiv?.totaux?.absences));
  v("il porte la mention de régularisation",
    /décision de la Direction/.test(indiv?.totaux?.regularisation?.mention || ""),
    indiv?.totaux?.regularisation?.mention);
  v("il conserve le détail brut des journées",
    Array.isArray(indiv?.journees) && indiv.journees.some((j) => j.du_brut === true));
  v("les journées non pointées restent visibles, non transformées en présences",
    indiv.journees.some((j) => j.statut === "ABSENT") || Number(indiv.totaux.absences_brutes) === 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑩ AUCUNE CONFUSION AVEC LE MODULE DES JOURS CHÔMÉS");
  v("l'exception de septembre n'a créé AUCUN jour chômé",
    (await q(`SELECT count(*)::int AS n FROM attendance_special_days
               WHERE company_id=1 AND day_date BETWEEN '2026-08-25' AND '2026-09-24'
                 AND type_key <> 'JOUR_FERIE'`))[0].n === 0);
  v("aucune journée spéciale ne porte le motif de la régularisation",
    (await q(`SELECT count(*)::int AS n FROM attendance_special_days
               WHERE company_id=1 AND description ILIKE '%incidents du syst%'`))[0].n === 0);
  v("les lignes de septembre ne comptent aucun jour chômé",
    lignes.every((l) => Number(l.jours_chomes_payes || 0) === 0
                     && Number(l.jours_chomes_non_payes || 0) === 0));
  v("et aucune retenue de jour chômé",
    lignes.every((l) => Number(l.retenue_jour_chome || 0) === 0));
  v("aucun salaire payé dans toute cette suite",
    (await q(`SELECT count(*)::int AS n FROM attendance_payroll_items_v2 WHERE status='PAID'`))[0].n === 0);

  console.log(`\n${ko === 0 ? "✅" : "❌"} ${ok} réussis, ${ko} échoués\n`);
  await pool.end();
  process.exit(ko === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
