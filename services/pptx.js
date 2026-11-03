"use strict";
/**
 * LIRE ET ÉCRIRE UN FICHIER .PPTX.
 *
 * Un .pptx est une archive ZIP de documents XML — la norme Office Open XML.
 * Rien d'extérieur n'est donc nécessaire : ni service en ligne, ni logiciel
 * installé. Ce module construit l'archive à la main et la relit de même.
 *
 * ════════════════════ CE QUI EST REPRIS, ET CE QUI NE L'EST PAS ═══════════
 *
 * Il faut l'écrire ici plutôt que de le laisser découvrir. Un .pptx peut
 * contenir des tableaux, des graphiques, des SmartArt, des vidéos, des
 * animations, des transitions, des thèmes dont les formes héritent leurs
 * couleurs et leurs polices, et des masques dont elles héritent leur
 * position. Reprendre tout cela, c'est réécrire PowerPoint.
 *
 * À L'ÉCRITURE, ce module produit des formes VRAIES et modifiables : zones
 * de texte, rectangles, ellipses, traits, images. Ouvert dans PowerPoint, le
 * texte se corrige, les formes se déplacent. Ce n'est PAS une image de
 * diapositive collée sur une page.
 *
 * À LA LECTURE, il reprend ces mêmes familles lorsque leur géométrie est
 * écrite dans la diapositive. Tout le reste est DÉCLARÉ NON REPRIS, forme
 * par forme, dans un compte rendu que l'appelant doit montrer. Le silence
 * serait le pire choix : on découvrirait le tableau manquant devant
 * l'auditoire.
 *
 * DEUX CAS PARTICULIERS, parce qu'ils arrivent tout le temps.
 *
 * 1. UN TITRE SANS POSITION. Dans la plupart des présentations, le titre et
 *    le corps sont des « emplacements » qui tiennent leur position du masque
 *    de la diapositive. La diapositive elle-même ne dit alors rien de l'où.
 *    Plutôt que de perdre le texte, on le place à un endroit raisonnable et
 *    ON LE SIGNALE : le texte est là, sa position est approchée.
 *
 * 2. UNE COULEUR DE THÈME. « accent1 » ne veut rien dire sans le thème. On
 *    ne devine pas : la forme garde une couleur neutre, et c'est signalé.
 *
 * ═════════════════════════════ LES UNITÉS ════════════════════════════════
 *
 * Office mesure en EMU : 914 400 par pouce, donc 36 000 par millimètre. La
 * taille des caractères se compte en centièmes de point. Le plan du Studio,
 * lui, est tout en millimètres — y compris la taille du texte, qui est la
 * hauteur du cadratin. Les conversions sont rassemblées ici, nulle part
 * ailleurs.
 */
const JSZip = require("jszip");
const { DOMParser } = require("@xmldom/xmldom");

const EMU_PAR_MM = 36000;
const POINTS_PAR_MM = 72 / 25.4;

const mmVersEmu = (mm) => Math.round(Number(mm) * EMU_PAR_MM);
const emuVersMm = (emu) => Number(emu) / EMU_PAR_MM;
/** La taille d'un texte : millimètres de cadratin → centièmes de point. */
const mmVersSz = (mm) => Math.max(100, Math.round(Number(mm) * POINTS_PAR_MM * 100));
const szVersMm = (sz) => (Number(sz) / 100) / POINTS_PAR_MM;

function erreur(message, code, httpStatus = 400) {
  const e = new Error(message);
  e.code = code; e.httpStatus = httpStatus;
  return e;
}

const ech = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/* Une couleur du plan (#rrggbb) vers la forme attendue par Office (RRGGBB). */
function hex6(couleur, defaut = "000000") {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(couleur || ""));
  return m ? m[1].toUpperCase() : defaut;
}
const transparent = (c) => !c || String(c).toLowerCase() === "transparent";

/* ════════════════════════════════════════════════════════════════════════
   ÉCRIRE
   ════════════════════════════════════════════════════════════════════════ */

const POLICE_OFFICE = {
  sans: "Arial",
  serif: "Georgia",
  mono: "Courier New",
};

const ALIGNEMENT = { gauche: "l", centre: "ctr", droite: "r" };

/** Les propriétés communes d'une forme : nom, position, géométrie. */
function formeXml({ id, nom, x, y, l, h, geom, remplissage, trait, corps }) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${ech(nom)}"/>` +
    `<p:cNvSpPr${geom === "txt" ? ' txBox="1"' : ""}/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${mmVersEmu(x)}" y="${mmVersEmu(y)}"/>` +
    `<a:ext cx="${Math.max(1, mmVersEmu(l))}" cy="${Math.max(1, mmVersEmu(h))}"/></a:xfrm>` +
    (geom === "txt" ? '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' : geom) +
    (remplissage || "<a:noFill/>") + (trait || "") +
    `</p:spPr>${corps || "<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>"}</p:sp>`;
}

