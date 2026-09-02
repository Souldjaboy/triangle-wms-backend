"use strict";

/**
 * LECTURE DU CLASSEUR EM2S.
 *
 * Ce module LIT. Il n'écrit rien, ne devine rien, et ne complète aucune donnée
 * manquante : ce qui est ambigu ressort en anomalie, avec l'adresse de la
 * cellule qui l'a produit, pour qu'une personne tranche.
 *
 * Trois pièges du fichier réel, qui justifient chaque règle ci-dessous :
 *
 *   1. Le marqueur de bloc de réception s'écrit de trois façons —
 *      « CONTAINER NUMBER », « CONTAINER NUMBER: », « CONTEINER NUMBER: ».
 *      Chercher la forme exacte ne trouve que 2 blocs sur 15.
 *
 *   2. La dernière ligne de la feuille de stock est un TOTAL (`=SUM(...)`),
 *      coloriée comme une sortie. Comptée comme un mouvement, elle ajoute
 *      12 218 unités qui n'existent pas. Une ligne sans description d'article
 *      n'est pas une ligne d'article.
 *
 *   3. Une couleur n'est pas un mot. « jaune » et « jaune-or » se ressemblent
 *      à l'œil et sont deux règles métier opposées : on lit le code de
 *      remplissage, jamais l'apparence.
 */

const crypto = require("crypto");
const XLSX = require("xlsx");

/* ─────────────────────────────────────────────────── couleurs métier ── */

const COULEURS = {
  FFFF00: { cle: "ANCIENNE_ENTREE", sens: "Entrée", nouveau: false, libelle: "ancienne entrée (jaune)" },
  FF0000: { cle: "ANCIENNE_SORTIE", sens: "Sortie", nouveau: false, libelle: "ancienne sortie (rouge)" },
  FFC000: { cle: "NOUVELLE_ENTREE", sens: "Entrée", nouveau: true,  libelle: "nouvelle entrée (jaune-or)" },
  C00000: { cle: "NOUVELLE_SORTIE", sens: "Sortie", nouveau: true,  libelle: "nouvelle sortie (rouge foncé)" },
};

/** Remplissage réel d'une cellule, en six hexadécimaux majuscules. */
function remplissage(cellule) {
  const s = cellule && cellule.s;
  if (!s || s.patternType !== "solid" || !s.fgColor) return null;
  const brut = String(s.fgColor.rgb || "").toUpperCase();
  if (!brut) return null;
  /* Les fichiers mélangent AARRGGBB et RRGGBB selon l'outil qui les a écrits. */
  return brut.length === 8 ? brut.slice(2) : brut;
}

/* ───────────────────────────────────────────── zones et hiérarchie ── */

/**
 * Zones sans rack : elles apparaissent dans ROW, LOCATION et LEVEL à la fois.
 * Ce ne sont pas des niveaux — en faire un niveau créerait un « Level R&I »
 * qui n'existe nulle part dans l'entrepôt.
 */
const ZONES_SANS_RACK = ["I", "R&I", "ALLE 3M", "PICKING AREA"];

/** Espaces multiples ramenés à un seul, majuscules, bords rognés. */
const compacter = (v) => String(v ?? "").replace(/\s+/g, " ").trim().toUpperCase();

function estZoneSansRack(valeur) {
  return ZONES_SANS_RACK.includes(compacter(valeur));
}

/**
 * Une ligne est une zone au sol quand c'est le NIVEAU qui porte le nom de
 * zone — c'est bien là qu'est l'erreur de saisie à traiter : « R&I » occupe
 * une colonne réservée aux niveaux.
 *
 * Le rayon seul ne suffit pas : « I » est aussi une allée de rack parfaitement
 * normale (les rayons vont de A à X). Les lignes I1/I2/I3 en niveau TOP avec
 * leurs bacs sont des emplacements rackés, pas un stockage au sol — les
 * traiter en zone leur ferait perdre leurs bacs, et donc leur anomalie de
 * répartition.
 */
function ligneEstZone({ rayon, location, niveau }) {
  if (estZoneSansRack(niveau)) return true;
  /* Niveau absent et rayon/location portant un nom de zone : même situation,
     la structure de rack n'existe simplement pas ici. */
  if (!compacter(niveau) && (estZoneSansRack(rayon) || estZoneSansRack(location))) return true;
  return false;
}

const NIVEAUX_VALIDES = ["1", "2", "3", "4", "TOP"];

