"use strict";
/**
 * LES PRÉSENTATIONS.
 *
 * Ce que ces essais éprouvent :
 *
 *  1. Qu'une présentation est un DOCUMENT DE LA BIBLIOTHÈQUE comme un autre —
 *     versions, corbeille, cloisonnement — et que le fichier rangé est un PDF
 *     d'autant de pages que de diapositives, aux dimensions exactes.
 *  2. QU'UNE PRÉSENTATION À TROU EST REFUSÉE. Si le plan annonce trois
 *     diapositives et que deux images arrivent, rien n'est enregistré : une
 *     page manquante ne se découvrirait qu'en projetant.
 *  3. Que l'export PowerPoint produit un VRAI .pptx, relisible, et qu'il entre
 *     comme un document DE PLUS sans remplacer le PDF.
 *  4. Que lire un .pptx déposé N'ENREGISTRE RIEN : le plan et le compte rendu
 *     reviennent, et c'est l'écran qui décide ensuite.
 *  5. QUE LES DEUX FAMILLES NE SE MÉLANGENT PAS. Une carte de visite n'est pas
 *     dans les présentations, une présentation n'est pas dans les planches, et
 *     ouvrir l'une dans l'éditeur de l'autre est refusé en disant où aller.
 *  6. Qu'enregistrer demande le droit de modifier, et exporter celui
 *     d'exporter.
 */
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { PDFDocument } = require("pdf-lib");
const PPTX = require("../services/pptx");
const { png } = require("./image-essai");

const BASE = "http://localhost:5050";
const SECRET = process.env.JWT_SECRET || "test_studio";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PPMM = 72 / 25.4;
let ok = 0, ko = 0;
const v = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ✔ ${n}`); }
  else { ko++; console.log(`  ✘ ${n}${d ? `\n      → ${d}` : ""}`); }
};
const titre = (t) => console.log(`\n── ${t}`);
const jeton = (u) => jwt.sign({ ...u, tenant_id: "triangle" }, SECRET, { expiresIn: "1h" });
const q = async (s, p = []) => (await pool.query(s, p)).rows;

const DIR    = { id: 900, fullname: "Direction Triangle", role: "direction", company_id: 1, is_super_admin: false };
const MAGA   = { id: 902, fullname: "Magasinier Triangle", role: "magasinier", company_id: 1, is_super_admin: false };
const FAT    = { id: 903, fullname: "Direction Fatemat", role: "direction", company_id: 2, is_super_admin: false };

const entetes = (u, societe) => ({
  Authorization: `Bearer ${jeton(u)}`,
  "x-tenant-id": "triangle",
  "x-active-company-id": String(societe ?? u.company_id),
});

async function appel(m, chemin, { user, societe, corps, brut } = {}) {
  const h = entetes(user, societe);
  if (corps !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(BASE + chemin, {
    method: m, headers: h,
    body: corps === undefined ? undefined : JSON.stringify(corps) });
  if (brut) return { status: r.status, buffer: Buffer.from(await r.arrayBuffer()) };
  let data = null; try { data = await r.json(); } catch { /* non JSON */ }
  return { status: r.status, data };
}

/* Chaque diapositive d'essai porte une couleur unie qui lui est propre : on
   peut donc dire, en relisant le PDF, QUELLE page est où — et pas seulement
   combien il y en a. */
const COULEURS = [[0, 160, 0], [192, 0, 0], [0, 0, 192], [200, 150, 0]];
const imageDiapo = (i) => png(24, 14, () => COULEURS[i % COULEURS.length]);

const planDe = (n) => ({
  diapositives: Array.from({ length: n }, (_, i) => ({
    fond: "#ffffff",
    elements: [
      { id: `t${i}`, type: "texte", x: 20, y: 20, l: 280,
        texte: `Diapositive ${i + 1}`, taille: 10, couleur: "#111827",
        graisse: 700, alignement: "gauche", police: "sans", interligne: 1.2 },
      { id: `r${i}`, type: "rect", x: 20, y: 60, l: 100, h: 40,
        couleur: `#${COULEURS[i % COULEURS.length].map((c) => c.toString(16).padStart(2, "0")).join("")}`,
        rayon: 0, bordure: 0, couleurBordure: "#000000" },
    ],
  })),
});