function corpsTexte(el) {
  const texte = el.majuscules ? String(el.texte ?? "").toUpperCase() : String(el.texte ?? "");
  const sz = mmVersSz(el.taille);
  const gras = Number(el.graisse) >= 600 ? ' b="1"' : "";
  const police = POLICE_OFFICE[el.police] || POLICE_OFFICE.sans;
  const interligne = Math.round((Number(el.interligne) || 1.3) * 100000);
  const algn = ALIGNEMENT[el.alignement] || "l";
  const rPr = `<a:rPr lang="fr-FR" sz="${sz}"${gras} dirty="0">` +
    `<a:solidFill><a:srgbClr val="${hex6(el.couleur, "111827")}"/></a:solidFill>` +
    `<a:latin typeface="${ech(police)}"/><a:cs typeface="${ech(police)}"/></a:rPr>`;
  /* UN RETOUR À LA LIGNE VOULU EST UN PARAGRAPHE. Les transformer en un seul
     paragraphe collerait toutes les lignes, et PowerPoint ne saurait plus
     les séparer. */
  const paragraphes = texte.split(/\r\n?|\n/).map((ligne) =>
    `<a:p><a:pPr algn="${algn}"><a:lnSpc><a:spcPct val="${interligne}"/></a:lnSpc></a:pPr>` +
    (ligne === "" ? `<a:endParaRPr lang="fr-FR" sz="${sz}"/>`
      : `<a:r>${rPr}<a:t>${ech(ligne)}</a:t></a:r>`) +
    `</a:p>`).join("");
  /* Les marges intérieures à zéro : le plan place le texte au millimètre, et
     les marges d'Office le décaleraient de deux millimètres et demi. */
  return `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t">` +
    `<a:spAutoFit/></a:bodyPr><a:lstStyle/>${paragraphes}</p:txBody>`;
}

/** La hauteur qu'occupera un texte : autant de lignes que de paragraphes. */
function hauteurTexte(el) {
  const lignes = String(el.texte ?? "").split(/\r\n?|\n/).length;
  return Math.max(Number(el.taille) || 4, lignes * (Number(el.taille) || 4) * (Number(el.interligne) || 1.3));
}

function remplissageXml(couleur) {
  return transparent(couleur) ? "<a:noFill/>"
    : `<a:solidFill><a:srgbClr val="${hex6(couleur)}"/></a:solidFill>`;
}

function traitXml(epaisseurMm, couleur) {
  if (!(Number(epaisseurMm) > 0)) return "";
  return `<a:ln w="${Math.max(1, mmVersEmu(epaisseurMm))}">` +
    `<a:solidFill><a:srgbClr val="${hex6(couleur)}"/></a:solidFill></a:ln>`;
}

/**
 * Une diapositive en XML, plus les images qu'elle réclame.
 *
 * @returns { xml, medias: [{ nom, octets, type, rid }] }
 */
