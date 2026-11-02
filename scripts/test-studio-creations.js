"use strict";
/**
 * LES CRÉATIONS GRAPHIQUES.
 *
 * Ce que ces essais éprouvent :
 *
 *  1. Qu'une création est un DOCUMENT ORDINAIRE — une image qui se cherche,
 *     se partage, se télécharge — et qu'elle porte en plus son plan.
 *  2. Que le PDF d'impression sort aux DIMENSIONS PHYSIQUES EXACTES. Une
 *     carte de visite à 90 % n'entre plus dans un porte-cartes, et cela ne se
 *     découvre qu'une fois les cartes livrées.
 *  3. Qu'on ne peut pas enregistrer un plan sans dimensions, ni un plan
 *     illisible, ni un plan démesuré.
 *  4. Que modifier produit une version de plus, et que le plan suit l'image.
 *  5. Que l'autre société ne voit rien.
 */
const jwt = require("jsonwebtoken");
const zlib = require("zlib");
const { Pool } = require("pg");
const { PDFDocument } = require("pdf-lib");
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

let TABLE = null;
function crc32(b) {
  if (!TABLE) {
    TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (const x of b) c = TABLE[(c ^ x) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function png(largeur, hauteur) {
  const bloc = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, "latin1");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largeur, 0); ihdr.writeUInt32BE(hauteur, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const lignes = [];
  for (let y = 0; y < hauteur; y++) {
    lignes.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(largeur * 3, 230)]));
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    bloc("IHDR", ihdr),
    bloc("IDAT", zlib.deflateSync(Buffer.concat(lignes))),
    bloc("IEND", Buffer.alloc(0)),
  ]);
}

const PLAN = {
  fond: "#ffffff",
  elements: [
    { id: "t1", type: "texte", x: 5, y: 5, l: 70, texte: "Prénom NOM", taille: 6,
      couleur: "#0f172a", graisse: 700, alignement: "gauche", police: "sans", interligne: 1.2 },
  ],
};

/* On omet un champ avec `null`, PAS avec `undefined` : en déstructuration,
   `undefined` déclenche la valeur par défaut, si bien que « sans dimensions »
   envoyait en réalité 85×55 et l'essai accusait le serveur d'accepter ce
   qu'il n'avait jamais reçu. */
async function creer(user, { nom = "Carte", plan = PLAN, largeur = 85, hauteur = 55,
  format = "Carte de visite", societe, image } = {}) {
  const form = new FormData();
  form.append("image", new Blob([image || png(1004, 650)], { type: "image/png" }), `${nom}.png`);
  form.append("nom", nom);
  if (plan !== null) form.append("plan", typeof plan === "string" ? plan : JSON.stringify(plan));
  if (largeur !== null) form.append("largeur_mm", String(largeur));
  if (hauteur !== null) form.append("hauteur_mm", String(hauteur));
  form.append("format", format);
  const r = await fetch(`${BASE}/studio/creations`, {
    method: "POST", headers: entetes(user, societe), body: form });
  let d = null; try { d = await r.json(); } catch { /* non JSON */ }
  return { status: r.status, data: d };
}

