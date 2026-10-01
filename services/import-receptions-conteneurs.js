"use strict";

/**
 * IMPORT DES RÉCEPTIONS DE CONTENEURS — PLANIFIER, PUIS APPLIQUER.
 *
 * Ce module ne remplace rien. Il s'appuie sur ce qui existe déjà :
 *
 *   • `services/import-em2s.js`     lit le classeur (deux dispositions) ;
 *   • `services/import-em2s-db.js`  clés d'idempotence, index des produits ;
 *   • `services/receptions.js`      crée les réceptions et leurs lignes ;
 *   • `stock_import_operations`     refuse le doublon AU NIVEAU DE LA BASE ;
 *   • `stock_import_anomalies`      endroit où une donnée ambiguë attend ;
 *   • `product_import_aliases`      décision humaine mémorisée, pour les articles ;
 *   • `warehouse_import_aliases`    la même chose pour les entrepôts (migration 102).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DEUX GESTES, JAMAIS UN SEUL
 *
 * `planifier()` LIT et ne décide rien d'irréversible : aucune écriture, pas une.
 * `appliquer()` écrit, et seulement ce que le plan a nommé. Le second refuse de
 * travailler si l'état de la base a changé depuis le premier — une réception
 * qu'on a rangée entre-temps ne se complète pas à l'aveugle.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IMPORTER N'EST PAS METTRE EN STOCK
 *
 * `impactStock` vaut 0, toujours, par construction : ce module n'appelle jamais
 * `stockOps`, ne touche ni `products.stock`, ni `stock_movements`, ni
 * `stock_putaways`. Le stock ne bouge qu'à la mise en stock, ligne par ligne,
 * avec un produit confirmé par une personne.
 */

const crypto = require("crypto");
const P = require("./import-em2s");
const DB = require("./import-em2s-db");
const R = require("./receptions");

/* Les états d'une réception du classeur face à la base. */
const ETAT = {
  ABSENTE: "ABSENTE",
  IDENTIQUE: "IDENTIQUE",
  INCOMPLETE: "INCOMPLETE",
  DIVERGENTE: "DIVERGENTE",
  AMBIGUE: "AMBIGUE",
  BLOQUEE: "BLOQUEE",
};
/* Les décisions possibles sur un libellé d'article. */
const DECISION = {
  EXACT: "EXACT",
  PROBABLE: "PROBABLE À CONFIRMER",
  AMBIGU: "AMBIGU",
  A_CREER: "PRODUIT À CRÉER",
  BLOQUE: "BLOQUÉ",
};

const norm = (v) => DB.normaliserLibelle(v);
/* Les nombres d'un libellé : « 1800 LEDGER » et « 1000 LEDGER » sont deux
   articles, pas deux orthographes. Cette seule différence suffit à refuser un
   rapprochement, quelle que soit la ressemblance du reste. */
const chiffres = (v) => (String(v || "").match(/\d+/g) || []).sort().join(",");

