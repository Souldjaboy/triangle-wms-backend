"use strict";

/**
 * CLASSEUR D'ESSAI EM2S.
 *
 * Le classeur du client ne doit pas entrer dans le dépôt : il porte des
 * données réelles. On fabrique donc ici un classeur minuscule qui reproduit
 * exactement ce qui compte pour les règles métier — les trois orthographes du
 * marqueur de bloc, une date en numéro de série, la fusion A/C d'un même
 * conteneur, les quatre couleurs, une ligne multi-bacs, une cellule à dates
 * multiples, une ligne incohérente, une zone sans rack, et la ligne TOTAL qui
 * fausse les comptes si on la prend pour un article.
 *
 * Le fichier est écrit ici en OOXML brut parce que la bibliothèque `xlsx`
 * installée sait LIRE les couleurs mais pas les ÉCRIRE : un classeur d'essai
 * sans couleur ne prouverait rien de la règle qui compte le plus.
 *
 *   node scripts/fixture-em2s.js /chemin/sortie.xlsx
 */

const zlib = require("zlib");

/* ────────────────────────────────────────────────── conteneur ZIP ── */

function entree(nom, contenu) {
  const donnees = Buffer.from(contenu, "utf8");
  return { nom: Buffer.from(nom, "utf8"), donnees, crc: zlib.crc32(donnees) };
}

/** ZIP « stored » minimal : suffisant pour un .xlsx, et lisible sans dépendance. */
function zip(entrees) {
  const morceaux = [];
  const central = [];
  let position = 0;

  for (const e of entrees) {
    const enTete = Buffer.alloc(30);
    enTete.writeUInt32LE(0x04034b50, 0);
    enTete.writeUInt16LE(20, 4);            // version minimale
    enTete.writeUInt16LE(0, 6);             // pas de drapeau
    enTete.writeUInt16LE(0, 8);             // méthode : stocké
    enTete.writeUInt16LE(0, 10);            // heure
    enTete.writeUInt16LE(0x21, 12);         // date : 1980-01-01, stable
    enTete.writeUInt32LE(e.crc, 14);
    enTete.writeUInt32LE(e.donnees.length, 18);
    enTete.writeUInt32LE(e.donnees.length, 22);
    enTete.writeUInt16LE(e.nom.length, 26);
    enTete.writeUInt16LE(0, 28);

    const dossier = Buffer.alloc(46);
    dossier.writeUInt32LE(0x02014b50, 0);
    dossier.writeUInt16LE(20, 4);
    dossier.writeUInt16LE(20, 6);
    dossier.writeUInt16LE(0, 8);
    dossier.writeUInt16LE(0, 10);
    dossier.writeUInt16LE(0, 12);
    dossier.writeUInt16LE(0x21, 14);
    dossier.writeUInt32LE(e.crc, 16);
    dossier.writeUInt32LE(e.donnees.length, 20);
    dossier.writeUInt32LE(e.donnees.length, 24);
    dossier.writeUInt16LE(e.nom.length, 28);
    dossier.writeUInt32LE(position, 42);

    morceaux.push(enTete, e.nom, e.donnees);
    central.push(dossier, e.nom);
    position += 30 + e.nom.length + e.donnees.length;
  }

  const debutCentral = position;
  const tailleCentral = central.reduce((s, b) => s + b.length, 0);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(entrees.length, 8);
  fin.writeUInt16LE(entrees.length, 10);
  fin.writeUInt32LE(tailleCentral, 12);
  fin.writeUInt32LE(debutCentral, 16);

  return Buffer.concat([...morceaux, ...central, fin]);
}

/* ────────────────────────────────────────────────────── styles ── */

/* Index des styles utilisés par les cellules ci-dessous. L'ordre compte : il
   définit les `s="…"` du XML des feuilles. */
const STYLE = { NEUTRE: 0, ANCIEN_JAUNE: 1, ANCIEN_ROUGE: 2, JAUNE_OR: 3, ROUGE_FONCE: 4, DATE: 5 };

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="6">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor rgb="FFFFFF00"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/><bgColor rgb="FFC00000"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFC000"/><bgColor rgb="FFFF9900"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFC00000"/><bgColor rgb="FFFF0000"/></patternFill></fill>
</fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/* ──────────────────────────────────────────────── écriture cellules ── */

