"use strict";

/**
 * ÉCRIRE LES MOUVEMENTS D'UN IMPORT.
 *
 * C'est la seule partie de l'import qui touche au stock. Elle vient APRÈS que
 * tout a été tranché, jamais avant :
 *
 *   — une ligne dont la répartition par bac n'est pas donnée n'écrit rien ;
 *   — une cellule à plusieurs dates n'écrit rien tant qu'on ignore combien
 *     d'unités vont sur chacune ;
 *   — une ligne dont le stock final ne suit pas le calcul n'écrit rien tant
 *     que personne n'a dit quelle valeur fait foi.
 *
 * Le moteur de stock existant (`services/stock-locations.js`) fait le travail :
 * on ne réécrit pas une seconde façon de bouger du stock, on appelle celle qui
 * est déjà éprouvée — verrous, balances, refus des quantités insuffisantes.
 *
 * Chaque écriture porte sa clé d'idempotence. Relancer la même validation ne
 * produit rien de plus : c'est l'index d'unicité qui le garantit, pas la
 * prudence de l'appelant.
 */

const L = require("./stock-locations");
const D = require("./import-em2s-db");
const R = require("./import-em2s-repartitions");

const BLOQUANTES = ["MULTI_BIN", "DATES_MULTIPLES", "NEW_STOCK_INCOHERENT"];

/* Refus que les données peuvent légitimement provoquer, et qui n'ont pas à
   faire tomber le lot entier : le stock manque, la réservation bloque, le bac
   ne convient pas. Tout autre code d'erreur reste une anomalie du programme. */
const REFUS_METIER = new Set([
  /* Relevés dans services/stock-locations.js, pas devinés : ce sont les refus
     que l'état des données peut légitimement provoquer. Tout autre code reste
     une anomalie du programme et fait tomber le lot. */
  "STOCK_INSUFFICIENT", "LOCATION_STOCK_INSUFFICIENT", "NO_BALANCE_AT_LOCATION",
  "LOCATION_NOT_FOUND", "PRODUCT_NOT_FOUND", "INVALID_QUANTITY",
  "LOCATION_WITHOUT_BIN", "LOCATION_INACTIVE", "LEGACY_PLACEHOLDER",
  "WRITE_OFF_NOT_A_LOCATION", "BIN_NOT_SPECIFIED", "LOCATION_REQUIRED",
  "NO_ALLOCATION", "SAME_LOCATION", "DUPLICATE_LOCATION",
  "LOCATION_BALANCE_MISMATCH", "RESERVATION_EXCEEDS_AVAILABLE",
]);

/* ────────────────────────────────────────── ce qui reste bloqué ── */

/**
 * Les anomalies encore ouvertes, indexées par ligne du classeur.
 * Une ligne présente ici ne peut produire aucun mouvement.
 */
async function anomaliesOuvertes(client, { companyId, sha }) {
  const { rows } = await client.query(
    `SELECT anomaly_type, excel_sheet, excel_row, status, resolution, payload
       FROM stock_import_anomalies
      WHERE company_id = $1 AND file_sha256 = $2 AND anomaly_type = ANY($3)`,
    [companyId, sha, BLOQUANTES]
  );

  const parLigne = new Map();
  for (const a of rows) {
    const cle = `${a.excel_sheet}:${a.excel_row}`;
    if (!parLigne.has(cle)) parLigne.set(cle, { ouvertes: [], resolues: [] });
    parLigne.get(cle)[a.status === "OPEN" ? "ouvertes" : "resolues"].push(a);
  }
  return parLigne;
}

/* ─────────────────────────────────────── décomposer un mouvement ── */

/**
 * Ce qu'un mouvement du classeur devient réellement, une fois les décisions
 * humaines appliquées.
 *
 * Une ligne à trois bacs devient trois mouvements ; une cellule à trois dates
 * en devient trois de plus. La quantité totale est conservée à l'unité près —
 * c'est ce que les contrôles de somme ont déjà garanti au moment de trancher.
 */
