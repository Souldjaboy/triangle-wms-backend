"use strict";
/**
 * ANNOTER UNE PAGE : TEXTE, TABLEAUX, SURLIGNAGE, CADRES.
 *
 * Ce que ces essais éprouvent :
 *
 *  1. Que l'écran reçoit la géométrie des pages TELLE QU'ON LA VOIT. Une
 *     page tournée d'un quart de tour se présente couchée ; c'est dans ce
 *     repère que l'interface place les annotations, et l'ignorer les envoie
 *     à l'autre bout du papier.
 *  2. Que poser une annotation produit une VERSION DE PLUS, et que la note
 *     de version dit CE QUI a été posé et OÙ. Six mois plus tard, c'est
 *     tout ce dont on disposera pour expliquer une mention sur un bon.
 *  3. Que l'ORIGINAL NE BOUGE PAS : même fichier, même empreinte.
 *  4. Que rien ne déborde en silence — ni un texte trop long pour son cadre,
 *     ni un tableau trop haut, ni une annotation hors de la page.
 *  5. Que les accents français passent et qu'un alphabet qu'aucune police
 *     standard n'écrit est refusé AVEC LE CARACTÈRE FAUTIF NOMMÉ, au lieu
 *     d'une erreur obscure venue des entrailles de pdf-lib.
 *  6. Qu'annoter demande le droit de MODIFIER, pas celui de lire.
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

/* Trois pages de tailles et de rotations différentes : la deuxième est
   tournée d'un quart de tour, comme en sort un scanner. */