/**
 * Niveau normalisé. « TOP », « TOP  » et « top » désignent le même niveau ;
 * une zone sans rack n'en a aucun.
 */
function niveauNormalise(brut) {
  const v = compacter(brut);
  if (!v || estZoneSansRack(v)) return null;
  const n = v.replace(/^LEVEL\s*/i, "");
  return NIVEAUX_VALIDES.includes(n) ? n : null;
}

/* ─────────────────────────────────────────────────────── conteneurs ── */

/**
 * Numéro de conteneur sous sa forme canonique : « MSNU 5745901/6 ».
 * Le fichier écrit le même conteneur « MSNU: 5745901/ 6 », « MRKU:559131/ 6 »
 * ou « TCKU 632071 /7 ». Sans forme unique, la fusion A/C n'a pas lieu et le
 * même conteneur physique est reçu deux fois.
 */
function numeroConteneur(brut) {
  const nu = String(brut ?? "").replace(/[^A-Za-z0-9/]/g, "").toUpperCase();
  const m = nu.match(/^([A-Z]{4})(\d+)\/(\d)$/);
  if (m) return `${m[1]} ${m[2]}/${m[3]}`;
  /* Certaines saisies collent le chiffre de contrôle sans barre oblique. */
  const m2 = nu.match(/^([A-Z]{4})(\d{6,7})(\d)$/);
  if (m2) return `${m2[1]} ${m2[2]}/${m2[3]}`;
  return nu || null;
}

/* ───────────────────────────────────────────────────────────── dates ── */

const MOIS_JOUR = /(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{4})/;

/**
 * Une date isolée, rendue en ISO `AAAA-MM-JJ`, ou `null`.
 *
 * Excel stocke une date comme un nombre de jours. On le convertit avec la
 * table d'Excel elle-même plutôt qu'en passant par un `Date` JavaScript : ce
 * dernier interprète l'instant en UTC puis le réaffiche dans le fuseau de la
 * machine, ce qui recule d'un jour toutes les dates à l'ouest de Greenwich —
 * la réception du conteneur CAIU 993644/0 tombait au 12 août au lieu du 13.
 */
