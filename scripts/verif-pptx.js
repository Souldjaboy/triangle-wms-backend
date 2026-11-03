"use strict";
/**
 * LE .PPTX PRODUIT EST-IL UN VRAI .PPTX, ET DIT-IL CE QU'ON A VOULU ?
 *
 * TROIS CHOSES SE VÉRIFIENT ICI, ET AUCUNE NE SE VÉRIFIE EN RELISANT SON
 * PROPRE CODE.
 *
 * 1. QU'UN VRAI LOGICIEL OUVRE L'ARCHIVE. « jszip a bien écrit vingt-cinq
 *    fichiers » ne prouve rien : PowerPoint refuse une archive dont il manque
 *    une déclaration de type ou une relation. LibreOffice Impress est ici le
 *    juge — il lit le même format — et on lui demande de convertir la
 *    présentation en PDF. S'il y arrive, l'archive est valide. Si la
 *    conversion donne le bon nombre de pages aux bonnes dimensions, la
 *    présentation est aussi celle qu'on a décrite.
 *
 * 2. QUE CE SOIT AU BON ENDROIT ET DE LA BONNE COULEUR. Le PDF de LibreOffice
 *    est RENDU et ses pixels relus : un carré vert à 20 mm du bord gauche
 *    doit être vert, à 20 mm du bord gauche. Le texte doit avoir laissé de
 *    l'encre là où on l'a posé, et nulle part ailleurs.
 *
 * 3. QUE LE LECTEUR TIENNE DEVANT L'XML D'UN AUTRE. Relire sa propre écriture
 *    ne prouve presque rien : les deux moitiés peuvent se tromper de la même
 *    façon. On demande donc à LibreOffice de RÉÉCRIRE l'archive — il produit
 *    son propre XML, avec ses propres préfixes, ses propres masques et ses
 *    emplacements — et c'est CELLE-LÀ qu'on relit.
 *
 * On éprouve enfin que l'aller-retour est un POINT FIXE : lire puis réécrire
 * puis relire doit redonner exactement le même plan. Sans quoi chaque export
 * dégraderait un peu la présentation, ce qui ne se voit qu'au dixième tour.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const { PDFDocument } = require("pdf-lib");
const P = require("../services/pptx");
const { repereRouge } = require("./image-essai");
const { lancer } = require(
  path.join(__dirname, "..", "..", "triangle-wms-frontend", "scripts", "navigateur"));

const FRONT = path.join(__dirname, "..", "..", "triangle-wms-frontend");
const PPMM = 72 / 25.4;
const LARGEUR = 338.67, HAUTEUR = 190.5;
const ECHELLE = 2;

let ok = 0, ko = 0;
const v = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ✔ ${n}`); }
  else { ko++; console.log(`  ✘ ${n}${d ? `\n      → ${d}` : ""}`); }
};
const titre = (t) => console.log(`\n── ${t}`);

const DOSSIER = fs.mkdtempSync(path.join(os.tmpdir(), "verif-pptx-"));
const PROFIL = path.join(DOSSIER, "profil-lo");

/** LibreOffice, en mode sans interface. */
function convertir(entree, vers, sortie) {
  execFileSync("soffice", [
    "--headless", "--norestore", `-env:UserInstallation=file://${PROFIL}`,
    "--convert-to", vers, "--outdir", sortie, entree,
  ], { stdio: ["ignore", "pipe", "pipe"], timeout: 300000 });
  const attendu = path.join(sortie,
    `${path.basename(entree).replace(/\.[^.]+$/, "")}.${vers.split(":")[0]}`);
  return fs.existsSync(attendu) ? attendu : null;
}

