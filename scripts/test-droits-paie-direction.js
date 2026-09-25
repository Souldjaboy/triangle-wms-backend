"use strict";
/**
 * DROITS DE LA PAIE À L'ÉCRAN — ce que le serveur dit, et ce qu'il fait ensuite.
 *
 * Le défaut corrigé ici n'était pas une règle métier fausse : c'était une
 * ABSENCE de données lue comme une règle. Tant que le backend ne renvoyait pas
 * `droits`, l'écran concluait « la validation revient à quelqu'un d'autre » —
 * parce qu'il testait `!droits.peut_decider`, soit `!undefined` — et
 * n'affichait aucun bouton, puisque ceux-ci exigeaient les mêmes champs au
 * positif. Ces tests vérifient donc deux choses ensemble : ce que `droits`
 * annonce, et ce que la route répond quand on agit.
 *
 * Aucun salaire n'est payé. Les seules écritures sont celles des routes
 * testées, sur une base de test reconstruite à chaque exécution.
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

const SUPER  = { id: 900, fullname: "Super Triangle", role: "super_admin", company_id: 1, is_super_admin: true };
const COMPTA = { id: 903, fullname: "Comptable Triangle", role: "comptable", company_id: 1, is_super_admin: false };
/* LE JETON FORGÉ : il se présente comme super administrateur — rôle et
   drapeau — alors que `users.is_super_admin` vaut false pour ce compte. Rien
   dans ce jeton n'est faux au sens cryptographique : il est signé. C'est
   précisément le cas d'un jeton émis AVANT un retrait de privilège. */
const FORGE  = { id: 903, fullname: "Comptable Triangle", role: "super_admin", company_id: 1, is_super_admin: true };

const run = async (periode = "2026-09") => (await q(
  `SELECT * FROM attendance_payroll_runs_v2 WHERE company_id=1 AND to_char(period_month,'YYYY-MM')=$1`, [periode]))[0];
const demandeDe = async (runId) => (await q(
  `SELECT * FROM payroll_requests WHERE payroll_run_id=$1 ORDER BY submitted_at DESC, id DESC LIMIT 1`, [runId]))[0];
const droitsDe = async (token) => {
  const r = await appel("GET", "/attendance-v2/payroll?month=2026-09", { token, societe: 1 });
  return { status: r.status, droits: r.data?.droits, demande: r.data?.demande, run: r.data?.run };
};
const soldes = async () => (await q(
  `SELECT (SELECT COALESCE(sum(solde_actuel),0) FROM caisses WHERE company_id=1)        AS caisses,
          (SELECT COALESCE(sum(current_balance),0) FROM accounting_banks WHERE company_id=1) AS banques,
          (SELECT COALESCE(sum(current_balance),0) FROM treasury_accounts WHERE company_id=1) AS tresorerie,
          (SELECT count(*) FROM accounting_transactions WHERE company_id=1)             AS ecritures,
          (SELECT count(*) FROM attendance_payroll_items_v2 WHERE company_id=1 AND status='PAID') AS payes`))[0];

/* Remet la paie de septembre en brouillon, sans rien supprimer : chaque
   catégorie repart du même état sans dépendre de la précédente. */
async function remettreEnBrouillon() {
  const r = await run();
  if (!r) return null;
  await q(`UPDATE payroll_requests SET status='ANNULEE' WHERE payroll_run_id=$1 AND status='EN_ATTENTE_DIRECTION'`, [r.id]);
  await q(`UPDATE attendance_payroll_runs_v2 SET status='DRAFT' WHERE id=$1`, [r.id]);
  await q(`UPDATE attendance_periods SET status='PAIE_PREPAREE' WHERE company_id=1 AND code='2026-09'`);
  return r;
}