function dateSimple(valeur) {
  if (typeof valeur === "number" && Number.isFinite(valeur) && valeur > 0) {
    const d = XLSX.SSF.parse_date_code(valeur);
    if (!d || !d.y) return null;
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  if (valeur instanceof Date && !Number.isNaN(valeur.getTime())) {
    /* Un `Date` ne peut venir que d'une lecture faite avec `cellDates` : on
       relit ses composantes UTC, seules fiables ici. */
    return `${valeur.getUTCFullYear()}-${String(valeur.getUTCMonth() + 1).padStart(2, "0")}`
         + `-${String(valeur.getUTCDate()).padStart(2, "0")}`;
  }
  const m = MOIS_JOUR.exec(String(valeur ?? ""));
  if (!m) return null;
  const [, j, mo, a] = m;
  return `${a}-${String(Number(mo)).padStart(2, "0")}-${String(Number(j)).padStart(2, "0")}`;
}

/**
 * Cellule de date multiple : « 19.21.25/08/2026 », « 9,25,27/07/2026 ».
 * Les séparateurs point et virgule sont mélangés dans le fichier. On sait
 * proposer les dates ; on ne sait PAS combien d'unités vont sur chacune —
 * c'est précisément ce qu'il ne faut pas deviner.
 */
function datesMultiples(valeur) {
  const texte = String(valeur ?? "").trim();
  if (!texte || valeur instanceof Date || typeof valeur === "number") return null;
  const m = texte.match(/^([\d\s.,]+)[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!m) return null;
  const jours = m[1].split(/[.,\s]+/).map((x) => x.trim()).filter(Boolean);
  if (jours.length < 2) return null;
  const mois = String(Number(m[2])).padStart(2, "0");
  return jours.map((j) => `${m[3]}-${mois}-${String(Number(j)).padStart(2, "0")}`);
}

/* ─────────────────────────────────────────────────── accès classeur ── */

const AA = (feuille, ligne, colonne) =>
  feuille[XLSX.utils.encode_cell({ r: ligne, c: colonne })];

const valeur = (cellule) => (cellule ? cellule.v : undefined);
const texte = (cellule) => String(valeur(cellule) ?? "").trim();
const nombre = (cellule) => {
  const v = valeur(cellule);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/* ═══════════════════════════════════════════════════ RÉCEPTIONS ══ */

const COL_A = 0, COL_C = 2, COL_E = 4, COL_H = 7, COL_I = 8;
const DEBUT_BLOC = /^cont[ae]iner\s*number/i;

/**
 * Blocs de réception d'une feuille d'entrepôt. Un bloc va d'un marqueur au
 * suivant ; sa date est en tête, son numéro de conteneur dans le corps.
 */
function lireFeuilleReception(classeur, nomFeuille, entrepot) {
  const feuille = classeur.Sheets[nomFeuille];
  if (!feuille || !feuille["!ref"]) return [];
  const plage = XLSX.utils.decode_range(feuille["!ref"]);

  const debuts = [];
  for (let r = plage.s.r; r <= plage.e.r; r++) {
    if (DEBUT_BLOC.test(texte(AA(feuille, r, COL_A)))) debuts.push(r);
  }

  return debuts.map((debut, i) => {
    const fin = i + 1 < debuts.length ? debuts[i + 1] - 1 : plage.e.r;

    const celluleDate = AA(feuille, debut, COL_C);
    const date = dateSimple(valeur(celluleDate));

    let conteneur = null, celluleConteneur = null;
    for (let r = debut + 1; r <= fin; r++) {
      const t = texte(AA(feuille, r, COL_C));
      if (t) {
        conteneur = numeroConteneur(t);
        celluleConteneur = XLSX.utils.encode_cell({ r, c: COL_C });
        break;
      }
    }

    const lignes = [];
    for (let r = debut + 1; r <= fin; r++) {
      const libelle = texte(AA(feuille, r, COL_E));
      const quantite = nombre(AA(feuille, r, COL_I));
      /* Une ligne d'article a un libellé ET une quantité. Les cellules
         d'unité isolées en fin de bloc sont des restes de mise en forme. */
      if (!libelle || quantite === null) continue;
      lignes.push({
        libelle,
        unite: texte(AA(feuille, r, COL_H)) || "EA",
        quantite,
        entrepot,
        provenance: { feuille: nomFeuille, ligne: r + 1,
                      cellule: XLSX.utils.encode_cell({ r, c: COL_E }) },
      });
    }

    return {
      entrepot,
      conteneur,
      date,
      dateBrute: texte(celluleDate),
      lignes,
      provenance: {
        feuille: nomFeuille,
        ligneDebut: debut + 1, ligneFin: fin + 1,
        celluleDate: XLSX.utils.encode_cell({ r: debut, c: COL_C }),
        celluleConteneur,
      },
    };
  });
}

/**
 * Fusion A/C. Un même numéro dans les deux feuilles est UNE réception
 * physique : le conteneur a été dépoté une fois, ses articles rangés dans
 * deux entrepôts. En créer deux inventerait un conteneur.
 */
function fusionnerReceptions(blocs) {
  const parConteneur = new Map();

  for (const bloc of blocs) {
    const cle = bloc.conteneur || `SANS-NUMERO-${bloc.provenance.feuille}-${bloc.provenance.ligneDebut}`;
    if (!parConteneur.has(cle)) {
      parConteneur.set(cle, {
        conteneur: bloc.conteneur, date: bloc.date,
        entrepots: [], lignes: [], blocs: [], anomalies: [],
      });
    }
    const fusion = parConteneur.get(cle);

    /* Deux dates différentes pour un même conteneur : on garde la plus
       ancienne et on le signale, sans choisir en silence. */
    if (fusion.date && bloc.date && fusion.date !== bloc.date) {
      fusion.anomalies.push({
        type: "DATE_CONTENEUR_DIVERGENTE",
        message: `Le conteneur ${cle} porte deux dates : ${fusion.date} et ${bloc.date}.`,
        provenance: bloc.provenance,
      });
      fusion.date = fusion.date < bloc.date ? fusion.date : bloc.date;
    } else if (!fusion.date) {
      fusion.date = bloc.date;
    }

    if (!fusion.entrepots.includes(bloc.entrepot)) fusion.entrepots.push(bloc.entrepot);
    fusion.lignes.push(...bloc.lignes);
    fusion.blocs.push(bloc.provenance);
  }

  return [...parConteneur.values()].map((r) => ({
    ...r,
    entrepots: r.entrepots.sort(),
    fusionne: r.entrepots.length > 1,
    totalLignes: r.lignes.length,
    totalQuantite: r.lignes.reduce((s, l) => s + l.quantite, 0),
    parEntrepot: r.entrepots.map((e) => ({
      entrepot: e,
      lignes: r.lignes.filter((l) => l.entrepot === e).length,
      quantite: r.lignes.filter((l) => l.entrepot === e).reduce((s, l) => s + l.quantite, 0),
    })),
  }));
}

/* ═══════════════════════════════════════════════ LISTE DES STOCK ══ */

const S_DESC = 0, S_ROW = 2, S_LOC = 3, S_LEVEL = 4;
const S_BIN_A = 5, S_BIN_B = 6, S_BIN_C = 7;
const S_QTE = 8, S_UNITE = 9, S_IN = 11, S_OUT = 12, S_NEW = 13, S_DATE = 14;

const BINS = [[S_BIN_A, "BIN1"], [S_BIN_B, "BIN2"], [S_BIN_C, "BIN3"]];

/* Les deux premières lignes de la feuille portent son titre et ses en-têtes ;
   elles ont une « description » mais ne décrivent aucun article. */
const EN_TETES = /^(inventory list|item description)/i;

function lireFeuilleStock(classeur, nomFeuille = "LISTE DES STOCK") {
  const feuille = classeur.Sheets[nomFeuille];
  if (!feuille || !feuille["!ref"]) return { lignes: [], anomalies: [] };
  const plage = XLSX.utils.decode_range(feuille["!ref"]);

  const lignes = [];
  const anomalies = [];

  for (let r = plage.s.r; r <= plage.e.r; r++) {
    const description = texte(AA(feuille, r, S_DESC));
    /* Sans description, ce n'est pas un article : c'est une ligne vide ou le
       TOTAL de bas de feuille — lequel est colorié comme une sortie et
       ajouterait 12 218 unités qui n'existent pas. */
    if (!description) continue;
    if (EN_TETES.test(description)) continue;

    const numeroLigne = r + 1;
    const prov = (col) => ({
      feuille: nomFeuille, ligne: numeroLigne,
      cellule: XLSX.utils.encode_cell({ r, c: col }),
    });

    const rayonBrut = texte(AA(feuille, r, S_ROW));
    const locationBrut = texte(AA(feuille, r, S_LOC));
    const niveauBrut = texte(AA(feuille, r, S_LEVEL));

    const zone = ligneEstZone({ rayon: rayonBrut, location: locationBrut, niveau: niveauBrut });

    const binsCoches = BINS
      .filter(([col]) => texte(AA(feuille, r, col)).toUpperCase() === "X")
      .map(([, nom]) => nom);

    const cellulesIn = AA(feuille, r, S_IN);
    const cellulesOut = AA(feuille, r, S_OUT);
    const celluleDate = AA(feuille, r, S_DATE);

    const mouvements = [];
    for (const [cellule, col, sens] of [[cellulesIn, S_IN, "Entrée"], [cellulesOut, S_OUT, "Sortie"]]) {
      const q = nombre(cellule);
      if (q === null || q === 0) continue;
      const rgb = remplissage(cellule);
      const regle = rgb ? COULEURS[rgb] : null;
      mouvements.push({
        sens, quantite: q, couleur: rgb,
        classe: regle ? regle.cle : "SANS_COULEUR",
        nouveau: regle ? regle.nouveau : false,
        libelleCouleur: regle ? regle.libelle : "sans couleur métier",
        provenance: prov(col),
      });
    }

    const dateUnique = dateSimple(valeur(celluleDate));
    const plusieursDates = datesMultiples(valeur(celluleDate));

    const stockInitial = nombre(AA(feuille, r, S_QTE));
    const entrees = nombre(cellulesIn) ?? 0;
    const sorties = nombre(cellulesOut) ?? 0;
    const nouveauStock = nombre(AA(feuille, r, S_NEW));

    const ligne = {
      description,
      rayon: compacter(rayonBrut) || null,
      rayonBrut,
      location: compacter(locationBrut) || null,
      locationBrut,
      niveau: zone ? null : niveauNormalise(niveauBrut),
      niveauBrut,
      zoneSansRack: zone,
      /* Une zone au sol n'a ni niveau ni bac : le stock y est localisé au
         niveau de la zone elle-même. */
      bins: zone ? [] : binsCoches,
      stockInitial, entrees, sorties, nouveauStock,
      unite: texte(AA(feuille, r, S_UNITE)) || "EACH",
      dateUnique, datesProposees: plusieursDates,
      dateBrute: texte(celluleDate),
      mouvements,
      provenance: prov(S_DESC),
      anomalies: [],
    };

    /* ── Anomalies bloquantes ─────────────────────────────────────── */

    if (!zone && binsCoches.length > 1) {
      ligne.anomalies.push({
        type: "MULTI_BIN",
        message: "À compléter — répartition exacte par bin requise",
        bins: binsCoches,
        quantiteAttendue: nouveauStock ?? stockInitial,
        provenance: prov(S_BIN_A),
      });
    }

    if (plusieursDates) {
      ligne.anomalies.push({
        type: "DATES_MULTIPLES",
        message: "À compléter — quantité exacte pour chaque date requise",
        dates: plusieursDates,
        provenance: prov(S_DATE),
      });
    }

    if ([stockInitial, entrees, sorties, nouveauStock].every((v) => typeof v === "number")) {
      const attendu = stockInitial + entrees - sorties;
      if (attendu !== nouveauStock) {
        ligne.anomalies.push({
          type: "NEW_STOCK_INCOHERENT",
          message: `Incohérent : ${stockInitial} + ${entrees} − ${sorties} = ${attendu}, `
                 + `mais « new stock » affiche ${nouveauStock}.`,
          attendu, affiche: nouveauStock,
          provenance: prov(S_NEW),
        });
      }
    }

    if (!zone && niveauBrut && ligne.niveau === null) {
      ligne.anomalies.push({
        type: "NIVEAU_INCONNU",
        message: `« ${niveauBrut} » n'est pas un niveau reconnu (1, 2, 3, 4, TOP).`,
        provenance: prov(S_LEVEL),
      });
    }

    anomalies.push(...ligne.anomalies.map((a) => ({ ...a, ligne: numeroLigne, description })));
    lignes.push(ligne);
  }

  return { lignes, anomalies };
}

/* ═══════════════════════════════════════════════════════ SYNTHÈSE ══ */

function totauxCouleurs(lignes) {
  const out = {};
  for (const cle of Object.values(COULEURS).map((c) => c.cle).concat("SANS_COULEUR")) {
    out[cle] = { lignes: 0, quantite: 0 };
  }
  for (const l of lignes) {
    for (const m of l.mouvements) {
      out[m.classe].lignes += 1;
      out[m.classe].quantite += m.quantite;
    }
  }
  return out;
}

/**
 * Lecture complète. `buffer` est le contenu du fichier ; l'empreinte est
 * calculée ici et accompagne chaque donnée produite, pour qu'on sache
 * toujours de quelle version du classeur vient une ligne.
 */
function lireClasseur(buffer, { nomFichier = "classeur.xlsx" } = {}) {
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  /* `cellDates` est volontairement désactivé : on veut les numéros de série
     bruts, que `dateSimple` convertit sans passer par le fuseau de la machine. */
  const classeur = XLSX.read(buffer, { cellStyles: true, cellDates: false, type: "buffer" });

  const blocsA = lireFeuilleReception(classeur, "W-EM2S-A", "A");
  const blocsC = lireFeuilleReception(classeur, "W-EM2S-C", "C");
  const receptions = fusionnerReceptions([...blocsA, ...blocsC]);

  const stock = lireFeuilleStock(classeur);

  return {
    fichier: { nom: nomFichier, sha256, taille: buffer.length },
    feuilles: classeur.SheetNames,
    receptions: {
      blocs: { A: blocsA.length, C: blocsC.length, total: blocsA.length + blocsC.length },
      physiques: receptions.length,
      fusionnees: receptions.filter((r) => r.fusionne).length,
      liste: receptions,
    },
    stock: {
      lignes: stock.lignes,
      totalLignes: stock.lignes.length,
      couleurs: totauxCouleurs(stock.lignes),
      anomalies: stock.anomalies,
    },
    provenanceRacine: `${nomFichier} + ${sha256}`,
  };
}

module.exports = {
  COULEURS, ZONES_SANS_RACK, NIVEAUX_VALIDES,
  remplissage, compacter, estZoneSansRack, ligneEstZone, niveauNormalise,
  numeroConteneur, dateSimple, datesMultiples,
  lireFeuilleReception, fusionnerReceptions, lireFeuilleStock,
  totauxCouleurs, lireClasseur,
};
