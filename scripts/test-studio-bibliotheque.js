"use strict";
/**
 * LA BIBLIOTHÈQUE DU STUDIO.
 *
 * Ce que ces tests éprouvent, dans l'ordre où cela compte :
 *
 *  1. Qu'un document n'est atteignable que par son propriétaire, les
 *     personnes avec qui il est partagé, et — s'il est marqué SOCIETE — par
 *     l'entreprise. Jamais par l'autre société.
 *  2. Qu'aucune URL ne contourne ces contrôles : les fichiers vivent hors du
 *     dossier servi en statique.
 *  3. Que l'ORIGINAL ne change jamais : une modification crée une version, et
 *     la version 1 garde son fichier et son empreinte.
 *  4. Qu'un fichier déguisé est refusé — HTML renommé en PDF, extension qui
 *     ment, contenu qui ne correspond pas au type annoncé.
 *  5. Que rien ne disparaît d'un clic : corbeille, puis suppression
 *     définitive avec motif.
 *  6. Qu'un lien signé expire, se révoque, se compte — et que son jeton n'est
 *     jamais relisible.
 */
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { Pool } = require("pg");
const BASE = "http://localhost:5050";
const SECRET = process.env.JWT_SECRET || "test_studio";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let ok = 0, ko = 0;
const v = (n, c, d = "") => { if (c) { ok++; console.log(`  ✔ ${n}`); } else { ko++; console.log(`  ✘ ${n}${d ? `\n      → ${d}` : ""}`); } };
const titre = (t) => console.log(`\n── ${t}`);
const jeton = (u) => jwt.sign({ ...u, tenant_id: "triangle" }, SECRET, { expiresIn: "1h" });
const q = async (s, p = []) => (await pool.query(s, p)).rows;
const un = async (s, p = []) => (await q(s, p))[0];

const DIR    = { id: 900, fullname: "Direction Triangle", role: "direction", company_id: 1, is_super_admin: false };
const COMPTA = { id: 901, fullname: "Comptable Triangle", role: "comptable", company_id: 1, is_super_admin: false };
const MAGA   = { id: 902, fullname: "Magasinier Triangle", role: "magasinier", company_id: 1, is_super_admin: false };
const FAT    = { id: 903, fullname: "Direction Fatemat", role: "direction", company_id: 2, is_super_admin: false };

const entetes = (u, societe) => ({
  Authorization: `Bearer ${jeton(u)}`,
  "x-tenant-id": "triangle",
  "x-active-company-id": String(societe ?? u.company_id),
});

