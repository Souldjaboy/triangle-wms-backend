"use strict";
/**
 * LE SCANNER DU STUDIO.
 *
 * Ce que ces essais éprouvent, dans l'ordre où cela compte :
 *
 *  1. Qu'une séance de numérisation est un BROUILLON PRIVÉ : ni l'autre
 *     société, ni un collègue de la même société ne la voit — pas même la
 *     direction. Scanner un bulletin de paie ne doit pas le rendre lisible
 *     avant qu'on ait choisi où le ranger.
 *  2. Que les pages SURVIVENT : rangées dès la capture, retrouvées après un
 *     rechargement, reprises là où on s'était arrêté.
 *  3. Que l'ordre des pages se tient : insertion au milieu, retrait,
 *     déplacement — sans trou et sans rang en double, l'index unique étant
 *     le juge.
 *  4. Que l'assemblage produit un VRAI PDF, dont chaque page suit son
 *     orientation, et que ce PDF entre dans la bibliothèque comme un
 *     document ordinaire avec sa version 1 marquée « original ».
 *  5. Qu'une page altérée sur le disque n'est ni servie ni assemblée.
 *  6. Qu'abandonner efface réellement les fichiers.
 */
const jwt = require("jsonwebtoken");
const zlib = require("zlib");
const { Pool } = require("pg");
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
      buffer: Buffer.from(await r.arrayBuffer()) };
  }
  let data = null; try { data = await r.json(); } catch { /* non JSON */ }
  return { status: r.status, data };
}

/* ───────────────────── UN VRAI PNG, PAS UNE IMITATION ─────────────────────
   Le serveur contrôle les octets de tête : un faux PNG serait refusé, et
   l'essai mesurerait le refus au lieu du scanner. On en fabrique donc de
   véritables, aux dimensions voulues, pour éprouver l'orientation. */
let tableCrc = null;
function crc32(buf) {
  if (!tableCrc) {
    tableCrc = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      tableCrc[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (const b of buf) c = tableCrc[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function png(largeur, hauteur, gris = 200) {
  const bloc = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, "latin1");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largeur, 0); ihdr.writeUInt32BE(hauteur, 4);
  ihdr[8] = 8; ihdr[9] = 2;                       /* 8 bits, RVB */
  const lignes = [];
  for (let y = 0; y < hauteur; y++) {
    lignes.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(largeur * 3, gris)]));
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    bloc("IHDR", ihdr),
    bloc("IDAT", zlib.deflateSync(Buffer.concat(lignes))),
    bloc("IEND", Buffer.alloc(0)),
  ]);
}

async function ajouter(user, seanceId, { buffer, mime = "image/png", nom = "page.png",
  rang, coins, redressee, ocr } = {}) {
  const form = new FormData();
  form.append("page", new Blob([buffer], { type: mime }), nom);
  if (rang !== undefined) form.append("rang", String(rang));
  if (coins) form.append("coins", JSON.stringify(coins));
  if (redressee) form.append("redressee", "1");
  if (ocr) form.append("ocr_texte", ocr);
  const r = await fetch(`${BASE}/studio/scans/${seanceId}/pages`, {
    method: "POST", headers: entetes(user), body: form });
  let d = null; try { d = await r.json(); } catch { /* non JSON */ }
  return { status: r.status, data: d };
}

const rangs = (pages) => pages.map((p) => p.position).join(",");

