"use strict";
/**
 * §A — LES DOCUMENTS DU PERSONNEL.
 *
 * Ce que ces tests éprouvent n'est pas « un PDF a été produit » — un fichier
 * se produit toujours. C'est :
 *
 *   • qu'un bulletin SANS taux de cotisation paramétré n'affiche AUCUN net,
 *     et dit pourquoi, au lieu d'un montant faux d'allure crédible ;
 *   • qu'un CDD sans motif de recours et un CDI avec date de fin sont
 *     refusés, parce que ce ne sont pas des contrats ;
 *   • qu'une clause non relue par un juriste porte une mention VISIBLE sur
 *     le document imprimé ;
 *   • qu'un salaire ne s'affiche pas à qui n'a pas le droit de le voir ;
 *   • et que le PDF contient réellement ce qu'on croit y avoir mis.
 */
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const pymupdfDispo = (() => { try { require("child_process").execFileSync("python3", ["-c", "import pymupdf"], { stdio: "pipe" }); return true; } catch { return false; } })();
const BASE = "http://localhost:5050";
const SECRET = process.env.JWT_SECRET || "triangle_wms_secret_key";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let ok = 0, ko = 0;
const v = (n, c, d = "") => { if (c) { ok++; console.log(`  ✔ ${n}`); } else { ko++; console.log(`  ✘ ${n}${d ? `\n      → ${d}` : ""}`); } };
const jeton = (u) => jwt.sign({ ...u, tenant_id: "triangle" }, SECRET, { expiresIn: "1h" });
const q = async (s, p = []) => (await pool.query(s, p)).rows;
const un = async (s, p = []) => (await q(s, p))[0];