function decomposer(mouvement, decisions) {
  /* `parBin` répond à « où repose le stock de cette ligne ? ». Ce n'est PAS
     la réponse à « par quel bac ce mouvement de trois unités est-il passé ? ».
     Les confondre ferait entrer quarante et une unités là où trois seulement
     ont bougé. Le mouvement a donc sa propre question, `parBinMouvement`, et
     tant qu'elle est sans réponse la ligne attend. */
  const repartitionMouvement = decisions.parBinMouvement || null;
  const ventilation = decisions.parDate || null;

  let parts;
  if (repartitionMouvement) {
    parts = Object.entries(repartitionMouvement)
      .filter(([, q]) => Number(q) > 0)
      .map(([bin, q]) => ({ quantite: Number(q), bin, date: mouvement.date }));
  } else if (mouvement.bins.length > 1) {
    /* Plusieurs bacs possibles et personne n'a dit lequel : on ne choisit pas
       à sa place. */
    return null;
  } else {
    parts = [{ quantite: mouvement.quantite, bin: mouvement.bins[0] || null,
               date: mouvement.date }];
  }

  if (ventilation) {
    const dates = Object.entries(ventilation).filter(([, q]) => Number(q) > 0);
    const total = dates.reduce((s, [, q]) => s + Number(q), 0);
    if (total > 0) {
      /* Chaque part garde sa quantité, répartie entre les dates au prorata
         exact des quantités saisies. Le dernier reçoit le reste, pour qu'aucune
         unité ne se perde dans un arrondi. */
      parts = parts.flatMap((p) => {
        let reste = p.quantite;
        return dates.map(([date, q], i) => {
          const part = i === dates.length - 1
            ? reste
            : Math.round((p.quantite * Number(q)) / total);
          reste -= part;
          return { quantite: part, bin: p.bin, date };
        }).filter((x) => x.quantite > 0);
      });
    }
  }

  return parts;
}

/* ──────────────────────────────────────── résolution d'un bac ── */

/** Retrouve l'emplacement exact d'un bac nommé sur une ligne du classeur. */
async function emplacementDuBac(client, companyId, ligne, bin) {
  const { rows } = await client.query(
    `SELECT id, full_code FROM locations
      WHERE company_id = $1
        AND upper(btrim(COALESCE(NULLIF(rayon_code,''), zone, ''))) = upper(btrim($2))
        AND upper(btrim(COALESCE(NULLIF(case_code,''), rayon, ''))) = upper(btrim($3))
        AND upper(btrim(COALESCE(level_code,''))) = upper(btrim($4))
        AND ($5::text IS NULL OR upper(btrim(COALESCE(bin_code,''))) = upper(btrim($5)))
        AND COALESCE(is_active, TRUE) = TRUE
      LIMIT 2`,
    [companyId, ligne.rayon || "", ligne.location || "", ligne.niveau || "", bin]
  );
  if (rows.length === 1) return rows[0];
  return null;
}

/* ═════════════════════════════════════════════ PRÉVALIDATION ══ */

/**
 * Classe chaque mouvement AVANT toute écriture : prêt, ou bloqué avec son
 * motif exact.
 *
 * C'est le cœur de la garantie promise à l'utilisateur. Écrire sept lignes et
 * en refuser trois au passage, après qu'il a cliqué « importer », lui fait
 * croire que tout est passé. Il doit voir la liste des refusées AVANT, et
 * choisir explicitement de laisser celles-là en attente.
 *
 * Aucune clé d'idempotence n'est posée ici : une ligne qu'on n'écrit pas ne
 * doit jamais être tenue pour faite.
 */