function diapositiveXml(plan, numero, { largeurMm, hauteurMm }) {
  const medias = [];
  let id = 2;
  const formes = [];
  const nonRepris = [];

  for (const el of (plan?.elements || [])) {
    id += 1;
    switch (el?.type) {
      case "rect": {
        const min = Math.max(0.1, Math.min(Number(el.l) || 1, Number(el.h) || 1));
        const rayon = Math.max(0, Math.min(Number(el.rayon) || 0, min / 2));
        const geom = rayon > 0
          ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${
              Math.round((rayon / (min / 2)) * 50000)}"/></a:avLst></a:prstGeom>`
          : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
        formes.push(formeXml({
          id, nom: `Rectangle ${id}`, x: el.x, y: el.y, l: el.l, h: el.h, geom,
          remplissage: remplissageXml(el.couleur),
          trait: traitXml(el.bordure, el.couleurBordure) }));
        break;
      }
      case "ellipse":
        formes.push(formeXml({
          id, nom: `Ellipse ${id}`, x: el.x, y: el.y, l: el.l, h: el.h,
          geom: '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>',
          remplissage: remplissageXml(el.couleur),
          trait: traitXml(el.bordure, el.couleurBordure) }));
        break;
      case "ligne":
        /* UN TRAIT EST ÉCRIT COMME UN RECTANGLE PLEIN de son épaisseur, et
           non comme un connecteur. Un connecteur a deux points d'accroche et
           se comporte autrement quand on le déplace ; un filet sous un titre
           n'est pas un connecteur, c'est un filet. */
        formes.push(formeXml({
          id, nom: `Filet ${id}`, x: el.x, y: el.y - (Number(el.epaisseur) || 0.3) / 2,
          l: el.l, h: Number(el.epaisseur) || 0.3,
          geom: '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
          remplissage: remplissageXml(el.couleur || "#000000") }));
        break;
      case "texte":
        formes.push(formeXml({
          id, nom: `Texte ${id}`, x: el.x, y: el.y, l: el.l, h: hauteurTexte(el),
          geom: "txt", remplissage: "<a:noFill/>", corps: corpsTexte(el) }));
        break;
      case "image": {
        const m = /^data:(image\/(png|jpeg|jpg));base64,(.+)$/i.exec(String(el.src || ""));
        if (!m) { nonRepris.push("une image dont la source n'est pas lisible"); break; }
        const ext = /png/i.test(m[2]) ? "png" : "jpeg";
        const nom = `image${numero}_${id}.${ext}`;
        const rid = `rId${medias.length + 10}`;
        medias.push({ nom, octets: Buffer.from(m[3], "base64"),
          type: ext === "png" ? "image/png" : "image/jpeg", rid });
        formes.push(
          `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Image ${id}"/>` +
          `<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
          `<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
          `<p:spPr><a:xfrm><a:off x="${mmVersEmu(el.x)}" y="${mmVersEmu(el.y)}"/>` +
          `<a:ext cx="${Math.max(1, mmVersEmu(el.l))}" cy="${Math.max(1, mmVersEmu(el.h))}"/></a:xfrm>` +
          `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`);
        break;
      }
      default:
        nonRepris.push(`un élément de type « ${el?.type} »`);
    }
  }

  /* LE FOND VA DANS « p:bg », pas dans un rectangle.

     Le premier jet en faisait un rectangle plein couvrant la diapositive. Le
     rendu était juste, mais l'aller-retour ne l'était plus : à la relecture,
     ce rectangle redevenait un ÉLÉMENT du plan et non le fond. Un export
     suivi d'un import suivi d'un export accumulait donc un rectangle de
     plus à chaque tour.

     `p:bg` avec une couleur écrite en clair — `srgbClr`, et non une couleur
     de thème — ne laisse aucune place à l'interprétation. */
  const fond = transparent(plan?.fond) ? "" :
    `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex6(plan.fond, "FFFFFF")}"/></a:solidFill>` +
    `<a:effectLst/></p:bgPr></p:bg>`;

  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld>' + fond +
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    formes.join("") +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';

  return { xml, medias, nonRepris };
}

const THEME = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Triangle">' +
  '<a:themeElements><a:clrScheme name="Triangle">' +
  '<a:dk1><a:srgbClr val="0F172A"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="1D4ED8"/></a:accent1><a:accent2><a:srgbClr val="2563EB"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="15803D"/></a:accent3><a:accent4><a:srgbClr val="B45309"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="DC2626"/></a:accent5><a:accent6><a:srgbClr val="64748B"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="1D4ED8"/></a:hlink><a:folHlink><a:srgbClr val="64748B"/></a:folHlink>' +
  '</a:clrScheme><a:fontScheme name="Triangle">' +
  '<a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
  '</a:fontScheme><a:fmtScheme name="Triangle">' +
  '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
  '</a:fmtScheme></a:themeElements></a:theme>';

const VIDE_SPTREE =
  '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr/></p:spTree></p:cSld>';

/**
 * Construit le .pptx.
 *
 * @param titre        le nom de la présentation
 * @param diapositives une liste de plans { fond, elements }
 * @param largeurMm/hauteurMm  la taille d'une diapositive
 * @returns { buffer, diapositives, nonRepris }
 */
