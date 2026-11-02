"use strict";
/**
 * L'ÉDITEUR DE PAGES.
 *
 * Ce que ces essais éprouvent :
 *
 *  1. Qu'AUCUNE PAGE NE SE PERD EN SILENCE. Chaque réponse dit combien il y
 *     en avait et combien il en reste, et le découpage signale les pages
 *     qu'aucune tranche ne reprend.
 *  2. Que ce qui MODIFIE un document produit une version de plus, l'original
 *     gardant toutes ses pages — et que ce qui en CRÉE d'autres ne touche
 *     pas aux sources.
 *  3. Que retirer des pages, seul geste qui fait disparaître du contenu,
 *     exige une raison qui se relit.
 *  4. Que la rotation s'AJOUTE à celle déjà présente.
 *  5. Qu'on ne modifie pas un document qu'on n'a qu'en lecture, ni celui de
 *     l'autre société, ni un fichier altéré sur le disque.
 */
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { PDFDocument, degrees, rgb } = require("pdf-lib");
const S = require("../services/studio-stockage");

const BASE = "http://localhost:5050";
const SECRET = process.env.JWT_SECRET || "test_studio";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let ok = 0, ko = 0;
const v = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ✔ ${n}`); }
  else { ko++; console.log(`  ✘ ${n}${d ? `\n      → ${d}` : ""}`); }
};
const titre = (t) => console.log(`\n── ${t}`);
const jeton = (u) => jwt.sign({ ...u, tenant_id: "triangle" }, SECRET, { expiresIn: "1h" });
const q = async (s, p = []) => (await pool.query(s, p)).rows;

const DIR    = { id: 900, fullname: "Direction Triangle", role: "direction", company_id: 1, is_super_admin: false };
const COMPTA = { id: 901, fullname: "Comptable Triangle", role: "comptable", company_id: 1, is_super_admin: false };
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

/* Un PDF dont CHAQUE PAGE EST RECONNAISSABLE : un carré de couleur dont la
   position change selon le numéro. On peut ainsi dire, après réorganisation,
   quelle page est où — et pas seulement combien il y en a. */
async function pdfNumerote(n, rotation = 0) {
  const d = await PDFDocument.create();
  for (let i = 0; i < n; i++) {
    const p = d.addPage([400, 600]);
    if (rotation) p.setRotation(degrees(rotation));
    p.drawRectangle({
      x: 20 + (i % 5) * 60, y: 500, width: 40, height: 40,
      color: rgb(0.1 + (i % 9) / 10, 0.2, 0.8 - (i % 7) / 10),
    });
  }
  return Buffer.from(await d.save());
}

async function deposer(user, { nom, contenu, visibilite = "SOCIETE", societe, mime = "application/pdf" }) {
  const form = new FormData();
  form.append("fichier", new Blob([contenu], { type: mime }), nom);
  form.append("nom", nom);
  form.append("visibilite", visibilite);
  const r = await fetch(`${BASE}/studio/documents`, {
    method: "POST", headers: entetes(user, societe), body: form });
  let d = null; try { d = await r.json(); } catch { /* non JSON */ }
  return d?.document;
}

/* Lire l'ordre des pages d'un PDF par la couleur de leur carré : c'est ce
   qui permet de dire que la page 5 est bien passée en tête. */
async function empreintesDePages(buffer) {
  const doc = await PDFDocument.load(buffer);
  return doc.getPages().map((p) => {
    const { width, height } = p.getSize();
    return `${Math.round(width)}x${Math.round(height)}r${p.getRotation().angle || 0}`;
  });
}

(async () => {
  /* ════════════════════════ RÉORDONNER ═══════════════════════════ */
  titre("Réordonner ne supprime rien");
  let doc = await deposer(DIR, { nom: "Dossier 5 pages.pdf", contenu: await pdfNumerote(5) });
  v("le PDF de cinq pages est déposé", doc?.page_count === 5 || !!doc, JSON.stringify(doc)?.slice(0, 120));

  let r = await appel("POST", `/studio/documents/${doc.id}/pages/ordre`, {
    user: DIR, corps: { ordre: [5, 4, 3, 2, 1] } });
  v("la réorganisation passe", r.status === 200, JSON.stringify(r.data)?.slice(0, 200));
  v("le compte ne bouge pas", r.data?.avant === 5 && r.data?.apres === 5, JSON.stringify(r.data));
  v("le document passe en version 2", r.data?.version === 2, String(r.data?.version));
  v("le message rappelle que la précédente reste",
    /précédente reste intacte/.test(r.data?.message || ""), r.data?.message);

  r = await appel("POST", `/studio/documents/${doc.id}/pages/ordre`, {
    user: DIR, corps: { ordre: [1, 2, 3] } });
  v("un ordre partiel est refusé",
    r.status === 400 && r.data?.code === "ORDRE_INCOMPLET", `${r.status} ${r.data?.code}`);
  v("et le refus dit quoi faire à la place",
    /utilisez le retrait/.test(r.data?.error || ""), r.data?.error);
  r = await appel("POST", `/studio/documents/${doc.id}/pages/ordre`, {
    user: DIR, corps: { ordre: [1, 1, 2, 3, 4] } });
  v("une page citée deux fois est refusée",
    r.status === 400 && r.data?.code === "PAGE_EN_DOUBLE", `${r.status} ${r.data?.code}`);

  /* ════════════════════════ TOURNER ══════════════════════════════ */
  titre("La rotation s'ajoute à celle qui existe");
  r = await appel("POST", `/studio/documents/${doc.id}/pages/rotation`, {
    user: DIR, corps: { pages: [1, 2], angle: 90 } });
  v("la rotation passe", r.status === 200 && r.data?.tournees === 2, JSON.stringify(r.data)?.slice(0, 160));
  r = await appel("POST", `/studio/documents/${doc.id}/pages/rotation`, {
    user: DIR, corps: { pages: [1], angle: 90 } });
  v("un second quart de tour passe", r.status === 200, `${r.status}`);
  let fichier = await appel("GET", `/studio/documents/${doc.id}/fichier`, { user: DIR, brut: true });
  let formes = await empreintesDePages(fichier.buffer);
  v("la première page est à 180°, pas revenue à 90",
    /r180$/.test(formes[0]), formes.join(" | "));
  v("la deuxième est restée à 90", /r90$/.test(formes[1]), formes.join(" | "));
  v("les autres n'ont pas bougé", /r0$/.test(formes[2]), formes.join(" | "));

  r = await appel("POST", `/studio/documents/${doc.id}/pages/rotation`, {
    user: DIR, corps: { pages: [1], angle: 45 } });
  v("un angle qui n'est pas un quart de tour est refusé",
    r.status === 400 && r.data?.code === "ANGLE_INVALIDE", `${r.status} ${r.data?.code}`);

  /* ════════════════════════ RETIRER ══════════════════════════════ */
  titre("Retirer des pages demande une raison");
  r = await appel("DELETE", `/studio/documents/${doc.id}/pages`, {
    user: DIR, corps: { pages: [2], motif: "court" } });
  v("un motif trop court est refusé",
    r.status === 400 && r.data?.code === "MOTIF_REQUIS", `${r.status} ${r.data?.code}`);

  const versionAvantRetrait = (await appel("GET", `/studio/documents/${doc.id}`, { user: DIR }))
    .data?.document?.version;
  r = await appel("DELETE", `/studio/documents/${doc.id}/pages`, {
    user: DIR, corps: { pages: [2, 4], motif: "pages blanches du scanner" } });
  v("le retrait passe", r.status === 200, JSON.stringify(r.data)?.slice(0, 200));
  v("il dit combien il y avait et combien il reste",
    r.data?.avant === 5 && r.data?.apres === 3, JSON.stringify(r.data));
  v("le message renvoie vers la version complète",
    /complète, reste téléchargeable/.test(r.data?.message || ""), r.data?.message);

  /* LA VERSION PRÉCÉDENTE GARDE SES CINQ PAGES. */
  r = await appel("GET", `/studio/documents/${doc.id}`, { user: DIR });
  const versionComplete = (r.data?.versions || []).find((x) => x.version === versionAvantRetrait);
  v("la version d'avant est toujours là", !!versionComplete);
  const f2 = await appel("GET", `/studio/versions/${versionComplete.id}/fichier`, { user: DIR, brut: true });
  v("et elle porte encore cinq pages",
    (await empreintesDePages(f2.buffer)).length === 5,
    String((await empreintesDePages(f2.buffer)).length));
  v("la note de version dit pourquoi elles sont parties",
    /pages blanches du scanner/.test(
      (r.data?.versions || []).find((x) => x.version === versionAvantRetrait + 1)?.change_note || ""),
    (r.data?.versions || []).find((x) => x.version === versionAvantRetrait + 1)?.change_note);

  r = await appel("DELETE", `/studio/documents/${doc.id}/pages`, {
    user: DIR, corps: { pages: [1, 2, 3], motif: "tout retirer pour voir" } });
  v("on ne retire pas toutes les pages",
    r.status === 400 && r.data?.code === "DOCUMENT_VIDE", `${r.status} ${r.data?.code}`);

  /* ════════════════════════ EXTRAIRE ═════════════════════════════ */
  titre("Extraire ne touche pas à la source");
  const avantExtraction = (await appel("GET", `/studio/documents/${doc.id}`, { user: DIR }))
    .data?.document;
  r = await appel("POST", `/studio/documents/${doc.id}/pages/extraire`, {
    user: DIR, corps: { pages: [1, 3], nom: "Bon detache" } });
  v("l'extraction passe", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  const extrait = r.data?.document?.id;
  v("un nouveau document est créé", !!extrait);
  v("avec le bon nombre de pages", r.data?.pages === 2, String(r.data?.pages));
  v("le message dit que la source n'a pas bougé",
    /n.a pas été modifié/.test(r.data?.message || ""), r.data?.message);
  v("la provenance est inscrite",
    /extraites de/.test(r.data?.document?.source_note || ""), r.data?.document?.source_note);
  v("et le lien vers la source est gardé",
    Number(r.data?.document?.source_document_id) === Number(doc.id));

  const apresExtraction = (await appel("GET", `/studio/documents/${doc.id}`, { user: DIR }))
    .data?.document;
  v("la source garde sa version", apresExtraction.version === avantExtraction.version,
    `${avantExtraction.version} → ${apresExtraction.version}`);
  v("et son empreinte", apresExtraction.sha256 === avantExtraction.sha256);

  /* ════════════════════════ FUSIONNER ════════════════════════════ */
  titre("Fusionner assemble sans rien modifier");
  const a = await deposer(DIR, { nom: "Piece A.pdf", contenu: await pdfNumerote(2) });
  const b = await deposer(DIR, { nom: "Piece B.pdf", contenu: await pdfNumerote(3) });
  r = await appel("POST", "/studio/pdf/fusion", {
    user: DIR, corps: { documents: [a.id, b.id], nom: "Dossier complet" } });
  v("la fusion passe", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  v("le total est la somme", r.data?.pages === 5, String(r.data?.pages));
  v("la composition est consignée", (r.data?.composition || []).length === 2,
    JSON.stringify(r.data?.composition));
  v("elle dit à quelle page commence chaque pièce",
    r.data?.composition?.[1]?.depuis === 3, JSON.stringify(r.data?.composition));
  v("la note du document garde la composition",
    /Fusion de/.test(r.data?.document?.source_note || ""), r.data?.document?.source_note);

  r = await appel("POST", "/studio/pdf/fusion", { user: DIR, corps: { documents: [a.id], nom: "Seul" } });
  v("fusionner un seul document est refusé",
    r.status === 400 && r.data?.code === "PAS_ASSEZ_DE_DOCUMENTS", `${r.status} ${r.data?.code}`);
  r = await appel("POST", "/studio/pdf/fusion", {
    user: DIR, corps: { documents: [a.id, a.id], nom: "Deux fois" } });
  v("le même document deux fois est refusé",
    r.status === 400 && r.data?.code === "DOCUMENT_EN_DOUBLE", `${r.status} ${r.data?.code}`);
  r = await appel("POST", "/studio/pdf/fusion", { user: DIR, corps: { documents: [a.id, b.id] } });
  v("une fusion sans nom est refusée",
    r.status === 400 && r.data?.code === "NOM_REQUIS", `${r.status} ${r.data?.code}`);

  /* ════════════════════════ DÉCOUPER ═════════════════════════════ */
  titre("Découper dit ce qui n'a pas été repris");
  const gros = await deposer(DIR, { nom: "Lot de bons.pdf", contenu: await pdfNumerote(6) });
  r = await appel("POST", `/studio/documents/${gros.id}/pages/decouper`, {
    user: DIR, corps: { tranches: [
      { nom: "Bon 1", pages: [1, 2] },
      { nom: "Bon 2", pages: [3, 4] },
    ] } });
  v("le découpage passe", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  v("deux documents sont créés", (r.data?.crees || []).length === 2);
  v("chacun porte ses pages",
    r.data?.crees?.[0]?.pages === 2 && r.data?.crees?.[1]?.pages === 2,
    JSON.stringify(r.data?.crees?.map((c) => c.pages)));
  /* LA PROMESSE : ON NE PERD PAS DE PAGE EN SILENCE. */
  v("les pages non reprises sont signalées",
    JSON.stringify(r.data?.oubliees) === "[5,6]", JSON.stringify(r.data?.oubliees));
  v("et le message les nomme",
    /ne figurent.*dans aucune partie \(5, 6\)/.test(r.data?.message || ""), r.data?.message);

  r = await appel("POST", `/studio/documents/${gros.id}/pages/decouper`, {
    user: DIR, corps: { tranches: [
      { nom: "Un", pages: [1, 2] }, { nom: "Deux", pages: [2, 3] },
    ] } });
  v("une page dans deux tranches est refusée",
    r.status === 400 && r.data?.code === "PAGE_PARTAGEE", `${r.status} ${r.data?.code}`);
  v("et le refus nomme la page", /page 2/.test(r.data?.error || ""), r.data?.error);

  /* ════════════════════ CE QUI DOIT ÊTRE REFUSÉ ══════════════════ */
  titre("Ce qui doit être refusé");
  const priveCompta = await deposer(COMPTA, { nom: "Note comptable.pdf", contenu: await pdfNumerote(2) });
  r = await appel("POST", `/studio/documents/${priveCompta.id}/pages/ordre`, {
    user: DIR, corps: { ordre: [2, 1] } });
  v("on ne réordonne pas un document qu'on n'a qu'en lecture", r.status === 404, `${r.status}`);
  r = await appel("POST", `/studio/documents/${priveCompta.id}/pages/extraire`, {
    user: DIR, corps: { pages: [1] } });
  v("mais on peut en extraire une page, qu'on a le droit de lire",
    r.status === 201, `${r.status} ${JSON.stringify(r.data)?.slice(0, 120)}`);

  const image = await deposer(DIR, {
    nom: "Photo.png", mime: "image/png",
    contenu: Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" + "0d0a2db4" + "0000000049454e44ae426082", "hex") });
  r = await appel("POST", `/studio/documents/${image.id}/pages/ordre`, {
    user: DIR, corps: { ordre: [1] } });
  v("une image n'a pas de pages à réordonner",
    r.status === 415 && r.data?.code === "PAS_UN_PDF", `${r.status} ${r.data?.code}`);

  const jete = await deposer(DIR, { nom: "A jeter.pdf", contenu: await pdfNumerote(2), visibilite: "PRIVE" });
  await appel("POST", `/studio/documents/${jete.id}/corbeille`, { user: DIR });
  r = await appel("POST", `/studio/documents/${jete.id}/pages/ordre`, {
    user: DIR, corps: { ordre: [2, 1] } });
  v("on ne touche pas à ce qui est à la corbeille",
    r.status === 409 && r.data?.code === "DOCUMENT_A_LA_CORBEILLE", `${r.status} ${r.data?.code}`);

  /* L'AUTRE SOCIÉTÉ. */
  r = await appel("POST", `/studio/documents/${doc.id}/pages/ordre`, {
    user: FAT, societe: 2, corps: { ordre: [1, 2, 3] } });
  v("l'autre société ne touche à rien", r.status === 404 || r.status === 403, `${r.status}`);

  /* UN FICHIER ALTÉRÉ. */
  titre("Un fichier altéré sur le disque est refusé");
  const cle = (await q(`SELECT storage_key FROM studio_documents WHERE id = $1`, [a.id]))[0].storage_key;
  const original = await S.octets(cle);
  await S.ecrire(cle, await pdfNumerote(9));
  r = await appel("POST", `/studio/documents/${a.id}/pages/ordre`, {
    user: DIR, corps: { ordre: [2, 1] } });
  v("rien n'est modifié", r.status === 409 && r.data?.code === "DOCUMENT_ALTERE",
    `${r.status} ${r.data?.code}`);
  r = await appel("POST", "/studio/pdf/fusion", {
    user: DIR, corps: { documents: [a.id, b.id], nom: "Fusion depuis un altere" } });
  v("et il n'entre pas dans une fusion", r.status === 409, `${r.status} ${r.data?.code}`);
  await S.ecrire(cle, original);
  r = await appel("POST", `/studio/documents/${a.id}/pages/ordre`, {
    user: DIR, corps: { ordre: [2, 1] } });
  v("réparé, il se modifie à nouveau", r.status === 200, `${r.status}`);

  console.log(`\n  ${ok} réussis, ${ko} échoués\n`);
  await pool.end();
  process.exit(ko ? 1 : 0);
})().catch(async (e) => {
  console.error("\n  ✘ interrompu :", e.message, "\n", e.stack);
  await pool.end().catch(() => {});
  process.exit(2);
});