/* ── UNE PRÉSENTATION DONT ON CONNAÎT CHAQUE COULEUR ET CHAQUE POSITION ── */
const VERT = "#00a000", ROUGE = "#c00000", BLEU = "#0000c0", NUIT = "#101820";
const DIAPOS = [
  {
    fond: "#ffffff",
    elements: [
      { id: "t1", type: "texte", x: 20, y: 18, l: 280, texte: "TRIANGLE LOGISTICS",
        taille: 12, couleur: "#111827", graisse: 700, alignement: "gauche",
        police: "sans", interligne: 1.2 },
      { id: "r1", type: "rect", x: 20, y: 60, l: 100, h: 50, couleur: VERT,
        rayon: 0, bordure: 0, couleurBordure: "#000000" },
      { id: "r2", type: "rect", x: 150, y: 60, l: 100, h: 50, couleur: ROUGE,
        rayon: 6, bordure: 0, couleurBordure: "#000000" },
      { id: "l1", type: "ligne", x: 20, y: 45, l: 120, epaisseur: 2, couleur: BLEU },
    ],
  },
  {
    fond: NUIT,
    elements: [
      { id: "t2", type: "texte", x: 24, y: 24, l: 280,
        texte: "Bilan du trimestre\nDeux lignes", taille: 9, couleur: "#ffffff",
        graisse: 400, alignement: "centre", police: "serif", interligne: 1.4 },
      { id: "e1", type: "ellipse", x: 230, y: 100, l: 70, h: 70, couleur: VERT,
        bordure: 0, couleurBordure: "#ffffff" },
    ],
  },
  {
    fond: "#ffffff",
    elements: [
      { id: "i1", type: "image", x: 40, y: 40, l: 80, h: 60, arrondi: 0,
        /* UNE IMAGE FABRIQUÉE, PAS RECOPIÉE. Le premier jet de cet essai
           portait ici un base64 écrit à la main pour « un PNG 2×2, rouge en
           haut à gauche ». Son en-tête était juste, mais son flux compressé
           échouait à sa somme de contrôle : LibreOffice l'a transporté dans
           l'archive sans jamais le dessiner, et l'essai, qui cherchait du
           rouge, trouvait du blanc. Il accusait l'export d'un défaut qui
           était celui de l'image d'essai. */
        src: `data:image/png;base64,${repereRouge(40).toString("base64")}` },
    ],
  },
];

/* ─── Un .pptx qui contient un tableau, écrit à la main ───
   Pour éprouver que la lecture SIGNALE ce qu'elle ne reprend pas, il faut un
   fichier qui en contienne. LibreOffice n'en fabriquera pas à la demande ;
   on écrit donc l'archive minimale nous-mêmes. */
async function pptxAvecTableau() {
  const JSZip = require("jszip");
  const zip = new JSZip();
  const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const Pns = "http://schemas.openxmlformats.org/presentationml/2006/main";
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  zip.file("[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
    "</Types>");
  zip.file("_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  zip.file("ppt/presentation.xml",
    `<?xml version="1.0"?><p:presentation xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${Pns}">` +
    '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>' +
    '<p:sldSz cx="12192000" cy="6858000"/></p:presentation>');
  zip.file("ppt/_rels/presentation.xml.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${R}/slide" Target="slides/slide1.xml"/></Relationships>`);
  zip.file("ppt/slides/slide1.xml",
    `<?xml version="1.0"?><p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${Pns}"><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    /* Un titre SANS position : c'est le cas le plus courant du monde réel. */
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Titre 1"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Titre héritant du masque</a:t></a:r></a:p></p:txBody></p:sp>' +
    /* Un tableau. */
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Tableau 1"/>' +
    '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
    '<p:xfrm><a:off x="1000000" y="2000000"/><a:ext cx="4000000" cy="2000000"/></p:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
    '<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="2000000"/></a:tblGrid>' +
    '<a:tr h="500000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Cellule</a:t></a:r></a:p></a:txBody></a:tc></a:tr>' +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>' +
    /* Un groupe. */
    '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="Groupe 1"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr/></p:grpSp>' +
    /* Une forme dont la couleur vient du thème. */
    '<p:sp><p:nvSpPr><p:cNvPr id="5" name="Carre theme"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="6000000" y="1000000"/><a:ext cx="1000000" cy="1000000"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>' +
    /* Une forme exotique. */
    '<p:sp><p:nvSpPr><p:cNvPr id="6" name="Etoile"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="8000000" y="1000000"/><a:ext cx="1000000" cy="1000000"/></a:xfrm>' +
    '<a:prstGeom prst="star5"><a:avLst/></a:prstGeom>' +
    '<a:solidFill><a:srgbClr val="FF8800"/></a:solidFill></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>' +
    "</p:spTree></p:cSld></p:sld>");
  return zip.generateAsync({ type: "nodebuffer" });
}