async function ecrire({ titre, diapositives, largeurMm, hauteurMm, auteur = "" }) {
  const liste = Array.isArray(diapositives) ? diapositives : null;
  if (!liste || !liste.length) {
    throw erreur("Une présentation sans diapositive ne s'exporte pas.", "AUCUNE_DIAPOSITIVE");
  }
  if (!(Number(largeurMm) > 0) || !(Number(hauteurMm) > 0)) {
    throw erreur("La taille d'une diapositive manque.", "DIMENSIONS_REQUISES");
  }

  const zip = new JSZip();
  const typesSupplementaires = new Set();
  const nonRepris = [];

  const relsPresentation = [];
  const typesDefaut = new Map([
    ["rels", "application/vnd.openxmlformats-package.relationships+xml"],
    ["xml", "application/xml"],
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["jpg", "image/jpeg"],
  ]);

  liste.forEach((plan, i) => {
    const numero = i + 1;
    const { xml, medias, nonRepris: manques } = diapositiveXml(
      plan, numero, { largeurMm, hauteurMm });
    zip.file(`ppt/slides/slide${numero}.xml`, xml);
    const rels = [
      '<Relationship Id="rId1" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" ' +
      'Target="../slideLayouts/slideLayout1.xml"/>',
      ...medias.map((m) =>
        `<Relationship Id="${m.rid}" ` +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ' +
        `Target="../media/${m.nom}"/>`),
    ];
    zip.file(`ppt/slides/_rels/slide${numero}.xml.rels`,
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels.join("") + "</Relationships>");
    for (const m of medias) {
      zip.file(`ppt/media/${m.nom}`, m.octets);
      typesSupplementaires.add(m.type);
    }
    for (const q of manques) nonRepris.push(`diapositive ${numero} : ${q}`);
    relsPresentation.push(numero);
  });

  /* ─── Le masque et la mise en page : volontairement vides ───
     Les diapositives portent toutes leurs formes en propre et n'héritent
     rien. Un masque garni ajouterait des cadres fantômes par-dessus. */
  zip.file("ppt/slideMasters/slideMaster1.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    VIDE_SPTREE +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
    'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ' +
    'hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    '</p:sldMaster>');
  zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" ' +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" ' +
    'Target="../slideLayouts/slideLayout1.xml"/>' +
    '<Relationship Id="rId2" ' +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" ' +
    'Target="../theme/theme1.xml"/></Relationships>');

  zip.file("ppt/slideLayouts/slideLayout1.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">' +
    VIDE_SPTREE +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>');
  zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" ' +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" ' +
    'Target="../slideMasters/slideMaster1.xml"/></Relationships>');

  zip.file("ppt/theme/theme1.xml", THEME);

  zip.file("ppt/presentation.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:sldIdLst>' +
    relsPresentation.map((n) => `<p:sldId id="${255 + n}" r:id="rId${n + 1}"/>`).join("") +
    '</p:sldIdLst>' +
    `<p:sldSz cx="${mmVersEmu(largeurMm)}" cy="${mmVersEmu(hauteurMm)}"/>` +
    `<p:notesSz cx="${mmVersEmu(hauteurMm)}" cy="${mmVersEmu(largeurMm)}"/>` +
    '</p:presentation>');
  zip.file("ppt/_rels/presentation.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" ' +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" ' +
    'Target="slideMasters/slideMaster1.xml"/>' +
    relsPresentation.map((n) =>
      `<Relationship Id="rId${n + 1}" ` +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" ' +
      `Target="slides/slide${n}.xml"/>`).join("") +
    `<Relationship Id="rId${relsPresentation.length + 2}" ` +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" ' +
    'Target="theme/theme1.xml"/></Relationships>');

  zip.file("docProps/core.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${ech(titre || "Présentation")}</dc:title>` +
    `<dc:creator>${ech(auteur || "Triangle Studio Pro")}</dc:creator>` +
    `<cp:lastModifiedBy>${ech(auteur || "Triangle Studio Pro")}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>` +
    '</cp:coreProperties>');

  zip.file("_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" ' +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
    'Target="ppt/presentation.xml"/>' +
    '<Relationship Id="rId2" ' +
    'Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" ' +
    'Target="docProps/core.xml"/></Relationships>');

  /* [Content_Types].xml s'écrit en dernier : il doit connaître toutes les
     extensions réellement présentes, sinon PowerPoint refuse l'archive. */
  zip.file("[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    [...typesDefaut.entries()].map(([ext, type]) =>
      `<Default Extension="${ext}" ContentType="${type}"/>`).join("") +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    relsPresentation.map((n) =>
      `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("") +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>');

  const buffer = await zip.generateAsync({
    type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 },
    /* Une date fixe rendrait l'archive reproductible, mais Office se fie à la
       date de modification pour certains caches : on garde la vraie. */
  });
  return { buffer, diapositives: liste.length, nonRepris };
}

/* ════════════════════════════════════════════════════════════════════════
   LIRE

   On n'essaie pas de deviner. Tout ce dont la géométrie, la couleur ou la
   nature n'est pas ÉCRITE DANS LA DIAPOSITIVE est signalé, forme par forme,
   et l'appelant doit montrer ce compte rendu. Lire à moitié en silence est
   la seule façon de perdre un tableau sans que personne ne s'en aperçoive
   avant de projeter.
   ════════════════════════════════════════════════════════════════════════ */

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/* LES PRÉFIXES NE SONT PAS GARANTIS. « a: », « p: », « r: » sont ceux
   qu'emploient PowerPoint et LibreOffice, mais la norme ne les impose pas :
   un producteur a le droit d'écrire « x: » partout. On interroge donc par
   ESPACE DE NOMS, jamais par préfixe. */
function enfants(noeud, ns, local) {
  const sortie = [];
  for (let n = noeud?.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.localName === local && (!ns || n.namespaceURI === ns)) sortie.push(n);
  }
  return sortie;
}
const enfant = (noeud, ns, local) => enfants(noeud, ns, local)[0] || null;
/** Le premier descendant, à n'importe quelle profondeur. */
function descendant(noeud, ns, local) {
  if (!noeud) return null;
  const l = noeud.getElementsByTagNameNS ? noeud.getElementsByTagNameNS(ns, local) : null;
  return l && l.length ? l[0] : null;
}
const texteDe = (n) => (n ? String(n.textContent ?? "") : "");

function lirePlan(xml) {
  const doc = new DOMParser({ onError: () => {} }).parseFromString(xml, "text/xml");
  return doc;
}

/** La couleur d'un remplissage, ou ce qui empêche de la connaître. */
function couleurDe(parent, manques, quoi) {
  if (!parent) return { couleur: null, connue: false };
  if (enfant(parent, NS_A, "noFill")) return { couleur: "transparent", connue: true };
  const solide = enfant(parent, NS_A, "solidFill");
  if (solide) {
    const srgb = enfant(solide, NS_A, "srgbClr");
    if (srgb) return { couleur: `#${hex6(srgb.getAttribute("val")).toLowerCase()}`, connue: true };
    const theme = enfant(solide, NS_A, "schemeClr");
    if (theme) {
      /* UNE COULEUR DE THÈME NE VEUT RIEN DIRE SANS LE THÈME, et le thème
         peut lui-même être redéfini par le masque. On ne devine pas. */
      manques.push(`${quoi} : la couleur « ${theme.getAttribute("val")} » vient du thème`);
      return { couleur: null, connue: false };
    }
  }
  if (enfant(parent, NS_A, "gradFill")) {
    manques.push(`${quoi} : un dégradé, remplacé par une couleur unie`);
    return { couleur: null, connue: false };
  }
  if (enfant(parent, NS_A, "blipFill")) {
    manques.push(`${quoi} : un remplissage par image`);
    return { couleur: null, connue: false };
  }
  return { couleur: null, connue: false };
}