async function appel(m, chemin, { user, societe, corps, brut } = {}) {
  const h = user ? entetes(u = user, societe) : { "x-tenant-id": "triangle" };
  if (corps !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(BASE + chemin, { method: m, headers: h,
    body: corps === undefined ? undefined : JSON.stringify(corps) });
  if (brut) return { status: r.status, type: r.headers.get("content-type"),
                     disposition: r.headers.get("content-disposition"),
                     buffer: Buffer.from(await r.arrayBuffer()) };
  let data = null; try { data = await r.json(); } catch { /* non JSON */ }
  return { status: r.status, data };
}
let u;

async function deposer(user, { nom, mime, contenu, ...reste }) {
  const form = new FormData();
  form.append("fichier", new Blob([contenu], { type: mime }), nom);
  for (const [k, val] of Object.entries(reste)) form.append(k, String(val));
  const r = await fetch(`${BASE}/studio/documents`, {
    method: "POST", headers: entetes(user), body: form });
  let d = null; try { d = await r.json(); } catch { /* non JSON */ }
  return { status: r.status, data: d };
}

const PDF = Buffer.from("%PDF-1.7\nContrat Triangle Logistics\n%%EOF");
const PDF2 = Buffer.from("%PDF-1.7\nContrat Triangle Logistics - version corrigee\n%%EOF");

(async () => {
  titre("Un dossier, puis un document");
  let r = await appel("POST", "/studio/dossiers", {
    user: DIR, corps: { nom: "Contrats" } });
  v("le dossier est créé", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  const dossier = r.data?.dossier?.id;

  r = await appel("POST", "/studio/dossiers", { user: DIR, corps: { nom: "Contrats" } });
  v("deux dossiers de même nom au même endroit sont refusés",
    r.status === 409 && r.data?.code === "DOSSIER_EXISTE", JSON.stringify(r.data));

  r = await appel("POST", "/studio/dossiers", {
    user: DIR, corps: { nom: "2026", parent_id: dossier } });
  v("un sous-dossier est accepté", r.status === 201);
  v("et son chemin est lisible", r.data?.dossier?.path === "Contrats / 2026", r.data?.dossier?.path);

  let d = await deposer(DIR, {
    nom: "Contrat SOCOBAT.pdf", mime: "application/pdf", contenu: PDF,
    dossier_id: dossier, description: "Contrat de transport annuel", tags: "contrat,socobat",
  });
  v("le document est déposé", d.status === 201, JSON.stringify(d.data)?.slice(0, 250));
  const doc = d.data?.document;
  v("il est en version 1", doc?.version === 1);
  v("son empreinte est calculée",
    doc?.sha256 === crypto.createHash("sha256").update(PDF).digest("hex"), doc?.sha256);
  v("la réponse ne transporte pas le texte reconnu", doc?.ocr_text === undefined);

  titre("LE POINT CENTRAL : aucune URL ne mène au fichier");
  const S = require(require("path").join(process.cwd(), "services/studio-stockage"));
  v("le fichier est hors du dossier servi en statique",
    !S.RACINE.includes("/uploads"), S.RACINE);
  r = await appel("GET", `/uploads/${doc.storage_key}`, {});
  v("une adresse statique vers la clé ne donne rien", r.status === 404, `${r.status}`);
  r = await appel("GET", `/storage/${doc.storage_key}`, {});
  v("et il n'existe aucune route /storage", r.status === 404, `${r.status}`);

  titre("Qui peut lire ce document ?");
  let f = await appel("GET", `/studio/documents/${doc.id}/fichier`, { user: DIR, brut: true });
  v("son propriétaire le télécharge", f.status === 200, `${f.status}`);
  v("et c'est bien le bon contenu", f.buffer?.equals(PDF));
  r = await appel("GET", `/studio/documents/${doc.id}`, { user: COMPTA });
  v("un collègue non destinataire ne le voit pas", r.status === 404, `${r.status}`);
  r = await appel("GET", `/studio/documents/${doc.id}`, { user: FAT, societe: 2 });
  v("FAT & MAT encore moins", r.status === 404, `${r.status}`);

  titre("Un partage nominatif");
  r = await appel("POST", `/studio/documents/${doc.id}/partages`, {
    user: DIR, corps: { utilisateur_id: 901, niveau: "LECTURE" } });
  v("le partage est enregistré", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  r = await appel("GET", `/studio/documents/${doc.id}`, { user: COMPTA });
  v("le destinataire voit désormais la fiche", r.status === 200, `${r.status}`);
  v("et sait pourquoi il y a accès", r.data?.motif_acces === "PARTAGE", r.data?.motif_acces);
  v("avec le niveau accordé", r.data?.mon_niveau === "LECTURE", r.data?.mon_niveau);

  r = await appel("PATCH", `/studio/documents/${doc.id}`, {
    user: COMPTA, corps: { name: "Renommé par un lecteur" } });
  v("mais un lecteur ne renomme pas", r.status === 404, `${r.status}`);

  r = await appel("POST", `/studio/documents/${doc.id}/partages`, {
    user: DIR, corps: { utilisateur_id: 903, niveau: "LECTURE" } });
  v("on ne partage pas vers l'autre société",
    r.status === 404 && r.data?.code === "DESTINATAIRE_INTROUVABLE", JSON.stringify(r.data));

  titre("La visibilité « société »");
  r = await appel("PATCH", `/studio/documents/${doc.id}`, {
    user: DIR, corps: { visibility: "SOCIETE" } });
  v("la visibilité change", r.status === 200 && r.data?.document?.visibility === "SOCIETE");
  r = await appel("GET", `/studio/documents/${doc.id}`, { user: MAGA });
  v("tout Triangle le voit maintenant", r.status === 200, `${r.status}`);
  v("et le motif le dit", r.data?.motif_acces === "SOCIETE", r.data?.motif_acces);
  r = await appel("GET", `/studio/documents/${doc.id}`, { user: FAT, societe: 2 });
  v("FAT & MAT ne le voit toujours pas", r.status === 404, `${r.status}`);

  titre("L'ORIGINAL NE CHANGE JAMAIS");
  const form = new FormData();
  form.append("fichier", new Blob([PDF2], { type: "application/pdf" }), "Contrat SOCOBAT.pdf");
  form.append("note", "montant de la ligne 3 corrigé");
  let rep = await fetch(`${BASE}/studio/documents/${doc.id}/versions`, {
    method: "POST", headers: entetes(DIR), body: form });
  let data = await rep.json().catch(() => ({}));
  v("la nouvelle version est acceptée", rep.status === 201, JSON.stringify(data)?.slice(0, 200));
  v("le document passe en version 2", data?.document?.version === 2, String(data?.document?.version));

  const versions = await q(
    `SELECT * FROM studio_document_versions WHERE document_id=$1 ORDER BY version`, [doc.id]);
  v("deux versions existent", versions.length === 2, String(versions.length));
  v("la version 1 est marquée « original »", versions[0].is_original === true);
  v("la version 2 ne l'est pas", versions[1].is_original === false);
  v("l'original garde son empreinte d'origine",
    versions[0].sha256 === crypto.createHash("sha256").update(PDF).digest("hex"));
  v("et sa propre clé de stockage", versions[0].storage_key !== versions[1].storage_key);

  f = await appel("GET", `/studio/versions/${versions[0].id}/fichier`, { user: DIR, brut: true });
  v("l'original se télécharge encore, intact", f.status === 200 && f.buffer?.equals(PDF));
  v("et son nom dit que c'est l'original",
    /original/.test(f.disposition || ""), f.disposition);
  f = await appel("GET", `/studio/documents/${doc.id}/fichier`, { user: DIR, brut: true });
  v("la version courante est bien la nouvelle", f.buffer?.equals(PDF2));

  r = await appel("POST", `/studio/documents/${doc.id}/versions`, {
    user: DIR, corps: {} });
  v("une version sans fichier est refusée", r.status === 400, `${r.status}`);

  titre("Une modification doit dire ce qu'elle change");
  const form2 = new FormData();
  form2.append("fichier", new Blob([PDF2], { type: "application/pdf" }), "x.pdf");
  /* « correction » fait exactement dix caractères et passerait le minimum :
     c'est le piège dans lequel deux essais précédents sont déjà tombés. */
  form2.append("note", "oubli");
  rep = await fetch(`${BASE}/studio/documents/${doc.id}/versions`, {
    method: "POST", headers: entetes(DIR), body: form2 });
  data = await rep.json().catch(() => ({}));
  v("une note trop courte est refusée", rep.status === 400 && data?.code === "NOTE_REQUISE",
    JSON.stringify(data));

  titre("Les fichiers déguisés sont refusés");
  d = await deposer(DIR, {
    nom: "piege.pdf", mime: "application/pdf",
    contenu: Buffer.from("<html><script>alert(1)</script></html>") });
  v("du HTML renommé en PDF est refusé",
    d.status === 415 && d.data?.code === "CONTENU_INCOHERENT", JSON.stringify(d.data));
  d = await deposer(DIR, { nom: "piege.exe", mime: "application/pdf", contenu: PDF });
  v("une extension qui ment est refusée",
    d.status === 415 && d.data?.code === "EXTENSION_INCOHERENTE", JSON.stringify(d.data));
  d = await deposer(DIR, {
    nom: "script.js", mime: "application/javascript", contenu: Buffer.from("alert(1)") });
  v("un type hors de la liste est refusé",
    d.status === 415 && d.data?.code === "TYPE_REFUSE", JSON.stringify(d.data));
  d = await deposer(DIR, { nom: "vide.pdf", mime: "application/pdf", contenu: Buffer.alloc(0) });
  v("un fichier vide est refusé", d.status === 400 && d.data?.code === "FICHIER_VIDE",
    JSON.stringify(d.data));

  titre("La recherche");
  await deposer(DIR, {
    nom: "Facture BDM.pdf", mime: "application/pdf", contenu: PDF,
    visibilite: "SOCIETE", ocr_texte: "Banque de Developpement du Mali facture mensuelle" });
  r = await appel("GET", "/studio/documents?q=banque", { user: DIR });
  v("un mot du texte reconnu retrouve le document",
    (r.data?.documents || []).some((x) => x.name === "Facture BDM.pdf"),
    (r.data?.documents || []).map((x) => x.name).join(", "));
  r = await appel("GET", "/studio/documents?q=contrat", { user: DIR });
  v("un mot du nom aussi", (r.data?.documents || []).length >= 1);
  r = await appel("GET", "/studio/documents?tag=socobat", { user: DIR });
  v("une étiquette filtre la liste", (r.data?.documents || []).length === 1,
    String((r.data?.documents || []).length));
  r = await appel("GET", "/studio/documents", { user: FAT, societe: 2 });
  v("la liste de FAT & MAT est vide", (r.data?.documents || []).length === 0,
    String((r.data?.documents || []).length));

  titre("Rien ne disparaît d'un clic");
  r = await appel("DELETE", `/studio/documents/${doc.id}`, {
    user: DIR, corps: { motif: "suppression sans passer par la corbeille" } });
  v("on ne supprime pas ce qui n'est pas à la corbeille",
    r.status === 409 && r.data?.code === "PAS_A_LA_CORBEILLE", JSON.stringify(r.data));

  r = await appel("POST", `/studio/documents/${doc.id}/corbeille`, { user: DIR });
  v("la mise à la corbeille passe", r.status === 200, JSON.stringify(r.data)?.slice(0, 200));
  v("et le dit clairement", /Rien n'est effacé/.test(r.data?.message || ""), r.data?.message);
  r = await appel("GET", "/studio/documents", { user: DIR });
  v("il quitte la liste courante",
    !(r.data?.documents || []).some((x) => x.id === doc.id));
  r = await appel("GET", "/studio/documents?corbeille=1", { user: DIR });
  v("et se retrouve dans la corbeille", (r.data?.documents || []).some((x) => x.id === doc.id));

  /* CETTE AFFIRMATION ÉTAIT FAUSSE ET ELLE A COÛTÉ CHER. Elle exigeait un
     404 sur la fiche d'un document à la corbeille — ce qui semblait prudent
     et rendait en réalité la corbeille inutilisable : « Restaurer » et
     « Supprimer définitivement » vivent dans cette fiche, donc un document
     jeté ne pouvait plus ni revenir ni partir. Le défaut n'est apparu
     qu'en pilotant l'écran. La frontière n'est pas là : elle est sur le
     lien public, qui refuse bien d'ouvrir un document à la corbeille. */
  r = await appel("GET", `/studio/documents/${doc.id}`, { user: DIR });
  v("sa fiche s'ouvre encore, sinon la corbeille est un cul-de-sac",
    r.status === 200, `${r.status}`);
  v("et la fiche dit qu'il est à la corbeille", !!r.data?.document?.trashed_at);
  r = await appel("GET", `/studio/documents/${doc.id}/fichier`, { user: DIR });
  v("on peut le relire avant de le détruire", r.status === 200, `${r.status}`);

  r = await appel("POST", `/studio/documents/${doc.id}/restaurer`, { user: DIR });
  v("il se restaure", r.status === 200, `${r.status}`);
  r = await appel("GET", `/studio/documents/${doc.id}`, { user: DIR });
  v("et redevient visible", r.status === 200);

  titre("La suppression définitive");
  await appel("POST", `/studio/documents/${doc.id}/corbeille`, { user: DIR });
  r = await appel("DELETE", `/studio/documents/${doc.id}`, { user: DIR, corps: { motif: "court" } });
  v("un motif trop court est refusé", r.status === 400 && r.data?.code === "MOTIF_REQUIS",
    JSON.stringify(r.data));
  r = await appel("DELETE", `/studio/documents/${doc.id}`, { user: MAGA, corps: { motif: "tentative du magasinier" } });
  v("le magasinier ne supprime pas", r.status === 404 || r.status === 403, `${r.status}`);

  const clesAvant = (await q(
    `SELECT storage_key FROM studio_document_versions WHERE document_id=$1`, [doc.id]))
    .map((x) => x.storage_key);
  r = await appel("DELETE", `/studio/documents/${doc.id}`, {
    user: DIR, corps: { motif: "contrat résilié, demande du client" } });
  v("la direction supprime définitivement", r.status === 200, JSON.stringify(r.data)?.slice(0, 200));
  v("les deux versions sont comptées", r.data?.versions === 2, String(r.data?.versions));
  v("l'avertissement est explicite",
    /toutes les versions ont été effacés/.test(r.data?.avertissement || ""), r.data?.avertissement);
  v("la ligne a disparu de la base",
    !(await un(`SELECT id FROM studio_documents WHERE id=$1`, [doc.id])));
  let restants = 0;
  for (const cle of clesAvant) if (await S.existe(cle)) restants += 1;
  v("et les fichiers du disque aussi", restants === 0, `${restants} fichier(s) restant(s)`);
  const trace = await un(
    `SELECT * FROM studio_access_log WHERE document_id=$1 AND action='SUPPRESSION_DEFINITIVE'`, [doc.id]);
  v("mais la trace du journal subsiste", !!trace);
  v("avec son motif", /contrat résilié/.test(trace?.detail || ""), trace?.detail);

  titre("Les liens signés");
  d = await deposer(DIR, { nom: "A partager.pdf", mime: "application/pdf", contenu: PDF });
  const doc2 = d.data?.document;
  r = await appel("POST", `/studio/documents/${doc2.id}/liens`, {
    user: DIR, corps: { heures: 2, max_telechargements: 2 } });
  v("le lien est créé", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  const lien = r.data?.lien;
  v("il est rendu une fois, avec l'avertissement",
    /n'est affiché qu'une fois/.test(r.data?.avertissement || ""), r.data?.avertissement);
  v("la réponse ne contient pas l'empreinte du jeton",
    r.data?.partage?.token_sha256 === undefined);

  const enBase = await un(`SELECT token_sha256 FROM studio_shares WHERE kind='LIEN' ORDER BY id DESC LIMIT 1`);
  const jetonClair = String(lien).replace("/studio/liens/", "");
  v("la base garde une EMPREINTE, pas le jeton",
    enBase?.token_sha256 === crypto.createHash("sha256").update(jetonClair).digest("hex")
    && enBase?.token_sha256 !== jetonClair);

  f = await appel("GET", lien, { brut: true });
  v("le lien s'ouvre SANS jeton de session", f.status === 200, `${f.status}`);
  v("et rend le bon fichier", f.buffer?.equals(PDF));
  f = await appel("GET", lien, { brut: true });
  v("une deuxième fois aussi", f.status === 200, `${f.status}`);
  f = await appel("GET", lien, { brut: true });
  v("mais pas une troisième : le compteur est atteint", f.status === 404, `${f.status}`);

  r = await appel("GET", "/studio/liens/jeton-invente-de-toutes-pieces", {});
  v("un jeton inventé ne donne rien", r.status === 404 && r.data?.code === "LIEN_INVALIDE",
    JSON.stringify(r.data));

  titre("Révoquer un lien");
  r = await appel("POST", `/studio/documents/${doc2.id}/liens`, { user: DIR, corps: { heures: 24 } });
  const lien2 = r.data?.lien;
  const partage2 = r.data?.partage?.id;
  f = await appel("GET", lien2, { brut: true });
  v("le nouveau lien fonctionne", f.status === 200, `${f.status}`);
  r = await appel("DELETE", `/studio/partages/${partage2}`, { user: DIR, corps: { motif: "court" } });
  v("révoquer sans motif suffisant est refusé", r.status === 400, `${r.status}`);
  r = await appel("DELETE", `/studio/partages/${partage2}`, {
    user: DIR, corps: { motif: "envoyé au mauvais destinataire" } });
  v("avec motif, la révocation passe", r.status === 200, JSON.stringify(r.data)?.slice(0, 160));
  f = await appel("GET", lien2, { brut: true });
  v("le lien ne fonctionne plus", f.status === 404, `${f.status}`);

  titre("Un lien expiré");
  r = await appel("POST", `/studio/documents/${doc2.id}/liens`, { user: DIR, corps: { heures: 1 } });
  const lien3 = r.data?.lien;
  await pool.query(
    `UPDATE studio_shares SET expires_at = now() - interval '1 minute'
      WHERE kind='LIEN' AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`).catch(async () => {
    await pool.query(
      `UPDATE studio_shares SET expires_at = now() - interval '1 minute'
        WHERE id = (SELECT id FROM studio_shares WHERE kind='LIEN' AND revoked_at IS NULL ORDER BY id DESC LIMIT 1)`);
  });
  f = await appel("GET", lien3, { brut: true });
  v("il ne s'ouvre plus", f.status === 404, `${f.status}`);
  r = await appel("POST", `/studio/documents/${doc2.id}/liens`, { user: DIR, corps: { heures: 0 } });
  v("une durée nulle est refusée", r.status === 400 && r.data?.code === "DUREE_INVALIDE",
    JSON.stringify(r.data));
  r = await appel("POST", `/studio/documents/${doc2.id}/liens`, { user: DIR, corps: { heures: 10000 } });
  v("une durée de plus de 30 jours aussi", r.status === 400, `${r.status}`);

  titre("Une archive altérée n'est pas servie");
  const cle = (await un(`SELECT storage_key FROM studio_documents WHERE id=$1`, [doc2.id]))?.storage_key;
  const fsx = require("fs");
  fsx.appendFileSync(S.cheminDe(cle), "octet en trop");
  f = await appel("GET", `/studio/documents/${doc2.id}/fichier`, { user: DIR });
  v("le serveur refuse", f.status === 409, `${f.status}`);

  titre("Le journal");
  const actions = await q(
    `SELECT action, count(*)::int n FROM studio_access_log GROUP BY 1 ORDER BY 1`);
  const parAction = Object.fromEntries(actions.map((x) => [x.action, x.n]));
  for (const a of ["DEPOT", "LECTURE", "TELECHARGEMENT", "NOUVELLE_VERSION",
                   "PARTAGE", "CORBEILLE", "RESTAURATION", "SUPPRESSION_DEFINITIVE",
                   "REVOCATION", "LIEN_UTILISE"]) {
    v(`« ${a} » est journalisé`, (parAction[a] || 0) >= 1, JSON.stringify(parAction));
  }

  console.log(`\n${"─".repeat(56)}\n  ${ok} réussis, ${ko} échoués\n${"─".repeat(56)}`);
  await pool.end();
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
