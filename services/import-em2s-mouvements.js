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

/* ═══════════════════════════════════════════════════ ÉCRITURE ══ */

/**
 * Écrit les mouvements exploitables d'un aperçu.
 *
 * `client` est déjà dans une transaction : si une ligne échoue, tout le lot
 * est annulé. Aucun demi-mouvement, aucune balance incohérente.
 *
 * @returns compte-rendu détaillé, ligne par ligne
 */
async function ecrireMouvements(client, {
  companyId, batchId, sha, apercu, utilisateur, limite = null,
}) {
  const anomalies = await anomaliesOuvertes(client, { companyId, sha });

  const rapport = {
    ecrits: 0, ignores: 0, dejaFaits: 0, bloques: 0, refuses: 0,
    quantiteEntree: 0, quantiteSortie: 0, details: [],
  };

  for (const m of apercu.mouvements.liste) {
    const cleLigne = `${m.provenance.feuille}:${m.provenance.ligne}`;
    const etat = anomalies.get(cleLigne) || { ouvertes: [], resolues: [] };

    if (etat.ouvertes.length > 0) {
      rapport.bloques += 1;
      rapport.details.push({ ligne: cleLigne, article: m.description,
        etat: "bloqué", motifs: etat.ouvertes.map((a) => a.anomaly_type) });
      continue;
    }

    if (m.dejaImporte) {
      rapport.dejaFaits += 1;
      rapport.details.push({ ligne: cleLigne, article: m.description, etat: "déjà importé" });
      continue;
    }

    if (!m.produit) {
      rapport.ignores += 1;
      rapport.details.push({ ligne: cleLigne, article: m.description,
        etat: "sans produit — la correspondance doit être confirmée d'abord" });
      continue;
    }

    /* Les décisions prises sur cette ligne, s'il y en a eu. */
    const decisions = {};
    for (const a of etat.resolues) {
      Object.assign(decisions, a.resolution || {});
    }

    const parts = decomposer(m, decisions);
    if (parts === null) {
      rapport.bloques += 1;
      rapport.details.push({ ligne: cleLigne, article: m.description,
        etat: "en attente — indiquez par quel bac ce mouvement est passé",
        bacsPossibles: m.bins });
      continue;
    }
    const sommeParts = parts.reduce((s, p) => s + p.quantite, 0);
    if (sommeParts !== m.quantite) {
      /* Garde-fou : la décomposition ne doit jamais créer ni perdre d'unité.
         Si elle le fait, c'est un défaut de notre côté, pas une donnée à
         corriger — on refuse le lot entier plutôt que d'écrire un stock faux. */
      const e = new Error(
        `Décomposition incohérente pour « ${m.description} » (${cleLigne}) : `
        + `${sommeParts} au lieu de ${m.quantite}.`);
      e.httpStatus = 500; e.code = "DECOMPOSITION_MISMATCH";
      throw e;
    }

    for (const part of parts) {
      const emplacement = part.bin
        ? await emplacementDuBac(client, companyId, m, part.bin)
        : (m.emplacement || null);

      if (!emplacement) {
        rapport.ignores += 1;
        rapport.details.push({ ligne: cleLigne, article: m.description,
          etat: `emplacement introuvable${part.bin ? ` pour ${part.bin}` : ""}` });
        continue;
      }

      const cle = D.cleIdempotence({
        sha, kind: "MOVEMENT", libelle: m.description, sens: m.sens,
        quantite: part.quantite, date: part.date,
        emplacement: `${emplacement.id}`,
        feuille: m.provenance.feuille, ligne: m.provenance.ligne,
      });

      /* La clé est posée AVANT le mouvement : si elle existe déjà, on n'a
         rien écrit et on passe. C'est la base qui tranche, pas une lecture
         préalable qui pourrait être doublée par deux requêtes simultanées. */
      const { rowCount } = await client.query(
        `INSERT INTO stock_import_operations
           (company_id, batch_id, idempotency_key, kind, file_sha256, excel_sheet,
            excel_row, excel_cell, product_id, product_label, location_id,
            location_code, movement_kind, quantity, business_date, created_by)
         VALUES ($1,$2,$3,'MOVEMENT',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (company_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [companyId, batchId, cle, sha, m.provenance.feuille, m.provenance.ligne,
         m.provenance.cellule, m.produit.id, m.description, emplacement.id,
         emplacement.full_code, m.sens, part.quantite, part.date,
         utilisateur?.id || null]
      );

      if (rowCount === 0) {
        rapport.dejaFaits += 1;
        continue;
      }

      const options = {
        companyId, productId: m.produit.id, locationId: emplacement.id,
        quantity: part.quantite, user: utilisateur,
        reason: `Import ${sha.slice(0, 12)} — ${m.provenance.feuille}:${m.provenance.ligne}`,
      };

      /* Une sortie qui dépasse le disponible est une CONDITION des données,
         pas un défaut du programme : elle doit se signaler ligne par ligne,
         pas faire échouer les cent autres. On retire la clé posée juste avant,
         sinon la ligne serait tenue pour faite et ne repasserait jamais. */
      let out;
      try {
        out = m.sens === "Entrée"
          ? await L.entryAtLocation(client, options)
          : await L.exitFromLocation(client, options);
      } catch (erreur) {
        if (!REFUS_METIER.has(erreur.code)) throw erreur;
        await client.query(
          `DELETE FROM stock_import_operations
            WHERE company_id = $1 AND idempotency_key = $2 AND movement_id IS NULL`,
          [companyId, cle]);
        rapport.refuses += 1;
        rapport.details.push({ ligne: cleLigne, article: m.description,
          etat: "refusé", motif: erreur.message, code: erreur.code,
          sens: m.sens, quantite: part.quantite, bac: part.bin });
        continue;
      }

      /* La date métier du classeur, pas celle de la frappe. */
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
        ligne: cleLigne, article: m.description, etat: "écrit",
        sens: m.sens, quantite: part.quantite, bac: part.bin,
        emplacement: emplacement.full_code, date: part.date,
        stockAvant: out.stockBefore, stockApres: out.stockAfter,
      });

      if (limite && rapport.ecrits >= limite) return rapport;
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

module.exports = { BLOQUANTES, anomaliesOuvertes, decomposer, emplacementDuBac,
                   ecrireMouvements, reconcilier };