const POLICE_RETOUR = (typeface) => {
  const t = String(typeface || "").toLowerCase();
  if (/georgia|times|garamond|book|serif|cambria|constantia/.test(t)) return "serif";
  if (/courier|consolas|mono|menlo/.test(t)) return "mono";
  return "sans";
};
const ALIGNEMENT_RETOUR = { l: "gauche", ctr: "centre", r: "droite", just: "gauche" };

/** Le texte d'un corps, paragraphe par paragraphe, avec son premier style. */
function lireTexte(txBody, manques, quoi) {
  if (!txBody) return null;
  const paragraphes = enfants(txBody, NS_A, "p");
  if (!paragraphes.length) return null;

  const lignes = [];
  let style = null;
  let stylesDifferents = false;

  for (const par of paragraphes) {
    const runs = enfants(par, NS_A, "r");
    lignes.push(runs.map((r) => texteDe(enfant(r, NS_A, "t"))).join(""));
    const pPr = enfant(par, NS_A, "pPr");
    for (const r of runs) {
      const rPr = enfant(r, NS_A, "rPr");
      const courant = {
        /* Le passage par les centièmes de point introduit un millième de
           millimètre d'écart : on arrondit, sinon un aller-retour laisse
           « 14,001749999 » dans le plan. */
        taille: rPr?.getAttribute("sz")
          ? Math.round(szVersMm(rPr.getAttribute("sz")) * 1000) / 1000 : null,
        graisse: rPr?.getAttribute("b") === "1" ? 700 : 400,
        couleur: couleurDe(rPr, [], "").couleur,
        police: POLICE_RETOUR(enfant(rPr, NS_A, "latin")?.getAttribute("typeface")),
        alignement: ALIGNEMENT_RETOUR[pPr?.getAttribute("algn")] || "gauche",
        interligne: (() => {
          const pct = enfant(enfant(pPr, NS_A, "lnSpc"), NS_A, "spcPct");
          return pct ? Math.max(0.8, Math.min(3, Number(pct.getAttribute("val")) / 100000)) : 1.3;
        })(),
      };
      if (!style) style = courant;
      else if (style.taille !== courant.taille || style.graisse !== courant.graisse
            || style.couleur !== courant.couleur || style.police !== courant.police) {
        stylesDifferents = true;
      }
    }
  }

  const texte = lignes.join("\n").replace(/\s+$/, "");
  if (!texte.trim()) return null;
  if (stylesDifferents) {
    /* LE PLAN DU STUDIO A UN SEUL STYLE PAR BLOC DE TEXTE. Un paragraphe
       dont un mot est en gras rouge et le reste en noir ne s'y traduit pas :
       on garde le premier style et on le dit, plutôt que de laisser croire
       que la mise en forme a suivi. */
    manques.push(`${quoi} : plusieurs mises en forme dans le même texte, seule la première est reprise`);
  }
  return { texte, style: style || {} };
}

