"use strict";
/**
 * MISSION B — JOURS FÉRIÉS, JOURS CHÔMÉS, JOURNÉES EXCEPTIONNELLES.
 *
 * Ce que ces tests éprouvent, c'est que le logiciel n'INTERPRÈTE rien : la même
 * date, déclarée chômée payée ou chômée non payée, produit deux traitements
 * différents sans qu'une ligne de code change. Et qu'une journée chômée n'est
 * jamais une absence injustifiée.
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
const COMPTA = { id: 903, fullname: "Comptable Triangle", role: "comptable", company_id: 1, is_super_admin: false };

const ENTREPOT = 810;   // Fanta Keita, entrepôt (site 3) — deux journées non pointées
const BUREAU = 811;     // Bakary Traore, bureau (site 1) — présent tous les jours

const ligneDe = async (id, p = "2026-09") => (await q(
  `SELECT i.* FROM attendance_payroll_items_v2 i
     JOIN attendance_payroll_runs_v2 r ON r.id = i.payroll_run_id
    WHERE i.employee_id = $1 AND to_char(r.period_month,'YYYY-MM') = $2`, [id, p]))[0];
const elements = async (id, p = "2026-09") => q(
  `SELECT * FROM payroll_elements WHERE company_id=1 AND employee_id=$1 AND period_code=$2
    ORDER BY id`, [id, p]);
const pointage = async (id, jour) => (await q(
  `SELECT check_in::text, check_out::text, worked_minutes FROM attendance_day_records_v2
    WHERE company_id=1 AND employee_id=$1 AND work_date=$2::date`, [id, jour]))[0];
const preparer = async (t, p = "2026-09") =>
  appel("POST", `/paie/periodes/${p}/preparer`, { token: t, societe: 1, corps: {} });
const rapport = async (t, p = "2026-09") =>
  (await appel("GET", `/pointage/rapports/global?periode=${p}`, { token: t, societe: 1 })).data;
const journeeDu = async (jour) => (await q(
  `SELECT * FROM attendance_special_days WHERE company_id=1 AND day_date=$1::date ORDER BY id DESC`, [jour]))[0];

(async () => {
  const tS = jeton(SUPER), tC = jeton(COMPTA);
  const directeur = (await q(`SELECT id FROM attendance_employees WHERE full_name='Mohamedou Diallo'`))[0]?.id;
  if (directeur) {
    await appel("POST", `/paie/salaries/${directeur}/non-remunere`, { token: tS, societe: 1, corps: {
      reason: "Directeur : ne percoit volontairement aucun salaire. Decision direction." } });
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n① JOUR NORMAL SANS POINTAGE — l'absence se compte normalement");
  let r = await preparer(tS);
  v("la paie se prépare", r.status === 200 || r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  let entrepot = await ligneDe(ENTREPOT);
  v("l'entrepôt compte 2 absences (08/09 et 09/09)", Number(entrepot?.absence_days) === 2,
    `${entrepot?.absence_days} (brut ${entrepot?.absence_days_brut})`);
  v("elles sont retenues : 2 × 4 000 = 8 000", Number(entrepot?.absence_deduction) === 8000,
    String(entrepot?.absence_deduction));
  v("son net est 100 000 − 8 000 = 92 000", Number(entrepot?.net_salary) === 92000,
    String(entrepot?.net_salary));
  let bureau = await ligneDe(BUREAU);
  v("le bureau n'a aucune absence", Number(bureau?.absence_days) === 0, String(bureau?.absence_days));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n② JOUR CHÔMÉ ET PAYÉ — aucune absence, aucune retenue, salaire maintenu");
  r = await appel("POST", "/pointage/calendrier", { token: tS, societe: 1, corps: {
    day_date: "2026-09-08", label: "Fermeture entrepot Sotuba",
    type_key: "FERMETURE_EXCEPTIONNELLE",
    description: "Fermeture exceptionnelle de l'entrepot decidee par la direction.",
    decision_reference: "Note de service 2026-14",
    est_chome: true, est_paye: true, pointage_requis: false,
    portee: "SITE", cibles: [3] } });
  v("la journée est enregistrée", r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  v("elle porte le traitement saisi", r.data?.journee?.impact_absence === "AUCUNE"
    && r.data?.journee?.impact_salaire === "MAINTENU", JSON.stringify(r.data?.journee));
  await preparer(tS);
  entrepot = await ligneDe(ENTREPOT);
  v("il ne reste qu'UNE absence", Number(entrepot?.absence_days) === 1, String(entrepot?.absence_days));
  v("la retenue tombe à 4 000", Number(entrepot?.absence_deduction) === 4000, String(entrepot?.absence_deduction));
  v("la journée est comptée comme jour chômé payé", Number(entrepot?.jours_chomes_payes) === 1,
    String(entrepot?.jours_chomes_payes));
  v("aucune retenue de jour chômé", Number(entrepot?.retenue_jour_chome) === 0, String(entrepot?.retenue_jour_chome));
  v("les jours attendus ont diminué d'un, pas les jours travaillés",
    Number(entrepot?.expected_days) === Number(entrepot?.attended_days) + 1,
    `attendus ${entrepot?.expected_days}, présents ${entrepot?.attended_days}`);
  v("AUCUN faux pointage n'a été créé", !(await pointage(ENTREPOT, "2026-09-08")),
    JSON.stringify(await pointage(ENTREPOT, "2026-09-08")));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n③ JOUR CHÔMÉ NON PAYÉ — une retenue, mais PAS une absence");
  r = await appel("POST", "/pointage/calendrier", { token: tS, societe: 1, corps: {
    day_date: "2026-09-09", label: "Journee chomee non payee",
    type_key: "JOUR_CHOME_EXCEPTIONNEL",
    description: "Journee chomee sans maintien de salaire, decision de l'autorite competente.",
    est_chome: true, est_paye: false, pointage_requis: false,
    portee: "SITE", cibles: [3] } });
  v("la journée est enregistrée", r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  v("l'impact salarial est une retenue d'un jour", r.data?.journee?.impact_salaire === "RETENUE_JOUR",
    r.data?.journee?.impact_salaire);
  await preparer(tS);
  entrepot = await ligneDe(ENTREPOT);
  v("plus AUCUNE absence injustifiée", Number(entrepot?.absence_days) === 0, String(entrepot?.absence_days));
  v("et aucune retenue d'absence", Number(entrepot?.absence_deduction) === 0, String(entrepot?.absence_deduction));
  v("la journée est comptée comme jour chômé NON payé",
    Number(entrepot?.jours_chomes_non_payes) === 1, String(entrepot?.jours_chomes_non_payes));
  v("la retenue existe, et elle est SÉPARÉE : 4 000",
    Number(entrepot?.retenue_jour_chome) === 4000, String(entrepot?.retenue_jour_chome));
  v("le net reste 100 000 − 4 000 = 96 000", Number(entrepot?.net_salary) === 96000,
    String(entrepot?.net_salary));
  v("les absences brutes conservent les deux journées",
    Number(entrepot?.absence_days_brut) === 2, String(entrepot?.absence_days_brut));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n④ UN SALARIÉ TRAVAILLE UN JOUR CHÔMÉ — pointage conservé, compensation configurée");
  const avantPointage = await pointage(BUREAU, "2026-09-10");
  r = await appel("POST", "/pointage/calendrier", { token: tS, societe: 1, corps: {
    day_date: "2026-09-10", label: "Journee chomee toute l'entreprise",
    type_key: "JOUR_CHOME_DIRECTION",
    description: "Journee chomee decidee par la direction pour l'ensemble de l'entreprise.",
    est_chome: true, est_paye: true, pointage_requis: false, portee: "ENTREPRISE",
    traitement_si_travaille: "PRIME_FIXE", compensation_montant: 15000,
    compensation_note: "Prime forfaitaire pour travail un jour chome." } });
  v("la journée entreprise est enregistrée", r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  await preparer(tS);
  v("le pointage réel est CONSERVÉ tel quel",
    JSON.stringify(await pointage(BUREAU, "2026-09-10")) === JSON.stringify(avantPointage),
    `${JSON.stringify(avantPointage)} → ${JSON.stringify(await pointage(BUREAU, "2026-09-10"))}`);
  bureau = await ligneDe(BUREAU);
  v("la journée est comptée comme travail un jour chômé",
    Number(bureau?.travail_jour_chome_jours) === 1, String(bureau?.travail_jour_chome_jours));
  v("elle n'est PAS comptée dans les jours travaillés ordinaires",
    Number(bureau?.attended_days) === Number(bureau?.expected_days),
    `attendus ${bureau?.expected_days}, présents ${bureau?.attended_days}`);
  const elts = await elements(BUREAU);
  const compensation = elts.find((e) => e.source_kind === "JOUR_CHOME");
  v("la compensation est devenue un ÉLÉMENT DE PAIE", Boolean(compensation), JSON.stringify(elts));
  v("elle vaut le montant configuré : 15 000", Number(compensation?.amount) === 15000,
    String(compensation?.amount));
  v("elle porte sa référence d'origine", /^JC:\d+:811:2026-09-10$/.test(String(compensation?.source_ref)),
    String(compensation?.source_ref));
  v("elle apparaît dans les primes du bulletin", Number(bureau?.primes_total) === 15000,
    String(bureau?.primes_total));
  v("son net est 100 000 + 15 000 = 115 000", Number(bureau?.net_salary) === 115000,
    String(bureau?.net_salary));
  v("AUCUN pourcentage n'a été inventé : sans configuration, aucune compensation",
    (await elements(ENTREPOT)).filter((e) => e.source_kind === "JOUR_CHOME"
      && String(e.source_ref).endsWith("2026-09-08")).length === 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑤ PORTÉE — une fermeture de site ne chôme pas les autres");
  const j8 = await journeeDu("2026-09-08");
  v("la journée du 08/09 est bien limitée au site", j8.portee === "SITE", j8.portee);
  v("le bureau n'a AUCUN jour chômé payé limité à l'entrepôt",
    Number(bureau?.jours_chomes_payes) === 0, String(bureau?.jours_chomes_payes));
  v("le bureau n'a aucune retenue de jour chômé",
    Number(bureau?.retenue_jour_chome) === 0, String(bureau?.retenue_jour_chome));
  v("le bureau garde sa journée du 08/09 comme journée travaillée normale",
    Boolean(await pointage(BUREAU, "2026-09-08")));
  /* La journée ENTREPRISE du 10/09, elle, concerne aussi l'entrepôt. */
  entrepot = await ligneDe(ENTREPOT);
  v("l'entrepôt est bien concerné par la journée ENTREPRISE du 10/09",
    Number(entrepot?.travail_jour_chome_jours) === 1, String(entrepot?.travail_jour_chome_jours));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑥ AUTRE SOCIÉTÉ — aucune contamination");
  v("FAT & MAT n'a aucune journée spéciale",
    (await q(`SELECT count(*)::int AS n FROM attendance_special_days WHERE company_id=2`))[0].n === 0);
  v("aucune cible ne pointe vers une autre société",
    (await q(`SELECT count(*)::int AS n FROM attendance_special_day_targets c
               JOIN attendance_special_days s ON s.id=c.special_day_id
              WHERE c.company_id <> s.company_id`))[0].n === 0);
  v("aucun élément de paie JOUR_CHOME chez FAT & MAT",
    (await q(`SELECT count(*)::int AS n FROM payroll_elements
               WHERE company_id=2 AND source_kind='JOUR_CHOME'`))[0].n === 0);
  r = await appel("POST", "/pointage/calendrier", { token: tS, societe: 2, corps: {
    day_date: "2026-09-11", label: "Tentative site Triangle depuis FAT",
    type_key: "AUTRE", description: "Tentative de rattacher un site d'une autre societe.",
    portee: "SITE", cibles: [3] } });
  v("déclarer une journée FAT & MAT sur un site Triangle est refusé",
    r.data?.code === "SITE_NOT_FOUND", `${r.status} ${JSON.stringify(r.data)}`);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑦ RECALCUL — aucune duplication de compensation");
  const netsAvant = { entrepot: (await ligneDe(ENTREPOT)).net_salary, bureau: (await ligneDe(BUREAU)).net_salary };
  for (let i = 0; i < 3; i += 1) await preparer(tS);
  v("une seule compensation par salarié et par journée",
    (await q(`SELECT count(*)::int AS n FROM payroll_elements
               WHERE company_id=1 AND source_kind='JOUR_CHOME' AND status='ACTIF'
                 AND source_ref = $1`, [compensation.source_ref]))[0].n === 1);
  v("aucun doublon toutes journées confondues",
    (await q(`SELECT count(*)::int AS n FROM (
                SELECT source_ref FROM payroll_elements
                 WHERE company_id=1 AND source_kind='JOUR_CHOME'
                 GROUP BY source_ref HAVING count(*) > 1) d`))[0].n === 0);
  v("les nets sont identiques après trois recalculs",
    (await ligneDe(ENTREPOT)).net_salary === netsAvant.entrepot
    && (await ligneDe(BUREAU)).net_salary === netsAvant.bureau,
    `${netsAvant.entrepot}/${netsAvant.bureau} → ${(await ligneDe(ENTREPOT)).net_salary}/${(await ligneDe(BUREAU)).net_salary}`);
  v("les primes ne s'accumulent pas", Number((await ligneDe(BUREAU)).primes_total) === 15000,
    String((await ligneDe(BUREAU)).primes_total));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑧ RAPPORT — les catégories sont séparées");
  const rap = await rapport(tS);
  const fanta = rap.employes.find((e) => e.employee_id === ENTREPOT);
  const bakary = rap.employes.find((e) => e.employee_id === BUREAU);
  v("l'entrepôt affiche un jour chômé payé", Number(fanta?.totaux?.jours_chomes_payes) === 1,
    JSON.stringify(fanta?.totaux));
  v("l'entrepôt affiche un jour chômé non payé", Number(fanta?.totaux?.jours_chomes_non_payes) === 1,
    String(fanta?.totaux?.jours_chomes_non_payes));
  v("l'entrepôt n'affiche AUCUNE absence", Number(fanta?.totaux?.absences) === 0,
    String(fanta?.totaux?.absences));
  v("le bureau affiche un travail un jour chômé", Number(bakary?.totaux?.travail_jours_chomes) === 1,
    String(bakary?.totaux?.travail_jours_chomes));
  v("une journée chômée ne gonfle pas les jours travaillés",
    Number(bakary?.totaux?.jours_travailles) + Number(bakary?.totaux?.travail_jours_chomes)
      === Number(bakary?.totaux?.jours_attendus) + 1,
    JSON.stringify(bakary?.totaux));
  const detail = (await appel("GET", `/pointage/rapports/employe/${ENTREPOT}?periode=2026-09`,
    { token: tS, societe: 1 })).data;
  v("le détail nomme la journée chômée payée",
    detail.journees.some((j) => j.jour === "2026-09-08" && j.statut === "CHOME_PAYE"),
    JSON.stringify(detail.journees.filter((j) => j.jour === "2026-09-08")));
  v("et la journée chômée non payée",
    detail.journees.some((j) => j.jour === "2026-09-09" && j.statut === "CHOME_NON_PAYE"));
  v("aucune de ces journées n'est marquée ABSENT",
    !detail.journees.some((j) => ["2026-09-08", "2026-09-09"].includes(j.jour) && j.statut === "ABSENT"));
  v("le motif de la décision est visible sur la journée",
    detail.journees.find((j) => j.jour === "2026-09-08")?.motif?.length > 0,
    detail.journees.find((j) => j.jour === "2026-09-08")?.motif);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑨ MODIFIER UNE JOURNÉE DÉJÀ UTILISÉE — protection et audit");
  r = await appel("PATCH", `/pointage/calendrier/${j8.id}`, { token: tS, societe: 1, corps: { label: "Sans motif" } });
  v("sans motif, la modification est refusée", r.data?.code === "REASON_REQUIRED", `${r.status} ${JSON.stringify(r.data)}`);
  r = await appel("PATCH", `/pointage/calendrier/${j8.id}`, { token: tC, societe: 1, corps: {
    label: "Tentative comptable", reason: "Tentative de modification par le comptable." } });
  v("le comptable n'a pas le droit de modifier le calendrier", r.status === 403 || r.status === 404,
    `${r.status} ${JSON.stringify(r.data)}`);
  r = await appel("PATCH", `/pointage/calendrier/${j8.id}`, { token: tS, societe: 1, corps: {
    label: "Fermeture entrepot Sotuba ACI", reason: "Precision du libelle de la note de service." } });
  v("sur une paie en brouillon, la modification passe", r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  let audit = (await appel("GET", `/pointage/calendrier/${j8.id}/audit`, { token: tS, societe: 1 })).data;
  v("l'audit conserve la création et la modification", audit.audit.length >= 2, String(audit.audit.length));
  v("il garde l'avant et l'après", audit.audit.some((a) => a.avant && a.apres));
  v("il garde le motif", audit.audit.some((a) => /Precision du libelle/.test(a.motif || "")));

  /* La paie est soumise : la journée devient rétroactive. */
  const paie = (await q(`SELECT * FROM attendance_payroll_runs_v2 WHERE company_id=1
                          AND to_char(period_month,'YYYY-MM')='2026-09'`))[0];
  await appel("POST", `/paie/runs/${paie.id}/soumettre`, { token: tS, societe: 1, corps: {} });
  r = await appel("PATCH", `/pointage/calendrier/${j8.id}`, { token: tS, societe: 1, corps: {
    est_paye: false, reason: "Changement du regime de paiement." } });
  v("une paie soumise bloque la modification silencieuse",
    r.data?.code === "RETROACTIVE_CORRECTION_REQUIRED", `${r.status} ${JSON.stringify(r.data)}`);
  r = await appel("PATCH", `/pointage/calendrier/${j8.id}`, { token: tS, societe: 1, corps: {
    est_paye: false, correction_controlee: true, reason: "Trop court" } });
  v("une correction contrôlée exige un motif circonstancié",
    r.data?.code === "REASON_TOO_SHORT", `${r.status} ${JSON.stringify(r.data)}`);
  r = await appel("PATCH", `/pointage/calendrier/${j8.id}`, { token: tC, societe: 1, corps: {
    est_paye: false, correction_controlee: true,
    reason: "Correction retroactive demandee par la direction apres verification de la note de service." } });
  v("un compte non super administrateur ne corrige pas rétroactivement",
    r.status === 403 || r.status === 404, `${r.status} ${JSON.stringify(r.data)}`);
  r = await appel("PATCH", `/pointage/calendrier/${j8.id}`, { token: tS, societe: 1, corps: {
    est_paye: false, correction_controlee: true,
    reason: "Correction retroactive demandee par la direction apres verification de la note de service." } });
  v("le super administrateur corrige, explicitement", r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  audit = (await appel("GET", `/pointage/calendrier/${j8.id}/audit`, { token: tS, societe: 1 })).data;
  v("la correction rétroactive est tracée comme telle",
    audit.audit.some((a) => a.action === "CORRECTION_CONTROLEE"),
    JSON.stringify(audit.audit.map((a) => a.action)));
  v("l'audit note l'état de la paie au moment du geste",
    audit.audit.some((a) => /EN_ATTENTE_DIRECTION/.test(a.paie_concernee || "")),
    JSON.stringify(audit.audit.map((a) => a.paie_concernee)));

  /* Une paie déjà payée ne se corrige plus du tout. On simule UNE ligne payée
     directement en base — c'est le seul moyen d'éprouver la garde sans payer —
     puis on la remet comme elle était. */
  const ligneTest = (await q(`SELECT id, status FROM attendance_payroll_items_v2
                               WHERE payroll_run_id=$1 LIMIT 1`, [paie.id]))[0];
  await q(`UPDATE attendance_payroll_items_v2 SET status='PAID' WHERE id=$1`, [ligneTest.id]);
  r = await appel("POST", `/pointage/calendrier/${j8.id}/desactiver`, { token: tS, societe: 1, corps: {
    correction_controlee: true,
    reason: "Tentative de retrait alors qu'un salaire a deja ete paye sur cette periode." } });
  v("une paie déjà payée interdit toute correction de la journée",
    r.data?.code === "PAYROLL_ALREADY_PAID", `${r.status} ${JSON.stringify(r.data)}`);
  await q(`UPDATE attendance_payroll_items_v2 SET status=$2 WHERE id=$1`, [ligneTest.id, ligneTest.status]);

  /* Retour en brouillon, puis retrait : la journée est désactivée, pas effacée. */
  await appel("POST", `/paie/runs/${paie.id}/retirer-soumission`, { token: tS, societe: 1, corps: {
    reason: "Retrait pour poursuivre les tests du calendrier." } });
  r = await appel("POST", `/pointage/calendrier/${j8.id}/desactiver`, { token: tS, societe: 1, corps: {
    reason: "La fermeture n'a finalement pas eu lieu." } });
  v("la journée se désactive", r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  v("elle n'est PAS supprimée", Boolean(await journeeDu("2026-09-08")));
  v("son statut est INACTIF", (await journeeDu("2026-09-08")).status === "INACTIF");
  await preparer(tS);
  entrepot = await ligneDe(ENTREPOT);
  v("l'absence du 08/09 redevient une absence ordinaire",
    Number(entrepot?.absence_days) === 1, String(entrepot?.absence_days));
  v("et le jour chômé payé disparaît du décompte",
    Number(entrepot?.jours_chomes_payes) === 0, String(entrepot?.jours_chomes_payes));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑩ PÉRIODE SUIVANTE — rien ne se propage");
  await appel("POST", "/paie/periodes/2026-10/ouvrir", { token: tS, societe: 1, corps: {} });
  await appel("POST", "/paie/periodes/2026-10/valider-pointage",
    { token: tS, societe: 1, corps: { reason: "Pointage octobre controle pour ce test." } });
  r = await preparer(tS, "2026-10");
  v("octobre se prépare", r.status === 200 || r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  const oct = await ligneDe(BUREAU, "2026-10");
  v("octobre ne compte aucun jour chômé", Number(oct?.jours_chomes_payes || 0) === 0
    && Number(oct?.jours_chomes_non_payes || 0) === 0, JSON.stringify(oct));
  v("aucune compensation d'octobre", (await elements(BUREAU, "2026-10"))
    .filter((e) => e.source_kind === "JOUR_CHOME").length === 0);
  v("octobre n'a pas hérité de l'exception d'absences de septembre",
    (await q(`SELECT absences_non_retenues FROM attendance_periods
               WHERE company_id=1 AND code='2026-10'`))[0].absences_non_retenues === false);
  v("la compensation de septembre est intacte",
    (await q(`SELECT count(*)::int AS n FROM payroll_elements
               WHERE company_id=1 AND period_code='2026-09' AND source_kind='JOUR_CHOME'
                 AND status='ACTIF'`))[0].n >= 1);
  v("aucun salaire payé dans toute cette suite",
    (await q(`SELECT count(*)::int AS n FROM attendance_payroll_items_v2 WHERE status='PAID'`))[0].n === 0);

  console.log(`\n${ko === 0 ? "✅" : "❌"} ${ok} réussis, ${ko} échoués\n`);
  await pool.end();
  process.exit(ko === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
