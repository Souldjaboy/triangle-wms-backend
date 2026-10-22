"use strict";
/**
 * DOCUMENTS DU PERSONNEL : APERÇU, VERSIONS, ARCHIVAGE.
 *
 * Ce que ces tests éprouvent :
 *
 *  1. Qu'un APERÇU n'entre pas au registre, et qu'il porte une mention qui
 *     l'empêche de passer pour la pièce s'il est imprimé.
 *  2. Que le PDF est CONSERVÉ, et que la réimpression sert les octets
 *     archivés — pas une régénération qui pourrait différer.
 *  3. Que l'empreinte est revérifiée avant de servir la pièce.
 *  4. Que deux bulletins du même mois sont deux VERSIONS, chaînées, et que la
 *     première cesse de faire foi ; qu'une attestation rééditée est au
 *     contraire une pièce de plus.
 *  5. Que réimprimer est un droit distinct d'imprimer.
 *  6. Qu'annuler une pièce ne l'efface pas, et avertit qu'elle peut déjà
 *     être entre les mains du salarié.
 */
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const BASE = "http://localhost:5050";
const SECRET = process.env.JWT_SECRET || "triangle_wms_secret_key";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let ok = 0, ko = 0;
const v = (n, c, d = "") => { if (c) { ok++; console.log(`  ✔ ${n}`); } else { ko++; console.log(`  ✘ ${n}${d ? `\n      → ${d}` : ""}`); } };
const titre = (t) => console.log(`\n── ${t}`);
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
  let data = null; try { data = await r.json(); } catch { /* non JSON */ }
  return { status: r.status, data };
}