const GEOM_RETOUR = {
  rect: "rect", roundRect: "rect", snipRoundRect: "rect", flowChartProcess: "rect",
  ellipse: "ellipse", oval: "ellipse", flowChartConnector: "ellipse",
  line: "ligne", straightConnector1: "ligne",
};

/**
 * @param zip      l'archive ouverte
 * @param chemin   le chemin de la diapositive dans l'archive
 * @param taille   { largeurMm, hauteurMm }
 */
async function lireDiapositive(zip, chemin, taille, numero) {
  const manques = [];
  const xml = await zip.file(chemin).async("string");
  const doc = lirePlan(xml);
  const sld = doc.documentElement;
  const cSld = enfant(sld, NS_P, "cSld");

  /* ─ Le fond ─ */
  let fond = "#ffffff";
  const bgPr = enfant(enfant(cSld, NS_P, "bg"), NS_P, "bgPr");
  if (bgPr) {
    const c = couleurDe(bgPr, manques, "le fond de la diapositive");
    if (c.couleur && c.couleur !== "transparent") fond = c.couleur;
  }

  /* ─ Les relations, pour retrouver les images ─ */
  const dossier = chemin.slice(0, chemin.lastIndexOf("/"));
  const cheminRels = `${dossier}/_rels/${chemin.slice(chemin.lastIndexOf("/") + 1)}.rels`;
  const relations = new Map();
  const fRels = zip.file(cheminRels);
  if (fRels) {
    const dr = lirePlan(await fRels.async("string"));
    for (const r of Array.from(dr.getElementsByTagName("*"))) {
      if (r.localName !== "Relationship") continue;
      relations.set(r.getAttribute("Id"), r.getAttribute("Target"));
    }
  }

  const elements = [];
  let compteur = 0;
  const idNeuf = (p) => `${p}${numero}_${(compteur += 1)}`;

  /* Une position de secours pour les emplacements qui tiennent la leur du
     masque : le titre en haut, le reste au tiers. */
  const secours = (estTitre) => ({
    x: taille.largeurMm * 0.07,
    y: estTitre ? taille.hauteurMm * 0.10 : taille.hauteurMm * 0.35,
    l: taille.largeurMm * 0.86,
    h: taille.hauteurMm * 0.2,
  });

  const geometrie = (spPr, quoi, estTitre) => {
    const xfrm = enfant(spPr, NS_A, "xfrm");
    const off = enfant(xfrm, NS_A, "off");
    const ext = enfant(xfrm, NS_A, "ext");
    if (off && ext) {
      const mm = (v) => Math.round(emuVersMm(v) * 1000) / 1000;
      return {
        x: mm(off.getAttribute("x")), y: mm(off.getAttribute("y")),
        l: mm(ext.getAttribute("cx")), h: mm(ext.getAttribute("cy")),
        ecrite: true,
      };
    }
    manques.push(`${quoi} : sa position vient du masque, elle est approchée`);
    return { ...secours(estTitre), ecrite: false };
  };

  const spTree = enfant(cSld, NS_P, "spTree");
  for (let n = spTree?.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    const local = n.localName;

    if (local === "sp") {
      const nvSpPr = enfant(n, NS_P, "nvSpPr");
      const nom = enfant(nvSpPr, NS_P, "cNvPr")?.getAttribute("name") || "une forme";
      const ph = descendant(enfant(nvSpPr, NS_P, "nvPr"), NS_P, "ph");
      const typePh = ph?.getAttribute("type") || "";
      const estTitre = /title/i.test(typePh);
      const spPr = enfant(n, NS_P, "spPr");
      const g = geometrie(spPr, `« ${nom} »`, estTitre);

      const prst = enfant(spPr, NS_A, "prstGeom")?.getAttribute("prst") || "rect";
      const famille = GEOM_RETOUR[prst];
      if (!famille) {
        manques.push(`« ${nom} » : la forme « ${prst} » est rendue comme un rectangle`);
      }
      const forme = famille || "rect";

      const fill = couleurDe(spPr, manques, `« ${nom} »`);
      const ln = enfant(spPr, NS_A, "ln");
      const traitCouleur = couleurDe(ln, [], "").couleur;
      const bordure = ln?.getAttribute("w") ? emuVersMm(ln.getAttribute("w")) : 0;

      /* UNE FORME PEUT ÊTRE DEUX CHOSES À LA FOIS : un rectangle de couleur
         QUI PORTE du texte. Le plan du Studio les sépare, donc on émet les
         deux — le fond d'abord, le texte par-dessus. */
      const aUnFond = fill.couleur && fill.couleur !== "transparent";
      const aUnTrait = bordure > 0 && traitCouleur;
      if (forme === "ligne") {
        elements.push({ id: idNeuf("l"), type: "ligne", x: g.x, y: g.y + g.h / 2,
          l: Math.max(0.5, g.l), epaisseur: Math.max(0.2, bordure || g.h || 0.3),
          couleur: traitCouleur || fill.couleur || "#000000" });
      } else if (aUnFond || aUnTrait) {
        const commun = { x: g.x, y: g.y, l: Math.max(0.5, g.l), h: Math.max(0.5, g.h),
          couleur: aUnFond ? fill.couleur : "transparent",
          bordure: aUnTrait ? bordure : 0,
          couleurBordure: traitCouleur || "#000000" };
        elements.push(forme === "ellipse"
          ? { id: idNeuf("e"), type: "ellipse", ...commun }
          : { id: idNeuf("r"), type: "rect", ...commun, rayon: prst === "roundRect" ? Math.min(g.l, g.h) * 0.1 : 0 });
      }

      const t = lireTexte(enfant(n, NS_P, "txBody"), manques, `« ${nom} »`);
      if (t) {
        const st = t.style;
        elements.push({
          id: idNeuf("t"), type: "texte", x: g.x, y: g.y, l: Math.max(2, g.l),
          texte: t.texte,
          taille: st.taille && st.taille > 0.5 ? st.taille
            : (estTitre ? taille.hauteurMm * 0.07 : taille.hauteurMm * 0.035),
          couleur: st.couleur || "#111827",
          graisse: st.graisse || (estTitre ? 700 : 400),
          alignement: st.alignement || "gauche",
          police: st.police || "sans",
          interligne: st.interligne || 1.3,
        });
        if (!st.taille) {
          manques.push(`« ${nom} » : la taille du texte vient du masque, elle est approchée`);
        }
      }
      continue;
    }

    if (local === "pic") {
      const nom = descendant(enfant(n, NS_P, "nvPicPr"), NS_P, "cNvPr")?.getAttribute("name") || "une image";
      const g = geometrie(enfant(n, NS_P, "spPr"), `« ${nom} »`, false);
      const blip = descendant(enfant(n, NS_P, "blipFill"), NS_A, "blip");
      const rid = blip?.getAttributeNS?.(NS_R, "embed") || blip?.getAttribute("r:embed");
      const cible = rid ? relations.get(rid) : null;
      if (!cible) { manques.push(`« ${nom} » : son fichier n'est pas dans l'archive`); continue; }
      const chemin2 = cible.startsWith("/") ? cible.slice(1)
        : `${dossier}/${cible}`.replace(/[^/]+\/\.\.\//g, "");
      const f = zip.file(chemin2);
      if (!f) { manques.push(`« ${nom} » : ${chemin2} est absent de l'archive`); continue; }
      const octets = await f.async("nodebuffer");
      const ext = (chemin2.split(".").pop() || "").toLowerCase();
      if (!["png", "jpg", "jpeg"].includes(ext)) {
        manques.push(`« ${nom} » : une image ${ext.toUpperCase()}, que le navigateur ne saura pas remettre dans le plan`);
        continue;
      }
      if (octets.length > 900 * 1024) {
        /* LA MÊME LIMITE QUE L'ÉDITEUR. Au-delà, le plan deviendrait trop
           lourd pour être enregistré, et l'échec arriverait plus tard, sans
           que personne puisse relier la cause à l'effet. */
        manques.push(`« ${nom} » : ${Math.round(octets.length / 1024)} Ko, au-delà des 900 Ko qu'un plan accepte`);
        continue;
      }
      elements.push({ id: idNeuf("i"), type: "image", x: g.x, y: g.y,
        l: Math.max(1, g.l), h: Math.max(1, g.h), arrondi: 0,
        src: `data:image/${ext === "png" ? "png" : "jpeg"};base64,${octets.toString("base64")}` });
      continue;
    }

    if (local === "graphicFrame") {
      /* Tableaux, graphiques, SmartArt, objets incorporés. Les reprendre,
         c'est réécrire une partie de PowerPoint. */
      const quoi = descendant(n, NS_A, "tbl") ? "un tableau"
        : descendant(n, NS_A, "graphicData")?.getAttribute("uri")?.includes("chart") ? "un graphique"
        : "un objet (SmartArt, graphique ou tableau)";
      manques.push(`${quoi} n'est pas repris`);
      continue;
    }
    if (local === "grpSp") {
      /* Un groupe porte sa propre transformation, qui met à l'échelle les
         positions de ses enfants. Les aplatir sans l'appliquer les
         déplacerait : on préfère le dire. */
      manques.push("un groupe de formes n'est pas repris");
      continue;
    }
    if (local === "cxnSp") { manques.push("un connecteur n'est pas repris"); continue; }
  }

  return { plan: { fond, elements }, manques };
}

/**
 * Lit un .pptx.
 *
 * @returns { largeurMm, hauteurMm, diapositives: [plan], nonRepris: [texte] }
 */
async function lire(octets) {
  if (!Buffer.isBuffer(octets) || octets.length < 4
      || octets[0] !== 0x50 || octets[1] !== 0x4b) {
    throw erreur(
      "Ce fichier n'est pas un .pptx : une présentation Office est une archive, " +
      "et celle-ci n'en a pas la signature.",
      "PAS_UN_PPTX", 415);
  }
  let zip;
  try { zip = await JSZip.loadAsync(octets); }
  catch (e) {
    throw erreur(`Cette archive n'a pas pu être ouverte : ${e.message}`, "ARCHIVE_ILLISIBLE", 415);
  }

  const fPres = zip.file("ppt/presentation.xml");
  if (!fPres) {
    throw erreur(
      "Cette archive ne contient pas « ppt/presentation.xml » : ce n'est pas une présentation " +
      "PowerPoint. Un .ppt d'avant 2007, un .odp ou un .key ne s'ouvrent pas ici.",
      "PAS_UNE_PRESENTATION", 415);
  }
  const docPres = lirePlan(await fPres.async("string"));
  const sldSz = descendant(docPres.documentElement, NS_P, "sldSz");
  const largeurMm = sldSz ? emuVersMm(sldSz.getAttribute("cx")) : 338.67;
  const hauteurMm = sldSz ? emuVersMm(sldSz.getAttribute("cy")) : 190.5;

  /* L'ORDRE DES DIAPOSITIVES EST CELUI DE sldIdLst, pas celui des noms de
     fichiers. « slide10.xml » peut être la deuxième ; une présentation
     réordonnée dans PowerPoint ne renomme rien. */
  const relsPres = new Map();
  const fRelsPres = zip.file("ppt/_rels/presentation.xml.rels");
  if (fRelsPres) {
    const dr = lirePlan(await fRelsPres.async("string"));
    for (const r of Array.from(dr.getElementsByTagName("*"))) {
      if (r.localName === "Relationship") relsPres.set(r.getAttribute("Id"), r.getAttribute("Target"));
    }
  }
  const ordre = [];
  const lst = descendant(docPres.documentElement, NS_P, "sldIdLst");
  for (const sldId of enfants(lst, NS_P, "sldId")) {
    const rid = sldId.getAttributeNS?.(NS_R, "id") || sldId.getAttribute("r:id");
    const cible = rid ? relsPres.get(rid) : null;
    if (!cible) continue;
    ordre.push(cible.startsWith("/") ? cible.slice(1) : `ppt/${cible}`.replace(/\/\.\//g, "/"));
  }
  if (!ordre.length) {
    /* Pas de liste exploitable : on se rabat sur les fichiers, en ordre
       NUMÉRIQUE, et on le signale. */
    const trouves = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    ordre.push(...trouves);
  }
  if (!ordre.length) {
    throw erreur("Cette présentation ne contient aucune diapositive.", "AUCUNE_DIAPOSITIVE", 415);
  }
  if (ordre.length > 200) {
    throw erreur(
      `Cette présentation compte ${ordre.length} diapositives ; la limite est 200.`,
      "TROP_DE_DIAPOSITIVES");
  }

  const diapositives = [];
  const nonRepris = [];
  for (const [i, chemin] of ordre.entries()) {
    if (!zip.file(chemin)) { nonRepris.push(`diapositive ${i + 1} : ${chemin} est absent`); continue; }
    const { plan, manques } = await lireDiapositive(
      zip, chemin, { largeurMm, hauteurMm }, i + 1);
    diapositives.push(plan);
    for (const m of manques) nonRepris.push(`diapositive ${diapositives.length} : ${m}`);
  }

  return { largeurMm, hauteurMm, diapositives, nonRepris };
}

module.exports = {
  ecrire, lire,
  EMU_PAR_MM, POINTS_PAR_MM, mmVersEmu, emuVersMm, mmVersSz, szVersMm,
};