function proximite(a, b) {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/* Les écarts d'orthographe qui ne suffisent JAMAIS à décider. Un mot de cette
   liste change de forme sans qu'on sache si l'article change : « BEARD » et
   « BOARD » diffèrent d'une lettre et désignent peut-être deux pièces. */
const VARIANTES_SENSIBLES = [
  ["STANDARD", "STANDART"], ["AJUSTABLE", "ADJUSTABLE"], ["ADJUSTTABLE", "ADJUSTABLE"],
  ["FORKHEAD", "FORHEAD"], ["LEDGE", "LEDGER"], ["BEARD", "BOARD"],
];
const sensible = (a, b) => VARIANTES_SENSIBLES.some(([x, y]) =>
  (a.includes(x) && b.includes(y)) || (a.includes(y) && b.includes(x)));

/* ══════════════════════════════════════════════════════════════════════════
   LES ENTREPÔTS — RÉSOLUS, JAMAIS CRÉÉS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Pour chaque feuille du plan, l'entrepôt réel. Aucune création : un code
 * introuvable produit une anomalie ENTREPOT_INCONNU, avec les candidats
 * proches, et la feuille entière est écartée de l'import.
 */
async function resoudreEntrepots(client, { companyId, plan }) {
  const resultat = {};
  for (const [feuille, code] of Object.entries(plan)) {
    try {
      const { warehouse, source, alias } = await R.ensureWarehouse(
        client, companyId, code, null, { createIfMissing: false });
      resultat[feuille] = {
        ok: true, code: warehouse.code, id: warehouse.id, nom: warehouse.name,
        site: warehouse.location || null, statut: warehouse.status, source, alias: alias || null,
      };
    } catch (e) {
      resultat[feuille] = {
        ok: false, demande: code, code: null, id: null,
        erreur: e.message, codeErreur: e.code || "WAREHOUSE_NOT_FOUND",
        candidats: (e.details && e.details.candidats) || [],
      };
    }
  }
  return resultat;
}

/* ══════════════════════════════════════════════════════════════════════════
   LES ARTICLES — PROPOSER AVEC DES PREUVES, NE JAMAIS APPLIQUER
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * La décision sur un libellé, et ce qui la justifie.
 *
 * `trouverProduit` du module EM2S ne connaît que trois degrés — alias confirmé,
 * nom identique, rien — et c'est une qualité : il ne rapproche jamais « à peu
 * près ». On garde cette rigueur et on ajoute, À CÔTÉ, une PROPOSITION motivée
 * pour les libellés qu'il laisse sans produit. La proposition ne s'applique pas
 * toute seule : elle attend qu'une personne pose un alias.
 */
function deciderProduit(index, produits, libelle, unites, historique) {
  const k = norm(libelle);
  const trouve = DB.trouverProduit(index, libelle);

  if (trouve.statut === "ALIAS") {
    return { decision: DECISION.EXACT, produit: trouve.produit, confiance: 1,
             preuves: ["alias confirmé par une personne"] };
  }
  if (trouve.statut === "NOM_EXACT") {
    return { decision: DECISION.EXACT, produit: trouve.produit, confiance: 1,
             preuves: ["désignation identique une fois normalisée"] };
  }
  if (trouve.statut === "AMBIGU") {
    return { decision: DECISION.AMBIGU, produit: null, confiance: 1,
             candidats: trouve.candidats,
             preuves: [`${trouve.candidats.length} fiches portent ce nom`] };
  }
  if (trouve.statut === "VIDE") {
    return { decision: DECISION.BLOQUE, produit: null, confiance: 0,
             preuves: ["désignation vide dans le document"] };
  }

  /* Rien d'exact : on PROPOSE, avec les preuves, et on laisse décider. */
  const candidats = produits
    .map((p) => ({ p, s: Math.max(proximite(norm(p.name), k), proximite(norm(p.reference), k)) }))
    .filter((x) => x.s >= 0.82)
    .sort((a, b) => b.s - a.s);
  if (!candidats.length) {
    return { decision: DECISION.A_CREER, produit: null, confiance: 0,
             preuves: ["aucun produit proche au catalogue"] };
  }

  const top = candidats[0];
  const kp = norm(top.p.name);
  const memesChiffres = chiffres(kp) === chiffres(k);
  const uniteCompatible = !unites.length || unites.some((u) =>
    norm(u) === norm(top.p.unit)
    || (norm(u) === "EACH" && /^(PIECE|UNITE|EA|EACH)$/i.test(norm(top.p.unit))));
  const vu = historique.get(Number(top.p.id)) || 0;
  const ecartSensible = sensible(kp, k);
  const exAequo = candidats.length > 1 && candidats[1].s >= top.s - 0.03;

  const preuves = [
    memesChiffres ? "dimensions identiques" : "DIMENSIONS DIFFÉRENTES",
    uniteCompatible ? `unité compatible (${top.p.unit || "?"})` : `unité différente (${top.p.unit || "?"})`,
    vu ? `${vu} mouvement(s) historiques` : "aucun mouvement historique",
    ecartSensible ? "écart d'orthographe non décisif" : null,
    exAequo ? `${candidats.length} candidats très proches` : null,
  ].filter(Boolean);

  /* Un écart sur une dimension, ou plusieurs candidats au coude à coude :
     AMBIGU. Un écart d'orthographe listé comme non décisif : PROBABLE, jamais
     EXACT — la ressemblance n'est pas une autorisation. */
  let decision;
  if (exAequo) decision = DECISION.AMBIGU;
  else if (!memesChiffres) decision = DECISION.AMBIGU;
  else if (!uniteCompatible) decision = DECISION.AMBIGU;
  else decision = DECISION.PROBABLE;

  return { decision, produit: null, propose: top.p, confiance: top.s,
           candidats: candidats.slice(0, 3).map((x) => ({ ...x.p, confiance: x.s })), preuves };
}

/* ══════════════════════════════════════════════════════════════════════════
   LE PLAN — AUCUNE ÉCRITURE
   ══════════════════════════════════════════════════════════════════════════ */

/** L'empreinte d'une réception existante : si elle change, le plan est périmé. */
const empreinteReception = (reception, lignes) => crypto.createHash("sha256").update([
  reception.id, reception.status,
  lignes.length,
  lignes.reduce((s, l) => s + Number(l.quantity_received || 0), 0),
  lignes.reduce((s, l) => s + Number(l.quantity_putaway || 0), 0),
].join("|")).digest("hex").slice(0, 16);

async function planifier(client, { companyId, buffer, nomFichier, plan }) {
  const lecture = P.lireClasseur(buffer, { nomFichier, plan });
  const sha = lecture.fichier.sha256;
  const entrepots = await resoudreEntrepots(client, { companyId, plan });

  /* SÉQUENTIEL, et non `Promise.all` : un même client PostgreSQL n'exécute
     qu'une requête à la fois. Les lancer en parallèle sur le même client les
     sérialise quand même, en passant par un chemin déprécié — et le jour où ce
     chemin disparaît, l'import casse. */
  const index = await DB.chargerIndexProduits(client, companyId);
  const { rows: produits } = await client.query(
    `SELECT id, name, reference, unit, stock FROM products WHERE company_id = $1`, [companyId]);
  const { rows: historiqueRows } = await client.query(
    `SELECT product_id, count(*)::int AS n FROM stock_movements
      WHERE company_id = $1 AND product_id IS NOT NULL GROUP BY product_id`, [companyId])
    .catch(() => ({ rows: [] }));
  const historique = new Map(historiqueRows.map((h) => [Number(h.product_id), h.n]));

  /* Les réceptions déjà enregistrées, et leurs lignes. */
  const { rows: existantes } = await client.query(
    `SELECT id, reception_number, container_number, reception_date::text AS reception_date,
            status, warehouse_code, vehicle_plate
       FROM stock_receptions WHERE company_id = $1 AND container_number IS NOT NULL`,
    [companyId]);
  const { rows: lignesExistantes } = await client.query(
    `SELECT l.id, l.reception_id, l.received_label, l.received_label_norm, l.product_id,
            l.quantity_received, l.quantity_putaway, l.unit, l.warehouse_code, l.match_status
       FROM stock_reception_lines l
       JOIN stock_receptions r ON r.id = l.reception_id
      WHERE l.company_id = $1`, [companyId]);
  const lignesDe = (id) => lignesExistantes.filter((l) => l.reception_id === id);
  const parCle = new Map();
  const parConteneur = new Map();
  for (const r of existantes) {
    const kc = norm(r.container_number);
    parCle.set(`${kc}|${r.reception_date}`, r);
    if (!parConteneur.has(kc)) parConteneur.set(kc, []);
    parConteneur.get(kc).push(r);
  }

  /* Les clés d'idempotence déjà consommées : la base est le juge, pas le code. */
  const { rows: dejaFaites } = await client.query(
    `SELECT idempotency_key FROM stock_import_operations
      WHERE company_id = $1 AND file_sha256 = $2`, [companyId, sha]).catch(() => ({ rows: [] }));
  const consommees = new Set(dejaFaites.map((o) => o.idempotency_key));

  /* Les décisions par libellé distinct, calculées une fois. */
  /* Un libellé distinct, c'est une CLÉ normalisée — mais le document peut
     l'écrire de plusieurs façons, et chacune est conservée. « STEEL PROP
     (GALVANIZED) 2200-4000mm » et « …2200*4000MM » se replient sur la même clé :
     la décision est donc prise une fois, et les deux écritures restent visibles
     pour qu'on sache ce que le document disait. */
  const parCleLibelle = new Map();
  for (const rec of lecture.receptions.liste) {
    for (const l of rec.lignes) {
      const k = norm(l.libelle);
      if (!parCleLibelle.has(k)) {
        parCleLibelle.set(k, { libelle: l.libelle, ecritures: new Set(), unites: new Set(), lignes: 0, quantite: 0 });
      }
      const e = parCleLibelle.get(k);
      e.ecritures.add(l.libelle);
      if (l.unite) e.unites.add(l.unite);
      e.lignes += 1;
      e.quantite += Number(l.quantite || 0);
    }
  }
  const decisions = new Map();
  for (const [k, v] of parCleLibelle) {
    decisions.set(k, {
      cle: k, libelle: v.libelle, ecritures: [...v.ecritures], unites: [...v.unites],
      lignes: v.lignes, quantite: v.quantite,
      ...deciderProduit(index, produits, v.libelle, [...v.unites], historique),
    });
  }

  const anomalies = [];
  const receptions = [];

  for (const rec of lecture.receptions.liste) {
    const feuille = rec.blocs[0]?.feuille;
    const entrepot = entrepots[feuille];
    const kc = norm(rec.conteneur);
    const existante = rec.conteneur && rec.date ? parCle.get(`${kc}|${rec.date}`) : null;
    const memeConteneur = parConteneur.get(kc) || [];

    let etat = ETAT.ABSENTE, motifs = [];
    const lignesPlan = [];

    if (!entrepot || !entrepot.ok) {
      etat = ETAT.BLOQUEE;
      motifs.push(entrepot ? entrepot.erreur : `feuille ${feuille} hors du plan`);
      anomalies.push({
        type: "ENTREPOT_INCONNU", feuille, ligne: rec.blocs[0]?.ligneDebut || null,
        cellule: null,
        message: entrepot ? entrepot.erreur : `Feuille ${feuille} sans entrepôt de destination.`,
        payload: { feuille, demande: entrepot?.demande, candidats: entrepot?.candidats || [] },
      });
    }
    if (!rec.conteneur) {
      etat = ETAT.BLOQUEE;
      motifs.push("numéro de conteneur illisible");
    }
    if (!rec.date) {
      etat = ETAT.BLOQUEE;
      motifs.push("date illisible");
    }
    if (!rec.vehicule) {
      /* Une plaque absente ne bloque pas la réception — la marchandise est bien
         arrivée — mais elle ne s'invente pas non plus. Elle attend. */
      anomalies.push({
        type: "VEHICULE_ABSENT", feuille, ligne: rec.blocs[0]?.ligneDebut || null,
        cellule: rec.blocs[0]?.celluleVehicule || null,
        message: `Conteneur ${rec.conteneur || "?"} du ${rec.date || "?"} : aucune plaque de véhicule `
          + `dans le document${rec.vehiculeDeclare ? " (champ présent mais vide)" : ""}.`,
        payload: { conteneur: rec.conteneur, date: rec.date, declare: rec.vehiculeDeclare },
      });
    }

    /* Les lignes, une par une. */
    for (const l of rec.lignes) {
      const k = norm(l.libelle);
      const d = decisions.get(k);
      const cle = DB.cleIdempotence({
        sha, kind: "RECEPTION_LINE", feuille: l.provenance.feuille, ligne: l.provenance.ligne,
        conteneur: rec.conteneur, entrepot: entrepot?.code, libelle: l.libelle,
        quantite: l.quantite, date: rec.date,
      });

      if (l.quantite == null) {
        anomalies.push({
          type: "QUANTITE_ABSENTE", feuille: l.provenance.feuille, ligne: l.provenance.ligne,
          cellule: l.provenance.cellule,
          message: `« ${l.libelle} » (conteneur ${rec.conteneur || "?"}) n'a aucune quantité `
            + `dans le document. Aucun chiffre n'est proposé.`,
          payload: { libelle: l.libelle, conteneur: rec.conteneur, date: rec.date },
        });
        lignesPlan.push({ ...l, cle, action: "BLOQUEE", raison: "quantité absente",
                          decisionProduit: d?.decision || null });
        continue;
      }

      /* Déjà présente ? Même libellé normalisé OU même produit confirmé, ET même
         quantité, ET même entrepôt. Le trio fait la ligne : deux lignes de même
         libellé et de quantités différentes sont deux lignes. */
      const candidatesBase = existante ? lignesDe(existante.id) : [];
      const deja = candidatesBase.find((x) =>
        (norm(x.received_label) === k
          || (d?.produit && Number(x.product_id) === Number(d.produit.id)))
        && Math.abs(Number(x.quantity_received || 0) - Number(l.quantite)) < 0.001
        && (!x.warehouse_code || !entrepot?.code
            || norm(x.warehouse_code) === norm(entrepot.code)));

      if (deja) {
        lignesPlan.push({ ...l, cle, action: "DEJA_PRESENTE", ligneBase: deja.id,
                          decisionProduit: d?.decision || null });
      } else if (consommees.has(cle)) {
        /* La base a déjà vu cette opération exacte : rejouer le fichier ne doit
           rien produire, même si la ligne a été supprimée depuis. */
        lignesPlan.push({ ...l, cle, action: "DEJA_IMPORTEE",
                          decisionProduit: d?.decision || null });
      } else {
        lignesPlan.push({ ...l, cle, action: "A_CREER",
                          decisionProduit: d?.decision || null,
                          produitPropose: d?.produit || d?.propose || null });
      }
    }

    /* L'état de la réception découle de ses lignes, jamais du seul numéro. */
    if (etat !== ETAT.BLOQUEE) {
      if (!existante && memeConteneur.length) {
        etat = ETAT.AMBIGUE;
        motifs.push(`conteneur connu à une autre date : `
          + memeConteneur.map((m) => `${m.reception_number} (${m.reception_date})`).join(", "));
        anomalies.push({
          type: "DATE_CONTENEUR_DIVERGENTE", feuille, ligne: rec.blocs[0]?.ligneDebut || null,
          cellule: rec.blocs[0]?.celluleDate || null,
          message: `Le conteneur ${rec.conteneur} existe en base à une autre date `
            + `(${memeConteneur.map((m) => m.reception_date).join(", ")}) ; le document dit ${rec.date}.`,
          payload: { conteneur: rec.conteneur, dateDocument: rec.date,
                     datesBase: memeConteneur.map((m) => m.reception_date) },
        });
      } else if (!existante) {
        etat = ETAT.ABSENTE;
      } else {
        const lb = lignesDe(existante.id);
        const aCreer = lignesPlan.filter((l) => l.action === "A_CREER").length;
        const enTrop = lb.filter((x) => !rec.lignes.some((l) =>
          norm(l.libelle) === norm(x.received_label)
          && Math.abs(Number(x.quantity_received || 0) - Number(l.quantite || -1)) < 0.001));
        if (!aCreer && !enTrop.length) etat = ETAT.IDENTIQUE;
        else if (enTrop.length) {
          etat = ETAT.DIVERGENTE;
          motifs.push(`${enTrop.length} ligne(s) en base ne correspondent à rien dans le document : `
            + enTrop.map((x) => `« ${x.received_label} » ${x.quantity_received}`).join(", "));
        } else {
          etat = ETAT.INCOMPLETE;
          motifs.push(`${aCreer} ligne(s) manquante(s)`);
        }
      }
    }

    const lbExist = existante ? lignesDe(existante.id) : [];
    receptions.push({
      conteneur: rec.conteneur, date: rec.date, vehicule: rec.vehicule,
      vehiculeDeclare: rec.vehiculeDeclare,
      feuille, entrepot: entrepot?.code || null, entrepotId: entrepot?.id || null,
      etat, motifs,
      lignesDocument: rec.lignes.length,
      quantiteDocument: rec.totalQuantite,
      lignes: lignesPlan,
      existante: existante ? {
        id: existante.id, numero: existante.reception_number, statut: existante.status,
        lignes: lbExist.length,
        recu: lbExist.reduce((s, x) => s + Number(x.quantity_received || 0), 0),
        range: lbExist.reduce((s, x) => s + Number(x.quantity_putaway || 0), 0),
        empreinte: empreinteReception(existante, lbExist),
      } : null,
      anomaliesDocument: rec.anomalies || [],
    });
  }

  const compte = (e) => receptions.filter((r) => r.etat === e).length;
  const lignesTotales = receptions.reduce((s, r) => s + r.lignes.length, 0);
  const act = (a) => receptions.reduce((s, r) => s + r.lignes.filter((l) => l.action === a).length, 0);
  const dec = (d) => [...decisions.values()].filter((x) => x.decision === d).length;

  return {
    fichier: lecture.fichier,
    plan, dispositions: lecture.dispositions, feuillesIgnorees: lecture.feuillesIgnorees,
    entrepots, receptions, anomalies,
    produits: [...decisions.values()],
    totaux: {
      receptions: receptions.length,
      absentes: compte(ETAT.ABSENTE), identiques: compte(ETAT.IDENTIQUE),
      incompletes: compte(ETAT.INCOMPLETE), divergentes: compte(ETAT.DIVERGENTE),
      ambigues: compte(ETAT.AMBIGUE), bloquees: compte(ETAT.BLOQUEE),
      lignes: lignesTotales,
      lignesACreer: act("A_CREER"), lignesDejaPresentes: act("DEJA_PRESENTE"),
      lignesDejaImportees: act("DEJA_IMPORTEE"), lignesBloquees: act("BLOQUEE"),
      quantiteACreer: receptions.reduce((s, r) =>
        s + r.lignes.filter((l) => l.action === "A_CREER")
          .reduce((t, l) => t + Number(l.quantite || 0), 0), 0),
      /* Deux comptes, parce qu'ils ne disent pas la même chose : ce que le
         document ÉCRIT, et ce qui se rapproche en une seule décision. */
      libellesEcrits: new Set([...parCleLibelle.values()].flatMap((v) => [...v.ecritures])).size,
      libelles: decisions.size,
      libellesPlusieursEcritures: [...decisions.values()].filter((d) => d.ecritures.length > 1).length,
      produitsExacts: dec(DECISION.EXACT), produitsProbables: dec(DECISION.PROBABLE),
      produitsAmbigus: dec(DECISION.AMBIGU), produitsACreer: dec(DECISION.A_CREER),
      produitsBloques: dec(DECISION.BLOQUE),
      anomalies: anomalies.length,
      /* Par construction : ce module n'appelle jamais le moteur de stock. */
      impactStock: 0,
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   APPLIQUER — SEULEMENT CE QUE LE PLAN A NOMMÉ
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Crée les réceptions absentes et complète les incomplètes. Rien d'autre.
 *
 * `dryRun` vaut TRUE par défaut : appeler cette fonction sans y penser ne peut
 * rien écrire. En dry-run, elle retourne exactement ce qu'elle aurait fait.
 *
 * TROIS REFUS, VOLONTAIRES :
 *
 *   • une réception dont l'EMPREINTE a changé depuis le plan est sautée. Elle a
 *     été modifiée ou rangée entre-temps ; la compléter à l'aveugle pourrait
 *     ajouter une ligne qu'on vient de ranger ;
 *   • une réception BLOQUÉE ou AMBIGUË n'est jamais écrite ;
 *   • une ligne sans quantité n'est jamais écrite.
 *
 * Aucun stock ne bouge : aucune ligne de ce code n'appelle le moteur de stock.
 */
async function appliquer(pool, { companyId, plan, utilisateur = null, dryRun = true, batchId = null }) {
  const sha = plan.fichier.sha256;
  const resultat = { dryRun, creees: [], completees: [], sautees: [], impactStock: 0 };
  const q = async (texte, params = []) => (await pool.query(texte, params));

  for (const rec of plan.receptions) {
    if ([ETAT.BLOQUEE, ETAT.AMBIGUE, ETAT.DIVERGENTE].includes(rec.etat)) {
      resultat.sautees.push({ conteneur: rec.conteneur, date: rec.date, etat: rec.etat,
                              raison: rec.motifs.join(" ; ") || rec.etat });
      continue;
    }
    if (rec.etat === ETAT.IDENTIQUE) {
      resultat.sautees.push({ conteneur: rec.conteneur, date: rec.date, etat: rec.etat,
                              raison: "déjà présente et identique — rien à faire" });
      continue;
    }
    const aCreer = rec.lignes.filter((l) => l.action === "A_CREER");
    if (!aCreer.length) {
      resultat.sautees.push({ conteneur: rec.conteneur, date: rec.date, etat: rec.etat,
                              raison: "aucune ligne à ajouter" });
      continue;
    }

    try {
      /* ─── 1. L'ÉTAT D'AUJOURD'HUI, pas celui du plan ─────────────────
         Une simple lecture, SANS verrou tenu : les services de réception
         posent eux-mêmes leur verrou, et tenir le nôtre pendant qu'on les
         appelle bloquerait la connexion qu'ils prennent dans le même pool —
         chacun attendant l'autre. C'est la clé d'idempotence, et non un
         verrou, qui garantit qu'on n'écrit pas deux fois. */
      const { rows: actuelles } = await q(
        `SELECT * FROM stock_receptions
          WHERE company_id = $1 AND container_number = $2 AND reception_date = $3::date`,
        [companyId, rec.conteneur, rec.date]);
      const actuelle = actuelles[0] || null;

      if (rec.existante && !actuelle) {
        resultat.sautees.push({ conteneur: rec.conteneur, date: rec.date, etat: "ETAT_CHANGE",
                                raison: "la réception a disparu depuis l'analyse" });
        continue;
      }
      if (actuelle && !rec.existante) {
        resultat.sautees.push({
          conteneur: rec.conteneur, date: rec.date, etat: "ETAT_CHANGE",
          raison: `une réception ${actuelle.reception_number} existe désormais : relancez l'analyse.`,
        });
        continue;
      }
      if (actuelle && rec.existante) {
        const { rows: lb } = await q(
          `SELECT * FROM stock_reception_lines WHERE reception_id = $1 AND company_id = $2`,
          [actuelle.id, companyId]);
        const empreinte = empreinteReception(actuelle, lb);
        if (empreinte !== rec.existante.empreinte) {
          resultat.sautees.push({
            conteneur: rec.conteneur, date: rec.date, etat: "ETAT_CHANGE",
            raison: `la réception ${actuelle.reception_number} a changé depuis l'analyse `
              + `(empreinte ${rec.existante.empreinte} → ${empreinte}) : relancez l'analyse.`,
          });
          continue;
        }
      }

      if (dryRun) {
        (actuelle ? resultat.completees : resultat.creees).push({
          conteneur: rec.conteneur, date: rec.date, entrepot: rec.entrepot,
          vehicule: rec.vehicule, lignes: aCreer.length,
          quantite: aCreer.reduce((s, l) => s + Number(l.quantite || 0), 0),
          numero: actuelle ? actuelle.reception_number : "(à attribuer)",
        });
        continue;
      }

      /* ─── 2. LA BARRIÈRE : les clés d'abord ──────────────────────────
         On réserve les clés AVANT d'écrire. L'index unique de
         `stock_import_operations` refuse la seconde réservation : ce qui
         revient vide est déjà importé, et ne sera pas réécrit. La base
         tranche, pas le code appelant. */
      const reservees = [];
      for (const l of aCreer) {
        const { rows } = await q(
          `INSERT INTO stock_import_operations
             (company_id, batch_id, idempotency_key, kind, file_sha256, excel_sheet, excel_row,
              excel_cell, container_number, business_date, warehouse_code, product_label,
              quantity, vehicle_plate, created_by)
           VALUES ($1,$2,$3,'RECEPTION_LINE',$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13,$14)
           ON CONFLICT (company_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [companyId, batchId, l.cle, sha, l.provenance.feuille, l.provenance.ligne,
           l.provenance.cellule, rec.conteneur, rec.date, rec.entrepot, l.libelle,
           l.quantite, rec.vehicule, utilisateur?.id || null]);
        if (rows[0]) reservees.push({ ligne: l, operationId: rows[0].id });
      }
      if (!reservees.length) {
        resultat.sautees.push({ conteneur: rec.conteneur, date: rec.date, etat: "DEJA_IMPORTEE",
                                raison: "toutes les lignes portent une clé déjà consommée" });
        continue;
      }

      /* ─── 3. L'ÉCRITURE, par le service existant ─────────────────────
         Le produit n'est posé que s'il est CERTAIN ; sinon la ligne attend
         une confirmation humaine, et aucun stock ne bouge d'ici là. */
      const lignes = reservees.map(({ ligne: l }) => ({
        label: l.libelle, quantity: l.quantite,
        unit: l.unite || "EACH", warehouseCode: rec.entrepot,
        productId: l.decisionProduit === DECISION.EXACT && l.produitPropose
          ? l.produitPropose.id : null,
        matchStatus: l.decisionProduit === DECISION.EXACT ? "MATCHED" : "TO_REVIEW",
        sheet: l.provenance.feuille, excelRow: l.provenance.ligne,
      }));

      let receptionId, numero;
      try {
        if (actuelle) {
          await R.addReceptionLines(pool, { companyId, receptionId: actuelle.id,
                                            lines: lignes, user: utilisateur });
          receptionId = actuelle.id; numero = actuelle.reception_number;
        } else {
          const out = await R.createReception(pool, {
            companyId, warehouseCode: rec.entrepot, containerNumber: rec.conteneur,
            receptionDate: rec.date, source: "EXCEL_IMPORT", sourceFile: plan.fichier.nom,
            user: utilisateur, lines: lignes,
          });
          receptionId = out.reception.id; numero = out.reception.reception_number;
        }
      } catch (e) {
        /* L'écriture a échoué : on LIBÈRE les clés réservées, sinon un second
           essai serait refusé pour toujours par sa propre réservation — une
           réception resterait manquante sans que rien ne le dise. */
        await q(`DELETE FROM stock_import_operations
                  WHERE company_id = $1 AND id = ANY($2::int[])`,
          [companyId, reservees.map((r) => r.operationId)]).catch(() => {});
        throw e;
      }

      /* ─── 4. RATTACHER LA TRACE À CE QU'ELLE A PRODUIT ───────────────── */
      await q(`UPDATE stock_import_operations SET reception_id = $1
                WHERE company_id = $2 AND id = ANY($3::int[])`,
        [receptionId, companyId, reservees.map((r) => r.operationId)]);

      /* La plaque, si le document la donne. COALESCE : on ne remplace jamais
         une plaque déjà saisie à la main par celle du classeur. */
      if (rec.vehicule) {
        await q(`UPDATE stock_receptions
                    SET vehicle_plate = COALESCE(vehicle_plate, $1), updated_at = NOW()
                  WHERE id = $2 AND company_id = $3`, [rec.vehicule, receptionId, companyId]);
      }

      (actuelle ? resultat.completees : resultat.creees).push({
        conteneur: rec.conteneur, date: rec.date, entrepot: rec.entrepot, numero,
        vehicule: rec.vehicule, lignes: reservees.length,
        quantite: reservees.reduce((s, r) => s + Number(r.ligne.quantite || 0), 0),
      });
    } catch (e) {
      resultat.sautees.push({ conteneur: rec.conteneur, date: rec.date, etat: "ERREUR",
                              raison: e.message, code: e.code || null });
    }
  }
  return resultat;
}

module.exports = { ETAT, DECISION, resoudreEntrepots, deciderProduit, planifier, appliquer,
                   empreinteReception, proximite };