(async () => {
  /* ═════════════════════ OUVRIR ET REPRENDRE ═════════════════════ */
  titre("Une séance s'ouvre, et se retrouve");
  let r = await appel("POST", "/studio/scans", {
    user: DIR, corps: { titre: "Contrat transport 2026", format: "AUTO", visibilite: "SOCIETE" } });
  v("la séance s'ouvre", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  const seance = r.data?.seance?.id;
  v("elle est en cours", r.data?.seance?.status === "EN_COURS");
  v("elle n'a pas encore de document", r.data?.seance?.document_id === null);

  r = await appel("GET", "/studio/scans", { user: DIR });
  v("elle apparaît dans ce qu'il y a à reprendre",
    (r.data?.seances || []).some((s) => s.id === seance));
  v("avec zéro page pour l'instant",
    (r.data?.seances || []).find((s) => s.id === seance)?.pages === 0);

  /* ═══════════════════ UN BROUILLON EST PRIVÉ ════════════════════ */
  titre("Un brouillon n'appartient qu'à celui qui scanne");
  r = await appel("GET", `/studio/scans/${seance}`, { user: COMPTA });
  v("un collègue de la même société ne la voit pas",
    r.status === 404 && r.data?.code === "SEANCE_INTROUVABLE", `${r.status}`);
  r = await appel("GET", `/studio/scans/${seance}`, { user: FAT, societe: 2 });
  v("l'autre société non plus", r.status === 404, `${r.status}`);
  r = await appel("GET", "/studio/scans", { user: COMPTA });
  v("elle n'est pas dans SA liste de reprise",
    !(r.data?.seances || []).some((s) => s.id === seance));
  r = await ajouter(COMPTA, seance, { buffer: png(600, 900) });
  v("un collègue n'y ajoute pas de page", r.status === 404, `${r.status}`);

  /* ════════════════════════ LES PAGES ════════════════════════════ */
  titre("Les pages se rangent dès la capture");
  r = await ajouter(DIR, seance, {
    buffer: png(600, 900), coins: [[10, 10], [590, 12], [588, 880], [12, 878]],
    redressee: true, ocr: "Contrat de transport entre Triangle et le transporteur" });
  v("la première page entre", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  v("elle prend le rang 1", r.data?.page?.position === 1);
  v("ses dimensions sont lues", r.data?.page?.width_px === 600 && r.data?.page?.height_px === 900,
    `${r.data?.page?.width_px}×${r.data?.page?.height_px}`);
  v("le redressement est noté", r.data?.page?.corrected === true);
  v("les quatre coins sont conservés", (r.data?.page?.corners || []).length === 4);

  r = await ajouter(DIR, seance, { buffer: png(900, 600), ocr: "Annexe tarifaire" });
  v("la deuxième page prend le rang 2", r.data?.page?.position === 2);
  r = await ajouter(DIR, seance, { buffer: png(600, 900) });
  v("la troisième prend le rang 3", r.data?.page?.position === 3);

  /* LES PAGES SURVIVENT À UN RECHARGEMENT : c'est toute la raison de les
     ranger en base plutôt que de les garder dans l'onglet. */
  r = await appel("GET", `/studio/scans/${seance}`, { user: DIR });
  v("les trois pages sont retrouvées après rechargement", r.data?.pages?.length === 3);
  v("dans l'ordre 1,2,3", rangs(r.data.pages) === "1,2,3", rangs(r.data.pages));
  v("et le texte reconnu est signalé sans être renvoyé",
    r.data.pages[0]?.texte_reconnu === true && r.data.pages[0]?.ocr_text === undefined);

  /* ════════════════════ L'ORDRE SE TIENT ═════════════════════════ */
  titre("Une page oubliée s'insère au milieu");
  r = await ajouter(DIR, seance, { buffer: png(600, 900), rang: 2, ocr: "Page oubliee" });
  v("elle prend bien le rang 2", r.data?.page?.position === 2, `${r.data?.page?.position}`);
  r = await appel("GET", `/studio/scans/${seance}`, { user: DIR });
  v("les suivantes ont été décalées", rangs(r.data.pages) === "1,2,3,4", rangs(r.data.pages));
  v("sans aucun rang en double",
    new Set(r.data.pages.map((p) => p.position)).size === 4);
  const inseree = r.data.pages.find((p) => p.position === 2)?.id;

  titre("Les rangs se resserrent quand on retire une page");
  r = await appel("DELETE", `/studio/scans/${seance}/pages/${inseree}`, { user: DIR });
  v("le retrait passe", r.status === 200, JSON.stringify(r.data));
  r = await appel("GET", `/studio/scans/${seance}`, { user: DIR });
  v("il ne reste pas de trou", rangs(r.data.pages) === "1,2,3", rangs(r.data.pages));

  titre("Une page se déplace");
  const pages3 = r.data.pages;
  const derniere = pages3.find((p) => p.position === 3).id;
  r = await appel("POST", `/studio/scans/${seance}/pages/${derniere}/rang`, {
    user: DIR, corps: { vers: 1 } });
  v("le déplacement passe", r.status === 200, JSON.stringify(r.data));
  r = await appel("GET", `/studio/scans/${seance}`, { user: DIR });
  v("les rangs restent 1,2,3", rangs(r.data.pages) === "1,2,3", rangs(r.data.pages));
  v("la page déplacée est bien en tête",
    r.data.pages.find((p) => p.position === 1)?.id === derniere);
  v("aucun rang négatif ne subsiste", r.data.pages.every((p) => p.position >= 1));

  /* On la remet en queue pour la suite. */
  await appel("POST", `/studio/scans/${seance}/pages/${derniere}/rang`, {
    user: DIR, corps: { vers: 3 } });

  /* ═════════════════ VOIR UNE PAGE AVANT D'ASSEMBLER ═════════════ */
  titre("On revoit une page avant de l'assembler");
  r = await appel("GET", `/studio/scans/${seance}`, { user: DIR });
  const premiere = r.data.pages.find((p) => p.position === 1).id;
  r = await appel("GET", `/studio/scans/${seance}/pages/${premiere}/image`,
    { user: DIR, brut: true });
  v("l'image est servie", r.status === 200, `${r.status}`);
  v("et c'est bien un PNG", (r.type || "").includes("png"), r.type || "aucun");
  v("les octets de tête sont ceux d'un PNG",
    r.buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a");
  r = await appel("GET", `/studio/scans/${seance}/pages/${premiere}/image`,
    { user: COMPTA, brut: true });
  v("un collègue n'obtient pas l'image", r.status === 404, `${r.status}`);

  /* ═══════════════════ UNE PAGE ALTÉRÉE EST REFUSÉE ══════════════ */
  titre("Une page altérée sur le disque n'est ni servie ni assemblée");
  const cle = (await q(
    `SELECT storage_key FROM studio_scan_pages WHERE id = $1`, [premiere]))[0].storage_key;
  const original = await S.octets(cle);
  await S.ecrire(cle, png(600, 900, 50));          /* même format, autre contenu */
  r = await appel("GET", `/studio/scans/${seance}/pages/${premiere}/image`,
    { user: DIR, brut: true });
  v("l'image altérée n'est pas remise", r.status === 409, `${r.status}`);
  r = await appel("POST", `/studio/scans/${seance}/assembler`, {
    user: DIR, corps: { nom: "Contrat transport 2026" } });
  v("l'assemblage refuse de continuer",
    r.status === 409 && r.data?.code === "PAGE_ALTEREE", JSON.stringify(r.data)?.slice(0, 160));
  v("et nomme la page en cause", /page 1/i.test(r.data?.error || ""), r.data?.error);
  await S.ecrire(cle, original);                    /* on répare */
  r = await appel("GET", `/studio/scans/${seance}/pages/${premiere}/image`,
    { user: DIR, brut: true });
  v("une fois réparée, elle est servie à nouveau", r.status === 200, `${r.status}`);

  /* ═════════════════════════ ASSEMBLER ═══════════════════════════ */
  titre("L'assemblage produit un vrai PDF, rangé dans la bibliothèque");
  r = await appel("POST", `/studio/scans/${seance}/assembler`, {
    user: DIR, corps: { nom: "Contrat transport 2026", description: "Scanné au bureau", tags: "contrat,transport" } });
  v("l'assemblage passe", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  v("il annonce trois pages", r.data?.pages === 3, `${r.data?.pages}`);
  const docId = r.data?.document?.id;
  v("un document est créé", !!docId);
  v("de nature SCAN", r.data?.document?.kind === "SCAN", r.data?.document?.kind);
  v("au format PDF", r.data?.document?.mime === "application/pdf");
  v("avec son nombre de pages", r.data?.document?.page_count === 3);
  v("et un nom qui finit par .pdf", /\.pdf$/.test(r.data?.document?.name || ""), r.data?.document?.name);
  v("le message dit que le contenu est cherchable", /trouvable par son contenu/.test(r.data?.message || ""),
    r.data?.message);

  /* LE DOCUMENT EST UN DOCUMENT ORDINAIRE : il se lit par la bibliothèque,
     avec sa version 1 marquée « original ». */
  r = await appel("GET", `/studio/documents/${docId}`, { user: DIR });
  v("il se lit depuis la bibliothèque", r.status === 200, `${r.status}`);
  v("il porte une seule version", r.data?.versions?.length === 1);
  v("qui est marquée original", r.data?.versions?.[0]?.is_original === true);
  v("le lien vers la séance est gardé", Number(r.data?.document?.scan_session_id) === Number(seance),
    `${r.data?.document?.scan_session_id}`);
  v("la note d'origine dit d'où il vient",
    /séance de numérisation/.test(r.data?.document?.source_note || ""),
    r.data?.document?.source_note);

  /* LE PDF EST UN PDF, ET CHAQUE PAGE SUIT SON ORIENTATION. */
  r = await appel("GET", `/studio/documents/${docId}/fichier`, { user: DIR, brut: true });
  v("le fichier se télécharge", r.status === 200, `${r.status}`);
  v("c'est un PDF", r.buffer.subarray(0, 5).toString("latin1") === "%PDF-",
    r.buffer.subarray(0, 8).toString("latin1"));
  const boites = [...r.buffer.toString("latin1").matchAll(/\/MediaBox\s*\[([^\]]*)\]/g)]
    .map((m) => m[1].trim());
  v("il porte trois pages", boites.length === 3, `${boites.length} : ${boites.join(" | ")}`);
  /* La page 600×900 est debout, la page 900×600 est couchée. Les coucher
     toutes les deux rendrait l'annexe tarifaire illisible à l'impression. */
  const debout = boites.filter((b) => {
    const [, , w, h] = b.split(/\s+/).map(Number); return h > w;
  }).length;
  v("deux pages debout, une couchée", debout === 2, `${debout} debout sur ${boites.length}`);

  /* LE TEXTE RECONNU REND LE PDF TROUVABLE PAR SON CONTENU. */
  r = await appel("GET", "/studio/documents?q=transporteur", { user: DIR });
  v("on le retrouve par un mot qui n'est que dans le texte reconnu",
    (r.data?.documents || []).some((d) => d.id === docId),
    (r.data?.documents || []).map((d) => d.name).join(", "));

  /* ═════════════════ UNE SÉANCE ASSEMBLÉE EST CLOSE ══════════════ */
  titre("Une séance assemblée ne se rouvre pas");
  r = await ajouter(DIR, seance, { buffer: png(600, 900) });
  v("on n'y ajoute plus de page",
    r.status === 409 && r.data?.code === "SEANCE_CLOSE", `${r.status} ${r.data?.code}`);
  v("et le message dit où trouver le document",
    /bibliothèque/.test(r.data?.error || ""), r.data?.error);
  r = await appel("POST", `/studio/scans/${seance}/assembler`, { user: DIR, corps: {} });
  v("on ne l'assemble pas deux fois", r.status === 409, `${r.status}`);
  r = await appel("GET", "/studio/scans", { user: DIR });
  v("elle quitte la liste de reprise",
    !(r.data?.seances || []).some((s) => s.id === seance));

  /* LES PAGES D'ORIGINE RESTENT, pour pouvoir réassembler autrement. */
  r = await appel("GET", `/studio/scans/${seance}`, { user: DIR });
  v("les pages d'origine sont encore là", r.data?.pages?.length === 3);
  v("la séance se consulte encore", r.data?.seance?.status === "ASSEMBLEE");

  titre("On retire les pages d'origine quand on l'a décidé");
  const clesPages = (await q(
    `SELECT storage_key FROM studio_scan_pages WHERE session_id = $1`, [seance]))
    .map((x) => x.storage_key);
  v("leurs fichiers existent avant", (await Promise.all(clesPages.map((c) => S.existe(c))))
    .every(Boolean));
  r = await appel("DELETE", `/studio/scans/${seance}/pages`, { user: DIR });
  v("le retrait passe", r.status === 200 && r.data?.pages_effacees === 3, JSON.stringify(r.data));
  v("le message dit ce qu'on perd",
    /ne pourra plus réassembler/.test(r.data?.message || ""), r.data?.message);
  v("les fichiers ont réellement disparu",
    (await Promise.all(clesPages.map((c) => S.existe(c)))).every((x) => !x));
  r = await appel("GET", `/studio/documents/${docId}/fichier`, { user: DIR, brut: true });
  v("mais le PDF assemblé reste intact", r.status === 200 &&
    r.buffer.subarray(0, 5).toString("latin1") === "%PDF-", `${r.status}`);

  /* ═════════════════════════ REFUS ÉVIDENTS ══════════════════════ */
  titre("Ce qui doit être refusé");
  r = await appel("POST", "/studio/scans", { user: DIR, corps: { format: "A3" } });
  v("un format inconnu est refusé",
    r.status === 400 && r.data?.code === "FORMAT_INCONNU", `${r.status} ${r.data?.code}`);
  r = await appel("POST", "/studio/scans", { user: DIR, corps: { visibilite: "PUBLIC" } });
  v("une visibilité inventée est refusée",
    r.status === 400 && r.data?.code === "VISIBILITE_INCONNUE", `${r.status} ${r.data?.code}`);
  r = await appel("POST", "/studio/scans", { user: DIR, corps: { dossier_id: 999999 } });
  v("un dossier inexistant est refusé", r.status === 404, `${r.status}`);

  r = await appel("POST", "/studio/scans", { user: DIR, corps: { titre: "Essai refus" } });
  const vide = r.data.seance.id;
  r = await appel("POST", `/studio/scans/${vide}/assembler`, { user: DIR, corps: {} });
  v("on n'assemble pas une séance vide",
    r.status === 400 && r.data?.code === "AUCUNE_PAGE", `${r.status} ${r.data?.code}`);
  r = await appel("DELETE", `/studio/scans/${vide}/pages`, { user: DIR });
  v("on ne retire pas les pages d'une séance non assemblée",
    r.status === 409 && r.data?.code === "SEANCE_PAS_ASSEMBLEE", `${r.status} ${r.data?.code}`);

  /* UN FICHIER QUI N'EST PAS UNE IMAGE. Le scanner n'est pas un dépôt
     détourné : un PDF glissé là passerait l'assemblage sans être une page. */
  r = await ajouter(DIR, vide, {
    buffer: Buffer.from("%PDF-1.7\nfaux\n%%EOF"), mime: "application/pdf", nom: "glisse.pdf" });
  v("un PDF n'est pas une page de scan",
    r.status === 415, `${r.status} ${r.data?.code}`);
  r = await ajouter(DIR, vide, {
    buffer: Buffer.from("<html><script>alert(1)</script></html>"),
    mime: "image/png", nom: "piege.png" });
  v("du HTML renommé en image est refusé", r.status === 415, `${r.status} ${r.data?.code}`);

  /* ═══════════════════════════ ABANDONNER ════════════════════════ */
  titre("Abandonner efface réellement les pages");
  r = await ajouter(DIR, vide, { buffer: png(600, 900) });
  await ajouter(DIR, vide, { buffer: png(600, 900) });
  const clesVide = (await q(
    `SELECT storage_key FROM studio_scan_pages WHERE session_id = $1`, [vide]))
    .map((x) => x.storage_key);
  v("deux pages ont été rangées", clesVide.length === 2);
  r = await appel("POST", `/studio/scans/${vide}/abandonner`, {
    user: DIR, corps: { motif: "mauvais document sous la main" } });
  v("l'abandon passe", r.status === 200 && r.data?.pages_effacees === 2, JSON.stringify(r.data));
  v("les fichiers ont disparu du dépôt",
    (await Promise.all(clesVide.map((c) => S.existe(c)))).every((x) => !x));
  v("plus aucune ligne de page",
    (await q(`SELECT 1 FROM studio_scan_pages WHERE session_id = $1`, [vide])).length === 0);
  r = await appel("GET", "/studio/scans", { user: DIR });
  v("la séance abandonnée quitte la reprise",
    !(r.data?.seances || []).some((s) => s.id === vide));
  r = await ajouter(DIR, vide, { buffer: png(600, 900) });
  v("on n'y ajoute plus rien", r.status === 409, `${r.status}`);

  /* ════════════════════ LA FRONTIÈRE DES SOCIÉTÉS ════════════════ */
  titre("Les deux sociétés ne se croisent pas");
  r = await appel("POST", "/studio/scans", {
    user: FAT, societe: 2, corps: { titre: "Scan Fatemat" } });
  v("FAT & MAT ouvre sa propre séance", r.status === 201);
  const seanceFat = r.data.seance.id;
  r = await ajouter(FAT, seanceFat, { buffer: png(600, 900) });
  v("et y range une page", r.status === 201, `${r.status}`);
  r = await appel("GET", `/studio/scans/${seanceFat}`, { user: DIR });
  v("la direction de Triangle ne la voit pas", r.status === 404, `${r.status}`);
  /* MÊME AVEC LE BON IDENTIFIANT ET LE BON PROPRIÉTAIRE, mais la mauvaise
     société active : c'est le cas du compte présent dans les deux maisons. */
  r = await appel("GET", `/studio/scans/${seanceFat}`, { user: FAT, societe: 1 });
  /* 403 OU 404 : deux barrières différentes, toutes deux bonnes. Ici c'est
     403, car la demande est écartée AVANT la route — ce compte n'a pas le
     droit d'agir pour Triangle, quelle que soit la ressource visée. Exiger
     404 accusait le code d'un défaut alors que la garde avait répondu plus
     tôt et plus largement. Ni l'un ni l'autre n'apprend que la séance
     existe. */
  v("et elle est hors d'atteinte depuis l'autre société active",
    r.status === 404 || r.status === 403, `${r.status}`);
  v("la réponse ne dit rien de la séance",
    !JSON.stringify(r.data || {}).includes("Scan Fatemat"), JSON.stringify(r.data));

  /* ═════════════ AUCUNE URL N'ATTEINT LES PAGES ══════════════════ */
  titre("Aucune URL publique n'atteint une page");
  const clePage = (await q(
    `SELECT storage_key FROM studio_scan_pages WHERE session_id = $1 LIMIT 1`, [seanceFat]))[0]
    .storage_key;
  for (const chemin of [`/uploads/${clePage}`, `/${clePage}`, `/storage/${clePage}`]) {
    const rep = await fetch(BASE + chemin);
    v(`« ${chemin.slice(0, 44)}… » ne donne rien`, rep.status === 404, `${rep.status}`);
  }

  console.log(`\n  ${ok} réussis, ${ko} échoués\n`);
  await pool.end();
  process.exit(ko ? 1 : 0);
})().catch(async (e) => {
  console.error("\n  ✘ interrompu :", e.message, "\n", e.stack);
  await pool.end().catch(() => {});
  process.exit(2);
});
