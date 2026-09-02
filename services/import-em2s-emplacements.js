"use strict";

/**
 * CRÉER LA HIÉRARCHIE D'EMPLACEMENTS DÉCRITE PAR LE CLASSEUR.
 *
 * `Entreprise → Entrepôt → Rayon → Location → Niveau → Bin`
 *
 * Trois règles, et une seule raison derrière chacune :
 *
 *   — On ne crée QUE ce que le fichier nomme. Fabriquer un « Level 4 » partout
 *     parce qu'il existe quelque part remplirait l'entrepôt d'étagères qui
 *     n'existent pas, et les inventaires les chercheraient.
 *
 *   — On ne supprime, ne renomme ni n'archive jamais un emplacement existant.
 *     Un identifiant d'emplacement est cité par des balances, des mouvements et
 *     des étiquettes collées sur des racks : le changer casse tout cela d'un
 *     coup. Les écarts se signalent, ils ne se corrigent pas d'office.
 *
 *   — Une zone au sol n'a ni niveau ni bac. « R&I » en colonne NIVEAU est une
 *     erreur de saisie du classeur, pas un étage : en faire un niveau créerait
 *     un « Level R&I » que personne ne retrouverait sur le terrain.
 *
 * Le rayon « I » reste un rayon de rack ordinaire quand la ligne porte un vrai
 * niveau : les allées vont de A à X, et I1/I2/I3 en niveau TOP sont des
 * emplacements rackés comme les autres.
 */

const H = require("./location-hierarchy");
const P = require("./import-em2s");

/* ─────────────────────────────────────────────────── description ── */

/**
 * Ce qu'une ligne du classeur décrit comme emplacement.
 *
 * Une ligne à plusieurs bacs décrit plusieurs emplacements : chaque bac coché
 * est un contenant réel, même si l'on ignore encore combien d'unités il porte.
 * C'est bien la structure qu'on crée ici, pas le stock.
 */
function emplacementsDeLaLigne(ligne, entrepotParDefaut) {
  const entrepot = entrepotParDefaut || "A";

  if (ligne.zoneSansRack) {
    /* La zone se nomme par son code, sans niveau ni bac. On garde la valeur
       brute du classeur comme alias : « PICKING  AREA », avec ses deux
       espaces, doit continuer de retrouver son emplacement. */
    const code = ligne.location || ligne.rayon;
    if (!code) return [];
    return [{
      type: "ZONE",
      entrepot, rayon: code, location: code, niveau: null, bin: null,
      alias: [ligne.rayonBrut, ligne.locationBrut, ligne.niveauBrut]
        .filter((v) => v && v !== code),
      description: ligne.description,
      provenance: ligne.provenance,
    }];
  }

  if (!ligne.rayon || !ligne.location) return [];

  /* Un rack sans niveau reconnu n'est pas un rack qu'on sait construire :
     on le signale plutôt que d'inventer un étage. */
  if (!ligne.niveau) {
    return [{
      type: "INVALIDE",
      entrepot, rayon: ligne.rayon, location: ligne.location,
      niveau: null, bin: null,
      motif: ligne.niveauBrut
        ? `« ${ligne.niveauBrut} » n'est pas un niveau reconnu (1, 2, 3, 4, Top).`
        : "Niveau absent : impossible de placer ce bac dans l'étagère.",
      description: ligne.description,
      provenance: ligne.provenance,
    }];
  }

  const bins = ligne.bins.length ? ligne.bins : [null];
  return bins.map((bin) => ({
    type: "RACK",
    entrepot, rayon: ligne.rayon, location: ligne.location,
    niveau: ligne.niveau, bin,
    alias: [], description: ligne.description, provenance: ligne.provenance,
  }));
}

const codeComplet = (e) => H.composeFullCode({
  warehouse: e.entrepot, row: e.rayon, shelf: e.location,
  level: e.niveau, bin: e.bin,
});

const codeEmplacement = (e) => H.composeEmplacementCode({
  warehouse: e.entrepot, row: e.rayon, shelf: e.location, level: e.niveau,
});

/* ═══════════════════════════════════════════════ PRÉVISUALISATION ══ */

/**
 * Ce que la création produirait, sans rien écrire.
 *
 * Chaque emplacement décrit par le classeur est rapproché de ce qui existe
 * déjà, par son code complet. Quatre états seulement, et aucun « à peu près » :
 * déjà présent, à créer, ambigu (le code désigne plusieurs lignes en base),
 * invalide (le classeur ne dit pas assez pour construire l'emplacement).
 */