async function pdfTrois() {
  const d = await PDFDocument.create();
  const a = d.addPage([595, 842]);
  a.drawRectangle({ x: 40, y: 700, width: 60, height: 60, color: rgb(0.1, 0.4, 0.9) });
  const b = d.addPage([595, 842]);
  b.setRotation(degrees(90));
  const c = d.addPage([420, 595]);
  c.setRotation(degrees(270));
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

const TEXTE = (p) => ({
  nature: "TEXTE", page: 1, x: 50, y: 600, largeur: 400, hauteur: 60, taille: 14,
  texte: "Reçu conforme à Sébénikoro le 2 novembre", ...p });
const TABLEAU = (p) => ({
  nature: "TABLEAU", page: 1, x: 50, y: 300, largeur: 450, hauteur: 150, taille: 10,
  lignes: [["Produit", "Quantité", "Unité"], ["Ciment", "320", "sacs"], ["Sable", "18", "tonnes"]],
  ...p });

(async () => {
  /* ═══════════════ LA GÉOMÉTRIE TELLE QU'ON LA VOIT ═══════════════ */
  titre("La géométrie des pages est donnée dans le repère de l'affichage");
  const doc = await deposer(DIR, { nom: "Bon a annoter.pdf", contenu: await pdfTrois() });
  v("le PDF de trois pages est déposé", !!doc?.id, JSON.stringify(doc)?.slice(0, 120));

  let r = await appel("GET", `/studio/documents/${doc.id}/pages-vues`, { user: DIR });
  v("la géométrie se lit", r.status === 200 && r.data?.pages?.length === 3,
    `${r.status} ${JSON.stringify(r.data)?.slice(0, 160)}`);
  v("la réponse dit dans quel repère elle parle", r.data?.repere === "affichage", r.data?.repere);
  const [p1, p2, p3] = r.data?.pages || [];
  v("la page droite garde ses dimensions", p1?.largeur === 595 && p1?.hauteur === 842,
    `${p1?.largeur}×${p1?.hauteur}`);
  v("la page tournée d'un quart de tour se présente couchée",
    p2?.largeur === 842 && p2?.hauteur === 595, `${p2?.largeur}×${p2?.hauteur}`);
  v("et elle dit de combien elle est tournée", p2?.rotation === 90, String(p2?.rotation));
  v("les dimensions du PDF restent lisibles à côté",
    p2?.largeurPdf === 595 && p2?.hauteurPdf === 842, `${p2?.largeurPdf}×${p2?.hauteurPdf}`);
  v("l'autre quart de tour aussi", p3?.largeur === 595 && p3?.hauteur === 420 && p3?.rotation === 270,
    `${p3?.largeur}×${p3?.hauteur} r${p3?.rotation}`);

  /* ═══════════════════ POSER, ET GARDER L'ORIGINAL ══════════════════ */
  titre("Annoter produit une version de plus");
  /* LE FICHIER D'UNE VERSION SE LIT PAR L'IDENTIFIANT DE LA VERSION, pas
     par un paramètre sur le document. Le premier jet de cet essai appelait
     « /fichier?version=1 » : le paramètre était simplement ignoré, donc
     l'essai comparait la version courante à elle-même et criait que
     l'original avait changé. L'affirmation était fausse, pas le code. */
  const idVersion = async (n) => (await q(
    `SELECT id FROM studio_document_versions WHERE document_id = $1 AND version = $2`,
    [doc.id, n]))[0]?.id;
  const vers1 = await idVersion(1);
  const v1 = await appel("GET", `/studio/versions/${vers1}/fichier`, { user: DIR, brut: true });
  const empreinteV1 = S.empreinte(v1.buffer);
  v("le fichier de la version 1 se lit", v1.status === 200 && v1.buffer.length > 0, `${v1.status}`);

  r = await appel("POST", `/studio/documents/${doc.id}/annotations`, {
    user: DIR, corps: { annotations: [TEXTE(), TABLEAU(), {
      nature: "SURLIGNAGE", page: 2, x: 100, y: 400, largeur: 300, hauteur: 30 }, {
      nature: "CADRE", page: 3, x: 40, y: 40, largeur: 200, hauteur: 100 }] } });
  v("les quatre annotations passent", r.status === 200, `${r.status} ${JSON.stringify(r.data)?.slice(0, 200)}`);
  v("le document passe en version 2", r.data?.version === 2, String(r.data?.version));
  v("les trois pages sont toujours là", r.data?.document?.page_count === 3,
    String(r.data?.document?.page_count));
  v("le message rappelle que la précédente reste",
    /précédente reste intacte/.test(r.data?.message || ""), r.data?.message);
  v("la réponse dit la rotation de chaque page annotée",
    r.data?.posees?.[2]?.rotation === 90 && r.data?.posees?.[3]?.rotation === 270,
    JSON.stringify(r.data?.posees));

  /* LA NOTE DE VERSION EST LA SEULE TRACE DE CE QU'ON A POSÉ. */
  const notes = await q(
    `SELECT version, change_note AS note FROM studio_document_versions WHERE document_id = $1 ORDER BY version`,
    [doc.id]);
  const note2 = notes.find((n) => n.version === 2)?.note || "";
  v("la note de version nomme ce qui a été posé",
    /mention/.test(note2) && /tableau/.test(note2) && /surlignage/.test(note2) && /cadre/.test(note2),
    note2);
  v("et sur quelles pages", /pages 1, 2, 3/.test(note2), note2);

  const apres = await appel("GET", `/studio/versions/${vers1}/fichier`, { user: DIR, brut: true });
  v("l'original garde exactement son fichier", S.empreinte(apres.buffer) === empreinteV1,
    `${S.empreinte(apres.buffer).slice(0, 12)} contre ${empreinteV1.slice(0, 12)}`);
  const v2 = await appel("GET", `/studio/documents/${doc.id}/fichier`, { user: DIR, brut: true });
  v("la version 2 est un autre fichier", S.empreinte(v2.buffer) !== empreinteV1);
  v("et c'est bien un PDF de trois pages",
    (await PDFDocument.load(v2.buffer)).getPageCount() === 3);
  v("dont les rotations n'ont pas été touchées",
    (await PDFDocument.load(v2.buffer)).getPages().map((p) => p.getRotation().angle).join(",") === "0,90,270",
    (await PDFDocument.load(v2.buffer)).getPages().map((p) => p.getRotation().angle).join(","));

  /* ═══════════════════ RIEN NE DÉBORDE EN SILENCE ═══════════════════ */
  titre("Rien ne déborde en silence");
  const refus = async (nom, annotations, code, motDansLErreur) => {
    const rep = await appel("POST", `/studio/documents/${doc.id}/annotations`, {
      user: DIR, corps: { annotations } });
    v(nom, rep.status >= 400 && rep.data?.code === code,
      `${rep.status} ${rep.data?.code} — ${String(rep.data?.error).slice(0, 140)}`);
    if (motDansLErreur) {
      v(`  et le refus l'explique (${motDansLErreur})`,
        new RegExp(motDansLErreur, "i").test(rep.data?.error || ""), rep.data?.error);
    }
    return rep;
  };

  await refus("un texte trop long pour son cadre",
    [TEXTE({ largeur: 90, hauteur: 18,
      texte: "Un commentaire bien trop long pour tenir dans un si petit cadre." })],
    "TEXTE_DEBORDE", "rien n'est rogné sans le dire");
  await refus("un tableau trop haut pour son cadre",
    [TABLEAU({ hauteur: 25 })], "TABLEAU_DEBORDE", "aucune ligne n'est coupée sans le dire");
  await refus("une annotation qui sort de la page",
    [TEXTE({ x: 500, largeur: 300 })], "HORS_PAGE", "sort de la page");
  await refus("une annotation sur une page qui n'existe pas",
    [TEXTE({ page: 9 })], "PAGE_INEXISTANTE", "3 pages");
  await refus("une nature inventée",
    [{ nature: "TAMPON", page: 1, x: 10, y: 10, largeur: 50, hauteur: 50 }], "NATURE_INCONNUE");
  await refus("une couleur qui n'en est pas",
    [TEXTE({ couleur: "bleu nuit" })], "COULEUR_INVALIDE", "hexad");
  await refus("une police inconnue",
    [TEXTE({ police: "comic" })], "POLICE_INCONNUE");
  await refus("une liste vide", [], "RIEN_A_POSER");
  await refus("un tableau sans ligne",
    [TABLEAU({ lignes: [] })], "TABLEAU_VIDE");

  /* LE RANG DE L'ANNOTATION FAUTIVE REMONTE JUSQU'À L'APPELANT. Avec six
     cadres en attente, « ce texte demande 4 lignes » ne dit pas lequel
     corriger : il faudrait les essayer un par un. */
  titre("Un refus dit DE QUELLE annotation il parle");
  let rr = await appel("POST", `/studio/documents/${doc.id}/annotations`, {
    user: DIR, corps: { annotations: [
      { nature: "CADRE", page: 1, x: 20, y: 20, largeur: 100, hauteur: 60 },
      TABLEAU(),
      TEXTE({ largeur: 80, hauteur: 16,
        texte: "Une mention bien trop longue pour un cadre de cette taille." }),
    ] } });
  v("le troisième cadre est désigné par son rang",
    rr.status === 400 && rr.data?.index === 3, `${rr.status} index ${rr.data?.index}`);
  v("et rien n'a été posé : la version n'a pas changé",
    (await q(`SELECT version FROM studio_documents WHERE id = $1`, [doc.id]))[0].version === 2,
    String((await q(`SELECT version FROM studio_documents WHERE id = $1`, [doc.id]))[0].version));
  rr = await appel("POST", `/studio/documents/${doc.id}/annotations`, {
    user: DIR, corps: { annotations: [TEXTE(), { nature: "CADRE", page: 9, x: 1, y: 1, largeur: 9, hauteur: 9 }] } });
  v("une page inexistante désigne aussi son rang",
    rr.data?.index === 2, `index ${rr.data?.index}`);

  /* ═══════════ CE QUE LES POLICES D'UN PDF SAVENT ÉCRIRE ═══════════ */
  titre("Les accents passent, le reste est refusé par son nom");
  r = await appel("POST", `/studio/documents/${doc.id}/annotations`, {
    user: DIR, corps: { annotations: [TEXTE({
      texte: "Reçu à Sébénikoro — cœur de l'entrepôt, coût 1 500 € déjà réglé" })] } });
  v("les accents, le tiret cadratin, l'œ et l'euro passent", r.status === 200,
    `${r.status} ${String(r.data?.error).slice(0, 160)}`);

  await refus("un alphabet qu'aucune police standard n'écrit",
    [TEXTE({ texte: "Livraison пример" })], "CARACTERE_INECRIVABLE", "пример|« п »");

  /* ═════════════════════════ LES DROITS ════════════════════════════ */
  titre("Annoter demande le droit de modifier");
  r = await appel("GET", `/studio/documents/${doc.id}/pages-vues`, { user: MAGA });
  v("le magasinier lit bien la géométrie", r.status === 200, `${r.status}`);
  r = await appel("POST", `/studio/documents/${doc.id}/annotations`, {
    user: MAGA, corps: { annotations: [TEXTE()] } });
  v("mais il ne peut pas annoter", r.status === 403 || r.status === 404, `${r.status}`);

  r = await appel("POST", `/studio/documents/${doc.id}/annotations`, {
    user: FAT, societe: 2, corps: { annotations: [TEXTE()] } });
  v("l'autre société ne voit même pas le document",
    r.status === 404, `${r.status} ${r.data?.code}`);

  /* ═══════════════ CE QUI N'EST PAS ANNOTABLE ══════════════════════ */
  titre("Ce qui n'est pas un PDF, et ce qui est à la corbeille");
  const image = await deposer(DIR, {
    nom: "Photo.png", mime: "image/png",
    contenu: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4AWP4//8/AyUYTAEAVsgL8f4e9t0AAAAASUVORK5CYII=",
      "base64") });
  r = await appel("POST", `/studio/documents/${image.id}/annotations`, {
    user: DIR, corps: { annotations: [TEXTE()] } });
  v("une image n'est pas annotable", r.status === 415 && r.data?.code === "PAS_UN_PDF",
    `${r.status} ${r.data?.code}`);

  const jete = await deposer(DIR, { nom: "A jeter.pdf", contenu: await pdfTrois() });
  /* METTRE À LA CORBEILLE est un POST ; le DELETE, lui, EFFACE pour de bon
     et demande un autre droit. Le premier jet de cet essai confondait les
     deux et ne jetait donc rien du tout. */
  const jet = await appel("POST", `/studio/documents/${jete.id}/corbeille`, { user: DIR });
  v("le document part à la corbeille", jet.status === 200, `${jet.status}`);
  r = await appel("POST", `/studio/documents/${jete.id}/annotations`, {
    user: DIR, corps: { annotations: [TEXTE()] } });
  v("un document à la corbeille demande d'être restauré d'abord",
    r.status === 409 && r.data?.code === "DOCUMENT_A_LA_CORBEILLE", `${r.status} ${r.data?.code}`);

  titre("Un fichier altéré sur le disque est refusé");
  const cle = (await q(`SELECT storage_key FROM studio_documents WHERE id = $1`, [doc.id]))[0].storage_key;
  const original = await S.octets(cle);
  await S.ecrire(cle, await pdfTrois());
  r = await appel("POST", `/studio/documents/${doc.id}/annotations`, {
    user: DIR, corps: { annotations: [TEXTE()] } });
  v("rien n'est posé", r.status === 409 && r.data?.code === "DOCUMENT_ALTERE",
    `${r.status} ${r.data?.code}`);
  await S.ecrire(cle, original);
  r = await appel("POST", `/studio/documents/${doc.id}/annotations`, {
    user: DIR, corps: { annotations: [TEXTE()] } });
  v("réparé, il s'annote à nouveau", r.status === 200, `${r.status}`);

  /* ══════════════ UNE PAGE TOURNÉE RESTE ANNOTABLE EN ENTIER ══════════ */
  titre("Le repère de l'affichage vaut sur une page tournée");
  r = await appel("POST", `/studio/documents/${doc.id}/annotations`, {
    user: DIR, corps: { annotations: [{
      /* 842 de large à l'affichage : un cadre de 800 y tient, alors qu'il
         dépasserait les 595 points de large du contenu. C'est la preuve que
         le serveur raisonne bien dans le repère annoncé. */
      nature: "CADRE", page: 2, x: 20, y: 20, largeur: 800, hauteur: 500 }] } });
  v("un cadre large de 800 points tient sur la page couchée", r.status === 200,
    `${r.status} ${String(r.data?.error).slice(0, 160)}`);
  r = await appel("POST", `/studio/documents/${doc.id}/annotations`, {
    user: DIR, corps: { annotations: [{
      nature: "CADRE", page: 2, x: 20, y: 20, largeur: 200, hauteur: 580 }] } });
  v("mais un cadre haut de 580 n'y tient pas : la page ne fait que 595 de haut",
    r.status === 400 && r.data?.code === "HORS_PAGE", `${r.status} ${r.data?.code}`);

  console.log(`\n  ${ok} réussis, ${ko} échoués\n`);
  await pool.end();
  process.exit(ko ? 1 : 0);
})().catch(async (e) => {
  console.error("\n  ✘ interrompu :", e.message, "\n", e.stack);
  await pool.end().catch(() => {});
  process.exit(2);
});