async function classer(client, { companyId, sha, apercu }) {
  const anomalies = await anomaliesOuvertes(client, { companyId, sha });
  const pretes = [];
  const bloquees = [];
  const dejaFaits = [];

  const bloquer = (m, motif, extra = {}) => bloquees.push({
    ligne: `${m.provenance.feuille}:${m.provenance.ligne}`,
    article: m.description, sens: m.sens, quantite: m.quantite,
    date: m.date, motif, ...extra,
  });

  for (const m of apercu.mouvements.liste) {
    const cleLigne = `${m.provenance.feuille}:${m.provenance.ligne}`;
    const etat = anomalies.get(cleLigne) || { ouvertes: [], resolues: [] };

    /* Les répartitions MULTI_BIN et DATES_MULTIPLES ont désormais leur propre
       cycle de vie. Seule l'incohérence du stock final reste une anomalie de
       ligne qui bloque indistinctement ses mouvements. */
    const ouvertesLigne = etat.ouvertes.filter((a)=>a.anomaly_type === "NEW_STOCK_INCOHERENT");
    if (ouvertesLigne.length > 0) {
      bloquer(m, "anomalie non tranchée", { motifs: etat.ouvertes.map((a) => a.anomaly_type) });
      continue;
    }
    if (m.dejaImporte) {
      dejaFaits.push({ ligne: cleLigne, article: m.description });
      continue;
    }
    if (!m.produit) {
      bloquer(m, "produit inconnu — la correspondance doit être confirmée d'abord");
      continue;
    }

    const {rows: evenements}=await client.query(
      `SELECT e.*,a.allocation,a.status allocation_status
         FROM stock_import_movement_events e
         JOIN stock_import_movement_allocations a ON a.movement_event_id=e.id
        WHERE e.company_id=$1 AND e.file_sha256=$2 AND e.excel_sheet=$3 AND e.excel_row=$4
          AND e.direction=$5 AND e.status<>'CANCELLED'
        ORDER BY e.effective_date,e.event_sequence`,
      [companyId,sha,m.provenance.feuille,m.provenance.ligne,R.directionDe(m.sens)]);
    if(evenements.length===0){
      bloquer(m,(m.datesProposees||[]).length>1
        ? "les quantités par date ne sont pas encore renseignées"
        : "l'événement de mouvement n'est pas initialisé");
      continue;
    }
    if(evenements.every((e)=>e.status==="IMPORTED")){
      dejaFaits.push({ligne:cleLigne,article:m.description,sens:m.sens});
      continue;
    }
    if(evenements.some((e)=>e.allocation_status!=="VALIDATED")){
      bloquer(m,"la répartition par bin d'un événement n'est pas validée",{
        evenements:evenements.filter((e)=>e.allocation_status!=="VALIDATED").map((e)=>e.id)});
      continue;
    }
    const sommeEvenements=evenements.reduce((s,e)=>s+Number(e.quantity),0);
    if(sommeEvenements!==Number(m.quantite)){
      bloquer(m,`fractions incohérentes : ${sommeEvenements} au lieu de ${m.quantite}`);
      continue;
    }

    const parts=evenements.flatMap((event)=>Object.entries(event.allocation||{})
      .filter(([,q])=>Number(q)>0).map(([bin,q])=>({quantite:Number(q),bin:bin==="__LOCATION__"?null:bin,
        date:String(event.effective_date).slice(0,10),event})));

    /* Chaque part doit trouver son emplacement, et une sortie doit trouver de
       quoi sortir. On le vérifie ici, à froid : découvrir le manque au moment
       d'écrire obligerait à défaire ce qui vient d'être fait. */
    const resolues = [];
    let refus = null;

    for (const part of parts) {
      const emplacement = part.bin
        ? await emplacementDuBac(client, companyId, m, part.bin)
        : (m.emplacement || null);

      if (!emplacement) {
        refus = { motif: `emplacement introuvable${part.bin ? ` pour ${part.bin}` : ""}`,
                  bac: part.bin };
        break;
      }

      if (m.sens === "Sortie") {
        const { rows } = await client.query(
          `SELECT COALESCE(quantity, 0)::numeric AS quantite,
                  COALESCE(reserved_quantity, 0)::numeric AS reserve
             FROM stock_location_balances
            WHERE company_id = $1 AND product_id = $2 AND location_id = $3`,
          [companyId, m.produit.id, emplacement.id]
        );
        const presente = Number(rows[0]?.quantite || 0);
        const reservee = Number(rows[0]?.reserve || 0);
        const disponible = presente - reservee;
        if (disponible < part.quantite) {
          refus = {
            motif: `stock insuffisant en ${emplacement.full_code} : `
                 + `${part.quantite} demandé(s), ${disponible} disponible(s)`,
            bac: part.bin, presente, reservee, disponible,
          };
          break;
        }
      }

      resolues.push({ ...part, emplacement });
    }

    if (refus) { bloquer(m, refus.motif, refus); continue; }

    pretes.push({ mouvement: m, cleLigne, parts: resolues });
  }

  const somme = (sens) => pretes
    .filter((p) => p.mouvement.sens === sens)
    .reduce((s, p) => s + p.parts.reduce((t, x) => t + x.quantite, 0), 0);

  return {
    total: apercu.mouvements.liste.length,
    pretes: pretes.length,
    bloquees: bloquees.length,
    dejaFaits: dejaFaits.length,
    quantiteEntreePrete: somme("Entrée"),
    quantiteSortiePrete: somme("Sortie"),
    listePretes: pretes.map((p) => ({
      ligne: p.cleLigne, article: p.mouvement.description,
      sens: p.mouvement.sens, quantite: p.mouvement.quantite, date: p.mouvement.date,
      repartition: p.parts.map((x) => ({ bac: x.bin, quantite: x.quantite,
                                         emplacement: x.emplacement.full_code, date: x.date })),
    })),
    listeBloquees: bloquees,
    listeDejaFaites: dejaFaits,
    /* Interne : porte les emplacements déjà résolus, pour ne pas les rechercher
       une seconde fois au moment d'écrire. */
    _pretes: pretes,
  };
}