(async () => {
  const tS = jeton(SUPER), tC = jeton(COMPTA), tF = jeton(FORGE);

  console.log("\n⓿ ÉTAT DE DÉPART");
  /* Le directeur ne perçoit volontairement aucun salaire : sans cette
     déclaration sa ligne reste BLOCKED et la soumission refuse — ce qui est le
     comportement voulu. */
  const emp = (await q(`SELECT id FROM attendance_employees WHERE full_name='Mohamedou Diallo'`))[0]?.id;
  if (emp) await appel("POST", `/paie/salaries/${emp}/non-remunere`, { token: tS, societe: 1, corps: {
    reason: "Directeur : ne percoit volontairement aucun salaire. Decision direction." } });

  let r = await appel("POST", "/paie/periodes/2026-09/preparer", { token: tS, societe: 1, corps: {} });
  v("la paie de septembre est préparée", r.status === 200 || r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  const paie = await run();
  v("la paie existe et est en brouillon", paie?.status === "DRAFT", paie?.status);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n① L'AUTEUR ORDINAIRE — comptable, non super administrateur en base");
  r = await appel("POST", `/paie/runs/${paie.id}/soumettre`, { token: tC, societe: 1, corps: {} });
  v("le comptable soumet sa paie", r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  let d = await droitsDe(tC);
  v("les droits sont renvoyés par le serveur", typeof d.droits?.peut_decider === "boolean", JSON.stringify(d.droits));
  v("la demande en attente est renvoyée", Boolean(d.demande), JSON.stringify(d.demande));
  v("est_super_admin est faux (lu en base)", d.droits?.est_super_admin === false);
  v("il est reconnu auteur de la soumission", d.droits?.est_auteur_de_la_soumission === true);
  v("il PEUT retirer sa soumission", d.droits?.peut_retirer_sa_soumission === true, JSON.stringify(d.droits));
  v("il NE PEUT PAS décider", d.droits?.peut_decider === false);
  v("aucune incohérence signalée", d.droits?.incoherence === null);
  /* Le jeu d'essai accorde VOLONTAIREMENT `paie.validate` au comptable : sans
     cela on éprouverait le RBAC, et non la règle métier « l'auteur ne décide
     pas ». Le motif attendu est donc l'auteur, pas un droit manquant. */
  v("il a bien le droit RBAC de valider", d.droits?.peut_valider === true, JSON.stringify(d.droits));
  v("le motif du refus de décision est nommé", d.droits?.motif_sans_decision === "AUTEUR_DE_LA_SOUMISSION",
    String(d.droits?.motif_sans_decision));
  v("aucun motif n'empêche le retrait", d.droits?.motif_sans_retrait === null, String(d.droits?.motif_sans_retrait));
  r = await appel("POST", `/paie/runs/${paie.id}/decision`, { token: tC, societe: 1, corps: { decision: "VALIDEE" } });
  v("la route refuse avec SELF_APPROVAL_FORBIDDEN", r.data?.code === "SELF_APPROVAL_FORBIDDEN",
    `${r.status} ${JSON.stringify(r.data)}`);

  console.log("\n①bis LES DROITS RBAC MANQUANTS SONT NOMMÉS, PAS DEVINÉS");
  /* Un DENY nominatif sur `validate` : l'écran doit dire « votre compte n'a pas
     le droit Valider », et non « la validation revient à quelqu'un d'autre ». */
  await q(`INSERT INTO user_permission_overrides(company_id,user_id,module_key,action,effect)
           VALUES (1,903,'paie','validate','DENY')
           ON CONFLICT (company_id,user_id,module_key,action) DO UPDATE SET effect='DENY'`);
  d = await droitsDe(tC);
  v("le droit de valider est retiré", d.droits?.peut_valider === false, JSON.stringify(d.droits));
  v("le motif devient « droit validate manquant »", d.droits?.motif_sans_decision === "DROIT_VALIDATE_MANQUANT",
    String(d.droits?.motif_sans_decision));
  await q(`DELETE FROM user_permission_overrides WHERE user_id=903 AND module_key='paie' AND action='validate'`);
  /* Même chose pour le RETRAIT : il passe par `paie.submit`. Sans ce droit, le
     bouton ne doit pas être proposé — sinon la route répondrait 403 après le
     clic, ce qui était exactement le reproche fait à l'écran. */
  await q(`INSERT INTO user_permission_overrides(company_id,user_id,module_key,action,effect)
           VALUES (1,903,'paie','submit','DENY')
           ON CONFLICT (company_id,user_id,module_key,action) DO UPDATE SET effect='DENY'`);
  d = await droitsDe(tC);
  v("sans le droit « Soumettre », le retrait n'est pas proposé", d.droits?.peut_retirer_sa_soumission === false);
  v("et le motif nomme le droit manquant", d.droits?.motif_sans_retrait === "DROIT_SUBMIT_MANQUANT",
    String(d.droits?.motif_sans_retrait));
  r = await appel("POST", `/paie/runs/${paie.id}/retirer-soumission`,
    { token: tC, societe: 1, corps: { reason: "Retrait tente sans le droit Soumettre" } });
  v("la route refuse aussi : l'écran et le serveur disent la même chose", r.status === 403 || r.status === 404,
    `${r.status} ${JSON.stringify(r.data)}`);
  await q(`DELETE FROM user_permission_overrides WHERE user_id=903 AND module_key='paie' AND action='submit'`);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n② L'AUTEUR EST LE VRAI SUPER ADMINISTRATEUR — les deux boutons");
  await remettreEnBrouillon();
  r = await appel("POST", `/paie/runs/${paie.id}/soumettre`, { token: tS, societe: 1, corps: {} });
  v("le super administrateur soumet", r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  d = await droitsDe(tS);
  v("est_super_admin est vrai (lu en base)", d.droits?.est_super_admin === true);
  v("il est auteur de la soumission", d.droits?.est_auteur_de_la_soumission === true);
  v("il PEUT décider — c'est l'exception autorisée", d.droits?.peut_decider === true, JSON.stringify(d.droits));
  v("il PEUT aussi retirer sa soumission", d.droits?.peut_retirer_sa_soumission === true);
  v("aucun motif d'indisponibilité", d.droits?.motif_sans_decision === null && d.droits?.motif_sans_retrait === null);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n③ UN TIERS HABILITÉ — il tranche la soumission d'autrui");
  /* La soumission est celle du super administrateur (catégorie ②). Le
     comptable, qui n'en est pas l'auteur, doit pouvoir décider — et ne doit
     surtout pas pouvoir retirer la soumission de quelqu'un d'autre. */
  d = await droitsDe(tC);
  v("il n'est pas l'auteur", d.droits?.est_auteur_de_la_soumission === false);
  v("il PEUT décider", d.droits?.peut_decider === true, JSON.stringify(d.droits));
  v("il NE PEUT PAS retirer la soumission d'autrui", d.droits?.peut_retirer_sa_soumission === false);
  v("le motif du refus de retrait est nommé", d.droits?.motif_sans_retrait === "NI_AUTEUR_NI_SUPER_ADMIN",
    String(d.droits?.motif_sans_retrait));
  r = await appel("POST", `/paie/runs/${paie.id}/retirer-soumission`,
    { token: tC, societe: 1, corps: { reason: "Tentative de retrait par un tiers" } });
  v("la route refuse le retrait par un tiers", r.data?.code === "WITHDRAW_NOT_AUTHOR", `${r.status} ${JSON.stringify(r.data)}`);
  r = await appel("POST", `/paie/runs/${paie.id}/decision`,
    { token: tC, societe: 1, corps: { decision: "CORRECTION_DEMANDEE", reason: "Revoir les primes de septembre" } });
  v("le tiers peut demander une correction", r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n④ JETON FORGÉ — super administrateur dans le jeton, pas en base");
  d = await droitsDe(tF);
  v("le serveur relit la base et répond FAUX", d.droits?.est_super_admin === false, JSON.stringify(d.droits));
  await remettreEnBrouillon();
  r = await appel("POST", `/paie/runs/${paie.id}/soumettre`, { token: tF, societe: 1, corps: {} });
  v("le compte soumet la paie", r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  d = await droitsDe(tF);
  v("auteur, et non super administrateur", d.droits?.est_auteur_de_la_soumission === true && d.droits?.est_super_admin === false);
  v("aucun droit de décider n'est annoncé", d.droits?.peut_decider === false);
  v("le motif est « auteur de la soumission »", d.droits?.motif_sans_decision === "AUTEUR_DE_LA_SOUMISSION",
    String(d.droits?.motif_sans_decision));
  r = await appel("POST", `/paie/runs/${paie.id}/decision`, { token: tF, societe: 1, corps: { decision: "VALIDEE" } });
  v("l'auto-validation est refusée malgré le jeton", r.data?.code === "SELF_APPROVAL_FORBIDDEN", `${r.status} ${JSON.stringify(r.data)}`);
  r = await appel("POST", "/paie/periodes/2026-09/exception-absences",
    { token: tF, societe: 1, corps: { actif: true, reason: "Tentative avec un jeton forge sur la periode" } });
  v("lever la retenue des absences est refusé au jeton forgé", r.data?.code === "EXCEPTION_FORBIDDEN", `${r.status} ${JSON.stringify(r.data)}`);
  v("la période n'a PAS été modifiée",
    (await q(`SELECT absences_non_retenues FROM attendance_periods WHERE company_id=1 AND code='2026-09'`))[0]
      ?.absences_non_retenues === false);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑤ LE RETRAIT — un geste réel, avec un motif enregistré");
  await remettreEnBrouillon();
  await appel("POST", `/paie/runs/${paie.id}/soumettre`, { token: tS, societe: 1, corps: {} });
  r = await appel("POST", `/paie/runs/${paie.id}/retirer-soumission`, { token: tS, societe: 1, corps: { reason: "court" } });
  v("un motif trop court est refusé", r.data?.code === "REASON_REQUIRED", `${r.status} ${JSON.stringify(r.data)}`);
  v("la paie est restée EN_ATTENTE_DIRECTION", (await run())?.status === "EN_ATTENTE_DIRECTION");
  const MOTIF = "Correction des primes avant nouvelle soumission";
  r = await appel("POST", `/paie/runs/${paie.id}/retirer-soumission`, { token: tS, societe: 1, corps: { reason: MOTIF } });
  v("l'auteur retire sa soumission", r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  const dem = await demandeDe(paie.id);
  v("la demande passe à ANNULEE", dem?.status === "ANNULEE", dem?.status);
  v("le motif est enregistré dans la demande", String(dem?.decision_reason || "").includes(MOTIF), dem?.decision_reason);
  v("la paie revient en DRAFT", (await run())?.status === "DRAFT", (await run())?.status);
  v("la période revient à PAIE_PREPAREE",
    (await q(`SELECT status FROM attendance_periods WHERE company_id=1 AND code='2026-09'`))[0]?.status === "PAIE_PREPAREE");
  v("aucun salarié n'est payé après un retrait",
    Number((await soldes()).payes) === 0);
  r = await appel("POST", `/paie/runs/${paie.id}/retirer-soumission`, { token: tS, societe: 1, corps: { reason: MOTIF } });
  v("un second retrait n'a plus rien à retirer", r.data?.code === "REQUEST_NOT_PENDING", `${r.status} ${JSON.stringify(r.data)}`);
  d = await droitsDe(tS);
  v("plus de soumission en attente : aucune action proposée", d.droits?.peut_decider === false && d.droits?.peut_retirer_sa_soumission === false);
  v("et le motif le dit sans ambiguïté", d.droits?.motif_sans_decision === "AUCUNE_SOUMISSION", String(d.droits?.motif_sans_decision));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑥ AUTORISER N'EST PAS PAYER");
  await remettreEnBrouillon();
  await appel("POST", `/paie/runs/${paie.id}/soumettre`, { token: tS, societe: 1, corps: {} });
  const avant = await soldes();
  r = await appel("POST", `/paie/runs/${paie.id}/decision`, { token: tS, societe: 1, corps: { decision: "VALIDEE" } });
  v("le super administrateur autorise sa propre paie", r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  const apres = await soldes();
  v("la paie est AUTORISEE_AU_PAIEMENT", (await run())?.status === "AUTORISEE_AU_PAIEMENT", (await run())?.status);
  v("aucune caisse n'a été débitée", String(avant.caisses) === String(apres.caisses), `${avant.caisses} → ${apres.caisses}`);
  v("aucune banque n'a été débitée", String(avant.banques) === String(apres.banques), `${avant.banques} → ${apres.banques}`);
  v("la trésorerie est inchangée", String(avant.tresorerie) === String(apres.tresorerie), `${avant.tresorerie} → ${apres.tresorerie}`);
  v("aucune écriture comptable n'a été créée", String(avant.ecritures) === String(apres.ecritures), `${avant.ecritures} → ${apres.ecritures}`);
  v("aucun salarié n'est marqué PAID", Number(apres.payes) === 0, String(apres.payes));
  const dem2 = await demandeDe(paie.id);
  v("l'auto-validation laisse une trace explicite",
    String(dem2?.decision_reason || "").startsWith("[Auto-validation super administrateur]"), dem2?.decision_reason);
  /* Une paie autorisée qu'on ne pourrait jamais payer ne serait pas un
     contrôle mais une impasse : la garde du paiement doit accepter la même
     exception, relue en base. On ne paie rien ici — on vérifie seulement que
     ce n'est plus CETTE garde qui refuse. */
  const ligneAPayer = (await q(
    `SELECT id FROM attendance_payroll_items_v2 WHERE payroll_run_id=$1 AND status='TO_PAY' AND net_salary > 0 LIMIT 1`,
    [paie.id]))[0]?.id;
  if (ligneAPayer) {
    r = await appel("POST", `/attendance-v2/payroll-items/${ligneAPayer}/pay`,
      { token: tS, societe: 1, corps: { payment_method: "CASH" } });
    v("la garde « validée par son auteur » ne bloque plus le super administrateur",
      r.data?.code !== "SELF_APPROVED_REQUEST", `${r.status} ${JSON.stringify(r.data)}`);
    v("et aucun salaire n'a pourtant été payé (fonds absents en base de test)",
      Number((await soldes()).payes) === 0, JSON.stringify(await soldes()));
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑦ INCOHÉRENCE — paie « en attente » sans demande en attente");
  await remettreEnBrouillon();
  await appel("POST", `/paie/runs/${paie.id}/soumettre`, { token: tS, societe: 1, corps: {} });
  /* On fabrique l'état que l'écran interprétait à tort comme une règle
     métier : la paie attend la Direction, mais aucune demande n'est en
     attente. C'est exactement ce que voit une page dont le backend ne renvoie
     pas de demande. */
  await q(`UPDATE payroll_requests SET status='ANNULEE' WHERE payroll_run_id=$1 AND status='EN_ATTENTE_DIRECTION'`, [paie.id]);
  d = await droitsDe(tS);
  v("la paie est toujours EN_ATTENTE_DIRECTION", d.run?.status === "EN_ATTENTE_DIRECTION", d.run?.status);
  v("l'incohérence est signalée, et non déguisée en règle", d.droits?.incoherence?.code === "DEMANDE_INTROUVABLE",
    JSON.stringify(d.droits?.incoherence));
  v("le dernier statut connu de la demande est donné", d.droits?.incoherence?.derniere_demande_statut === "ANNULEE",
    String(d.droits?.incoherence?.derniere_demande_statut));
  v("aucune décision n'est proposée", d.droits?.peut_decider === false);
  v("aucun retrait n'est proposé", d.droits?.peut_retirer_sa_soumission === false);
  v("les deux motifs nomment la même cause",
    d.droits?.motif_sans_decision === "DEMANDE_INTROUVABLE" && d.droits?.motif_sans_retrait === "DEMANDE_INTROUVABLE",
    `${d.droits?.motif_sans_decision} / ${d.droits?.motif_sans_retrait}`);
  r = await appel("POST", `/paie/runs/${paie.id}/decision`, { token: tS, societe: 1, corps: { decision: "VALIDEE" } });
  v("la route est d'accord avec l'écran : rien à décider", r.data?.code === "REQUEST_NOT_PENDING", `${r.status} ${JSON.stringify(r.data)}`);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑧ ISOLEMENT DES SOCIÉTÉS — FAT & MAT reste hors de portée");
  const avantFat = (await q(
    `SELECT count(*)::int AS n FROM attendance_payroll_runs_v2 WHERE company_id=2`))[0].n;
  d = await droitsDe(tS);
  v("les droits portent sur Triangle seulement", d.status === 200);
  v("aucune paie n'a été créée chez FAT & MAT",
    (await q(`SELECT count(*)::int AS n FROM attendance_payroll_runs_v2 WHERE company_id=2`))[0].n === avantFat);
  v("aucun salarié de FAT & MAT n'est payé",
    (await q(`SELECT count(*)::int AS n FROM attendance_payroll_items_v2 WHERE company_id=2 AND status='PAID'`))[0].n === 0);

  console.log(`\n${ko === 0 ? "✅" : "❌"} ${ok} réussis, ${ko} échoués\n`);
  await pool.end();
  process.exit(ko === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