async function analyser(client, { companyId, lecture, entrepotParDefaut = "A" }) {
  const decrits = new Map();

  for (const ligne of lecture.stock.lignes) {
    for (const e of emplacementsDeLaLigne(ligne, entrepotParDefaut)) {
      const cle = e.type === "INVALIDE"
        ? `INVALIDE|${e.rayon}|${e.location}|${e.provenance.ligne}`
        : codeComplet(e);
      if (!decrits.has(cle)) {
        decrits.set(cle, { ...e, code: cle, produits: new Set(), lignes: [] });
      }
      const d = decrits.get(cle);
      d.produits.add(e.description);
      d.lignes.push(e.provenance.ligne);
      for (const a of e.alias || []) if (!d.alias.includes(a)) d.alias.push(a);
    }
  }

  const codes = [...decrits.values()]
    .filter((d) => d.type !== "INVALIDE").map((d) => d.code.toUpperCase());

  const existants = new Map();
  if (codes.length) {
    const { rows } = await client.query(
      `SELECT id, UPPER(COALESCE(NULLIF(full_code,''), emplacement_code, '')) AS code,
              full_code, is_active
         FROM locations
        WHERE company_id = $1
          AND UPPER(COALESCE(NULLIF(full_code,''), emplacement_code, '')) = ANY($2::text[])`,
      [companyId, codes]
    );
    for (const r of rows) {
      if (!existants.has(r.code)) existants.set(r.code, []);
      existants.get(r.code).push(r);
    }
  }

  const liste = [...decrits.values()].map((d) => {
    const trouves = existants.get(d.code.toUpperCase()) || [];
    const statut = d.type === "INVALIDE" ? "INVALIDE"
      : trouves.length === 1 ? "EXISTANT"
      : trouves.length > 1 ? "AMBIGU"
      : "A_CREER";
    return {
      code: d.code, type: d.type, statut,
      entrepot: d.entrepot, rayon: d.rayon, location: d.location,
      niveau: d.niveau, bin: d.bin,
      alias: d.alias || [], motif: d.motif || null,
      nbProduits: d.produits.size,
      lignesExcel: [...new Set(d.lignes)].sort((a, b) => a - b),
      emplacementExistant: trouves[0]
        ? { id: trouves[0].id, fullCode: trouves[0].full_code, actif: trouves[0].is_active }
        : null,
      candidats: trouves.length > 1 ? trouves.map((t) => ({ id: t.id, fullCode: t.full_code })) : [],
    };
  });

  const compter = (s) => liste.filter((l) => l.statut === s).length;
  const uniques = (champ) => new Set(
    liste.filter((l) => l.statut !== "INVALIDE" && l[champ]).map((l) => l[champ])).size;

  return {
    total: liste.length,
    existants: compter("EXISTANT"),
    aCreer: compter("A_CREER"),
    ambigus: compter("AMBIGU"),
    invalides: compter("INVALIDE"),
    zones: liste.filter((l) => l.type === "ZONE").length,
    racks: liste.filter((l) => l.type === "RACK").length,
    structure: {
      entrepots: uniques("entrepot"), rayons: uniques("rayon"),
      locations: uniques("location"), niveaux: uniques("niveau"),
      bins: uniques("bin"),
    },
    liste,
  };
}

/* ═══════════════════════════════════════════════════ CRÉATION ══ */

/**
 * Crée les emplacements manquants. Rien d'autre.
 *
 * Ni suppression, ni renommage, ni archivage : un emplacement existant est
 * laissé exactement tel qu'il est, avec son identifiant, parce que des
 * balances, des mouvements et des étiquettes le citent.
 *
 * `client` est déjà dans une transaction ouverte par l'appelant.
 */
async function creer(client, { companyId, analyse, utilisateur }) {
  const rapport = {
    crees: 0, dejaPresents: 0, ambigus: 0, invalides: 0, details: [],
  };

  for (const e of analyse.liste) {
    if (e.statut === "EXISTANT") { rapport.dejaPresents += 1; continue; }
    if (e.statut === "AMBIGU") {
      rapport.ambigus += 1;
      rapport.details.push({ code: e.code, etat: "ambigu",
        candidats: e.candidats, note: "Ce code désigne déjà plusieurs emplacements : à trancher à la main." });
      continue;
    }
    if (e.statut === "INVALIDE") {
      rapport.invalides += 1;
      rapport.details.push({ code: e.code, etat: "invalide", motif: e.motif,
        lignesExcel: e.lignesExcel });
      continue;
    }

    /* `ON CONFLICT DO NOTHING` sur l'index d'unicité du code complet : c'est
       la base qui refuse le doublon, pas une lecture préalable que deux
       requêtes simultanées pourraient doubler.

       Le prédicat est répété parce que l'index est partiel : sans lui,
       PostgreSQL ne sait pas à quel index se raccrocher. On l'écrit ici plutôt
       que de refaire un index déjà en service en production. */
    const { rows } = await client.query(
      `INSERT INTO locations
         (company_id, warehouse_code, rayon_code, case_code, level_code, bin_code,
          full_code, emplacement_code, level_rank, bin_rank, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
       ON CONFLICT (company_id, full_code)
         WHERE full_code IS NOT NULL AND full_code <> ''
         DO NOTHING
       RETURNING id, full_code`,
      [companyId, e.entrepot, e.rayon, e.location, e.niveau, e.bin,
       e.code, codeEmplacement(e),
       e.niveau ? H.levelRank(e.niveau) : null,
       e.bin ? H.binRank(e.bin) : null]
    );

    if (rows.length === 0) {
      /* Créé entre-temps par quelqu'un d'autre : c'est exactement ce que
         l'idempotence doit absorber sans bruit. */
      rapport.dejaPresents += 1;
      continue;
    }

    rapport.crees += 1;
    rapport.details.push({
      code: rows[0].full_code, etat: "créé", id: rows[0].id,
      type: e.type, niveau: e.niveau, bin: e.bin, nbProduits: e.nbProduits,
    });

    /* Les écritures anciennes citent parfois « PICKING  AREA » avec ses deux
       espaces. L'alias les fait retomber sur le bon emplacement sans qu'on
       ait touché à leur libellé. */
    for (const alias of e.alias || []) {
      await client.query(
        `UPDATE locations SET previous_full_code = COALESCE(previous_full_code, $1)
          WHERE id = $2 AND company_id = $3`,
        [alias, rows[0].id, companyId]
      ).catch(() => {});
    }
  }

  return rapport;
}

module.exports = { emplacementsDeLaLigne, codeComplet, codeEmplacement, analyser, creer };