(async () => {
  /* ═══════════════════════ CRÉER ET ROUVRIR ══════════════════════ */
  titre("Une création est un document, et porte son plan");
  let r = await creer(DIR);
  v("la création passe", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  const id = r.data?.creation?.id;
  v("elle est de nature CREATION", r.data?.creation?.kind === "CREATION");
  v("ses dimensions physiques sont gardées",
    Number(r.data?.creation?.design_mm_width) === 85 &&
    Number(r.data?.creation?.design_mm_height) === 55,
    JSON.stringify([r.data?.creation?.design_mm_width, r.data?.creation?.design_mm_height]));
  v("la note d'origine dit le format",
    /85×55 mm/.test(r.data?.creation?.source_note || ""), r.data?.creation?.source_note);

  /* C'EST UN DOCUMENT ORDINAIRE : la bibliothèque le voit et le sert. */
  r = await appel("GET", `/studio/documents/${id}`, { user: DIR });
  v("la bibliothèque la voit comme un document", r.status === 200, `${r.status}`);
  v("avec sa version 1 marquée original", r.data?.versions?.[0]?.is_original === true);
  r = await appel("GET", `/studio/documents/${id}/fichier`, { user: DIR, brut: true });
  v("son image se télécharge",
    r.status === 200 && r.buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", `${r.status}`);

  r = await appel("GET", `/studio/creations/${id}`, { user: DIR });
  v("le plan se rouvre", r.status === 200, JSON.stringify(r.data)?.slice(0, 160));
  v("avec ses éléments", r.data?.plan?.elements?.length === 1, JSON.stringify(r.data?.plan));
  v("et ses dimensions", r.data?.largeur_mm === 85 && r.data?.hauteur_mm === 55,
    JSON.stringify([r.data?.largeur_mm, r.data?.hauteur_mm]));

  r = await appel("GET", "/studio/creations", { user: DIR });
  v("elle figure dans la liste des créations",
    (r.data?.creations || []).some((x) => x.id === id));

  /* ═══════════════════════ MODIFIER ══════════════════════════════ */
  titre("Modifier produit une version de plus, plan compris");
  const plan2 = { fond: "#f8fafc", elements: [
    ...PLAN.elements,
    { id: "t2", type: "texte", x: 5, y: 20, l: 70, texte: "Fonction", taille: 4,
      couleur: "#64748b", graisse: 400, alignement: "gauche", police: "sans", interligne: 1.2 },
  ] };
  const form = new FormData();
  form.append("image", new Blob([png(1004, 650)], { type: "image/png" }), "Carte.png");
  form.append("plan", JSON.stringify(plan2));
  form.append("largeur_mm", "85"); form.append("hauteur_mm", "55");
  form.append("note", "ajout de la fonction sous le nom");
  let rep = await fetch(`${BASE}/studio/creations/${id}`, {
    method: "POST", headers: entetes(DIR), body: form });
  let d = await rep.json().catch(() => ({}));
  v("la modification passe", rep.status === 200, JSON.stringify(d)?.slice(0, 200));
  v("le document passe en version 2", d?.creation?.version === 2, String(d?.creation?.version));
  v("le message rappelle que la précédente reste",
    /reste intacte et téléchargeable/.test(d?.message || ""), d?.message);

  r = await appel("GET", `/studio/creations/${id}`, { user: DIR });
  v("le plan rouvert est le nouveau", r.data?.plan?.elements?.length === 2,
    JSON.stringify(r.data?.plan?.elements?.length));
  v("et le fond a suivi", r.data?.plan?.fond === "#f8fafc", r.data?.plan?.fond);

  /* ═════════════════ LE PDF AUX VRAIES DIMENSIONS ════════════════ */
  titre("Le PDF d'impression sort aux dimensions exactes");
  r = await appel("POST", `/studio/creations/${id}/impression`, {
    user: DIR, corps: { exemplaires: 4 } });
  v("l'export passe", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  v("le message donne les dimensions réelles",
    /85×55 mm exactement/.test(r.data?.message || ""), r.data?.message);
  const pdfId = r.data?.document?.id;
  v("un document PDF est créé", r.data?.document?.mime === "application/pdf");
  v("avec le bon nombre de pages", r.data?.document?.page_count === 4,
    String(r.data?.document?.page_count));

  const fichier = await appel("GET", `/studio/documents/${pdfId}/fichier`, { user: DIR, brut: true });
  const pdf = await PDFDocument.load(fichier.buffer);
  v("le PDF porte quatre pages", pdf.getPageCount() === 4, String(pdf.getPageCount()));
  const taille = pdf.getPages()[0].getSize();
  /* 85 mm = 240,94 points ; 55 mm = 155,91 points. Un demi-point de
     tolérance : au-delà, l'imprimeur verrait la différence. */
  v("la page fait exactement 85 mm de large",
    Math.abs(taille.width - 85 * 72 / 25.4) < 0.5, `${taille.width.toFixed(2)} pt`);
  v("et exactement 55 mm de haut",
    Math.abs(taille.height - 55 * 72 / 25.4) < 0.5, `${taille.height.toFixed(2)} pt`);
  v("la provenance est inscrite",
    /Export d.impression de/.test(r.data?.document?.source_note || ""),
    r.data?.document?.source_note);

  /* ═══════════════════ CE QUI DOIT ÊTRE REFUSÉ ═══════════════════ */
  titre("Ce qui doit être refusé");
  r = await creer(DIR, { nom: "Sans dimensions", largeur: null, hauteur: null });
  v("une création sans dimensions",
    r.status === 400 && r.data?.code === "DIMENSIONS_REQUISES", `${r.status} ${r.data?.code}`);
  r = await creer(DIR, { nom: "Demesuree", largeur: 5000, hauteur: 5000 });
  v("des dimensions absurdes",
    r.status === 400 && r.data?.code === "DIMENSIONS_ABSURDES", `${r.status} ${r.data?.code}`);
  r = await creer(DIR, { nom: "Plan casse", plan: "{ceci n'est pas du JSON" });
  v("un plan illisible",
    r.status === 400 && r.data?.code === "PLAN_ILLISIBLE", `${r.status} ${r.data?.code}`);
  r = await creer(DIR, { nom: "Plan vide", plan: { fond: "#fff" } });
  v("un plan sans éléments",
    r.status === 400 && r.data?.code === "PLAN_SANS_ELEMENTS", `${r.status} ${r.data?.code}`);
  r = await creer(DIR, { nom: "" });
  v("une création sans nom",
    r.status === 400 && r.data?.code === "NOM_REQUIS", `${r.status} ${r.data?.code}`);

  /* UN PLAN DÉMESURÉ : une image entière collée dedans, par exemple. */
  const gros = { fond: "#fff", elements: [
    { id: "i1", type: "image", x: 0, y: 0, l: 10, h: 10, src: "x".repeat(2_100_000), arrondi: 0 }] };
  r = await creer(DIR, { nom: "Plan trop lourd", plan: gros });
  v("un plan démesuré",
    r.status === 400 && r.data?.code === "PLAN_TROP_LOURD", `${r.status} ${r.data?.code}`);
  v("et le refus dit quoi faire",
    /déposez les images dans la bibliothèque/.test(r.data?.error || ""), r.data?.error);

  /* UN DOCUMENT QUI N'EST PAS UNE CRÉATION. */
  const formOrdinaire = new FormData();
  formOrdinaire.append("fichier", new Blob([png(40, 40)], { type: "image/png" }), "Photo.png");
  formOrdinaire.append("nom", "Photo.png");
  formOrdinaire.append("visibilite", "SOCIETE");
  const rp = await fetch(`${BASE}/studio/documents`, {
    method: "POST", headers: entetes(DIR), body: formOrdinaire });
  const photo = (await rp.json()).document;
  r = await appel("GET", `/studio/creations/${photo.id}`, { user: DIR });
  v("un document ordinaire n'a pas de plan",
    r.status === 409 && r.data?.code === "PAS_UNE_CREATION", `${r.status} ${r.data?.code}`);
  v("et le refus explique pourquoi",
    /faites dans le studio graphique/.test(r.data?.error || ""), r.data?.error);
  r = await appel("POST", `/studio/creations/${photo.id}/impression`, { user: DIR, corps: {} });
  v("et ne s'exporte pas comme une création", r.status === 409, `${r.status}`);

  /* ════════════════════ LA FRONTIÈRE DES SOCIÉTÉS ═══════════════ */
  titre("Les deux maisons ne se croisent pas");
  r = await creer(FAT, { nom: "Carte Fatemat", societe: 2 });
  v("FAT & MAT fait ses propres créations", r.status === 201, `${r.status}`);
  const idFat = r.data?.creation?.id;
  r = await appel("GET", `/studio/creations/${idFat}`, { user: DIR });
  v("Triangle ne les rouvre pas", r.status === 404, `${r.status}`);
  r = await appel("GET", "/studio/creations", { user: DIR });
  v("et ne les voit pas dans sa liste",
    !(r.data?.creations || []).some((x) => x.id === idFat));

  /* UNE CRÉATION PRIVÉE RESTE PRIVÉE. */
  r = await appel("GET", `/studio/creations/${id}`, { user: COMPTA });
  v("un collègue ne rouvre pas une création privée", r.status === 404, `${r.status}`);

  /* ═══════════ UN FICHIER ALTÉRÉ N'EST PAS EXPORTÉ ══════════════ */
  titre("Un fichier altéré sur le disque n'est pas exporté");
  const cle = (await q(`SELECT storage_key FROM studio_documents WHERE id = $1`, [id]))[0].storage_key;
  const original = await S.octets(cle);
  await S.ecrire(cle, png(100, 100));
  r = await appel("POST", `/studio/creations/${id}/impression`, { user: DIR, corps: {} });
  v("l'export est refusé",
    r.status === 409 && r.data?.code === "DOCUMENT_ALTERE", `${r.status} ${r.data?.code}`);
  await S.ecrire(cle, original);
  r = await appel("POST", `/studio/creations/${id}/impression`, { user: DIR, corps: {} });
  v("réparé, il s'exporte à nouveau", r.status === 201, `${r.status}`);

  console.log(`\n  ${ok} réussis, ${ko} échoués\n`);
  await pool.end();
  process.exit(ko ? 1 : 0);
})().catch(async (e) => {
  console.error("\n  ✘ interrompu :", e.message, "\n", e.stack);
  await pool.end().catch(() => {});
  process.exit(2);
});
