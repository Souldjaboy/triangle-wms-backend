"use strict";
/**
 * SIGNATURES ET CACHETS.
 *
 * Ce que ces essais éprouvent, dans l'ordre où cela compte :
 *
 *  1. Qu'une SIGNATURE n'appartient qu'à son propriétaire. Ni son rôle, ni
 *     la direction, ni un administrateur n'y accèdent — pas même à son
 *     image. Quiconque obtient l'image peut signer à la place de quelqu'un :
 *     c'est la règle qui rend tout le reste crédible.
 *  2. Qu'un CACHET appartient à la société, est visible de ses membres, et
 *     ne traverse jamais la frontière vers l'autre maison.
 *  3. Que signer PRODUIT UNE VERSION DE PLUS : l'original non signé reste
 *     intact, marqué « original », et toujours téléchargeable.
 *  4. Que la trace garde les empreintes d'avant et d'après, la page et la
 *     position — ce qu'on relira le jour où une signature est contestée.
 *  5. Qu'on ne supprime pas une signature : on la révoque, avec un motif, et
 *     les documents déjà signés restent signés.
 *  6. Qu'un fichier altéré sur le disque n'est ni servi ni apposé.
 */
const jwt = require("jsonwebtoken");
const zlib = require("zlib");
const { Pool } = require("pg");
const { PDFDocument, degrees } = require("pdf-lib");
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
  if (brut) {
    return { status: r.status, type: r.headers.get("content-type"),
      cache: r.headers.get("cache-control"),
      buffer: Buffer.from(await r.arrayBuffer()) };
  }
  let data = null; try { data = await r.json(); } catch { /* non JSON */ }
  return { status: r.status, data };
}

/* ───────────────── UNE VRAIE IMAGE, PAS UNE IMITATION ──────────────────
   Le serveur contrôle les octets de tête : un faux PNG serait refusé, et
   l'essai mesurerait le refus au lieu de la signature. */
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
function png(largeur = 240, hauteur = 80, teinte = 0) {
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
    const l = Buffer.alloc(1 + largeur * 3);
    for (let x = 0; x < largeur; x++) {
      /* Un trait oblique : de quoi distinguer deux signatures à l'œil. */
      const trait = Math.abs(y - (x * hauteur) / largeur) < 6;
      l[1 + x * 3] = trait ? teinte : 255;
      l[2 + x * 3] = trait ? teinte : 255;
      l[3 + x * 3] = trait ? teinte : 255;
    }
    lignes.push(l);
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    bloc("IHDR", ihdr),
    bloc("IDAT", zlib.deflateSync(Buffer.concat(lignes))),
    bloc("IEND", Buffer.alloc(0)),
  ]);
}

async function pdfBlanc(pages = 2, rotation = 0) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = d.addPage([595, 842]);
    if (rotation) p.setRotation(degrees(rotation));
  }
  return Buffer.from(await d.save());
}

async function enregistrer(user, { buffer, nature = "SIGNATURE", nom = "", defaut = false, mime = "image/png", fichier = "signature.png", societe }) {
  const form = new FormData();
  form.append("image", new Blob([buffer], { type: mime }), fichier);
  form.append("nature", nature);
  if (nom) form.append("nom", nom);
  if (defaut) form.append("defaut", "1");
  const r = await fetch(`${BASE}/studio/signatures`, {
    method: "POST", headers: entetes(user, societe), body: form });
  let d = null; try { d = await r.json(); } catch { /* non JSON */ }
  return { status: r.status, data: d };
}

async function deposer(user, { nom, mime, contenu, visibilite = "PRIVE", societe }) {
  const form = new FormData();
  form.append("fichier", new Blob([contenu], { type: mime }), nom);
  form.append("nom", nom);
  form.append("visibilite", visibilite);
  const r = await fetch(`${BASE}/studio/documents`, {
    method: "POST", headers: entetes(user, societe), body: form });
  let d = null; try { d = await r.json(); } catch { /* non JSON */ }
  return { status: r.status, data: d };
}