async function appel(m, chemin, { token, societe, corps, brut } = {}) {
  const headers = { "x-tenant-id": "triangle" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (societe) headers["x-active-company-id"] = String(societe);
  if (corps !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(BASE + chemin, { method: m, headers,
    body: corps === undefined ? undefined : JSON.stringify(corps) });
  if (brut) return { status: r.status, buffer: Buffer.from(await r.arrayBuffer()),
                     type: r.headers.get("content-type") };
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

/** Le TEXTE réellement présent dans le PDF, pas ce qu'on a voulu y mettre. */
function texteDuPdf(buffer) {
  if (!pymupdfDispo) return null;
  const fs = require("fs"); const os = require("os"); const path = require("path");
  const f = path.join(os.tmpdir(), `rh-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(f, buffer);
  try {
    const out = require("child_process").execFileSync("python3", ["-c",
      `import pymupdf,re,sys;d=pymupdf.open(sys.argv[1]);print(re.sub(r'\\s+',' ',' '.join(p.get_text() for p in d)));print('PAGES:'+str(d.page_count))`,
      f], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return out;
  } finally { try { fs.unlinkSync(f); } catch { /* ignoré */ } }
}
const pagesDu = (texte) => Number((String(texte).match(/PAGES:(\d+)/) || [])[1] || 0);

const SUPER  = { id: 900, fullname: "Super Triangle", role: "super_admin", company_id: 1, is_super_admin: true };
const SUPER_F= { id: 901, fullname: "Super Fatemat", role: "super_admin", company_id: 2, is_super_admin: true };
const COMPTA = { id: 903, fullname: "Comptable Triangle", role: "comptable", company_id: 1, is_super_admin: false };
const RH     = { id: 908, fullname: "Assistante RH", role: "assistant_rh", company_id: 1, is_super_admin: false };
const ZERBO  = { id: 906, fullname: "Zerbo Magasinier", role: "magasinier", company_id: 1, is_super_admin: false };

const EMP = 801, EMP2 = 802, EMP_FAT = 809;

(async () => {
  const tS = jeton(SUPER), tF = jeton(SUPER_F), tC = jeton(COMPTA), tRH = jeton(RH), tZ = jeton(ZERBO);

  /* ══════════════════════════════════════════════════════════════════════
     1. LES CLAUSES SONT DES DONNÉES, ET ELLES SONT À VALIDER
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n1. Les clauses de contrat");

  const cl = await appel("GET", "/rh/clauses", { token: tS, societe: 1 });
  v("les clauses se lisent", cl.status === 200, `${cl.status}`);
  v("quatorze clauses sont livrées", (cl.data?.clauses || []).length === 14,
    `${(cl.data?.clauses || []).length}`);
  v("toutes sont marquées à faire valider par un juriste",
    cl.data?.a_valider === 14, `${cl.data?.a_valider}`);
  v("l'avertissement le dit",
    /n'ont pas été relues par un juriste/.test(String(cl.data?.avertissement)),
    String(cl.data?.avertissement));
  v("aucune clause ne prévoit de sanction ni de retenue automatique",
    !(cl.data?.clauses || []).some((c) =>
      /sanction|retenue sur salaire|amende|pénalité/i.test(String(c.body))),
    (cl.data?.clauses || []).filter((c) => /sanction|amende/i.test(c.body)).map((c) => c.clause_key).join(","));
  v("les clauses propres au CDD et au CDI sont distinguées",
    (cl.data?.clauses || []).some((c) => c.clause_key === "TERME_CDD" && !c.applies_to.includes("CDI"))
    && (cl.data?.clauses || []).some((c) => c.clause_key === "RUPTURE_CDI" && !c.applies_to.includes("CDD")));

  /* ══════════════════════════════════════════════════════════════════════
     2. CE QUI N'EST PAS UN CONTRAT EST REFUSÉ
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n2. CDI et CDD : ce que la base refuse");

  const refus = [
    ["un CDI avec une date de fin",
     { employee_id: EMP, contract_type: "CDI", job_title: "Responsable", start_date: "2026-11-01", end_date: "2027-11-01" },
     "CDI_WITH_END_DATE"],
    ["un CDD sans date de fin",
     { employee_id: EMP, contract_type: "CDD", job_title: "Responsable", start_date: "2026-11-01", cdd_reason: "Surcroît" },
     "END_DATE_REQUIRED"],
    ["un CDD sans motif de recours",
     { employee_id: EMP, contract_type: "CDD", job_title: "Responsable", start_date: "2026-11-01", end_date: "2027-04-30" },
     "CDD_REASON_REQUIRED"],
    ["un type inventé",
     { employee_id: EMP, contract_type: "INTERIM", job_title: "Responsable", start_date: "2026-11-01" },
     "CONTRACT_TYPE_INVALID"],
    ["un salarié d'une autre société",
     { employee_id: EMP_FAT, contract_type: "CDI", job_title: "Chauffeur", start_date: "2026-11-01" },
     "EMPLOYEE_NOT_FOUND"],
  ];
  for (const [quoi, corps, code] of refus) {
    const r = await appel("POST", "/rh/contrats", { token: tS, societe: 1, corps });
    v(`refusé : ${quoi} (${code})`, r.status >= 400 && r.data?.code === code,
      `${r.status} ${JSON.stringify(r.data)}`);
  }
  v("le message du CDD explique qu'aucun motif par défaut n'est proposé",
    /c'est à l'employeur de le dire/.test(String(
      (await appel("POST", "/rh/contrats", { token: tS, societe: 1,
        corps: { employee_id: EMP, contract_type: "CDD", job_title: "X",
                 start_date: "2026-11-01", end_date: "2027-04-30" } })).data?.error)));

  /* ══════════════════════════════════════════════════════════════════════
     3. UN CDI, PUIS SON PDF
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n3. Le CDI");

  const cdi = await appel("POST", "/rh/contrats", { token: tS, societe: 1,
    corps: { employee_id: EMP, contract_type: "CDI", job_title: "Responsable d'entrepôt",
             site_label: "Entrepôt Sotuba", start_date: "2026-11-01",
             trial_period_days: 90, weekly_hours: 40, gross_salary: 450000,
             signed_place: "Bamako" } });
  v("le CDI est créé", cdi.status === 201, `${cdi.status} ${JSON.stringify(cdi.data)}`);
  const idCDI = cdi.data?.contrat?.id;
  v("il naît en BROUILLON", cdi.data?.contrat?.status === "BROUILLON");
  v("sa référence est unique et lisible", /^CT-\d{4}-\d{4}$/.test(String(cdi.data?.contrat?.reference)),
    String(cdi.data?.contrat?.reference));

  const act = await appel("POST", `/rh/contrats/${idCDI}/activer`, { token: tS, societe: 1, corps: {} });
  v("il s'active", act.status === 200 && act.data?.contrat?.status === "ACTIF", `${act.status}`);

  /* Un salarié n'a qu'un contrat actif : sinon, lequel payer ? */
  const second = await appel("POST", "/rh/contrats", { token: tS, societe: 1,
    corps: { employee_id: EMP, contract_type: "CDD", job_title: "Autre poste",
             start_date: "2026-12-01", end_date: "2027-06-01",
             cdd_reason: "Remplacement d'un salarié absent", gross_salary: 300000 } });
  v("un second contrat se crée bien (en brouillon)", second.status === 201,
    `${second.status} ${JSON.stringify(second.data)}`);
  const act2 = await appel("POST", `/rh/contrats/${second.data?.contrat?.id}/activer`,
    { token: tS, societe: 1, corps: {} });
  v("un second contrat actif pour le même salarié est refusé",
    act2.status === 409, `${act2.status} ${JSON.stringify(act2.data)}`);
  v("et le message explique pourquoi",
    /deux salaires/.test(String(act2.data?.error)), String(act2.data?.error));

  const pdfCDI = await appel("GET", `/rh/contrats/${idCDI}/pdf`, { token: tS, societe: 1, brut: true });
  v("le PDF du contrat est servi", pdfCDI.status === 200 && pdfCDI.type === "application/pdf",
    `${pdfCDI.status} ${pdfCDI.type}`);
  v("c'est bien un PDF", pdfCDI.buffer.slice(0, 5).toString() === "%PDF-",
    pdfCDI.buffer.slice(0, 8).toString());

  if (pymupdfDispo) {
    const t = texteDuPdf(pdfCDI.buffer);
    v("le PDF porte le titre du contrat", /CONTRAT À DURÉE INDÉTERMINÉE/.test(t));
    v("il nomme le salarié", /Aminata Coulibaly/.test(t));
    v("il porte la fonction et le site", /Responsable d'entrepôt/.test(t) && /Entrepôt Sotuba/.test(t));
    v("il porte la période d'essai et les horaires", /90 jour\(s\)/.test(t) && /40 heures/.test(t));
    /* Le montant doit être LISIBLE : l'espace fine insécable de
       toLocaleString ne s'encode pas et donnait « 450 /000 FCFA ». */
    v("le salaire s'écrit « 450 000 FCFA », sans caractère parasite",
      /450 000 FCFA/.test(t), (t.match(/4[^ ]{0,3} ?000 FCFA/) || ["—"])[0]);
    v("les articles sont numérotés en continu",
      /Article 1 —/.test(t) && /Article 11 —/.test(t));
    v("la clause propre au CDI y est, pas celle du CDD",
      /Rupture du contrat/.test(t) && !/Terme du contrat/.test(t));
    v("le bandeau juridique est VISIBLE sur le document",
      /À FAIRE VALIDER PAR UN CONSEIL JURIDIQUE AVANT SIGNATURE/.test(t));
    v("les deux signatures sont prévues",
      /L'employeur/.test(t) && /Le salarié/.test(t) && /lu et approuvé/.test(t));
    v("chaque page porte un en-tête et une pagination",
      /Page 1 \/ \d/.test(t) && /TRIANGLE LOGISTICS SARL/.test(t));
    /* Une annexe n'est jamais affirmée sans être jointe. */
    v("aucune annexe n'est affirmée alors qu'aucune n'est jointe", !/ANNEXES/.test(t));
    v("le document tient en deux pages, sans page quasi vide", pagesDu(t) === 2, `${pagesDu(t)}`);
  }

  /* ══════════════════════════════════════════════════════════════════════
     4. LE BULLETIN SANS TAUX — LE POINT CENTRAL
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n4. Un bulletin sans taux de cotisation paramétré");

  v("aucun taux n'est en base au départ",
    Number((await un(`SELECT count(*) c FROM tax_rules`)).c) === 0);

  const bp = await appel("POST", `/rh/bulletins/${EMP}/2026-10`, { token: tC, societe: 1,
    corps: { gains: [{ libelle: "Prime de transport", montant: 25000 }],
             retenues: [{ libelle: "Retenue avance", montant: 50000 }] } });
  v("le bulletin est tout de même établi", bp.status === 201, `${bp.status} ${JSON.stringify(bp.data)}`);
  /* LE POINT : aucun net. Un net faux a l'air juste. */
  v("mais le NET À PAYER n'est PAS calculé", bp.data?.calcul?.net_a_payer === null,
    String(bp.data?.calcul?.net_a_payer));
  v("le coût employeur non plus", bp.data?.calcul?.cout_employeur === null);
  v("les cotisations manquantes sont nommées",
    (bp.data?.calcul?.cotisations_manquantes || []).includes("ITS")
    && (bp.data?.calcul?.cotisations_manquantes || []).includes("INPS"),
    JSON.stringify(bp.data?.calcul?.cotisations_manquantes));
  v("sans doublon : INPS n'est cité qu'une fois",
    (bp.data?.calcul?.cotisations_manquantes || []).filter((c) => c === "INPS").length === 1);
  v("le message dit de saisir les taux avec leur référence officielle",
    /référence de texte officiel/.test(String(bp.data?.calcul?.avertissement)),
    String(bp.data?.calcul?.avertissement));
  v("le brut, lui, est bien calculé",
    bp.data?.calcul?.brut_total === 475000, `${bp.data?.calcul?.brut_total}`);

  if (pymupdfDispo) {
    const r = await appel("POST", `/rh/bulletins/${EMP}/2026-11?pdf=1`,
      { token: tC, societe: 1, corps: {}, brut: true });
    const t = texteDuPdf(r.buffer);
    v("le PDF porte « NET À PAYER : NON CALCULÉ »", /NET À PAYER : NON CALCULÉ/.test(t));
    v("et dit qu'il ne peut pas être remis en l'état",
      /ne peut pas être remis en l'état/.test(t));
    v("aucun montant de net n'apparaît", !/NET À PAYER [0-9]/.test(t));
  }

  /* ══════════════════════════════════════════════════════════════════════
     5. AVEC DES TAUX VÉRIFIÉS ET SOURCÉS
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n5. Une fois les taux saisis, avec leur source");

  /* Un taux vérifié SANS référence de texte officiel : c'est la BASE qui le
     refuse, pas seulement le moteur de bulletin. Garantie plus forte qu'un
     contrôle applicatif, qu'un import pourrait contourner. */
  let refuseParLaBase = null;
  try {
    await pool.query(
      `INSERT INTO tax_rules (tax_type_id, company_id, rate_percent, effective_from,
                              source_reference, verification_status)
       SELECT id, 1, 5, '2026-01-01', '', 'VERIFIEE' FROM tax_types WHERE code='ITS'`);
  } catch (e) { refuseParLaBase = e.constraint || e.code; }
  v("la base refuse un taux vérifié sans référence officielle",
    refuseParLaBase === "tax_rules_source_obligatoire_check", String(refuseParLaBase));
  await pool.query(`DELETE FROM tax_rules`);

  await pool.query(
    `INSERT INTO tax_rules (tax_type_id, company_id, rate_percent, effective_from,
                            source_reference, verification_status)
     SELECT id, 1, 5, '2026-01-01', 'Texte officiel cité', 'A_VERIFIER' FROM tax_types WHERE code='ITS'`);
  const nonVerifie = await appel("POST", `/rh/bulletins/${EMP}/2026-12`,
    { token: tC, societe: 1, corps: {} });
  v("un taux encore « à vérifier » ne calcule aucune retenue",
    (nonVerifie.data?.calcul?.cotisations_manquantes || []).includes("ITS"),
    JSON.stringify(nonVerifie.data?.calcul?.cotisations_manquantes));
  await pool.query(`DELETE FROM tax_rules`);

  /* Un taux VERIFIEE doit porter sa source ET sa date de vérification : la
     base l'exige, et c'est ce qui rend « vérifié » autre chose qu'un mot. */
  let sansDate = null;
  try {
    await pool.query(
      `INSERT INTO tax_rules (tax_type_id, company_id, rate_percent, effective_from,
                              source_reference, verification_status)
       SELECT id, 1, 5, '2026-01-01', 'Texte officiel cité', 'VERIFIEE'
         FROM tax_types WHERE code='ITS'`);
  } catch (e) { sansDate = e.constraint; }
  v("la base refuse aussi un taux vérifié sans date de vérification",
    sansDate === "tax_rules_source_obligatoire_check", String(sansDate));
  await pool.query(`DELETE FROM tax_rules`);

  for (const [code, taux] of [["ITS", 5], ["INPS", 3.6], ["AMO", 3.06], ["CGS", 1],
                              ["CFE", 3.5], ["TFP", 2], ["TEJ", 1]]) {
    await pool.query(
      `INSERT INTO tax_rules (tax_type_id, company_id, rate_percent, effective_from,
                              source_reference, verification_status, verified_at, verified_by)
       SELECT id, 1, $2, '2026-01-01', $3, 'VERIFIEE', CURRENT_DATE, 900
         FROM tax_types WHERE code=$1`,
      [code, taux, `Taux d'essai ${code} — référence à remplacer`]);
  }

  const bp2 = await appel("POST", `/rh/bulletins/${EMP}/2027-01`, { token: tC, societe: 1,
    corps: { gains: [{ libelle: "Prime de transport", montant: 25000 }],
             retenues: [{ libelle: "Retenue avance", montant: 50000 }] } });
  v("le bulletin est complet", bp2.data?.calcul?.complet === true,
    JSON.stringify(bp2.data?.calcul?.cotisations_manquantes));
  const c2 = bp2.data?.calcul;
  v("le brut total est 475 000", c2?.brut_total === 475000, `${c2?.brut_total}`);
  /* Les retenues salariales : 5 + 3,6 + 3,06 + 1 = 12,66 % de 475 000. */
  v("les retenues salariales valent 60 135", c2?.retenues_salariales === 60135,
    `${c2?.retenues_salariales}`);
  v("le net est 475 000 − 60 135 − 50 000 = 364 865", c2?.net_a_payer === 364865,
    `${c2?.net_a_payer}`);
  v("les charges patronales sont séparées du net",
    c2?.charges_patronales > 0 && c2.net_a_payer === c2.brut_total - c2.retenues_salariales - 50000);
  v("le coût employeur est brut + charges patronales",
    c2?.cout_employeur === c2.brut_total + c2.charges_patronales, `${c2?.cout_employeur}`);
  v("chaque ligne porte la référence de son taux",
    (c2?.lignes || []).every((l) => !!l.reference && l.reference.length > 5));

  if (pymupdfDispo) {
    const r = await appel("POST", `/rh/bulletins/${EMP}/2027-02?pdf=1`,
      { token: tC, societe: 1, corps: { gains: [{ libelle: "Prime", montant: 25000 }] }, brut: true });
    const t = texteDuPdf(r.buffer);
    v("le PDF affiche le net", /NET À PAYER/.test(t) && !/NON CALCULÉ/.test(t));
    v("les colonnes ne se chevauchent pas",
      /Salaire de base 450 000 FCFA/.test(t), (t.match(/Salaire de base[^A-Z]{0,30}/) || ["—"])[0]);
    v("les références des taux sont imprimées", /Références des taux appliqués/.test(t));
    v("les charges patronales sont dites « non déduites du net »",
      /non déduites du net/.test(t));
  }

  /* ══════════════════════════════════════════════════════════════════════
     6. ATTESTATIONS, CERTIFICATS, DIPLÔME
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n6. Les autres pièces");

  const sansContrat = await appel("POST", "/rh/attestations", { token: tRH, societe: 1,
    corps: { type: "ATTESTATION_TRAVAIL", employee_id: EMP2 } });
  v("une attestation sans contrat est refusée",
    sansContrat.status === 409 && sansContrat.data?.code === "CONTRACT_REQUIRED",
    `${sansContrat.status} ${JSON.stringify(sansContrat.data)}`);
  v("le message dit qu'elle ne s'invente pas",
    /ne s'invente pas/.test(String(sansContrat.data?.error)));

  for (const type of ["ATTESTATION_TRAVAIL", "CERTIFICAT_TRAVAIL", "ATTESTATION_STAGE", "ATTESTATION_FORMATION"]) {
    const r = await appel("POST", "/rh/attestations", { token: tRH, societe: 1,
      corps: { type, employee_id: EMP, lieu: "Bamako",
               formation: { intitule: "Sécurité en entrepôt", du: "2026-09-01", au: "2026-09-05", duree_heures: 35 } } });
    v(`${type} est éditée`, r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
  }

  if (pymupdfDispo) {
    const r = await appel("POST", "/rh/attestations?pdf=1", { token: tRH, societe: 1,
      corps: { type: "CERTIFICAT_TRAVAIL", employee_id: EMP, lieu: "Bamako" }, brut: true });
    const t = texteDuPdf(r.buffer);
    v("le certificat tient sur une page", pagesDu(t) === 1, `${pagesDu(t)}`);
    v("il dit « libre de tout engagement »", /libre de tout engagement/.test(t));
    /* Un certificat de travail ne porte aucune appréciation, par principe. */
    v("il ne porte aucune appréciation sur le salarié",
      !/satisfaction|sérieux|excellent|recommand/i.test(t));
    v("il prévoit la signature et le cachet", /signature et cachet/.test(t));
  }

  const dip = await appel("POST", "/rh/diplomes", { token: tS, societe: 1,
    corps: { employee_id: EMP, intitule: "Sécurité en entrepôt et conduite de chariot élévateur",
             mention: "de formation professionnelle", du: "2026-09-01", au: "2026-09-05",
             duree_heures: 35, lieu: "Bamako" } });
  v("le diplôme est édité", dip.status === 201, `${dip.status} ${JSON.stringify(dip.data)}`);

  const sansNom = await appel("POST", "/rh/diplomes", { token: tS, societe: 1,
    corps: { intitule: "Formation sans bénéficiaire" } });
  v("un diplôme sans bénéficiaire est refusé",
    sansNom.status === 400 && sansNom.data?.code === "BENEFICIAIRE_REQUIS", `${sansNom.status}`);

  if (pymupdfDispo) {
    const r = await appel("POST", "/rh/diplomes?pdf=1", { token: tS, societe: 1,
      corps: { employee_id: EMP, intitule: "Sécurité en entrepôt", duree_heures: 35, lieu: "Bamako" },
      brut: true });
    const t = texteDuPdf(r.buffer);
    v("le diplôme tient sur une page", pagesDu(t) === 1, `${pagesDu(t)}`);
    v("il nomme le bénéficiaire en grand", /Aminata Coulibaly/.test(t));
    v("il porte le nom de l'entreprise et une référence unique",
      /T R I A N G L E/.test(t) && /Réf\. DIP-\d{4}-\d{4}/.test(t));
    v("il prévoit la place du cachet et de la signature",
      /cachet de l'entreprise/.test(t) && /La Direction/.test(t));
  }
  /* Le diplôme est en PAYSAGE : c'est une exigence de forme, vérifiable. */
  const { execFileSync } = require("child_process");
  if (pymupdfDispo) {
    const fs = require("fs");
    const r = await appel("POST", "/rh/diplomes?pdf=1", { token: tS, societe: 1,
      corps: { employee_id: EMP, intitule: "Format", lieu: "Bamako" }, brut: true });
    fs.writeFileSync("/tmp/dip-test.pdf", r.buffer);
    const dims = execFileSync("python3", ["-c",
      "import pymupdf;d=pymupdf.open('/tmp/dip-test.pdf');print(int(d[0].rect.width),int(d[0].rect.height))"],
      { encoding: "utf8" }).trim().split(" ").map(Number);
    v(`le diplôme est en paysage (${dims[0]}×${dims[1]})`, dims[0] > dims[1]);
  }

  /* ══════════════════════════════════════════════════════════════════════
     7. LE SALAIRE EST CONFIDENTIEL
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n7. Qui a le droit de voir une rémunération");

  const listeRH = await appel("GET", "/rh/contrats", { token: tRH, societe: 1 });
  v("l'assistante RH voit les contrats", listeRH.status === 200);
  v("mais aucun salaire ne lui est montré",
    (listeRH.data?.contrats || []).every((c) => c.gross_salary === null),
    JSON.stringify((listeRH.data?.contrats || []).map((c) => c.gross_salary)));
  v("et l'écran sait que les montants sont masqués",
    listeRH.data?.remunerations_masquees === true);

  const pdfRH = await appel("GET", `/rh/contrats/${idCDI}/pdf`, { token: tRH, societe: 1 });
  v("elle ne peut pas imprimer un contrat, qui porte un salaire",
    pdfRH.status === 403 && pdfRH.data?.code === "SALARY_FORBIDDEN",
    `${pdfRH.status} ${JSON.stringify(pdfRH.data)}`);

  const bpRH = await appel("POST", `/rh/bulletins/${EMP}/2027-03`, { token: tRH, societe: 1, corps: {} });
  v("ni établir un bulletin", bpRH.status === 403 && bpRH.data?.code === "SALARY_FORBIDDEN",
    `${bpRH.status}`);

  /* Mais elle édite bien une attestation de travail, qui ne révèle rien. */
  const attRH = await appel("POST", "/rh/attestations", { token: tRH, societe: 1,
    corps: { type: "ATTESTATION_TRAVAIL", employee_id: EMP, lieu: "Bamako" } });
  v("alors qu'elle édite une attestation de travail sans difficulté",
    attRH.status === 201, `${attRH.status}`);

  const parZerbo = await appel("GET", "/rh/contrats", { token: tZ, societe: 1 });
  v("un magasinier n'accède pas au module",
    parZerbo.status === 403 || parZerbo.status === 404, `${parZerbo.status}`);

  const listeComptable = await appel("GET", "/rh/contrats", { token: tC, societe: 1 });
  v("le comptable, lui, voit les salaires",
    (listeComptable.data?.contrats || []).some((c) => Number(c.gross_salary) === 450000));

  /* ══════════════════════════════════════════════════════════════════════
     8. L'ÉTANCHÉITÉ ET LE REGISTRE
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n8. Deux sociétés, un registre");

  const croise = await appel("GET", `/rh/contrats/${idCDI}/pdf`, { token: tF, societe: 2 });
  v("FAT & MAT n'imprime pas un contrat de Triangle",
    croise.status === 404, `${croise.status}`);

  const docsF = await appel("GET", "/rh/documents", { token: tF, societe: 2 });
  v("FAT & MAT ne voit aucun document de Triangle",
    (docsF.data?.documents || []).length === 0, `${(docsF.data?.documents || []).length}`);

  const reg = await appel("GET", "/rh/documents", { token: tS, societe: 1 });
  v("le registre liste les pièces remises", (reg.data?.documents || []).length > 5,
    `${(reg.data?.documents || []).length}`);
  v("chaque pièce porte une référence unique",
    new Set((reg.data?.documents || []).map((d) => d.reference)).size
      === (reg.data?.documents || []).length);
  v("et l'empreinte du PDF remis",
    (reg.data?.documents || []).every((d) => /^[0-9a-f]{64}$/.test(String(d.pdf_sha256))));
  v("le registre se filtre par type",
    ((await appel("GET", "/rh/documents?type=DIPLOME", { token: tS, societe: 1 }))
      .data?.documents || []).every((d) => d.doc_type === "DIPLOME"));

  /* ══════════════════════════════════════════════════════════════════════
     9. COHÉRENCE
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n9. Vérification d'ensemble");

  v("aucun CDI ne porte de date de fin",
    Number((await un(`SELECT count(*) c FROM hr_contracts
                       WHERE contract_type='CDI' AND end_date IS NOT NULL`)).c) === 0);
  v("aucun CDD sans motif de recours",
    Number((await un(`SELECT count(*) c FROM hr_contracts
                       WHERE contract_type='CDD' AND BTRIM(COALESCE(cdd_reason,''))=''`)).c) === 0);
  v("aucun salarié n'a deux contrats actifs",
    Number((await un(`SELECT count(*) c FROM (
                        SELECT employee_id FROM hr_contracts WHERE status='ACTIF'
                         GROUP BY company_id, employee_id HAVING count(*) > 1) x`)).c) === 0);
  v("aucun document sans référence ni empreinte",
    Number((await un(`SELECT count(*) c FROM hr_documents
                       WHERE BTRIM(COALESCE(reference,''))='' OR pdf_sha256 IS NULL`)).c) === 0);
  v("aucun document rattaché à un salarié d'une autre société",
    Number((await un(`SELECT count(*) c FROM hr_documents d
                        JOIN attendance_employees e ON e.id = d.employee_id
                       WHERE e.company_id <> d.company_id`)).c) === 0);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${ok} réussis, ${ko} échoués`);
  if (!pymupdfDispo) console.log("  (contrôles de rendu PDF ignorés : pymupdf absent)");
  console.log(ko === 0
    ? "  Aucun taux inventé, aucune disposition légale inventée, aucun salaire divulgué."
    : "  Des points restent à corriger.");
  await pool.end();
  process.exit(ko === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