async function envoyer(m, chemin, user, { plan, images, champs = {}, societe }) {
  const form = new FormData();
  if (plan !== undefined) form.append("plan", JSON.stringify(plan));
  for (const [k, val] of Object.entries(champs)) form.append(k, String(val));
  (images || []).forEach((octets, i) => {
    form.append("diapositives", new Blob([octets], { type: "image/png" }), `diapo${i + 1}.png`);
  });
  const r = await fetch(BASE + chemin, { method: m, headers: entetes(user, societe), body: form });
  let d = null; try { d = await r.json(); } catch { /* non JSON */ }
  return { status: r.status, data: d };
}

/* Lire la couleur du centre de chaque page d'un PDF : impossible sans
   rasteriser. On se contente donc ici des DIMENSIONS et du compte, et la
   couleur est éprouvée par l'essai de rendu (verif-pptx.js). */
async function pagesDe(buffer) {
  const d = await PDFDocument.load(buffer);
  return d.getPages().map((p) => {
    const s = p.getSize();
    return { largeur: s.width / PPMM, hauteur: s.height / PPMM };
  });
}

(async () => {
  /* ════════════════════ LES FORMATS ════════════════════ */
  titre("Les formats proposés");
  let r = await appel("GET", "/studio/presentations/formats", { user: DIR });
  v("les formats se lisent", r.status === 200 && Array.isArray(r.data?.formats),
    `${r.status} ${JSON.stringify(r.data)?.slice(0, 120)}`);
  v("le 16/9 fait les dimensions de PowerPoint",
    (() => { const f = r.data?.formats?.find((x) => x.cle === "16-9");
      return f && Math.abs(f.largeur_mm - 338.667) < 0.1 && Math.abs(f.hauteur_mm - 190.5) < 0.1; })(),
    JSON.stringify(r.data?.formats));
  v("et la route dit la limite de diapositives",
    r.data?.diapositives_max === 200, String(r.data?.diapositives_max));
  /* La route littérale « formats » n'est pas avalée par « /:id » : c'est
     exactement la classe de défaut qui laisse quatorze routes mortes dans ce
     dépôt. */
  v("« formats » n'est pas pris pour un identifiant",
    !/pas une présentation|introuvable/i.test(JSON.stringify(r.data || {})),
    JSON.stringify(r.data)?.slice(0, 120));

  /* ════════════════════ CRÉER ════════════════════ */
  titre("Créer une présentation");
  r = await envoyer("POST", "/studio/presentations", DIR, {
    plan: planDe(3),
    images: [imageDiapo(0), imageDiapo(1), imageDiapo(2)],
    champs: { nom: "Bilan trimestre", format: "16-9", visibilite: "SOCIETE" } });
  v("la création passe", r.status === 201, `${r.status} ${JSON.stringify(r.data)?.slice(0, 220)}`);
  const pres = r.data?.document;
  v("le document est un PDF", pres?.mime === "application/pdf", pres?.mime);
  v("il compte trois pages", pres?.page_count === 3, String(pres?.page_count));
  v("et il est marqué comme une présentation",
    pres?.design_kind === "PRESENTATION", pres?.design_kind);
  v("le message dit combien de diapositives",
    /3 diapositives/.test(r.data?.message || ""), r.data?.message);

  const fichier = await appel("GET", `/studio/documents/${pres.id}/fichier`, { user: DIR, brut: true });
  const pages = await pagesDe(fichier.buffer);
  v("le PDF rangé a une page par diapositive", pages.length === 3, String(pages.length));
  /* AU DIXIÈME DE MILLIMÈTRE, pas au millimètre arrondi. Le premier jet
     comparait des chaînes arrondies à l'entier et attendait « 339×191 » : le
     16/9 fait 190,5 mm de haut, que le passage par les points ramène à
     190,4999…, donc « 190 ». L'affirmation était fausse, le PDF juste. */
  v("et chaque page fait la taille du 16/9, au dixième de millimètre",
    pages.every((p) => Math.abs(p.largeur - 338.667) < 0.1 && Math.abs(p.hauteur - 190.5) < 0.1),
    pages.map((p) => `${p.largeur.toFixed(2)}×${p.hauteur.toFixed(2)}`).join(" "));

  /* ════════════ UNE PRÉSENTATION À TROU EST REFUSÉE ════════════ */
  titre("Une présentation à trou est refusée");
  const avant = (await q(`SELECT count(*)::int AS n FROM studio_documents WHERE company_id = 1`))[0].n;
  r = await envoyer("POST", "/studio/presentations", DIR, {
    plan: planDe(3), images: [imageDiapo(0), imageDiapo(1)],
    champs: { nom: "Incomplete", format: "16-9" } });
  v("deux images pour trois diapositives sont refusées",
    r.status === 400 && r.data?.code === "DIAPOSITIVES_MANQUANTES",
    `${r.status} ${r.data?.code}`);
  v("et le refus dit pourquoi c'est grave",
    /ne se découvrirait qu'en la projetant/.test(r.data?.error || ""), r.data?.error);
  const apres = (await q(`SELECT count(*)::int AS n FROM studio_documents WHERE company_id = 1`))[0].n;
  v("rien n'est entré dans la bibliothèque", apres === avant, `${avant} puis ${apres}`);

  r = await envoyer("POST", "/studio/presentations", DIR, {
    plan: { diapositives: [] }, images: [imageDiapo(0)], champs: { nom: "Vide", format: "16-9" } });
  v("une présentation sans diapositive est refusée",
    r.status === 400 && r.data?.code === "AUCUNE_DIAPOSITIVE", `${r.status} ${r.data?.code}`);
  r = await envoyer("POST", "/studio/presentations", DIR, {
    plan: planDe(1), images: [], champs: { nom: "Sans image", format: "16-9" } });
  v("une présentation sans image est refusée",
    r.status === 400 && r.data?.code === "AUCUNE_IMAGE", `${r.status} ${r.data?.code}`);
  r = await envoyer("POST", "/studio/presentations", DIR, {
    plan: planDe(1), images: [imageDiapo(0)], champs: { nom: "", format: "16-9" } });
  v("une présentation sans nom est refusée",
    r.status === 400 && r.data?.code === "NOM_REQUIS", `${r.status} ${r.data?.code}`);
  r = await envoyer("POST", "/studio/presentations", DIR, {
    plan: planDe(1), images: [imageDiapo(0)], champs: { nom: "Format bancal", format: "21-9" } });
  v("un format inconnu est refusé, en disant lesquels existent",
    r.status === 400 && r.data?.code === "FORMAT_INCONNU" && /16-9/.test(r.data?.error || ""),
    `${r.status} ${r.data?.code} ${r.data?.error}`);

  /* ════════════════════ ROUVRIR ════════════════════ */
  titre("Rouvrir une présentation");
  r = await appel("GET", `/studio/presentations/${pres.id}`, { user: DIR });
  v("le plan revient", r.status === 200 && r.data?.plan?.diapositives?.length === 3,
    `${r.status} ${JSON.stringify(r.data)?.slice(0, 160)}`);
  v("avec son format et ses dimensions",
    r.data?.format === "16-9" && Math.abs(r.data?.largeur_mm - 338.667) < 0.1,
    `${r.data?.format} ${r.data?.largeur_mm}`);
  v("et le texte de chaque diapositive est celui qu'on a envoyé",
    r.data?.plan?.diapositives?.[1]?.elements?.[0]?.texte === "Diapositive 2",
    JSON.stringify(r.data?.plan?.diapositives?.[1]?.elements?.[0]));

  /* ════════════════════ ENREGISTRER ════════════════════ */
  titre("Enregistrer crée une version de plus");
  const v1 = (await q(
    `SELECT id, sha256 FROM studio_document_versions WHERE document_id = $1 AND version = 1`,
    [pres.id]))[0];
  r = await envoyer("POST", `/studio/presentations/${pres.id}`, DIR, {
    plan: planDe(4),
    images: [imageDiapo(0), imageDiapo(1), imageDiapo(2), imageDiapo(3)],
    champs: { note: "Une diapositive de plus" } });
  v("l'enregistrement passe", r.status === 200, `${r.status} ${JSON.stringify(r.data)?.slice(0, 200)}`);
  v("la présentation passe en version 2", r.data?.document?.version === 2,
    String(r.data?.document?.version));
  v("et compte maintenant quatre pages", r.data?.document?.page_count === 4,
    String(r.data?.document?.page_count));
  v("le message rappelle que la précédente reste",
    /précédente reste intacte/.test(r.data?.message || ""), r.data?.message);
  const v1apres = (await q(
    `SELECT sha256 FROM studio_document_versions WHERE document_id = $1 AND version = 1`,
    [pres.id]))[0];
  v("l'original garde son empreinte", v1apres.sha256 === v1.sha256,
    `${v1apres.sha256?.slice(0, 12)} contre ${v1.sha256?.slice(0, 12)}`);
  const noteV2 = (await q(
    `SELECT change_note FROM studio_document_versions WHERE document_id = $1 AND version = 2`,
    [pres.id]))[0].change_note;
  v("la note de version est celle qu'on a écrite",
    /Une diapositive de plus/.test(noteV2), noteV2);

  /* ════════════════ EXPORTER VERS POWERPOINT ════════════════ */
  titre("Exporter vers PowerPoint");
  r = await appel("POST", `/studio/presentations/${pres.id}/pptx`, { user: DIR, corps: {} });
  v("l'export passe", r.status === 201, `${r.status} ${JSON.stringify(r.data)?.slice(0, 200)}`);
  const pptxDoc = r.data?.document;
  v("un document de plus est déposé", !!pptxDoc?.id && pptxDoc.id !== pres.id, String(pptxDoc?.id));
  v("il porte le type d'une présentation PowerPoint",
    pptxDoc?.mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    pptxDoc?.mime);
  v("son nom finit par .pptx", /\.pptx$/.test(pptxDoc?.name || ""), pptxDoc?.name);
  v("et sa provenance dit d'où il vient",
    /Export PowerPoint de/.test(
      (await q(`SELECT source_note FROM studio_documents WHERE id = $1`, [pptxDoc.id]))[0]?.source_note || ""),
    (await q(`SELECT source_note FROM studio_documents WHERE id = $1`, [pptxDoc.id]))[0]?.source_note);
  v("le message dit que les formes sont modifiables",
    /modifiables/.test(r.data?.message || ""), r.data?.message);

  /* LE FICHIER EXPORTÉ EST-IL UNE VRAIE PRÉSENTATION ? On le relit. */
  const telecharge = await appel("GET", `/studio/documents/${pptxDoc.id}/fichier`,
    { user: DIR, brut: true });
  v("le .pptx se télécharge", telecharge.status === 200 && telecharge.buffer.length > 2000,
    `${telecharge.status} ${telecharge.buffer.length} octets`);
  const relu = await PPTX.lire(telecharge.buffer);
  v("il contient les quatre diapositives", relu.diapositives.length === 4,
    String(relu.diapositives.length));
  v("à la taille du 16/9", Math.abs(relu.largeurMm - 338.667) < 0.2,
    String(relu.largeurMm));
  v("et le texte de chaque diapositive y est",
    relu.diapositives.every((d, i) =>
      d.elements.some((e) => e.type === "texte" && e.texte === `Diapositive ${i + 1}`)),
    JSON.stringify(relu.diapositives.map((d) =>
      d.elements.filter((e) => e.type === "texte").map((e) => e.texte))));
  v("la présentation d'origine n'a pas changé de version",
    (await q(`SELECT version FROM studio_documents WHERE id = $1`, [pres.id]))[0].version === 2,
    String((await q(`SELECT version FROM studio_documents WHERE id = $1`, [pres.id]))[0].version));

  /* ════════════ LIRE UN .PPTX SANS RIEN ENREGISTRER ════════════ */
  titre("Lire un .pptx n'enregistre rien");
  const avantLecture = (await q(`SELECT count(*)::int AS n FROM studio_documents WHERE company_id = 1`))[0].n;
  const form = new FormData();
  form.append("fichier", new Blob([telecharge.buffer], {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }),
    "a-lire.pptx");
  let rep = await fetch(`${BASE}/studio/presentations/lecture-pptx`,
    { method: "POST", headers: entetes(DIR), body: form });
  let lu = await rep.json().catch(() => ({}));
  v("la lecture passe", rep.status === 200, `${rep.status} ${JSON.stringify(lu)?.slice(0, 200)}`);
  v("quatre diapositives sont rendues", lu?.plan?.diapositives?.length === 4,
    String(lu?.plan?.diapositives?.length));
  v("le format est reconnu comme du 16/9", lu?.format === "16-9", lu?.format);
  v("le compte rendu de ce qui n'est pas repris est présent",
    Array.isArray(lu?.non_repris), JSON.stringify(lu?.non_repris)?.slice(0, 120));
  v("le message dit que rien n'est encore enregistré",
    /rien n'est encore enregistré/i.test(lu?.message || ""), lu?.message);
  const apresLecture = (await q(`SELECT count(*)::int AS n FROM studio_documents WHERE company_id = 1`))[0].n;
  v("ET RIEN N'EST ENTRÉ DANS LA BIBLIOTHÈQUE",
    apresLecture === avantLecture, `${avantLecture} puis ${apresLecture}`);

  /* Ce qui n'est pas un .pptx. */
  const mauvais = async (nom, octets, type, code) => {
    const f = new FormData();
    f.append("fichier", new Blob([octets], { type }), nom);
    const rr = await fetch(`${BASE}/studio/presentations/lecture-pptx`,
      { method: "POST", headers: entetes(DIR), body: f });
    const dd = await rr.json().catch(() => ({}));
    v(`${nom} est refusé`, rr.status >= 400 && dd?.code === code,
      `${rr.status} ${dd?.code} ${String(dd?.error).slice(0, 110)}`);
  };
  await mauvais("faux.pptx", fichier.buffer,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation", "PAS_UN_PPTX");

  /* ═══════════ LES DEUX FAMILLES NE SE MÉLANGENT PAS ═══════════ */
  titre("Une planche n'est pas une présentation");
  const planche = new FormData();
  planche.append("image", new Blob([png(40, 30, () => [10, 80, 200])], { type: "image/png" }), "carte.png");
  planche.append("plan", JSON.stringify({ fond: "#ffffff", elements: [
    { id: "t", type: "texte", x: 5, y: 5, l: 70, texte: "Carte", taille: 5,
      couleur: "#000000", graisse: 400, alignement: "gauche", police: "sans", interligne: 1.2 }] }));
  planche.append("nom", "Carte de visite essai");
  planche.append("largeur_mm", "85"); planche.append("hauteur_mm", "55");
  planche.append("format", "carte-visite");
  const repPlanche = await fetch(`${BASE}/studio/creations`,
    { method: "POST", headers: entetes(DIR), body: planche });
  const dPlanche = await repPlanche.json().catch(() => ({}));
  v("la planche est créée", repPlanche.status === 201 || repPlanche.status === 200,
    `${repPlanche.status} ${JSON.stringify(dPlanche)?.slice(0, 160)}`);
  /* La route des planches répond « creation », non « document » : chaque
     route nomme ce qu'elle rend, et l'essai doit lire le bon champ. */
  const idPlanche = Number(dPlanche?.creation?.id ?? dPlanche?.document?.id);
  v("l'identifiant de la planche est connu", Number.isInteger(idPlanche),
    JSON.stringify(dPlanche)?.slice(0, 160));

  r = await appel("GET", "/studio/presentations", { user: DIR });
  const ids = (r.data?.presentations || []).map((p) => Number(p.id));
  v("la liste des présentations contient la présentation",
    ids.includes(Number(pres.id)), JSON.stringify(ids));
  v("et PAS la planche", !ids.includes(idPlanche), JSON.stringify(ids));
  v("elle dit combien de diapositives chacune compte",
    (r.data?.presentations || []).find((p) => p.id === pres.id)?.diapositives === 4,
    JSON.stringify((r.data?.presentations || []).map((p) => [p.id, p.diapositives])));

  r = await appel("GET", "/studio/creations", { user: DIR });
  const idsC = (r.data?.creations || r.data?.documents || []).map((p) => Number(p.id));
  v("la liste des planches contient la planche", idsC.includes(idPlanche), JSON.stringify(idsC));
  v("et PAS la présentation", !idsC.includes(pres.id), JSON.stringify(idsC));

  r = await appel("GET", `/studio/creations/${pres.id}`, { user: DIR });
  v("ouvrir une présentation dans l'éditeur de planches est refusé",
    r.status === 409 && r.data?.code === "C_EST_UNE_PRESENTATION", `${r.status} ${r.data?.code}`);
  v("et le refus dit où aller", /Ouvrez-le dans les présentations/.test(r.data?.error || ""),
    r.data?.error);
  r = await appel("GET", `/studio/presentations/${idPlanche}`, { user: DIR });
  v("ouvrir une planche dans les présentations est refusé",
    r.status === 409 && r.data?.code === "PAS_UNE_PRESENTATION", `${r.status} ${r.data?.code}`);

  titre("Un identifiant qui n'est pas un nombre");
  for (const mauvaisId of ["undefined", "abc", "0", "-3", "1e9999"]) {
    const rr = await appel("GET", `/studio/presentations/${mauvaisId}`, { user: DIR });
    v(`« ${mauvaisId} » répond 404, pas 500`,
      rr.status === 404 && rr.data?.code === "DOCUMENT_INTROUVABLE",
      `${rr.status} ${rr.data?.code}`);
    v(`  et n'apprend rien sur la base`,
      !/relation|column|invalid input syntax|bigint/i.test(JSON.stringify(rr.data || {})),
      JSON.stringify(rr.data)?.slice(0, 140));
  }

  /* ════════════════════ LES DROITS ════════════════════ */
  titre("Les droits");
  r = await appel("GET", "/studio/presentations", { user: MAGA });
  v("le magasinier voit la liste", r.status === 200, `${r.status}`);
  r = await envoyer("POST", `/studio/presentations/${pres.id}`, MAGA, {
    plan: planDe(1), images: [imageDiapo(0)] });
  v("mais il n'enregistre pas", r.status === 403 || r.status === 404, `${r.status}`);
  r = await appel("POST", `/studio/presentations/${pres.id}/pptx`, { user: MAGA, corps: {} });
  v("et il n'exporte pas", r.status === 403 || r.status === 404, `${r.status}`);

  r = await appel("GET", `/studio/presentations/${pres.id}`, { user: FAT, societe: 2 });
  v("l'autre société ne voit pas la présentation", r.status === 404, `${r.status}`);
  r = await envoyer("POST", `/studio/presentations/${pres.id}`, FAT, {
    plan: planDe(1), images: [imageDiapo(0)], societe: 2 });
  v("et ne l'enregistre pas", r.status === 404 || r.status === 403, `${r.status}`);

  /* ════════════════════ LA CORBEILLE ════════════════════ */
  titre("La corbeille");
  await appel("POST", `/studio/documents/${pres.id}/corbeille`, { user: DIR });
  r = await envoyer("POST", `/studio/presentations/${pres.id}`, DIR, {
    plan: planDe(1), images: [imageDiapo(0)] });
  v("une présentation à la corbeille demande d'être restaurée d'abord",
    r.status === 409 && r.data?.code === "DOCUMENT_A_LA_CORBEILLE", `${r.status} ${r.data?.code}`);
  r = await appel("GET", `/studio/presentations/${pres.id}`, { user: DIR });
  v("mais son plan reste consultable : la fiche doit pouvoir s'ouvrir",
    r.status === 200 && !!r.data?.document?.trashed_at, `${r.status} ${r.data?.document?.trashed_at}`);
  r = await appel("GET", "/studio/presentations", { user: DIR });
  v("et elle sort de la liste",
    !(r.data?.presentations || []).map((p) => Number(p.id)).includes(Number(pres.id)),
    JSON.stringify((r.data?.presentations || []).map((p) => p.id)));

  console.log(`\n  ${ok} réussis, ${ko} échoués\n`);
  await pool.end();
  process.exit(ko ? 1 : 0);
})().catch(async (e) => {
  console.error("\n  ✘ interrompu :", e.message, "\n", e.stack);
  await pool.end().catch(() => {});
  process.exit(2);
});