/* ═══════════════════════════════════════════════════ ÉCRITURE ══ */

/**
 * Écrit les lignes déclarées prêtes par `classer`, et elles seules.
 *
 * `client` est déjà dans une transaction : une erreur inattendue sur la
 * quatrième ligne annule les trois premières. Les lignes bloquées n'entrent
 * jamais dans cette transaction — elles restent en attente, intactes.
 */
async function ecrireMouvements(client, {
  companyId, batchId, sha, classement, utilisateur,
}) {
  const rapport = {
    ecrits: 0, dejaFaits: 0, bloquees: classement.bloquees,
    quantiteEntree: 0, quantiteSortie: 0, details: [],
  };

  for (const prete of classement._pretes) {
    const m = prete.mouvement;

    for (const part of prete.parts) {
      const cle = D.cleIdempotence({
        sha, kind: "MOVEMENT_EVENT", evenement: part.event.event_key,
        libelle: m.description, sens: m.sens,
        quantite: part.quantite, date: part.date,
        emplacement: `${part.emplacement.id}`,
        feuille: m.provenance.feuille, ligne: m.provenance.ligne,
      });

      /* La clé est posée avant le mouvement : c'est la base qui refuse le
         doublon, pas une lecture préalable que deux requêtes simultanées
         pourraient doubler. */
      const { rowCount } = await client.query(
        `INSERT INTO stock_import_operations
           (company_id, batch_id, idempotency_key, kind, file_sha256, excel_sheet,
            excel_row, excel_cell, product_id, product_label, location_id,
            location_code, movement_kind, quantity, business_date, created_by)
         VALUES ($1,$2,$3,'MOVEMENT',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (company_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [companyId, batchId, cle, sha, m.provenance.feuille, m.provenance.ligne,
         m.provenance.cellule, m.produit.id, m.description, part.emplacement.id,
         part.emplacement.full_code, m.sens, part.quantite, part.date,
         utilisateur?.id || null]
      );

      if (rowCount === 0) { rapport.dejaFaits += 1; continue; }

      const options = {
        companyId, productId: m.produit.id, locationId: part.emplacement.id,
        quantity: part.quantite, user: utilisateur,
        reason: `Import ${sha.slice(0, 12)} — ${m.provenance.feuille}:${m.provenance.ligne}`,
      };

      /* Aucun refus métier n'est rattrapé ici : `classer` les a tous écartés
         en amont. Ce qui survient encore est inattendu, et doit annuler tout
         le lot plutôt que d'écrire à moitié. */
      const out = m.sens === "Entrée"
        ? await L.entryAtLocation(client, options)
        : await L.exitFromLocation(client, options);

      if (part.date && out.movement?.id) {
        await client.query(
          `UPDATE stock_movements
              SET operation_effective_at = $1::timestamp AT TIME ZONE 'Africa/Bamako'
            WHERE id = $2`,
          [part.date, out.movement.id]
        );
      }

      await client.query(
        `UPDATE stock_import_operations SET movement_id = $1
          WHERE company_id = $2 AND idempotency_key = $3`,
        [out.movement?.id || null, companyId, cle]
      );
      rapport.ecrits += 1;
      if (m.sens === "Entrée") rapport.quantiteEntree += part.quantite;
      else rapport.quantiteSortie += part.quantite;
      rapport.details.push({
        ligne: prete.cleLigne, article: m.description, etat: "écrit",
        sens: m.sens, quantite: part.quantite, bac: part.bin,
        emplacement: part.emplacement.full_code, date: part.date,
        stockAvant: out.stockBefore, stockApres: out.stockAfter,
      });
    }

    /* Un événement peut être réparti sur plusieurs bins, donc produire
       plusieurs mouvements de stock. Il ne devient IMPORTED qu'après que
       toutes ses parts ont réussi dans la transaction. */
    for (const event of [...new Map(prete.parts.map((p)=>[p.event.id,p.event])).values()]) {
      const mouvementLie=rapport.details.slice().reverse().find((d)=>d.ligne===prete.cleLigne
        && d.sens===m.sens && d.date===String(event.effective_date).slice(0,10));
      await client.query(`UPDATE stock_import_movement_events SET status='IMPORTED',updated_at=now()
        WHERE id=$1`,[event.id]);
      await client.query(`INSERT INTO stock_import_allocation_audit
        (company_id,entity_type,entity_id,action,after_value,actor_id)
        VALUES ($1,'MOVEMENT_EVENT',$2,'IMPORT',$3,$4)`,
        [companyId,event.id,JSON.stringify({eventKey:event.event_key,detail:mouvementLie||null}),
         utilisateur?.id||null]);
    }
  }

  return rapport;
}

/* ═════════════════════════════════════════════ RÉCONCILIATION ══ */

/**
 * Compare le stock réel au « new stock » du classeur, produit par produit et
 * emplacement par emplacement.
 *
 * On CONSTATE l'écart, on ne le corrige pas : créer un mouvement pour forcer
 * la concordance masquerait précisément ce qu'il faut voir.
 */
async function reconcilier(client, { companyId, apercu }) {
  const lignes = [];

  for (const m of apercu.mouvements.liste) {
    if (!m.produit) continue;
    if (lignes.some((l) => l.produitId === m.produit.id
                        && l.emplacementCode === (m.emplacement?.full_code || null))) continue;

    const { rows } = await client.query(
      `SELECT COALESCE(SUM(b.quantity), 0)::numeric AS reel
         FROM stock_location_balances b
        WHERE b.company_id = $1 AND b.product_id = $2
          ${m.emplacement ? "AND b.location_id = $3" : ""}`,
      m.emplacement ? [companyId, m.produit.id, m.emplacement.id]
                    : [companyId, m.produit.id]
    );

    const reel = Number(rows[0].reel);
    const attendu = Number(m.nouveauStock ?? NaN);
    lignes.push({
      produitId: m.produit.id, article: m.description,
      emplacementCode: m.emplacement?.full_code || null,
      reel, attendu: Number.isFinite(attendu) ? attendu : null,
      ecart: Number.isFinite(attendu) ? reel - attendu : null,
      source: `${m.provenance.feuille}:${m.provenance.ligne}`,
    });
  }

  const avecEcart = lignes.filter((l) => l.ecart !== null && l.ecart !== 0);
  return {
    lignes: lignes.length,
    concordantes: lignes.filter((l) => l.ecart === 0).length,
    ecarts: avecEcart.length,
    detail: avecEcart.slice(0, 200),
    note: "Les écarts sont constatés, jamais corrigés d'office : un mouvement "
        + "de régularisation silencieux masquerait ce qu'il faut examiner.",
  };
}

module.exports = { BLOQUANTES, REFUS_METIER, anomaliesOuvertes, decomposer,
                   emplacementDuBac, classer, ecrireMouvements, reconcilier };