(async () => {
  /* ═══════════════ 1. L'ARCHIVE EST-ELLE VALIDE ? ═══════════════ */
  titre("Un vrai logiciel ouvre l'archive");
  const ecrit = await P.ecrire({
    titre: "Bilan Triangle", auteur: "Direction",
    largeurMm: LARGEUR, hauteurMm: HAUTEUR, diapositives: DIAPOS });
  v("l'écriture produit une archive", ecrit.buffer.length > 3000, `${ecrit.buffer.length} octets`);
  v("l'archive commence par la signature ZIP",
    ecrit.buffer[0] === 0x50 && ecrit.buffer[1] === 0x4b);
  v("les trois diapositives sont annoncées", ecrit.diapositives === 3, String(ecrit.diapositives));
  v("et rien n'a été laissé de côté", ecrit.nonRepris.length === 0, JSON.stringify(ecrit.nonRepris));

  const chemin = path.join(DOSSIER, "bilan.pptx");
  fs.writeFileSync(chemin, ecrit.buffer);
  const dossierPdf = path.join(DOSSIER, "pdf");
  fs.mkdirSync(dossierPdf, { recursive: true });

  let cheminPdf = null;
  try { cheminPdf = convertir(chemin, "pdf", dossierPdf); }
  catch (e) { v("LibreOffice convertit la présentation", false, String(e.message).slice(0, 200)); }
  v("LibreOffice convertit la présentation en PDF", !!cheminPdf, String(cheminPdf));

  const pdf = await PDFDocument.load(fs.readFileSync(cheminPdf));
  v("le PDF a autant de pages que de diapositives", pdf.getPageCount() === 3,
    String(pdf.getPageCount()));
  const tailles = pdf.getPages().map((p) => {
    const s = p.getSize();
    return `${(s.width / PPMM).toFixed(1)}×${(s.height / PPMM).toFixed(1)}`;
  });
  v("et chaque page fait exactement la taille d'une diapositive",
    tailles.every((t) => t === `${LARGEUR.toFixed(1)}×${HAUTEUR.toFixed(1)}`), tailles.join(" "));

  /* ═══════════════ 2. AU BON ENDROIT, DE LA BONNE COULEUR ═══════════════ */
  titre("Ce que LibreOffice dessine est à l'endroit demandé");
  const nav = await lancer();
  const onglet = await nav.newPage();
  onglet.on("pageerror", (e) => console.log("  pageerror:", e.message.slice(0, 160)));
  await onglet.route("**/*", (route) => {
    const u = route.request().url();
    const servir = (rel, type) => route.fulfill({
      body: fs.readFileSync(path.join(FRONT, "node_modules/pdfjs-dist", rel)),
      contentType: type });
    if (u.endsWith("/pdf.mjs")) return servir("build/pdf.mjs", "text/javascript");
    if (u.endsWith("/pdf.worker.mjs")) return servir("build/pdf.worker.mjs", "text/javascript");
    return route.fulfill({
      body: "<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>",
      contentType: "text/html" });
  });
  await onglet.goto("http://essai.local/");

  /** Les couleurs à des points donnés, en MILLIMÈTRES sur la diapositive. */
  const sonder = async (octets, page, points) => onglet.evaluate(
    async ([tableau, numero, pts, ppmm, echelle]) => {
      const { getDocument, GlobalWorkerOptions } = await import("/pdf.mjs");
      GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";
      const doc = await getDocument({ data: new Uint8Array(tableau) }).promise;
      const pg = await doc.getPage(numero);
      const vue = pg.getViewport({ scale: echelle });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vue.width); c.height = Math.ceil(vue.height);
      const g = c.getContext("2d");
      /* PAS DE FOND BLANC ICI : on veut voir le fond que la diapositive
         déclare. En peindre un masquerait justement ce qu'on vérifie. */
      await pg.render({ canvasContext: g, viewport: vue, canvas: c }).promise;
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const lire = (xmm, ymm) => {
        const x = Math.round(Math.min(c.width - 1, Math.max(0, xmm * ppmm * echelle)));
        const y = Math.round(Math.min(c.height - 1, Math.max(0, ymm * ppmm * echelle)));
        const i = (y * c.width + x) * 4;
        return [d[i], d[i + 1], d[i + 2]];
      };
      const encreDans = (x1, y1, x2, y2) => {
        let n = 0;
        for (let ymm = y1; ymm <= y2; ymm += 0.4) {
          for (let xmm = x1; xmm <= x2; xmm += 0.4) {
            const [r, v2, b] = lire(xmm, ymm);
            if (r + v2 + b < 650) n += 1;
          }
        }
        return n;
      };
      return {
        couleurs: pts.map(([x, y]) => lire(x, y)),
        encreTitre: encreDans(20, 16, 200, 32),
        encreVide: encreDans(20, 150, 300, 180),
      };
    }, [Array.from(octets), page, points, PPMM, ECHELLE]);

  const octetsPdf = fs.readFileSync(cheminPdf);
  /* Page 1 : le fond, le carré vert, le carré rouge, le filet bleu. */
  let s = await sonder(octetsPdf, 1, [[300, 170], [70, 85], [200, 85], [80, 45]]);
  const [fond1, vert, rouge, filet] = s.couleurs;
  v("le fond blanc est blanc", fond1[0] > 240 && fond1[1] > 240 && fond1[2] > 240, `rvb ${fond1}`);
  v("le carré vert est vert, à 20 mm du bord",
    vert[1] > 120 && vert[0] < 110 && vert[2] < 110, `rvb ${vert}`);
  v("le carré rouge est rouge, à 150 mm du bord",
    rouge[0] > 140 && rouge[1] < 110 && rouge[2] < 110, `rvb ${rouge}`);
  v("le filet bleu est bleu, à 45 mm du haut",
    filet[2] > 120 && filet[0] < 110 && filet[1] < 110, `rvb ${filet}`);
  v("le titre a laissé de l'encre là où il est posé", s.encreTitre > 60, `${s.encreTitre} points`);
  v("et le bas de la diapositive est resté vide", s.encreVide === 0, `${s.encreVide} points`);

  /* Page 2 : le fond sombre — la vérification que `p:bg` a bien été honoré. */
  s = await sonder(octetsPdf, 2, [[300, 30], [265, 135], [20, 180]]);
  const [fond2, cercle, coin2] = s.couleurs;
  v("LE FOND SOMBRE EST SOMBRE : « p:bg » a été honoré",
    fond2[0] < 60 && fond2[1] < 60 && fond2[2] < 70, `rvb ${fond2}`);
  v("le fond couvre jusqu'au coin bas-gauche",
    coin2[0] < 60 && coin2[1] < 60 && coin2[2] < 70, `rvb ${coin2}`);
  v("l'ellipse verte est au centre de son cadre",
    cercle[1] > 120 && cercle[0] < 110 && cercle[2] < 110, `rvb ${cercle}`);

  /* Page 3 : l'image. Son quart haut-gauche est rouge. */
  s = await sonder(octetsPdf, 3, [[50, 50], [110, 90], [300, 30]]);
  const [hautGauche, basDroite, horsImage] = s.couleurs;
  v("l'image est posée à 40 mm, et son coin rouge est en haut à gauche",
    hautGauche[0] > 150 && hautGauche[1] < 120 && hautGauche[2] < 120, `rvb ${hautGauche}`);
  v("son coin bas-droite est blanc : elle n'est pas retournée",
    basDroite[0] > 200 && basDroite[1] > 200 && basDroite[2] > 200, `rvb ${basDroite}`);
  v("et rien n'a débordé hors de son cadre",
    horsImage[0] > 240 && horsImage[1] > 240 && horsImage[2] > 240, `rvb ${horsImage}`);

  await nav.close();

  /* ═══════ 3. LE LECTEUR DEVANT L'XML D'UN AUTRE PRODUCTEUR ═══════ */
  titre("Le lecteur tient devant l'archive réécrite par LibreOffice");
  const dossierRe = path.join(DOSSIER, "reecrit");
  fs.mkdirSync(dossierRe, { recursive: true });
  let cheminRe = null;
  try { cheminRe = convertir(chemin, "pptx", dossierRe); }
  catch (e) { v("LibreOffice réécrit l'archive", false, String(e.message).slice(0, 200)); }
  v("LibreOffice réécrit l'archive à sa façon", !!cheminRe, String(cheminRe));

  if (cheminRe) {
    const relu = await P.lire(fs.readFileSync(cheminRe));
    v("les trois diapositives sont retrouvées", relu.diapositives.length === 3,
      String(relu.diapositives.length));
    v("la taille de la diapositive est retrouvée au dixième de millimètre",
      Math.abs(relu.largeurMm - LARGEUR) < 0.2 && Math.abs(relu.hauteurMm - HAUTEUR) < 0.2,
      `${relu.largeurMm}×${relu.hauteurMm}`);
    const textes = relu.diapositives.flatMap((d) =>
      d.elements.filter((e) => e.type === "texte").map((e) => e.texte));
    v("le titre de la première diapositive est retrouvé",
      textes.some((t) => /TRIANGLE LOGISTICS/i.test(t)), JSON.stringify(textes));
    v("le texte sur deux lignes a gardé ses deux lignes",
      textes.some((t) => /Bilan du trimestre\nDeux lignes/.test(t)),
      JSON.stringify(textes));
    const d1 = relu.diapositives[0];
    const verts = d1.elements.filter((e) => /rect|ellipse/.test(e.type)
      && /^#0*0?a0*0?00$/i.test(String(e.couleur).replace("#", "#")));
    v("le carré vert est retrouvé avec sa couleur",
      d1.elements.some((e) => e.type === "rect" && String(e.couleur).toLowerCase() === VERT),
      JSON.stringify(d1.elements.map((e) => `${e.type}:${e.couleur}`)));
    const pose = d1.elements.find((e) => e.type === "rect"
      && String(e.couleur).toLowerCase() === VERT);
    v("et à sa position, à un millimètre près",
      !!pose && Math.abs(pose.x - 20) < 1 && Math.abs(pose.y - 60) < 1,
      JSON.stringify(pose && { x: pose.x, y: pose.y }));
    const image = relu.diapositives[2].elements.find((e) => e.type === "image");
    v("l'image traverse l'aller-retour par un autre logiciel",
      !!image && /^data:image\/(png|jpeg);base64,/.test(image.src),
      image ? image.src.slice(0, 40) : "absente");
    v("le fond sombre de la deuxième est retrouvé",
      String(relu.diapositives[1].fond).toLowerCase() === NUIT
      || relu.diapositives[1].elements.some((e) => String(e.couleur).toLowerCase() === NUIT),
      `${relu.diapositives[1].fond}`);
  }

  /* ═══════════════ 4. L'ALLER-RETOUR EST UN POINT FIXE ═══════════════ */
  titre("Lire, réécrire, relire redonne le même plan");
  const tour1 = await P.lire(ecrit.buffer);
  const re = await P.ecrire({
    titre: "Bilan Triangle", largeurMm: tour1.largeurMm, hauteurMm: tour1.hauteurMm,
    diapositives: tour1.diapositives });
  const tour2 = await P.lire(re.buffer);
  const sansId = (d) => d.map((x) => ({
    fond: x.fond,
    elements: x.elements.map(({ id, ...reste }) => reste) }));
  v("le nombre de diapositives ne bouge pas",
    tour1.diapositives.length === tour2.diapositives.length,
    `${tour1.diapositives.length} puis ${tour2.diapositives.length}`);
  v("le nombre d'éléments ne bouge pas : rien ne s'accumule",
    JSON.stringify(tour1.diapositives.map((d) => d.elements.length))
      === JSON.stringify(tour2.diapositives.map((d) => d.elements.length)),
    JSON.stringify([tour1.diapositives.map((d) => d.elements.length),
      tour2.diapositives.map((d) => d.elements.length)]));
  v("LE PLAN EST IDENTIQUE, élément par élément",
    JSON.stringify(sansId(tour1.diapositives)) === JSON.stringify(sansId(tour2.diapositives)),
    "les deux plans diffèrent");

  /* ═══════════════ 5. CE QUI N'EST PAS REPRIS EST DIT ═══════════════ */
  titre("Ce qui n'est pas repris est nommé, forme par forme");
  const avecTableau = await pptxAvecTableau();
  const lu = await P.lire(avecTableau);
  v("la diapositive est lue malgré ce qu'elle contient", lu.diapositives.length === 1);
  const dit = lu.nonRepris.join(" | ");
  v("le tableau est signalé", /tableau n'est pas repris/.test(dit), dit);
  v("le groupe de formes est signalé", /groupe de formes/.test(dit), dit);
  v("la couleur de thème est signalée", /accent1.*thème|thème.*accent1/.test(dit), dit);
  v("la forme exotique est signalée comme rendue en rectangle",
    /star5.*rectangle/.test(dit), dit);
  v("le titre sans position est signalé comme approché",
    /position vient du masque/.test(dit), dit);
  v("MAIS SON TEXTE N'EST PAS PERDU",
    lu.diapositives[0].elements.some((e) => e.type === "texte"
      && /Titre héritant du masque/.test(e.texte)),
    JSON.stringify(lu.diapositives[0].elements.map((e) => e.type)));
  v("la forme exotique garde sa couleur écrite en clair",
    lu.diapositives[0].elements.some((e) => String(e.couleur).toLowerCase() === "#ff8800"),
    JSON.stringify(lu.diapositives[0].elements.map((e) => e.couleur)));
  v("et la forme à couleur de thème n'invente pas de couleur",
    !lu.diapositives[0].elements.some((e) => /accent/.test(String(e.couleur))),
    JSON.stringify(lu.diapositives[0].elements.map((e) => e.couleur)));

  /* ═══════════════ 6. CE QUI DOIT ÊTRE REFUSÉ ═══════════════ */
  titre("Ce qui n'est pas une présentation est refusé, et dit pourquoi");
  const refus = async (nom, octets, code, mot) => {
    try { await P.lire(octets); v(nom, false, "accepté alors qu'il fallait refuser"); }
    catch (e) {
      v(nom, e.code === code, `${e.code} au lieu de ${code}`);
      if (mot) v(`  et le refus l'explique`, new RegExp(mot, "i").test(e.message), e.message);
    }
  };
  await refus("un PDF déposé par erreur", fs.readFileSync(cheminPdf), "PAS_UN_PPTX", "archive");
  await refus("du texte", Buffer.from("ceci n'est pas une présentation"), "PAS_UN_PPTX");
  const JSZip = require("jszip");
  const zipVide = new JSZip();
  zipVide.file("lisez-moi.txt", "rien ici");
  await refus("une archive sans présentation dedans",
    await zipVide.generateAsync({ type: "nodebuffer" }), "PAS_UNE_PRESENTATION", "avant 2007");

  try {
    await P.ecrire({ titre: "Vide", largeurMm: 300, hauteurMm: 200, diapositives: [] });
    v("une présentation sans diapositive est refusée", false, "acceptée");
  } catch (e) { v("une présentation sans diapositive est refusée", e.code === "AUCUNE_DIAPOSITIVE"); }

  fs.rmSync(DOSSIER, { recursive: true, force: true });
  console.log(`\n  ${ok} réussis, ${ko} échoués`);
  process.exit(ko ? 1 : 0);
})().catch((e) => {
  console.error("\n  ✘ interrompu :", e.message, "\n", e.stack);
  try { fs.rmSync(DOSSIER, { recursive: true, force: true }); } catch { /* rien */ }
  process.exit(2);
});
