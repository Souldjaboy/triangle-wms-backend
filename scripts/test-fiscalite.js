"use strict";

/**
 * FISCALITÉ ET COTISATIONS (migration 085).
 *
 *   bash scripts/test-fiscalite.sh
 *
 * Ce que la suite prouve — et qui est presque entièrement fait de refus :
 *
 *   • aucun taux n'est actif au départ ; une règle naît « à vérifier » quel
 *     que soit ce que le client envoie ;
 *   • une règle ne se valide pas sans référence de texte officiel ;
 *   • déclarer sans règle vérifiée exige un montant SAISI, et le dit ;
 *   • une règle vérifiée calcule, et le calcul est explicité ;
 *   • déclarer crée une DETTE sans toucher la trésorerie ;
 *   • seul le paiement débite, une fois, et produit une quittance ;
 *   • payer plus que dû est refusé, y compris en plusieurs fois ;
 *   • déclarer deux fois la même période est refusé ;
 *   • aucune pénalité n'est inventée : le message convenu est renvoyé ;
 *   • les règles sont VERSIONNÉES : la date de l'opération décide du taux.
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
const jeton = (id, role, companyId) =>
  jwt.sign({ id, fullname: `Compte ${id}`, email: `f${id}@essai.test`, role,
             company_id: companyId, is_super_admin: false }, SECRET, { expiresIn: "3h" });

async function appel(methode, chemin, token, corps) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  let json; try { json = JSON.parse(texte); } catch { json = { brut: texte }; }
  return { statut: r.status, corps: json };
}

const TRIANGLE = 1, FATMAT = 2;
let COMPTABLE = 0, DIRECTEUR = 0, COMPTABLE_F = 0, banqueId = 0;
const soldeBanque = async () =>
  Number((await q(`SELECT current_balance FROM accounting_banks WHERE id=$1`, [banqueId]))[0].current_balance);

async function poserLeJeu() {
  await pool.query(`DELETE FROM tax_payments`);
  await pool.query(`DELETE FROM tax_declarations`);
  await pool.query(`DELETE FROM tax_rules`);
  await pool.query(`DELETE FROM company_tax_obligations`);
  await pool.query(`DELETE FROM company_tax_profiles`);
  await pool.query(`DELETE FROM accounting_banks WHERE bank_name LIKE 'Banque Essai 085%'`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'fisc085-%@essai.test'`);

  const creer = async (email, nom, role, companyId) => (await pool.query(
    `INSERT INTO users (company_id, fullname, email, password, role, is_super_admin, is_active)
     VALUES ($1,$2,$3,'$non-utilisable$',$4,false,true) RETURNING id`,
    [companyId, nom, email, role])).rows[0].id;
  COMPTABLE   = await creer("fisc085-comptable@essai.test", "Essai 085 Comptable", "comptable", TRIANGLE);
  DIRECTEUR   = await creer("fisc085-directeur@essai.test", "Essai 085 Directeur", "direction", TRIANGLE);
  COMPTABLE_F = await creer("fisc085-comptable-f@essai.test", "Essai 085 Comptable FAT", "comptable", FATMAT);

  banqueId = (await pool.query(
    `INSERT INTO accounting_banks (company_id, bank_name, account_number, currency,
       initial_balance, current_balance, is_active)
     VALUES ($1,'Banque Essai 085','B085','FCFA',10000000,10000000,true) RETURNING id`,
    [TRIANGLE])).rows[0].id;

  await pool.query(`DELETE FROM user_permission_overrides WHERE user_id=ANY($1::int[])`,
    [[COMPTABLE, DIRECTEUR, COMPTABLE_F]]);
  const droit = (companyId, userId, action) => pool.query(
    `INSERT INTO user_permission_overrides (company_id, user_id, module_key, action, effect)
     VALUES ($1,$2,'fiscalite',$3,'ALLOW')
     ON CONFLICT (company_id, user_id, module_key, action) DO UPDATE SET effect='ALLOW'`,
    [companyId, userId, action]);
  for (const a of ["visible","view","create","update","pay","print"]) {
    await droit(TRIANGLE, COMPTABLE, a); await droit(FATMAT, COMPTABLE_F, a);
  }
  for (const a of ["visible","view","configure","validate","create"]) await droit(TRIANGLE, DIRECTEUR, a);
}

async function main() {
  console.log(`\n${G}FISCALITÉ ET COTISATIONS (085)${Z}`);
  await poserLeJeu();
  const tC = jeton(COMPTABLE, "comptable", TRIANGLE);
  const tD = jeton(DIRECTEUR, "direction", TRIANGLE);
  const tF = jeton(COMPTABLE_F, "comptable", FATMAT);

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}AU DÉPART, RIEN N'EST ACTIF${Z}`);
  {
    const cat = await appel("GET", "/fiscalite/catalogue", tC);
    verifier("le catalogue est chargé", cat.statut === 200 && (cat.corps.catalogue || []).length >= 15,
      `${(cat.corps.catalogue || []).length} types`);
    verifier("aucun type n'a de règle vérifiée",
      (cat.corps.catalogue || []).every((t) => t.regles_verifiees === 0));
    verifier("aucune obligation n'est active pour la société",
      (cat.corps.catalogue || []).every((t) => t.obligation_active === false));
    verifier("l'application le dit explicitement",
      typeof cat.corps.avertissement === "string" && cat.corps.avertissement.length > 20,
      cat.corps.avertissement);

    const codes = (cat.corps.catalogue || []).map((t) => t.code);
    for (const attendu of ["TVA", "ITS", "CFE", "CGS", "TFP", "TEJ", "PATENTE", "INPS", "AMO"]) {
      verifier(`le catalogue contient ${attendu}`, codes.includes(attendu));
    }
    const [patente] = (cat.corps.catalogue || []).filter((t) => t.code === "PATENTE");
    verifier("la patente dit qu'elle n'a aucun montant universel",
      /aucun montant universel/i.test(patente?.explanation || ""), patente?.explanation);

    const profil = await appel("GET", "/fiscalite/profil", tC);
    verifier("le profil fiscal n'est pas configuré et le signale",
      profil.corps.configure === false && typeof profil.corps.message === "string",
      profil.corps.message);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}DÉCLARER SANS OBLIGATION ACTIVE EST REFUSÉ${Z}`);
  {
    const r = await appel("POST", "/fiscalite/declarations", tC,
      { code: "CFE", period_code: "2026-08", base_amount: 1000000 });
    verifier("la déclaration est refusée tant que l'obligation n'est pas activée",
      r.statut === 409 && r.corps.code === "OBLIGATION_NOT_ACTIVE", JSON.stringify(r.corps));

    const parComptable = await appel("POST", "/fiscalite/obligations", tC,
      { code: "CFE", active: true });
    verifier("le comptable ne configure pas les obligations",
      parComptable.statut === 403 || parComptable.statut === 404, `statut ${parComptable.statut}`);

    const active = await appel("POST", "/fiscalite/obligations", tD, { code: "CFE", active: true });
    verifier("la Direction active l'obligation", active.statut === 200 && active.corps.obligation?.active === true,
      JSON.stringify(active.corps).slice(0, 120));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}UNE RÈGLE NAÎT « À VÉRIFIER », QUOI QU'ON ENVOIE${Z}`);
  let regleCFE = 0;
  {
    const r = await appel("POST", "/fiscalite/regles", tD, {
      code: "CFE", rate_percent: 3.5, effective_from: "2026-01-01",
      /* On tente délibérément d'imposer le statut : il doit être ignoré. */
      verification_status: "VERIFIEE",
      notes: "Valeur candidate, à confronter au texte en vigueur.",
    });
    verifier("la règle est créée", r.statut === 201, JSON.stringify(r.corps).slice(0, 120));
    regleCFE = r.corps.regle?.id;
    verifier("elle est À VÉRIFIER malgré le statut envoyé",
      r.corps.regle?.verification_status === "A_VERIFIER", r.corps.regle?.verification_status);
    verifier("l'application explique qu'elle ne calculera rien",
      /ne calculera rien/i.test(r.corps.message || ""), r.corps.message);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}SANS RÈGLE VÉRIFIÉE, LE MONTANT DOIT ÊTRE SAISI${Z}`);
  {
    const sansMontant = await appel("POST", "/fiscalite/declarations", tC,
      { code: "CFE", period_code: "2026-08", base_amount: 1000000 });
    verifier("déclarer sans montant saisi est refusé",
      sansMontant.statut === 409 && sansMontant.corps.code === "NO_VERIFIED_RULE",
      JSON.stringify(sansMontant.corps));
    verifier("le refus explique quoi faire",
      /saisissez le montant|validez d'abord/i.test(sansMontant.corps.error || ""),
      sansMontant.corps.error);

    const avecMontant = await appel("POST", "/fiscalite/declarations", tC,
      { code: "CFE", period_code: "2026-08", base_amount: 1000000, declared_amount: 35000 });
    verifier("avec un montant saisi, la déclaration passe", avecMontant.statut === 201,
      JSON.stringify(avecMontant.corps).slice(0, 150));
    verifier("l'application dit que le montant vient de la saisie",
      avecMontant.corps.calcul === "saisi", avecMontant.corps.calcul);
    verifier("elle avertit qu'une règle existe mais n'est pas vérifiée",
      typeof avecMontant.corps.avertissement === "string", avecMontant.corps.avertissement);
    verifier("et n'invente aucune pénalité",
      /non configuré/i.test(avecMontant.corps.penalite || ""), avecMontant.corps.penalite);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}VALIDER UNE RÈGLE EXIGE SA SOURCE${Z}`);
  {
    const sansSource = await appel("POST", `/fiscalite/regles/${regleCFE}/verifier`, tD, {});
    verifier("valider sans référence de texte est refusé",
      sansSource.statut === 400 && sansSource.corps.code === "SOURCE_REQUIRED",
      JSON.stringify(sansSource.corps));

    const parComptable = await appel("POST", `/fiscalite/regles/${regleCFE}/verifier`, tC,
      { source_reference: "CGI, article X" });
    verifier("le comptable ne valide pas une règle fiscale",
      parComptable.statut === 403 || parComptable.statut === 404, `statut ${parComptable.statut}`);

    const r = await appel("POST", `/fiscalite/regles/${regleCFE}/verifier`, tD, {
      source_reference: "Code général des impôts du Mali — contribution forfaitaire employeurs",
      source_url: "https://www.dgi.gouv.ml/CGI/",
      verified_at: "2026-09-04",
    });
    verifier("la Direction valide la règle avec sa source", r.statut === 200,
      JSON.stringify(r.corps).slice(0, 120));
    verifier("la règle porte sa source et sa date de vérification",
      r.corps.regle?.verification_status === "VERIFIEE"
      && String(r.corps.regle?.source_reference || "").length > 10
      && r.corps.regle?.verified_at != null,
      JSON.stringify(r.corps.regle).slice(0, 200));

    /* La base elle-même refuse une règle « vérifiée » sans source. */
    let contrainte = null;
    try {
      await pool.query(
        `INSERT INTO tax_rules (tax_type_id, effective_from, verification_status)
         VALUES ((SELECT id FROM tax_types WHERE code='TVA'), '2026-01-01', 'VERIFIEE')`);
    } catch (e) { contrainte = e; }
    verifier("PostgreSQL refuse une règle VÉRIFIÉE sans source ni date",
      Boolean(contrainte), contrainte ? "refusée comme attendu" : "ACCEPTÉE À TORT");
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}UNE RÈGLE VÉRIFIÉE CALCULE, ET LE DIT${Z}`);
  let declaration = 0;
  {
    const banqueAvant = await soldeBanque();
    const r = await appel("POST", "/fiscalite/declarations", tC,
      { code: "CFE", period_code: "2026-09", base_amount: 2000000 });
    verifier("la déclaration est calculée", r.statut === 201, JSON.stringify(r.corps).slice(0, 150));
    declaration = r.corps.declaration?.id;
    verifier("3,5 % de 2 000 000 font 70 000",
      Number(r.corps.declaration?.declared_amount) === 70000,
      `${r.corps.declaration?.declared_amount}`);
    verifier("le calcul est explicité",
      /3\.5|3,5/.test(r.corps.calcul || ""), r.corps.calcul);
    verifier("la règle utilisée est citée avec sa référence",
      String(r.corps.regle_utilisee?.reference || "").length > 10,
      JSON.stringify(r.corps.regle_utilisee));

    const banqueApres = await soldeBanque();
    verifier("DÉCLARER ne touche pas la trésorerie",
      banqueApres === banqueAvant, `${banqueAvant} → ${banqueApres}`);

    const ecritures = await q(
      `SELECT account_label, debit, credit FROM accounting_entries
        WHERE source_type='tax_declaration' AND source_id=$1`, [declaration]);
    verifier("mais crée bien une dette au passif",
      ecritures.some((e) => /Dettes fiscales/i.test(e.account_label) && Number(e.credit) === 70000),
      JSON.stringify(ecritures));

    const doublon = await appel("POST", "/fiscalite/declarations", tC,
      { code: "CFE", period_code: "2026-09", base_amount: 2000000 });
    verifier("déclarer deux fois la même période est refusé",
      doublon.statut === 409 && doublon.corps.code === "DECLARATION_ALREADY_EXISTS",
      JSON.stringify(doublon.corps));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}SEUL LE PAIEMENT DÉBITE${Z}`);
  {
    const banqueAvant = await soldeBanque();

    const p1 = await appel("POST", `/fiscalite/declarations/${declaration}/paiement`, tC,
      { amount: 30000, bank_id: banqueId, receipt_number: "QUIT-085-1" });
    verifier("un paiement partiel passe", p1.statut === 200, JSON.stringify(p1.corps).slice(0, 150));
    verifier("il reste 40 000 dus", Number(p1.corps.reste_du) === 40000, `${p1.corps.reste_du}`);
    verifier("une quittance numérotée est produite",
      /^PAI-FISC-\d{4}-\d{6}$/.test(p1.corps.quittance || ""), p1.corps.quittance);

    const [apresPartiel] = await q(`SELECT status FROM tax_declarations WHERE id=$1`, [declaration]);
    verifier("la déclaration passe en PARTIELLEMENT_PAYEE",
      apresPartiel.status === "PARTIELLEMENT_PAYEE", apresPartiel.status);

    const trop = await appel("POST", `/fiscalite/declarations/${declaration}/paiement`, tC,
      { amount: 50000, bank_id: banqueId });
    verifier("payer plus que le reste dû est refusé",
      trop.statut === 409 && trop.corps.code === "PAYMENT_ABOVE_DUE", JSON.stringify(trop.corps));

    const p2 = await appel("POST", `/fiscalite/declarations/${declaration}/paiement`, tC,
      { amount: 40000, bank_id: banqueId, receipt_number: "QUIT-085-2" });
    verifier("le solde se paie", p2.statut === 200 && Number(p2.corps.reste_du) === 0,
      JSON.stringify(p2.corps).slice(0, 120));

    const [soldee] = await q(`SELECT status FROM tax_declarations WHERE id=$1`, [declaration]);
    verifier("la déclaration passe à PAYEE", soldee.status === "PAYEE", soldee.status);

    const banqueApres = await soldeBanque();
    verifier("la banque a diminué d'exactement 70 000, une seule fois",
      banqueAvant - banqueApres === 70000, `${banqueAvant} → ${banqueApres}`);

    const encore = await appel("POST", `/fiscalite/declarations/${declaration}/paiement`, tC,
      { amount: 1000, bank_id: banqueId });
    verifier("payer une déclaration soldée est refusé", encore.statut === 409,
      JSON.stringify(encore.corps));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LES RÈGLES SONT VERSIONNÉES${Z}`);
  {
    /* Une seconde version, à partir de 2027 : la déclaration de 2026 doit
       continuer d'utiliser l'ancienne. */
    const nouvelle = await appel("POST", "/fiscalite/regles", tD, {
      code: "CFE", rate_percent: 4.0, effective_from: "2027-01-01" });
    await appel("POST", `/fiscalite/regles/${nouvelle.corps.regle.id}/verifier`, tD, {
      source_reference: "Loi de finances hypothétique 2027 — jeu d'essai",
      verified_at: "2026-09-04" });

    const en2026 = await appel("POST", "/fiscalite/declarations", tC,
      { code: "CFE", period_code: "2026-10", base_amount: 1000000 });
    verifier("une période de 2026 applique encore 3,5 %",
      Number(en2026.corps.declaration?.declared_amount) === 35000,
      `${en2026.corps.declaration?.declared_amount}`);

    const en2027 = await appel("POST", "/fiscalite/declarations", tC,
      { code: "CFE", period_code: "2027-02", base_amount: 1000000 });
    verifier("une période de 2027 applique 4 %",
      Number(en2027.corps.declaration?.declared_amount) === 40000,
      `${en2027.corps.declaration?.declared_amount}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}CALENDRIER, RETARDS ET PÉNALITÉS${Z}`);
  {
    const cal = await appel("GET", "/fiscalite/calendrier", tC);
    verifier("le calendrier répond", cal.statut === 200, JSON.stringify(cal.corps).slice(0, 120));
    verifier("il ne montre que ce qui reste dû",
      (cal.corps.echeances || []).every((e) => !["PAYEE", "EXONEREE", "ANNULEE"].includes(e.status)));
    verifier("il n'invente aucune pénalité et renvoie le message convenu",
      cal.corps.penalite === "Taux de pénalité non configuré — vérifier auprès de la DGI ou du comptable.",
      cal.corps.penalite);

    const [enRetard] = await q(
      `SELECT count(*)::int AS n FROM tax_declarations
        WHERE company_id=$1 AND penalty_amount IS NOT NULL`, [TRIANGLE]);
    verifier("aucune pénalité n'a été calculée en base", enRetard.n === 0, `${enRetard.n}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}ISOLATION ENTRE SOCIÉTÉS${Z}`);
  {
    const decl = await appel("GET", "/fiscalite/declarations", tF);
    verifier("FAT & MAT ne voit aucune déclaration Triangle",
      (decl.corps.declarations || []).length === 0, `${(decl.corps.declarations || []).length}`);

    const paiementCroise = await appel("POST", `/fiscalite/declarations/${declaration}/paiement`, tF,
      { amount: 1000 });
    verifier("elle ne peut pas payer une déclaration Triangle",
      paiementCroise.statut === 404, JSON.stringify(paiementCroise.corps));

    const cat = await appel("GET", "/fiscalite/catalogue", tF);
    verifier("le catalogue lui est commun, mais sans obligation active",
      (cat.corps.catalogue || []).every((t) => t.obligation_active === false));
  }

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