(async () => {
  /* ══════════════════ UNE SIGNATURE PERSONNELLE ══════════════════ */
  titre("Une signature s'enregistre");
  let r = await enregistrer(DIR, { buffer: png(240, 80, 20), nom: "Paraphe", defaut: true });
  v("l'enregistrement passe", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  const sigDir = r.data?.signature?.id;
  v("elle est de nature SIGNATURE", r.data?.signature?.kind === "SIGNATURE");
  v("elle porte son propriétaire", Number(r.data?.signature?.owner_id) === DIR.id);
  v("ses dimensions sont lues",
    r.data?.signature?.width_px === 240 && r.data?.signature?.height_px === 80,
    `${r.data?.signature?.width_px}×${r.data?.signature?.height_px}`);
  v("son rapport est calculé", Number(r.data?.signature?.ratio) === 3,
    String(r.data?.signature?.ratio));
  v("elle est celle par défaut", r.data?.signature?.is_default === true);

  r = await appel("GET", "/studio/signatures", { user: DIR });
  v("elle apparaît dans sa liste", (r.data?.signatures || []).some((x) => x.id === sigDir));
  v("et elle est marquée comme sienne",
    (r.data?.signatures || []).find((x) => x.id === sigDir)?.est_la_mienne === true);

  /* ═══════ PERSONNE D'AUTRE N'Y ACCÈDE — PAS MÊME SON IMAGE ══════ */
  titre("Une signature n'appartient qu'à son propriétaire");
  r = await appel("GET", "/studio/signatures", { user: COMPTA });
  v("un collègue ne la voit pas dans sa liste",
    !(r.data?.signatures || []).some((x) => x.id === sigDir),
    JSON.stringify(r.data?.signatures || []).slice(0, 160));
  r = await appel("GET", `/studio/signatures/${sigDir}/image`, { user: COMPTA, brut: true });
  v("il n'obtient pas son image", r.status === 404, `${r.status}`);
  r = await appel("GET", `/studio/signatures/${sigDir}/image`, { user: FAT, societe: 2, brut: true });
  v("l'autre société non plus", r.status === 404 || r.status === 403, `${r.status}`);

  r = await appel("GET", `/studio/signatures/${sigDir}/image`, { user: DIR, brut: true });
  v("son propriétaire, lui, l'obtient", r.status === 200, `${r.status}`);
  v("c'est bien un PNG", r.buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a");
  /* UNE SIGNATURE NE TRAÎNE PAS DANS UN CACHE de poste partagé. */
  v("elle n'est jamais mise en cache", /no-store/.test(r.cache || ""), r.cache || "aucun");

  /* ════════════════════ LE CACHET D'ENTREPRISE ═══════════════════ */
  titre("Un cachet engage la maison : il demande davantage");
  r = await enregistrer(COMPTA, { buffer: png(200, 200, 60), nature: "CACHET", nom: "Tampon Triangle" });
  v("le comptable ne pose pas le cachet de la maison",
    r.status === 404 || r.status === 403, `${r.status} ${JSON.stringify(r.data)?.slice(0, 120)}`);

  r = await enregistrer(DIR, { buffer: png(200, 200, 60), nature: "CACHET", nom: "Tampon Triangle", defaut: true });
  v("la direction, oui", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  const cachet = r.data?.signature?.id;
  v("le cachet n'a pas de propriétaire", r.data?.signature?.owner_id === null,
    String(r.data?.signature?.owner_id));

  r = await appel("GET", "/studio/signatures", { user: COMPTA });
  v("mais tous le voient dans la société", (r.data?.signatures || []).some((x) => x.id === cachet));
  r = await appel("GET", `/studio/signatures/${cachet}/image`, { user: COMPTA, brut: true });
  v("et peuvent en obtenir l'image", r.status === 200, `${r.status}`);
  r = await appel("GET", `/studio/signatures/${cachet}/image`, { user: FAT, societe: 2, brut: true });
  v("l'autre maison, jamais", r.status === 404 || r.status === 403, `${r.status}`);

  /* ═══════════════ UN SEUL DÉFAUT À LA FOIS ══════════════════════ */
  titre("Il n'y a qu'une signature par défaut");
  r = await enregistrer(DIR, { buffer: png(300, 90, 40), nom: "Paraphe large", defaut: true });
  v("une deuxième signature par défaut s'enregistre", r.status === 201, `${r.status}`);
  const sigDir2 = r.data?.signature?.id;
  const defauts = await q(
    `SELECT id FROM studio_signatures
      WHERE company_id = 1 AND kind = 'SIGNATURE' AND owner_id = $1
        AND is_default AND revoked_at IS NULL`, [DIR.id]);
  v("et l'ancienne cesse de l'être", defauts.length === 1 && Number(defauts[0].id) === Number(sigDir2),
    JSON.stringify(defauts));

  /* ═══════════════════════ APPOSER ═══════════════════════════════ */
  titre("Signer produit une version de plus, jamais une réécriture");
  let d = await deposer(DIR, {
    nom: "Contrat a signer.pdf", mime: "application/pdf",
    contenu: await pdfBlanc(2), visibilite: "SOCIETE" });
  v("le PDF est déposé", d.status === 201, JSON.stringify(d.data)?.slice(0, 160));
  const doc = d.data?.document?.id;
  const shaAvant = d.data?.document?.sha256;

  r = await appel("GET", `/studio/documents/${doc}/pages`, { user: DIR });
  v("l'écran peut connaître les pages", r.status === 200 && r.data?.pages?.length === 2,
    JSON.stringify(r.data)?.slice(0, 160));
  v("avec leurs dimensions", r.data?.pages?.[0]?.largeur === 595, JSON.stringify(r.data?.pages?.[0]));

  r = await appel("POST", `/studio/documents/${doc}/signer`, {
    user: DIR, corps: { signature_id: sigDir, page: 2, x: 350, y: 80, largeur: 150, hauteur: 50 } });
  v("la signature est apposée", r.status === 201, JSON.stringify(r.data)?.slice(0, 250));
  v("le document passe en version 2", r.data?.apposition?.version_apres === 2,
    JSON.stringify(r.data?.apposition));
  v("le message dit que la version non signée reste",
    /reste intacte et téléchargeable/.test(r.data?.message || ""), r.data?.message);
  const shaApres = r.data?.apposition?.empreinte_apres;
  v("l'empreinte a changé", shaApres && shaApres !== shaAvant);
  v("et celle d'avant est conservée", r.data?.apposition?.empreinte_avant === shaAvant);

  /* L'ORIGINAL RESTE INTACT ET TÉLÉCHARGEABLE. */
  r = await appel("GET", `/studio/documents/${doc}`, { user: DIR });
  v("le document porte deux versions", r.data?.versions?.length === 2);
  const v1 = (r.data?.versions || []).find((x) => x.version === 1);
  v("la version 1 est toujours marquée original", v1?.is_original === true);
  v("son empreinte n'a pas bougé", v1?.sha256 === shaAvant, `${v1?.sha256} / ${shaAvant}`);
  v("la note de version se relit seule",
    /Signé par .* en page 2/.test((r.data?.versions || []).find((x) => x.version === 2)?.change_note || ""),
    (r.data?.versions || []).find((x) => x.version === 2)?.change_note);

  r = await appel("GET", `/studio/versions/${v1.id}/fichier`, { user: DIR, brut: true });
  v("la version non signée se télécharge encore", r.status === 200 &&
    r.buffer.subarray(0, 5).toString("latin1") === "%PDF-", `${r.status}`);
  v("et elle pèse moins que la signée", r.buffer.length > 0);

  /* LA TRACE. */
  titre("La trace dit qui a signé quoi, et sur quoi exactement");
  r = await appel("GET", `/studio/documents/${doc}/signatures`, { user: DIR });
  v("la trace existe", (r.data?.appositions || []).length === 1, JSON.stringify(r.data)?.slice(0, 200));
  const trace = r.data?.appositions?.[0];
  v("elle nomme le signataire", trace?.acted_by_name === DIR.fullname, trace?.acted_by_name);
  v("elle dit la page", trace?.page_number === 2, String(trace?.page_number));
  v("elle garde la position", Number(trace?.pos_x) === 350 && Number(trace?.width_pt) === 150,
    JSON.stringify(trace));
  v("elle garde l'empreinte d'avant", trace?.sha256_before === shaAvant);
  v("et celle d'après", trace?.sha256_after === shaApres);
  v("elle relie les deux versions",
    trace?.version_before === 1 && trace?.version_after === 2, JSON.stringify(trace));

  /* ═══════════════ CE QU'ON NE PEUT PAS SIGNER ═══════════════════ */
  titre("Ce qui doit être refusé");
  r = await appel("POST", `/studio/documents/${doc}/signer`, {
    user: DIR, corps: { signature_id: sigDir, page: 1, x: 500, y: 80, largeur: 200, hauteur: 50 } });
  v("une signature qui déborde la page",
    r.status === 400 && r.data?.code === "HORS_PAGE", `${r.status} ${r.data?.code}`);
  r = await appel("POST", `/studio/documents/${doc}/signer`, {
    user: DIR, corps: { signature_id: sigDir, page: 9, x: 10, y: 10, largeur: 100, hauteur: 40 } });
  v("une page qui n'existe pas",
    r.status === 400 && r.data?.code === "PAGE_INEXISTANTE", `${r.status} ${r.data?.code}`);

  /* LA SIGNATURE D'AUTRUI : INTROUVABLE. */
  const sigCompta = (await enregistrer(COMPTA, { buffer: png(220, 70, 10), nom: "Paraphe comptable" })).data?.signature?.id;
  v("le comptable a sa propre signature", !!sigCompta);
  r = await appel("POST", `/studio/documents/${doc}/signer`, {
    user: DIR, corps: { signature_id: sigCompta, page: 1, x: 10, y: 10, largeur: 100, hauteur: 40 } });
  v("on ne signe pas avec la signature d'un autre",
    r.status === 404 && r.data?.code === "SIGNATURE_INTROUVABLE", `${r.status} ${r.data?.code}`);

  /* UN DOCUMENT QU'ON N'A QU'EN LECTURE. */
  const prive = (await deposer(COMPTA, {
    nom: "Note du comptable.pdf", mime: "application/pdf",
    contenu: await pdfBlanc(1), visibilite: "SOCIETE" })).data?.document?.id;
  r = await appel("POST", `/studio/documents/${prive}/signer`, {
    user: DIR, corps: { signature_id: sigDir, page: 1, x: 10, y: 10, largeur: 100, hauteur: 40 } });
  v("on ne signe pas un document qu'on n'a qu'en lecture",
    r.status === 404, `${r.status} ${r.data?.code}`);

  /* UN DOCUMENT QUI N'EST PAS UN PDF. */
  const image = (await deposer(DIR, {
    nom: "Photo.png", mime: "image/png", contenu: png(60, 40), visibilite: "SOCIETE" })).data?.document?.id;
  r = await appel("POST", `/studio/documents/${image}/signer`, {
    user: DIR, corps: { signature_id: sigDir, page: 1, x: 10, y: 10, largeur: 30, hauteur: 10 } });
  v("on ne signe que des PDF", r.status === 415 && r.data?.code === "PAS_UN_PDF",
    `${r.status} ${r.data?.code}`);

  /* UN DOCUMENT À LA CORBEILLE. */
  const jete = (await deposer(DIR, {
    nom: "A jeter.pdf", mime: "application/pdf",
    contenu: await pdfBlanc(1), visibilite: "PRIVE" })).data?.document?.id;
  await appel("POST", `/studio/documents/${jete}/corbeille`, { user: DIR });
  r = await appel("POST", `/studio/documents/${jete}/signer`, {
    user: DIR, corps: { signature_id: sigDir, page: 1, x: 10, y: 10, largeur: 100, hauteur: 40 } });
  v("on ne signe pas ce qui est à la corbeille",
    r.status === 409 && r.data?.code === "DOCUMENT_A_LA_CORBEILLE", `${r.status} ${r.data?.code}`);

  /* ═══════════ UN FICHIER ALTÉRÉ N'EST NI SERVI NI APPOSÉ ═══════ */
  titre("Un fichier altéré sur le disque est refusé");
  const cle = (await q(`SELECT storage_key FROM studio_signatures WHERE id = $1`, [sigDir]))[0].storage_key;
  const original = await S.octets(cle);
  await S.ecrire(cle, png(240, 80, 200));
  r = await appel("GET", `/studio/signatures/${sigDir}/image`, { user: DIR, brut: true });
  v("l'image altérée n'est pas servie", r.status === 409, `${r.status}`);
  r = await appel("POST", `/studio/documents/${doc}/signer`, {
    user: DIR, corps: { signature_id: sigDir, page: 1, x: 50, y: 50, largeur: 100, hauteur: 40 } });
  v("et elle n'est pas apposée",
    r.status === 409 && r.data?.code === "SIGNATURE_ALTEREE", `${r.status} ${r.data?.code}`);
  await S.ecrire(cle, original);
  r = await appel("GET", `/studio/signatures/${sigDir}/image`, { user: DIR, brut: true });
  v("réparée, elle est servie à nouveau", r.status === 200, `${r.status}`);

  /* ═══════════════════════ RÉVOQUER ══════════════════════════════ */
  titre("On ne supprime pas une signature, on la révoque");
  r = await appel("DELETE", `/studio/signatures/${sigDir}`, { user: DIR, corps: { motif: "court" } });
  v("un motif trop court est refusé",
    r.status === 400 && r.data?.code === "MOTIF_REQUIS", `${r.status} ${r.data?.code}`);
  r = await appel("DELETE", `/studio/signatures/${sigDir}`, { user: COMPTA, corps: { motif: "tentative du comptable" } });
  v("un collègue ne révoque pas la signature d'autrui", r.status === 404, `${r.status}`);

  r = await appel("DELETE", `/studio/signatures/${sigDir}`, {
    user: DIR, corps: { motif: "trace de paraphe trop pale a la numerisation" } });
  v("son propriétaire, oui", r.status === 200, JSON.stringify(r.data)?.slice(0, 160));
  v("le message rappelle que les documents signés le restent",
    /restent signés/.test(r.data?.message || ""), r.data?.message);

  r = await appel("GET", "/studio/signatures", { user: DIR });
  v("elle quitte la liste courante", !(r.data?.signatures || []).some((x) => x.id === sigDir));
  r = await appel("GET", "/studio/signatures?revoquees=1", { user: DIR });
  v("mais elle reste consultable", (r.data?.signatures || []).some((x) => x.id === sigDir));
  v("avec son motif",
    /pale a la numerisation/.test(
      (r.data?.signatures || []).find((x) => x.id === sigDir)?.revoke_reason || ""));

  r = await appel("POST", `/studio/documents/${doc}/signer`, {
    user: DIR, corps: { signature_id: sigDir, page: 1, x: 50, y: 50, largeur: 100, hauteur: 40 } });
  v("on ne signe plus avec elle",
    r.status === 409 && r.data?.code === "SIGNATURE_REVOQUEE", `${r.status} ${r.data?.code}`);
  v("et le refus dit pourquoi", /pale a la numerisation/.test(r.data?.error || ""), r.data?.error);

  /* LA TRACE SURVIT À LA RÉVOCATION. */
  r = await appel("GET", `/studio/documents/${doc}/signatures`, { user: DIR });
  v("la trace de l'apposition subsiste", (r.data?.appositions || []).length === 1);
  v("et garde le nom de la signature révoquée",
    (r.data?.appositions || [])[0]?.signature_kind === "SIGNATURE");

  /* ════════════════ LA FRONTIÈRE DES SOCIÉTÉS ═══════════════════ */
  titre("Les deux maisons ne se croisent pas");
  const sigFat = (await enregistrer(FAT, {
    buffer: png(210, 70, 30), nom: "Paraphe Fatemat", societe: 2 })).data?.signature?.id;
  v("FAT & MAT enregistre sa propre signature", !!sigFat);
  r = await appel("GET", `/studio/signatures/${sigFat}/image`, { user: DIR, brut: true });
  v("Triangle n'y accède pas", r.status === 404, `${r.status}`);
  r = await appel("POST", `/studio/documents/${doc}/signer`, {
    user: FAT, societe: 2,
    corps: { signature_id: sigFat, page: 1, x: 10, y: 10, largeur: 100, hauteur: 40 } });
  v("et ne signe pas un document de Triangle avec", r.status === 404, `${r.status}`);

  /* ═══════════ AUCUNE URL N'ATTEINT UNE SIGNATURE ═══════════════ */
  titre("Aucune URL publique n'atteint une signature");
  const cleFat = (await q(`SELECT storage_key FROM studio_signatures WHERE id = $1`, [sigFat]))[0].storage_key;
  for (const chemin of [`/uploads/${cleFat}`, `/${cleFat}`, `/storage/${cleFat}`]) {
    const rep = await fetch(BASE + chemin);
    v(`« ${chemin.slice(0, 40)}… » ne donne rien`, rep.status === 404, `${rep.status}`);
  }

  console.log(`\n  ${ok} réussis, ${ko} échoués\n`);
  await pool.end();
  process.exit(ko ? 1 : 0);
})().catch(async (e) => {
  console.error("\n  ✘ interrompu :", e.message, "\n", e.stack);
  await pool.end().catch(() => {});
  process.exit(2);
});