const echapper = (t) => String(t)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const LETTRES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const colonne = (i) => (i < 26 ? LETTRES[i] : LETTRES[Math.floor(i / 26) - 1] + LETTRES[i % 26]);

/** `cellule(colonne, ligne, valeur, style)` — texte ou nombre selon le type. */
function cellule(c, l, valeur, style = STYLE.NEUTRE) {
  if (valeur === null || valeur === undefined || valeur === "") return "";
  const ref = `${colonne(c)}${l}`;
  const s = style ? ` s="${style}"` : "";
  return typeof valeur === "number"
    ? `<c r="${ref}"${s}><v>${valeur}</v></c>`
    : `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${echapper(valeur)}</t></is></c>`;
}

/** Nombre de jours Excel pour une date ISO, sans passer par un fuseau. */
function serieExcel(iso) {
  const [a, m, j] = iso.split("-").map(Number);
  const jours = Date.UTC(a, m - 1, j) / 86400000;
  /* Excel compte depuis le 30/12/1899 et croit que 1900 est bissextile. */
  return jours + 25569;
}

function feuille(lignes) {
  const corps = lignes.map(({ n, cellules }) =>
    `<row r="${n}">${cellules.join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${corps}</sheetData></worksheet>`;
}

/* ═══════════════════════════════════════════ CONTENU DU CLASSEUR ══ */

/** Feuille de réception : marqueur, date, conteneur, articles. */
function feuilleReception(blocs) {
  const lignes = [];
  let n = 1;
  lignes.push({ n: n++, cellules: [cellule(0, 1, "RECEIVED ITEMS")] });

  for (const b of blocs) {
    const debut = n;
    lignes.push({ n, cellules: [
      cellule(0, n, b.marqueur),
      b.dateSerie
        ? cellule(2, n, serieExcel(b.date), STYLE.DATE)
        : cellule(2, n, `DATE: ${b.date.split("-").reverse().join("/")}`),
      cellule(4, n, "ITEMS DESCRIPTION"), cellule(7, n, "UNITY"), cellule(8, n, "QUANTITIES"),
    ] });
    n += 1;

    /* Le numéro de conteneur vit dans une cellule du corps, pas de l'en-tête :
       c'est ainsi que le fichier réel est bâti. On le pose sur la deuxième
       ligne quand elle existe, sinon sur la seule qu'il y ait — un bloc d'un
       seul article resterait sinon sans numéro, donc sans fusion possible. */
    const ligneDuNumero = Math.min(1, b.articles.length - 1);
    b.articles.forEach((a, i) => {
      const cellules = [cellule(4, n, a.libelle), cellule(7, n, a.unite || "EA"), cellule(8, n, a.quantite)];
      if (i === ligneDuNumero) cellules.push(cellule(2, n, b.conteneur));
      lignes.push({ n, cellules });
      n += 1;
    });

    /* Quelques cellules d'unité isolées, comme dans le fichier réel : elles ne
       sont pas des articles et ne doivent pas être comptées. */
    lignes.push({ n, cellules: [cellule(7, n, "EA")] });
    n += 1;
    void debut;
  }
  return feuille(lignes);
}

/** Feuille de stock : hiérarchie, bacs, entrées/sorties colorées, dates. */
function feuilleStock(articles) {
  const lignes = [];
  lignes.push({ n: 2, cellules: [cellule(0, 2, "Inventory list for:  W-EM2S- A")] });
  lignes.push({ n: 3, cellules: [
    cellule(0, 3, "ITEM DESCRIPTION"), cellule(2, 3, "ROW"), cellule(3, 3, "LOCATION"),
    cellule(4, 3, "LEVEL"), cellule(5, 3, "BIN"), cellule(8, 3, "QUANTITIES"),
    cellule(9, 3, "UNITE"), cellule(11, 3, "IN/EACH"), cellule(12, 3, "OUT/EACH"),
    cellule(13, 3, "new stock"), cellule(14, 3, "DATE"),
  ] });
  lignes.push({ n: 4, cellules: [cellule(5, 4, "A"), cellule(6, 4, "B"), cellule(7, 4, "C")] });

  for (const a of articles) {
    const n = a.ligne;
    const cellules = [
      cellule(0, n, a.description), cellule(2, n, a.rayon), cellule(3, n, a.location),
      cellule(4, n, a.niveau), cellule(8, n, a.stockInitial), cellule(9, n, "EACH"),
      cellule(13, n, a.nouveauStock),
    ];
    (a.bins || []).forEach((b) => cellules.push(cellule(4 + b, n, "X")));
    if (a.entree) cellules.push(cellule(11, n, a.entree.quantite, a.entree.style));
    if (a.sortie) cellules.push(cellule(12, n, a.sortie.quantite, a.sortie.style));
    if (a.dateTexte) cellules.push(cellule(14, n, a.dateTexte));
    else if (a.dateISO) cellules.push(cellule(14, n, serieExcel(a.dateISO), STYLE.DATE));
    lignes.push({ n, cellules });
  }

  /* La ligne TOTAL : coloriée comme une sortie, sans description. Prise pour
     un article, elle ajoute une sortie qui n'a jamais eu lieu. */
  const total = articles.reduce((s, a) => s + (a.sortie ? a.sortie.quantite : 0), 0);
  lignes.push({ n: 500, cellules: [
    cellule(7, 500, "TOTAL"),
    cellule(12, 500, total + 9999, STYLE.ROUGE_FONCE),
  ] });

  return feuille(lignes);
}

const BLOCS_A = [
  { marqueur: "CONTAINER NUMBER", date: "2026-06-22", conteneur: "MSNU: 5745901/ 6", articles: [
    { libelle: "CHAIR SEAT KOUTIALA", quantite: 100 },
    { libelle: "PROJECTEUR", quantite: 15 },
    { libelle: "MASQUE KOUTIALA", unite: "BOX", quantite: 1 },
  ] },
  { marqueur: "CONTAINER NUMBER:", date: "2026-07-27", conteneur: "TEMU 824100/0", articles: [
    { libelle: "WALL LAMP YKLBL2510", quantite: 676 },
    { libelle: "LAMPE SHADES 2LAMP", quantite: 12 },
  ] },
  /* Marqueur mal orthographié ET date en numéro de série : les deux pièges
     que le fichier réel réunit sur le bloc CAIU 993644/0. */
  { marqueur: "CONTEINER NUMBER:", date: "2026-08-13", dateSerie: true, conteneur: "CAIU 993644/0", articles: [
    { libelle: "SPEACKER LA212", quantite: 33 },
  ] },
];

const BLOCS_C = [
  { marqueur: "CONTAINER NUMBER", date: "2026-06-22", conteneur: "MSNU: 5745901/ 6", articles: [
    { libelle: "ACCESSOIRE CHAIR/PIED KOUTIALA", quantite: 98 },
  ] },
  { marqueur: "CONTEINER NUMBER:", date: "2026-07-27", conteneur: "TEMU 824100/0", articles: [
    { libelle: "BASSIN DRAINER PU-H337Z", quantite: 8 },
  ] },
];

const ARTICLES = [
  /* Multi-bacs : bloqué tant que la répartition n'est pas donnée. */
  { ligne: 167, description: "PROFESSIONAL AMPLIFIER POWER", rayon: "M", location: "M2", niveau: 1,
    bins: [1, 2], stockInitial: 52, nouveauStock: 54, dateISO: "2026-07-29",
    entree: { quantite: 4, style: STYLE.JAUNE_OR }, sortie: { quantite: 2, style: STYLE.ROUGE_FONCE } },

  /* Dates multiples : on sait lesquelles, pas combien sur chacune. */
  { ligne: 248, description: "MAMBRANE", rayon: "Q", location: "Q1", niveau: 2,
    bins: [1], stockInitial: 110, nouveauStock: 125, dateTexte: "19.21.25/08/2026",
    entree: { quantite: 40, style: STYLE.JAUNE_OR }, sortie: { quantite: 25, style: STYLE.ROUGE_FONCE } },

  /* Incohérente : 880 − 80 = 800, mais la feuille affiche 880. */
  { ligne: 297, description: "FAUX PLAFOND D", rayon: "S", location: "S1", niveau: 2,
    bins: [1, 2, 3], stockInitial: 880, nouveauStock: 880, dateISO: "2026-08-20",
    sortie: { quantite: 80, style: STYLE.ROUGE_FONCE } },

  /* Anciennes opérations : présentes, mais à ne jamais recréer. */
  { ligne: 300, description: "ANCIEN MOUVEMENT JAUNE", rayon: "A", location: "A1", niveau: 1,
    bins: [1], stockInitial: 10, nouveauStock: 15, dateISO: "2026-06-01",
    entree: { quantite: 5, style: STYLE.ANCIEN_JAUNE } },
  { ligne: 301, description: "ANCIEN MOUVEMENT ROUGE", rayon: "A", location: "A2", niveau: 1,
    bins: [1], stockInitial: 20, nouveauStock: 17, dateISO: "2026-06-02",
    sortie: { quantite: 3, style: STYLE.ANCIEN_ROUGE } },

  /* Zone au sol : le nom de zone occupe la colonne des niveaux. Ni niveau,
     ni bac — et surtout pas un niveau nommé « R&I ». */
  { ligne: 310, description: "PALETTE VRAC", rayon: "R&I", location: "R&I", niveau: "R&I",
    stockInitial: 40, nouveauStock: 44, dateISO: "2026-08-05",
    entree: { quantite: 4, style: STYLE.JAUNE_OR } },
  { ligne: 311, description: "CARTONS DIVERS", rayon: "PICKING  AREA", location: "PICKING  AREA",
    niveau: "PICKING  AREA", stockInitial: 12, nouveauStock: 12, dateISO: "2026-08-06" },

  /* Rayon « I » AVEC un vrai niveau : c'est une allée de rack, pas une zone.
     Ses deux bacs doivent donc rester une anomalie de répartition. */
  { ligne: 131, description: "TAPIS GYM VERT JAUNE", rayon: "I", location: "I1", niveau: "TOP",
    bins: [1, 2], stockInitial: 30, nouveauStock: 30 },

  /* Un seul bac : rien à répartir, aucune anomalie. */
  { ligne: 400, description: "MICRO SM 58", rayon: "T", location: "T1", niveau: 3,
    bins: [1], stockInitial: 60, nouveauStock: 91, dateISO: "2026-08-17",
    entree: { quantite: 31, style: STYLE.JAUNE_OR } },
];

/** Construit le classeur d'essai en mémoire. */
function construire() {
  const feuilles = [
    ["LISTE DES STOCK", feuilleStock(ARTICLES)],
    ["W-EM2S-A", feuilleReception(BLOCS_A)],
    ["W-EM2S-C", feuilleReception(BLOCS_C)],
    ["W-EM2S-B", feuille([{ n: 1, cellules: [cellule(0, 1, "RECEIVED ITEMS")] }])],
    ["WRITE OFF", feuille([{ n: 1, cellules: [cellule(0, 1, "WRITE OFF")] }])],
    ["Feuil1", feuille([])], ["Feuil2", feuille([])],
    ["Feuil3", feuille([])], ["Feuil4", feuille([])],
  ];

  const onglets = feuilles.map(([nom], i) =>
    `<sheet name="${echapper(nom)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  const liens = feuilles.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("");

  const entrees = [
    entree("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${feuilles.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
</Types>`),
    entree("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    entree("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${onglets}</sheets></workbook>`),
    entree("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${liens}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    entree("xl/styles.xml", STYLES_XML),
    ...feuilles.map(([, xml], i) => entree(`xl/worksheets/sheet${i + 1}.xml`, xml)),
  ];

  return zip(entrees);
}

module.exports = { construire, STYLE, BLOCS_A, BLOCS_C, ARTICLES };

if (require.main === module) {
  const chemin = process.argv[2] || "/tmp/fixture-em2s.xlsx";
  require("fs").writeFileSync(chemin, construire());
  console.log(`Classeur d'essai écrit : ${chemin}`);
}