function texteDuPdf(buffer) {
  const fs = require("fs"); const os = require("os"); const path = require("path");
  const f = path.join(os.tmpdir(), `rhv-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(f, buffer);
  try {
    return require("child_process").execFileSync("python3", ["-c",
      `import pymupdf,re,sys;d=pymupdf.open(sys.argv[1]);print(re.sub(r'\\s+',' ',' '.join(p.get_text() for p in d)))`,
      f], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch { return ""; } finally { try { fs.unlinkSync(f); } catch { /* ignoré */ } }
}

const SUPER = { id: 900, fullname: "Super Triangle", role: "super_admin", company_id: 1, is_super_admin: true };
const RH    = { id: 908, fullname: "Assistante RH", role: "assistant_rh", company_id: 1, is_super_admin: false };
const EMP = 801, EMP2 = 802;

const docs = async (type) => q(
  `SELECT * FROM hr_documents WHERE company_id=1 AND doc_type=$1 ORDER BY id`, [type]);
const journal = async (id) => q(
  `SELECT * FROM hr_document_history WHERE document_id=$1 ORDER BY id`, [id]);

(async () => {
  const tS = jeton(SUPER), tRH = jeton(RH);

  /* Une attestation de travail exige un contrat : « elle ne s'invente pas ».
     On en pose deux, pour les deux salariés de l'essai, avant toute chose. */
  titre("Mise en situation");
  for (const [emp, poste] of [[EMP, "Responsable d'entrepôt"], [EMP2, "Magasinier"]]) {
    const c = await appel("POST", "/rh/contrats", {
      token: tS, societe: 1,
      corps: { employee_id: emp, contract_type: "CDI", job_title: poste,
               site_label: "Entrepôt Sotuba", start_date: "2026-01-05",
               trial_period_days: 90, weekly_hours: 40, gross_salary: 300000,
               signed_place: "Bamako" },
    });
    v(`contrat du salarié ${emp}`, c.status === 201, JSON.stringify(c.data)?.slice(0, 180));
    await appel("POST", `/rh/contrats/${c.data?.contrat?.id}/activer`, { token: tS, societe: 1, corps: {} });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     1. L'APERÇU
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Un aperçu n'entre pas au registre");
  const avant = (await docs("ATTESTATION_TRAVAIL")).length;
  let r = await appel("POST", "/rh/attestations?apercu=1", {
    token: tS, societe: 1, corps: { type: "ATTESTATION_TRAVAIL", employee_id: EMP }, brut: true,
  });
  v("l'aperçu sort un PDF", r.status === 200 && r.type === "application/pdf", `${r.status} ${r.type}`);
  v("il n'est pas vide", (r.buffer?.length || 0) > 1000, `${r.buffer?.length}`);
  const texteApercu = texteDuPdf(r.buffer);
  v("il porte la mention APERÇU", /APERÇU/.test(texteApercu), texteApercu.slice(0, 160));
  v("et « NON ÉMIS »", /NON ÉMIS/.test(texteApercu));
  v("aucune pièce n'a été enregistrée", (await docs("ATTESTATION_TRAVAIL")).length === avant,
    `${(await docs("ATTESTATION_TRAVAIL")).length} contre ${avant}`);

  titre("Mais le fait d'avoir regardé est noté");
  const vus = await q(
    `SELECT * FROM hr_document_history WHERE action='APERCU' AND company_id=1 ORDER BY id DESC LIMIT 1`);
  v("une ligne APERCU existe", vus.length === 1);
  v("elle nomme qui a regardé", vus[0]?.acted_by_name === "Super Triangle", vus[0]?.acted_by_name);
  v("elle ne désigne aucune pièce", vus[0]?.document_id === null);

  /* ═══════════════════════════════════════════════════════════════════════
     2. L'ÉMISSION ET L'ARCHIVAGE
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Émettre pour de bon");
  r = await appel("POST", "/rh/attestations", {
    token: tS, societe: 1, corps: { type: "ATTESTATION_TRAVAIL", employee_id: EMP },
  });
  v("la pièce est éditée", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  const doc1 = r.data?.document;
  v("elle est en version 1", doc1?.version === 1, String(doc1?.version));
  v("et émise", doc1?.status === "EMIS", doc1?.status);
  v("les octets du PDF sont conservés", Number(doc1?.pdf_bytes) > 1000, String(doc1?.pdf_bytes));
  v("la réponse ne transporte PAS le fichier", doc1?.pdf_content === undefined);

  const enBase = await un(`SELECT pdf_content IS NOT NULL AS a, octet_length(pdf_content) n, pdf_sha256
                             FROM hr_documents WHERE id=$1`, [doc1.id]);
  v("le fichier est bien en base", enBase?.a === true);
  v("sa taille correspond", Number(enBase?.n) === Number(doc1.pdf_bytes), `${enBase?.n} / ${doc1.pdf_bytes}`);

  titre("La pièce archivée se sert telle quelle");
  r = await appel("GET", `/rh/documents/${doc1.id}/pdf`, { token: tS, societe: 1, brut: true });
  v("elle sort", r.status === 200 && r.type === "application/pdf", `${r.status}`);
  const crypto = require("crypto");
  const empreinteServie = crypto.createHash("sha256").update(r.buffer).digest("hex");
  v("octet pour octet, c'est bien l'archive", empreinteServie === enBase.pdf_sha256,
    `${empreinteServie.slice(0, 12)} contre ${String(enBase.pdf_sha256).slice(0, 12)}`);
  const texteServi = texteDuPdf(r.buffer);
  v("et elle ne porte AUCUN filigrane", !/APERÇU/.test(texteServi));
  v("la sortie est comptée",
    Number((await un(`SELECT printed_count FROM hr_documents WHERE id=$1`, [doc1.id]))?.printed_count) === 1);

  titre("Réimprimer est un droit distinct");
  r = await appel("GET", `/rh/documents/${doc1.id}/pdf`, { token: tRH, societe: 1, brut: true });
  v("l'assistante RH, sans « reprint », est refusée", r.status === 403, `${r.status}`);
  v("le compteur n'a pas bougé",
    Number((await un(`SELECT printed_count FROM hr_documents WHERE id=$1`, [doc1.id]))?.printed_count) === 1);
  r = await appel("GET", `/rh/documents/${doc1.id}/pdf`, { token: tS, societe: 1, brut: true });
  v("la direction réimprime", r.status === 200, `${r.status}`);
  v("le compteur avance",
    Number((await un(`SELECT printed_count FROM hr_documents WHERE id=$1`, [doc1.id]))?.printed_count) === 2);
  const j1 = await journal(doc1.id);
  v("la réimpression est distinguée dans le journal",
    j1.some((h) => h.action === "REIMPRESSION"), j1.map((h) => h.action).join(","));

  titre("Une archive altérée n'est pas servie");
  await pool.query(
    `UPDATE hr_documents SET pdf_content = pdf_content || '\\x00'::bytea WHERE id=$1`, [doc1.id]);
  r = await appel("GET", `/rh/documents/${doc1.id}/pdf`, { token: tS, societe: 1 });
  v("le service refuse", r.status === 409 && r.data?.code === "ARCHIVE_ALTEREE", JSON.stringify(r.data));
  v("et le dit clairement",
    /ne correspond plus à son contenu archivé/.test(r.data?.error || ""), r.data?.error);
  /* On remet l'archive dans son état, pour la suite. */
  await pool.query(
    `UPDATE hr_documents SET pdf_content = substring(pdf_content from 1 for octet_length(pdf_content)-1)
      WHERE id=$1`, [doc1.id]);
  r = await appel("GET", `/rh/documents/${doc1.id}/pdf`, { token: tS, societe: 1, brut: true });
  v("une fois rétablie, elle ressort", r.status === 200, `${r.status}`);

  /* ═══════════════════════════════════════════════════════════════════════
     3. LES ATTESTATIONS NE SE VERSIONNENT PAS
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Une attestation rééditée est une pièce de plus, pas une version");
  r = await appel("POST", "/rh/attestations", {
    token: tS, societe: 1, corps: { type: "ATTESTATION_TRAVAIL", employee_id: EMP },
  });
  v("la seconde édition passe sans motif", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  const doc2 = r.data?.document;
  v("elle est aussi en version 1", doc2?.version === 1, String(doc2?.version));
  v("elle ne remplace rien", doc2?.supersedes_document_id === null);
  v("et la première reste émise",
    (await un(`SELECT status FROM hr_documents WHERE id=$1`, [doc1.id]))?.status === "EMIS");
  v("les deux ont des références différentes", doc1.reference !== doc2.reference,
    `${doc1.reference} / ${doc2.reference}`);

  /* ═══════════════════════════════════════════════════════════════════════
     4. LES BULLETINS SE VERSIONNENT
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Deux bulletins du même mois sont deux versions");
  r = await appel("POST", `/rh/bulletins/${EMP2}/2026-09`, {
    token: tS, societe: 1, corps: { brut: 300000 },
  });
  v("le premier bulletin est établi", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  const bp1 = r.data?.document;
  v("en version 1", bp1?.version === 1, String(bp1?.version));

  r = await appel("POST", `/rh/bulletins/${EMP2}/2026-09`, {
    token: tS, societe: 1, corps: { brut: 350000 },
  });
  v("le second est refusé sans motif", r.status === 409 && r.data?.code === "VERSION_REASON_REQUIRED",
    JSON.stringify(r.data)?.slice(0, 250));
  v("le message nomme la pièce existante",
    (r.data?.error || "").includes(bp1.reference), r.data?.error);
  v("et la période", (r.data?.error || "").includes("2026-09"));
  v("rien n'a été créé", (await q(
    `SELECT id FROM hr_documents WHERE doc_type='BULLETIN' AND period_code='2026-09' AND employee_id=$1`,
    [EMP2])).length === 1);

  r = await appel("POST", `/rh/bulletins/${EMP2}/2026-09`, {
    token: tS, societe: 1,
    corps: { brut: 350000, motif_version: "prime de rendement oubliée au premier calcul" },
  });
  v("avec motif, la nouvelle version passe", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  const bp2 = r.data?.document;
  v("elle est en version 2", bp2?.version === 2, String(bp2?.version));
  v("elle désigne celle qu'elle remplace", Number(bp2?.supersedes_document_id) === Number(bp1.id));
  v("et porte le motif", bp2?.version_reason === "prime de rendement oubliée au premier calcul");

  const bp1Apres = await un(`SELECT * FROM hr_documents WHERE id=$1`, [bp1.id]);
  v("la première est REMPLACÉE", bp1Apres?.status === "REMPLACE", bp1Apres?.status);
  v("elle désigne celle qui lui succède", Number(bp1Apres?.superseded_by_document_id) === Number(bp2.id));
  v("elle n'est pas effacée", !!bp1Apres);
  v("son archive est toujours là", bp1Apres?.pdf_content !== null);

  titre("La pièce en vigueur");
  const courant = await un(
    `SELECT * FROM v_documents_rh_courants WHERE employee_id=$1 AND doc_type='BULLETIN' AND period_code='2026-09'`,
    [EMP2]);
  v("la vue désigne la version 2", Number(courant?.id) === Number(bp2.id), String(courant?.id));
  v("et une seule", (await q(
    `SELECT id FROM v_documents_rh_courants WHERE employee_id=$1 AND doc_type='BULLETIN' AND period_code='2026-09'`,
    [EMP2])).length === 1);

  titre("La chaîne des versions se lit");
  r = await appel("GET", `/rh/documents/${bp1.id}/versions`, { token: tS, societe: 1 });
  v("la route répond", r.status === 200, JSON.stringify(r.data)?.slice(0, 200));
  v("elle liste les deux versions", (r.data?.versions || []).length === 2,
    String((r.data?.versions || []).length));
  v("elle dit laquelle fait foi", Number(r.data?.en_vigueur?.id) === Number(bp2.id));
  v("elle dit si chaque version est archivée",
    (r.data?.versions || []).every((x) => x.archivee === true));
  v("et donne l'historique", (r.data?.historique || []).length >= 2,
    String((r.data?.historique || []).length));
  const actions = (r.data?.historique || []).map((h) => h.action);
  v("on y voit le remplacement", actions.includes("REMPLACEMENT"), actions.join(","));
  v("et la nouvelle version", actions.includes("NOUVELLE_VERSION"), actions.join(","));

  titre("Une version d'un autre mois n'entre pas dans la chaîne");
  r = await appel("POST", `/rh/bulletins/${EMP2}/2026-10`, {
    token: tS, societe: 1, corps: { brut: 350000 },
  });
  v("le bulletin d'octobre passe sans motif", r.status === 201, JSON.stringify(r.data)?.slice(0, 160));
  v("et repart en version 1", r.data?.document?.version === 1, String(r.data?.document?.version));

  /* ═══════════════════════════════════════════════════════════════════════
     5. L'APERÇU D'UN BULLETIN
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Regarder un bulletin avant de l'établir");
  const avantBp = (await docs("BULLETIN")).length;
  r = await appel("POST", `/rh/bulletins/${EMP}/2026-11?apercu=1`, {
    token: tS, societe: 1, corps: { brut: 500000 }, brut: true,
  });
  v("l'aperçu sort", r.status === 200 && r.type === "application/pdf", `${r.status} ${r.type}`);
  v("filigrané", /APERÇU/.test(texteDuPdf(r.buffer)));
  v("aucun bulletin n'a été établi", (await docs("BULLETIN")).length === avantBp,
    `${(await docs("BULLETIN")).length} contre ${avantBp}`);

  /* ═══════════════════════════════════════════════════════════════════════
     6. ANNULER
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Annuler une pièce");
  r = await appel("POST", `/rh/documents/${doc2.id}/annuler`, {
    token: tS, societe: 1, corps: { motif: "erreur" },
  });
  v("un motif trop court est refusé", r.status === 400 && r.data?.code === "REASON_REQUIRED",
    JSON.stringify(r.data));

  r = await appel("POST", `/rh/documents/${doc2.id}/annuler`, {
    token: tRH, societe: 1, corps: { motif: "éditée pour le mauvais salarié" },
  });
  v("l'assistante RH ne peut pas annuler", r.status === 403 || r.status === 404, `${r.status}`);

  r = await appel("POST", `/rh/documents/${doc2.id}/annuler`, {
    token: tS, societe: 1, corps: { motif: "éditée pour le mauvais salarié" },
  });
  v("la direction annule", r.status === 200, JSON.stringify(r.data)?.slice(0, 200));
  v("la pièce est ANNULÉE", r.data?.document?.status === "ANNULE");
  v("le motif est conservé", r.data?.document?.cancel_reason === "éditée pour le mauvais salarié");
  v("et le nom de qui l'a décidé", r.data?.document?.cancelled_by_name === "Super Triangle");
  v("l'écran est averti qu'elle peut déjà être remise",
    /le document qu'il détient ne fait plus foi/.test(r.data?.avertissement || ""), r.data?.avertissement);
  v("la pièce n'est PAS supprimée",
    !!(await un(`SELECT id FROM hr_documents WHERE id=$1`, [doc2.id])));
  v("son archive non plus",
    (await un(`SELECT pdf_content IS NOT NULL a FROM hr_documents WHERE id=$1`, [doc2.id]))?.a === true);

  titre("Les refus de bon sens");
  r = await appel("POST", `/rh/documents/${doc2.id}/annuler`, {
    token: tS, societe: 1, corps: { motif: "seconde tentative sur la même pièce" },
  });
  v("on n'annule pas deux fois", r.status === 409 && r.data?.code === "ALREADY_CANCELLED", JSON.stringify(r.data));

  r = await appel("POST", `/rh/documents/${bp1.id}/annuler`, {
    token: tS, societe: 1, corps: { motif: "annuler une version remplacée" },
  });
  v("une version remplacée ne s'annule pas", r.status === 409 && r.data?.code === "DOCUMENT_SUPERSEDED",
    JSON.stringify(r.data));
  v("et l'on dit laquelle viser",
    /c'est celle-là qu'il faut annuler/.test(r.data?.error || ""), r.data?.error);

  r = await appel("GET", "/rh/documents/999999/pdf", { token: tS, societe: 1 });
  v("une pièce inexistante répond 404", r.status === 404, `${r.status}`);

  /* ═══════════════════════════════════════════════════════════════════════
     7. LE REGISTRE RESTE LÉGER
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Le registre ne transporte pas les fichiers");
  r = await appel("GET", "/rh/documents", { token: tS, societe: 1 });
  v("il répond", r.status === 200);
  const liste = r.data?.documents || [];
  v("des pièces sont listées", liste.length >= 3, String(liste.length));
  v("aucune ne porte ses octets", liste.every((d) => d.pdf_content === undefined));
  v("mais chacune dit si elle est archivée", liste.every((d) => typeof d.archivee === "boolean"));
  v("et sa taille", liste.every((d) => d.pdf_bytes !== undefined));
  v("et sa version", liste.every((d) => d.version !== undefined));
  const poids = JSON.stringify(r.data).length;
  v("la réponse reste raisonnable", poids < 400000, `${Math.round(poids / 1024)} Ko`);

  /* ═══════════════════════════════════════════════════════════════════════
     8. LES SOCIÉTÉS
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Une pièce ne traverse pas les sociétés");
  r = await appel("GET", `/rh/documents/${doc1.id}/pdf`, {
    token: jeton({ id: 901, fullname: "Super Fatemat", role: "super_admin", company_id: 2, is_super_admin: true }),
    societe: 2,
  });
  v("FAT & MAT ne lit pas une pièce de Triangle", r.status === 404, `${r.status}`);
  r = await appel("GET", `/rh/documents/${doc1.id}/versions`, {
    token: jeton({ id: 901, fullname: "Super Fatemat", role: "super_admin", company_id: 2, is_super_admin: true }),
    societe: 2,
  });
  v("ni ses versions", r.status === 404, `${r.status}`);

  console.log(`\n${"─".repeat(56)}\n  ${ok} réussis, ${ko} échoués\n${"─".repeat(56)}`);
  await pool.end();
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
