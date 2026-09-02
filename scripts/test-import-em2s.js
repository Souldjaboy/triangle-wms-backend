"use strict";

/**
 * LECTURE DU CLASSEUR EM2S — tests du parseur.
 *
 * Ils tournent sur un classeur fabriqué par `scripts/fixture-em2s.js`, jamais
 * sur le fichier du client : celui-ci porte des données réelles et n'a pas sa
 * place dans le dépôt. La fixture reproduit ce qui compte — les trois
 * orthographes du marqueur, la date en numéro de série, la fusion A/C, les
 * quatre couleurs, la ligne TOTAL, les anomalies bloquantes.
 *
 *   node scripts/test-import-em2s.js
 *
 * Avec le vrai classeur sous la main, on peut en plus vérifier les totaux
 * attendus du fichier de référence :
 *
 *   CLASSEUR_REEL=/chemin/fichier.xlsx node scripts/test-import-em2s.js
 */

const fs = require("fs");
const P = require("../services/import-em2s");
const fixture = require("./fixture-em2s");

let reussis = 0, echoues = 0;
const verifier = (nom, ok, detail = "") => {
  if (ok) { reussis += 1; console.log(`  ✓ ${nom}`); }
  else { echoues += 1; console.log(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`); }
};

/* Empreinte du classeur de référence, telle qu'elle a été validée. Si le
   fichier change, les totaux ci-dessous ne valent plus rien : mieux vaut le
   dire que de comparer à des nombres périmés. */
const SHA_REFERENCE = "f0decaa2f85c36a31e93d48437b02ca1b920c8a698d9b849725d9992444ce368";
const REFERENCE = {
  feuilles: 9,
  blocsA: 11, blocsC: 4, physiques: 12, fusionnees: 3,
  lignesStock: 391,
  NOUVELLE_ENTREE: { lignes: 44, quantite: 2111 },
  NOUVELLE_SORTIE: { lignes: 21, quantite: 739 },
  ANCIENNE_ENTREE: { lignes: 25, quantite: 2048 },
  ANCIENNE_SORTIE: { lignes: 32, quantite: 11465 },
  MULTI_BIN: 165, DATES_MULTIPLES: 6, NEW_STOCK_INCOHERENT: 1,
};

function main() {
  console.log("\n▸ NORMALISATION DES NUMÉROS DE CONTENEUR");
  {
    const cas = [
      ["MSNU: 5745901/ 6", "MSNU 5745901/6"],
      ["MRKU:559131/ 6", "MRKU 559131/6"],
      ["TCKU 632071 /7", "TCKU 632071/7"],
      ["ECMU 710881/7", "ECMU 710881/7"],
      ["  temu 824100/0  ", "TEMU 824100/0"],
    ];
    for (const [brut, attendu] of cas) {
      verifier(`« ${brut.trim()} » → ${attendu}`,
        P.numeroConteneur(brut) === attendu, `obtenu « ${P.numeroConteneur(brut)} »`);
    }
  }

  console.log("\n▸ DATES");
  {
    verifier("une date texte se lit", P.dateSimple("DATE: 22/6/2026") === "2026-06-22",
      P.dateSimple("DATE: 22/6/2026"));
    /* 46247 = 13/08/2026. Le passage par un `Date` JavaScript reculerait d'un
       jour à l'ouest de Greenwich : c'est exactement le piège du conteneur
       CAIU 993644/0. */
    verifier("un numéro de série Excel se lit sans décalage de fuseau",
      P.dateSimple(46247) === "2026-08-13", P.dateSimple(46247));
    verifier("« 19.21.25/08/2026 » propose trois dates",
      JSON.stringify(P.datesMultiples("19.21.25/08/2026"))
        === JSON.stringify(["2026-08-19", "2026-08-21", "2026-08-25"]),
      JSON.stringify(P.datesMultiples("19.21.25/08/2026")));
    verifier("« 9,25,27/07/2026 » aussi, malgré l'autre séparateur",
      (P.datesMultiples("9,25,27/07/2026") || []).length === 3);
    verifier("une date simple n'est pas prise pour une date multiple",
      P.datesMultiples("22/06/2026") === null);
  }

  console.log("\n▸ NIVEAUX ET ZONES SANS RACK");
  {
    verifier("« TOP » et « top  » donnent le même niveau",
      P.niveauNormalise("TOP") === "TOP" && P.niveauNormalise("top  ") === "TOP");
    verifier("« Level 4 » se lit comme le niveau 4", P.niveauNormalise("Level 4") === "4");
    verifier("« 5 » n'est pas un niveau valable", P.niveauNormalise("5") === null);
    for (const z of ["R&I", "ALLE 3M", "PICKING  AREA", "I"]) {
      verifier(`« ${z} » en colonne LEVEL fait une zone au sol`,
        P.ligneEstZone({ rayon: "X", location: "X1", niveau: z }) === true);
      verifier(`« ${z} » ne devient jamais un niveau`, P.niveauNormalise(z) === null);
    }
    /* Le rayon « I » existe vraiment : les allées vont de A à X. Une ligne
       I1/TOP est un emplacement racké, pas un stockage au sol. */
    verifier("le rayon « I » avec un vrai niveau reste un emplacement racké",
      P.ligneEstZone({ rayon: "I", location: "I1", niveau: "TOP" }) === false);
    verifier("« PICKING  AREA » se compacte en « PICKING AREA »",
      P.compacter("PICKING  AREA") === "PICKING AREA");
  }

  console.log("\n▸ CLASSEUR D'ESSAI");
  const chemin = "/tmp/fixture-em2s-test.xlsx";
  fs.writeFileSync(chemin, fixture.construire());
  const r = P.lireClasseur(fs.readFileSync(chemin), { nomFichier: "fixture-em2s.xlsx" });
  {
    verifier("les neuf feuilles sont lues", r.feuilles.length === 9, `${r.feuilles.length}`);
    verifier("une empreinte accompagne la lecture", /^[0-9a-f]{64}$/.test(r.fichier.sha256));
    verifier("la provenance cite le fichier et son empreinte",
      r.provenanceRacine.includes("fixture-em2s.xlsx") && r.provenanceRacine.includes(r.fichier.sha256));
  }

  console.log("\n▸ BLOCS DE RÉCEPTION");
  {
    verifier("les trois orthographes du marqueur sont reconnues",
      r.receptions.blocs.A === 3, `${r.receptions.blocs.A} blocs en A`);
    verifier("les blocs de la feuille C sont lus aussi",
      r.receptions.blocs.C === 2, `${r.receptions.blocs.C}`);
    verifier("un conteneur présent en A et en C ne fait qu'une réception",
      r.receptions.physiques === 3, `${r.receptions.physiques}`);
    verifier("deux réceptions sont marquées fusionnées",
      r.receptions.fusionnees === 2, `${r.receptions.fusionnees}`);

    const msnu = r.receptions.liste.find((c) => c.conteneur === "MSNU 5745901/6");
    verifier("la réception fusionnée porte ses deux entrepôts",
      msnu && msnu.entrepots.join("+") === "A+C", JSON.stringify(msnu && msnu.entrepots));
    verifier("chaque ligne garde son entrepôt d'origine",
      msnu && msnu.lignes.filter((l) => l.entrepot === "A").length === 3
           && msnu.lignes.filter((l) => l.entrepot === "C").length === 1,
      JSON.stringify(msnu && msnu.parEntrepot));
    verifier("le total du conteneur additionne les deux entrepôts",
      msnu && msnu.totalQuantite === 214, `${msnu && msnu.totalQuantite}`);

    const caiu = r.receptions.liste.find((c) => c.conteneur === "CAIU 993644/0");
    verifier("une date en numéro de série donne le bon jour",
      caiu && caiu.date === "2026-08-13", `${caiu && caiu.date}`);

    const cellulesUnite = r.receptions.liste
      .flatMap((c) => c.lignes).filter((l) => !l.libelle || l.quantite === null);
    verifier("les cellules d'unité isolées ne deviennent pas des articles",
      cellulesUnite.length === 0, `${cellulesUnite.length}`);
  }

  console.log("\n▸ COULEURS MÉTIER");
  {
    const c = r.stock.couleurs;
    verifier("les nouvelles entrées jaune-or sont isolées",
      c.NOUVELLE_ENTREE.lignes === 4 && c.NOUVELLE_ENTREE.quantite === 79,
      JSON.stringify(c.NOUVELLE_ENTREE));
    verifier("les nouvelles sorties rouge foncé sont isolées",
      c.NOUVELLE_SORTIE.lignes === 3 && c.NOUVELLE_SORTIE.quantite === 107,
      JSON.stringify(c.NOUVELLE_SORTIE));
    verifier("l'ancien jaune reste à part et ne sera pas rejoué",
      c.ANCIENNE_ENTREE.lignes === 1 && c.ANCIENNE_ENTREE.quantite === 5,
      JSON.stringify(c.ANCIENNE_ENTREE));
    verifier("l'ancien rouge reste à part lui aussi",
      c.ANCIENNE_SORTIE.lignes === 1 && c.ANCIENNE_SORTIE.quantite === 3,
      JSON.stringify(c.ANCIENNE_SORTIE));
    verifier("aucun mouvement nouveau n'est confondu avec un ancien",
      c.NOUVELLE_ENTREE.quantite !== c.ANCIENNE_ENTREE.quantite);
  }

  console.log("\n▸ LA LIGNE TOTAL N'EST PAS UN MOUVEMENT");
  {
    const totalDansLesLignes = r.stock.lignes.some((l) => /^total$/i.test(l.description));
    verifier("la ligne TOTAL n'entre pas dans les articles", !totalDansLesLignes);
    verifier("son montant n'est pas compté en sortie",
      r.stock.couleurs.NOUVELLE_SORTIE.quantite === 107,
      `${r.stock.couleurs.NOUVELLE_SORTIE.quantite}`);
    verifier("les en-têtes de feuille ne sont pas des articles",
      !r.stock.lignes.some((l) => /inventory list|item description/i.test(l.description)));
  }

  console.log("\n▸ ANOMALIES BLOQUANTES");
  {
    const par = (t) => r.stock.anomalies.filter((a) => a.type === t);
    verifier("chaque ligne à plusieurs bacs est bloquée",
      par("MULTI_BIN").length === 3, `${par("MULTI_BIN").length}`);
    verifier("le message de blocage est celui convenu",
      par("MULTI_BIN")[0].message === "À compléter — répartition exacte par bin requise");
    verifier("la ligne à dates multiples est bloquée",
      par("DATES_MULTIPLES").length === 1);
    verifier("aucune quantité n'est répartie entre les dates",
      par("DATES_MULTIPLES")[0].dates.length === 3
        && par("DATES_MULTIPLES")[0].quantites === undefined);
    verifier("la ligne incohérente est bloquée",
      par("NEW_STOCK_INCOHERENT").length === 1);
    verifier("l'anomalie dit le calcul attendu sans corriger la feuille",
      par("NEW_STOCK_INCOHERENT")[0].attendu === 800
        && par("NEW_STOCK_INCOHERENT")[0].affiche === 880,
      JSON.stringify(par("NEW_STOCK_INCOHERENT")[0]));

    const l167 = r.stock.lignes.find((l) => l.provenance.ligne === 167);
    verifier("la ligne 167 garde ses deux bacs sans rien répartir",
      l167.bins.join(",") === "BIN1,BIN2" && l167.anomalies.some((a) => a.type === "MULTI_BIN"));
    verifier("la quantité attendue de la répartition est le stock final",
      l167.anomalies.find((a) => a.type === "MULTI_BIN").quantiteAttendue === 54);

    const l400 = r.stock.lignes.find((l) => l.provenance.ligne === 400);
    verifier("une ligne à un seul bac n'est pas bloquée",
      l400 && l400.bins.length === 1 && l400.anomalies.length === 0,
      JSON.stringify(l400 && l400.anomalies.map((a) => a.type)));
  }

  console.log("\n▸ ZONES SANS RACK");
  {
    const zones = r.stock.lignes.filter((l) => l.zoneSansRack);
    verifier("les zones au sol sont reconnues", zones.length === 2, `${zones.length}`);
    verifier("elles n'ont ni niveau ni bac",
      zones.every((z) => z.niveau === null && z.bins.length === 0));
    verifier("leur stock reste localisé dans la zone",
      zones.every((z) => z.rayon && z.location));
    verifier("« PICKING  AREA » est normalisé sans perdre la valeur d'origine",
      zones.some((z) => z.rayon === "PICKING AREA" && z.rayonBrut.includes("  ")));
    const l131 = r.stock.lignes.find((l) => l.provenance.ligne === 131);
    verifier("l'allée I avec niveau TOP n'est pas confondue avec une zone",
      l131 && !l131.zoneSansRack && l131.niveau === "TOP" && l131.bins.length === 2);
  }

  console.log("\n▸ PROVENANCE");
  {
    verifier("chaque ligne de stock cite sa feuille et sa cellule",
      r.stock.lignes.every((l) => l.provenance.feuille && l.provenance.ligne && l.provenance.cellule));
    verifier("chaque mouvement cite la cellule qui porte sa couleur",
      r.stock.lignes.flatMap((l) => l.mouvements).every((m) => m.provenance.cellule));
    verifier("chaque réception cite ses lignes de début et de fin",
      r.receptions.liste.every((c) => c.blocs.every((b) => b.ligneDebut && b.ligneFin)));
  }

  /* ── Le vrai classeur, quand il est là ──────────────────────────── */
  const reel = process.env.CLASSEUR_REEL;
  if (reel && fs.existsSync(reel)) {
    console.log("\n▸ CLASSEUR DE RÉFÉRENCE");
    const v = P.lireClasseur(fs.readFileSync(reel), { nomFichier: require("path").basename(reel) });
    if (v.fichier.sha256 !== SHA_REFERENCE) {
      console.log(`  ⚠ empreinte différente de la référence : ${v.fichier.sha256}`);
      console.log("    Les totaux attendus ne s'appliquent pas à cette version.");
      echoues += 1;
    } else {
      verifier("neuf feuilles", v.feuilles.length === REFERENCE.feuilles);
      verifier("11 blocs en A et 4 en C",
        v.receptions.blocs.A === REFERENCE.blocsA && v.receptions.blocs.C === REFERENCE.blocsC,
        `${v.receptions.blocs.A}/${v.receptions.blocs.C}`);
      verifier("12 réceptions physiques après fusion",
        v.receptions.physiques === REFERENCE.physiques, `${v.receptions.physiques}`);
      verifier("trois conteneurs fusionnés A/C",
        v.receptions.fusionnees === REFERENCE.fusionnees, `${v.receptions.fusionnees}`);
      verifier("391 lignes d'articles", v.stock.totalLignes === REFERENCE.lignesStock,
        `${v.stock.totalLignes}`);
      for (const cle of ["NOUVELLE_ENTREE", "NOUVELLE_SORTIE", "ANCIENNE_ENTREE", "ANCIENNE_SORTIE"]) {
        const att = REFERENCE[cle], obt = v.stock.couleurs[cle];
        verifier(`${cle} : ${att.lignes} lignes, ${att.quantite} unités`,
          obt.lignes === att.lignes && obt.quantite === att.quantite, JSON.stringify(obt));
      }
      for (const t of ["MULTI_BIN", "DATES_MULTIPLES", "NEW_STOCK_INCOHERENT"]) {
        const n = v.stock.anomalies.filter((a) => a.type === t).length;
        verifier(`${t} : ${REFERENCE[t]}`, n === REFERENCE[t], `${n}`);
      }
      const caiu = v.receptions.liste.find((c) => c.conteneur === "CAIU 993644/0");
      verifier("CAIU 993644/0 reçu le 13/08/2026", caiu && caiu.date === "2026-08-13",
        `${caiu && caiu.date}`);
    }
  } else {
    console.log("\n▸ CLASSEUR DE RÉFÉRENCE — absent, contrôles ignorés");
    console.log("    (CLASSEUR_REEL=/chemin/fichier.xlsx pour les activer)");
  }

  console.log(`\n${reussis} réussis, ${echoues} échoués`);
  process.exit(echoues === 0 ? 0 : 1);
}

main();
