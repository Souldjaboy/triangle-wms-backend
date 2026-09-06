"use strict";

/**
 * DOCUMENTS : GÉNÉRATION GROUPÉE, CORRECTION, ANNULATION.
 *
 *   GET  /documents/pending-movements       ce qui reste à documenter
 *   POST /documents/from-movements          générer plusieurs bons d'un coup
 *   PATCH /documents/:id/content            corriger numéro et quantités imprimés
 *   POST /documents/:id/cancel-replace      annuler en remplaçant
 *   GET  /documents/:id/content-revisions   l'historique des corrections
 *
 * Deux règles gouvernent tout ce fichier.
 *
 * La première : un mouvement de SORTIE donne un « Bon de sortie », jamais un
 * « Bon de livraison ». Un bon de livraison accompagne une marchandise vendue
 * et livrée à quelqu'un ; une sortie de stock peut être une casse, un
 * transfert vers un chantier, une consommation interne. Les confondre fait
 * sortir des BL pour des marchandises que personne n'a commandées.
 *
 * La seconde : corriger un document ne touche JAMAIS au stock. Les quantités
 * physiques ne changent pas parce qu'un papier était faux. `stock_movements`,
 * `products.stock` et `stock_location_balances` sont hors d'atteinte ici.
 */

const express = require("express");

/* Le type de document que chaque sens de mouvement appelle, et son préfixe.
   Une seule table : deux endroits qui décident séparément finissent par ne
   plus dire la même chose. */
const TYPE_PAR_MOUVEMENT = {
  "Entrée":     { type: "Bon de réception", prefixe: "BR" },
  "Sortie":     { type: "Bon de sortie",    prefixe: "BS" },
  "Transfert":  { type: "Bon de transfert", prefixe: "BT" },
  "Inventaire": { type: "Fiche inventaire", prefixe: "INV" },
};

const PREFIXE_PAR_TYPE = {
  "Bon de réception": "BR",
  "Bon de sortie":    "BS",
  "Bon de transfert": "BT",
  "Fiche inventaire": "INV",
  "Facture":          "FAC",
  "Proforma":         "PRO",
};

/* Au-delà, la transaction tient trop de verrous trop longtemps : mieux vaut
   plusieurs lots que bloquer les mouvements de tout le monde. */
const MAX_PAR_LOT = 500;

module.exports = function createDocumentsContentRouter(deps) {
  const {
    pool, authenticateToken, getEffectiveCompanyId, requirePermission,
    nextShortDocumentNumber, permissionsService,
  } = deps;
  const router = express.Router();

  const societeDe = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const nomDe = (req) => req.user?.fullname || req.user?.email || "Utilisateur";

  const peutVoir     = requirePermission("document", "view");
  const peutCreer    = requirePermission("document", "create");
  const peutModifier = requirePermission("document", "update");

  const echec = (res, e, defaut) => {
    console.error(defaut, e);
    res.status(e.httpStatus || 500).json({ error: e.message || defaut, code: e.code });
  };
  const sansSociete = (res) =>
    res.status(409).json({ error: "Entreprise indéterminée.", code: "COMPANY_CONTEXT_REQUIRED" });

  const erreur = (message, code, statut = 400) => {
    const e = new Error(message); e.code = code; e.httpStatus = statut; return e;
  };

  /** Tout le lot passe, ou rien : un lot à moitié écrit est pire qu'un refus. */
  const transaction = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };

  /* ═══════════════════════════════ CE QUI RESTE À DOCUMENTER ══ */

  /**
   * Les mouvements validés qui n'ont pas encore de document actif.
   *
   * Par défaut, uniquement ceux du DERNIER import. Le mélange avec
   * l'historique est précisément ce qui faisait lire « 30 » là où le nouveau
   * bon devait porter 10 : l'ancienne sortie de 20 et la nouvelle de 10
   * apparaissaient côte à côte, sans rien pour les distinguer.
   *
   * Le rattachement se fait sur `stock_movements.import_id`, jamais sur une
   * date approximative, un nom de produit ou le texte d'une observation.
   */
  router.get("/documents/pending-movements", authenticateToken, peutVoir, async (req, res) => {
    const companyId = societeDe(req);
    if (!companyId) return sansSociete(res);
    try {
      const avecHistorique = String(req.query.historique || "") === "1";
      const importDemande = req.query.import_id ? Number(req.query.import_id) : null;

      const { rows: dernier } = await pool.query(
        `SELECT id, file_name, created_at FROM inventory_imports
          WHERE company_id = $1 ORDER BY id DESC LIMIT 1`,
        [companyId]
      );
      const dernierImport = importDemande || dernier[0]?.id || null;

      const conditions = [
        "m.company_id = $1",
        "m.status = 'Validé'",
        /* Un document annulé libère son mouvement : il redevient à documenter. */
        `NOT EXISTS (SELECT 1 FROM documents d
                      WHERE d.company_id = m.company_id
                        AND d.stock_movement_id = m.id
                        AND d.cancelled_at IS NULL)`,
      ];
      const params = [companyId];

      if (!avecHistorique) {
        if (dernierImport) {
          conditions.push(`m.import_id = $${params.push(dernierImport)}`);
        } else {
          /* Aucun import enregistré : on ne devine pas. On montre ce qui n'a
             jamais été rattaché à un import plutôt que tout l'historique. */
          conditions.push("m.import_id IS NULL");
        }
      }

      const { rows: mouvements } = await pool.query(
        `SELECT m.id, m.type, m.quantity, m.product_name, m.product_reference,
                m.status, m.created_at, m.import_id,
                m.operation_effective_at, m.warehouse_id, m.location_code,
                COALESCE(w.name, w.code, m.destination_warehouse, m.source_warehouse) AS entrepot,
                i.file_name AS import_fichier,
                (m.import_id IS NOT DISTINCT FROM $${params.push(dernierImport)}) AS du_dernier_import
           FROM stock_movements m
           LEFT JOIN warehouses w ON w.id = m.warehouse_id
           LEFT JOIN inventory_imports i ON i.id = m.import_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY m.id DESC
          LIMIT ${Math.min(Number(req.query.limite) || 1000, 2000)}`,
        params
      );

      res.json({
        success: true,
        dernierImport: dernier[0] || null,
        historiqueInclus: avecHistorique,
        total: mouvements.length,
        mouvements,
      });
    } catch (e) { echec(res, e, "Erreur de lecture des mouvements à documenter."); }
  });

  /* ═══════════════════════════ LES ÉVÉNEMENTS À DOCUMENTER ══ */

  /**
   * Les sorties réelles du dernier import, une fiche par ÉVÉNEMENT.
   *
   * `stock_movements.import_id` ne suffit plus. L'ancien chemin d'import
   * consolidait plusieurs sorties d'un même produit en un seul mouvement :
   * trois sorties STADE 4 AOUT de 7, 7 et 6 devenaient un mouvement de 20.
   * Lister les mouvements affiche donc « 20 », un chiffre que personne n'a
   * sorti en une fois et qu'aucun bon ne peut porter.
   *
   * `stock_import_movement_events` décrit les sorties telles qu'elles ont eu
   * lieu — cellule, date, quantité. C'est cette table qui alimente l'écran.
   */
  router.get("/documents/pending-events", authenticateToken, peutVoir, async (req, res) => {
    const companyId = societeDe(req);
    if (!companyId) return sansSociete(res);
    try {
      const avecHistorique = String(req.query.historique || "") === "1";

      const { rows: dernier } = await pool.query(
        `SELECT id, file_name, file_hash, created_at FROM inventory_imports
          WHERE company_id = $1 ORDER BY id DESC LIMIT 1`,
        [companyId]);
      const imp = dernier[0] || null;

      const conditions = [
        "e.company_id = $1",
        "e.status <> 'CANCELLED'",
        `NOT EXISTS (SELECT 1 FROM documents d
                      WHERE d.company_id = e.company_id
                        AND d.stock_import_movement_event_id = e.id
                        AND d.cancelled_at IS NULL)`,
      ];
      const params = [companyId];

      if (!avecHistorique && imp?.file_hash) {
        /* Le rattachement passe par l'empreinte du fichier, pas par une date
           ni par un nom de produit : c'est la seule chose qui identifie le
           classeur importé sans ambiguïté. */
        conditions.push(`e.file_sha256 = $${params.push(imp.file_hash)}`);
      }

      const { rows: evenements } = await pool.query(
        `SELECT e.id, e.direction, e.quantity, e.effective_date::text AS effective_date,
                e.excel_sheet, e.excel_row, e.excel_cell, e.event_key, e.status,
                e.movement_id, e.file_sha256,
                e.source_context->>'produit'  AS product_name,
                e.source_context->>'fichier'  AS import_fichier,
                e.source_context->>'rayon'    AS rayon,
                e.source_context->>'location' AS location_code,
                m.product_reference, m.quantity AS quantite_mouvement,
                COALESCE(w.name, w.code) AS entrepot,
                (e.file_sha256 = $${params.push(imp?.file_hash || null)}) AS du_dernier_import
           FROM stock_import_movement_events e
           LEFT JOIN stock_movements m ON m.id = e.movement_id
           LEFT JOIN warehouses w ON w.id = m.warehouse_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY e.excel_row, e.event_sequence
          LIMIT ${Math.min(Number(req.query.limite) || 1000, 2000)}`,
        params);

      /* Cet import a-t-il produit des événements, documentés ou non ?
         La question n'est pas « reste-t-il quelque chose à faire » : une fois
         les 21 bons émis, la liste est vide, et retomber alors sur les
         mouvements consolidés ferait réapparaître à l'écran des lignes de 20
         que l'on vient précisément de remplacer. */
      const { rows: compte } = imp?.file_hash ? await pool.query(
        `SELECT count(*) AS n FROM stock_import_movement_events
          WHERE company_id = $1 AND file_sha256 = $2`,
        [companyId, imp.file_hash]) : [{ n: "0" }];

      res.json({
        success: true,
        dernierImport: imp,
        historiqueInclus: avecHistorique,
        importAvecEvenements: Number(compte[0]?.n || 0) > 0,
        evenementsDeLImport: Number(compte[0]?.n || 0),
        total: evenements.length,
        quantiteTotale: evenements.reduce((s, e) => s + Number(e.quantity), 0),
        evenements,
      });
    } catch (e) { echec(res, e, "Erreur de lecture des événements à documenter."); }
  });

  /**
   * Génère un bon par ÉVÉNEMENT, en une transaction.
   *
   * La quantité imprimée est celle de l'événement, jamais celle du mouvement
   * consolidé : c'est toute la différence entre un bon de 7 qu'on peut faire
   * signer et un bon de 20 qui ne correspond à rien.
   */
  router.post("/documents/from-events", authenticateToken, peutCreer, async (req, res) => {
    const companyId = societeDe(req);
    if (!companyId) return sansSociete(res);

    const ids = Array.isArray(req.body?.event_ids)
      ? [...new Set(req.body.event_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
      : [];

    if (ids.length === 0) {
      return res.status(400).json({ error: "Aucun événement fourni.", code: "EMPTY" });
    }
    if (ids.length > MAX_PAR_LOT) {
      return res.status(400).json({
        error: `Trop d'événements en une fois (${MAX_PAR_LOT} au plus).`, code: "TOO_MANY" });
    }

    const TYPE_PAR_SENS = {
      OUT: { type: "Bon de sortie", prefixe: "BS" },
      IN: { type: "Bon de réception", prefixe: "BR" },
      TRANSFER_SOURCE: { type: "Bon de transfert", prefixe: "BT" },
      TRANSFER_DESTINATION: { type: "Bon de transfert", prefixe: "BT" },
    };

    try {
      const out = await transaction(async (client) => {
        const { rows: evenements } = await client.query(
          `SELECT e.*, e.effective_date::text AS date_texte,
                  m.product_reference, m.warehouse_id
             FROM stock_import_movement_events e
             LEFT JOIN stock_movements m ON m.id = e.movement_id
            WHERE e.id = ANY($1::bigint[]) AND e.company_id = $2
            ORDER BY e.id
            FOR UPDATE OF e`,
          [ids, companyId]);

        const trouves = new Set(evenements.map((e) => Number(e.id)));
        const crees = [];
        const refuses = [];

        for (const id of ids) {
          if (!trouves.has(id)) {
            refuses.push({ id, motif: "événement introuvable dans cette entreprise" });
          }
        }

        for (const e of evenements) {
          if (e.status === "CANCELLED") {
            refuses.push({ id: Number(e.id), motif: "événement annulé" });
            continue;
          }

          const { rows: existants } = await client.query(
            `SELECT id, document_number, document_type FROM documents
              WHERE company_id = $1 AND stock_import_movement_event_id = $2
                AND cancelled_at IS NULL LIMIT 1`,
            [companyId, e.id]);
          if (existants[0]) {
            refuses.push({
              id: Number(e.id), motif: "un document actif existe déjà",
              document: existants[0],
            });
            continue;
          }

          const regle = TYPE_PAR_SENS[e.direction] || { type: "Document stock", prefixe: "DOC" };
          const numero = await nextShortDocumentNumber(regle.prefixe, companyId, client);
          const produit = e.source_context?.produit || "Article";
          const provenance = `Sortie EM2S — ${e.source_context?.fichier || "import"}`
            + ` · feuille ${e.excel_sheet} · ligne ${e.excel_row} · cellule ${e.excel_cell}`
            + (e.movement_id ? ` · mouvement #${e.movement_id}` : " · sans mouvement rattaché");

          const { rows: doc } = await client.query(
            `INSERT INTO documents
               (document_type, document_number, client_name, client_phone, client_address,
                total_amount, observation, created_by, company_id,
                related_entity_type, related_entity_id, stock_movement_id,
                stock_import_movement_event_id, warehouse_id, status, document_datetime)
             VALUES ($1,$2,'','','',0,$3,$4,$5,'stock_import_movement_event',
                     $6::integer,$7::integer,$6::bigint,$8::integer,'Validé',$9::timestamptz)
             RETURNING *`,
            [regle.type, numero, provenance, nomDe(req), companyId,
             e.id, e.movement_id, e.warehouse_id || null,
             `${e.date_texte}T12:00:00Z`]);

          /* La quantité de l'ÉVÉNEMENT. Reprendre celle du mouvement
             imprimerait 20 là où la sortie était de 7. */
          await client.query(
            `INSERT INTO document_items
               (document_id, product_reference, product_name, quantity, unit_price, total_price)
             VALUES ($1,$2,$3,$4,0,0)`,
            [doc[0].id, e.product_reference, produit, Number(e.quantity)]);

          crees.push({
            documentId: doc[0].id, numero, type: regle.type,
            evenementId: Number(e.id), sens: e.direction,
            quantite: Number(e.quantity), produit,
            ligneExcel: e.excel_row, date: e.date_texte,
            mouvementId: e.movement_id,
          });
        }

        return { crees, refuses };
      });

      res.status(201).json({
        success: true,
        crees: out.crees.length,
        refuses: out.refuses.length,
        documents: out.crees,
        evenementsRefuses: out.refuses,
      });
    } catch (e) { echec(res, e, "Erreur de génération groupée par événement."); }
  });

  /* ═════════════════════════════════════ GÉNÉRATION GROUPÉE ══ */

  /**
   * Génère un document par mouvement, en UNE transaction.
   *
   * Une boucle côté navigateur qui appelle la route unitaire N fois ne donne
   * pas cela : si la moitié échoue, la moitié des bons existe déjà, avec des
   * numéros consommés, et personne ne sait où reprendre.
   */
  router.post("/documents/from-movements", authenticateToken, peutCreer, async (req, res) => {
    const companyId = societeDe(req);
    if (!companyId) return sansSociete(res);

    const ids = Array.isArray(req.body?.movement_ids)
      ? [...new Set(req.body.movement_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
      : [];

    if (ids.length === 0) {
      return res.status(400).json({ error: "Aucun mouvement fourni.", code: "EMPTY" });
    }
    if (ids.length > MAX_PAR_LOT) {
      return res.status(400).json({
        error: `Trop de mouvements en une fois (${MAX_PAR_LOT} au plus).`, code: "TOO_MANY" });
    }

    try {
      const out = await transaction(async (client) => {
        /* Les mouvements sont verrouillés dans l'ordre de leur identifiant :
           deux lots qui se croisent attendent l'un l'autre au lieu de se
           bloquer mutuellement. */
        const { rows: mouvements } = await client.query(
          `SELECT * FROM stock_movements
            WHERE id = ANY($1::int[]) AND company_id = $2
            ORDER BY id
            FOR UPDATE`,
          [ids, companyId]
        );

        const trouves = new Set(mouvements.map((m) => m.id));
        const crees = [];
        const refuses = [];

        for (const id of ids) {
          if (!trouves.has(id)) {
            /* Introuvable ici veut dire « pas dans cette entreprise » aussi
               bien que « n'existe pas » : on ne révèle pas la différence. */
            refuses.push({ id, motif: "mouvement introuvable dans cette entreprise" });
          }
        }

        for (const m of mouvements) {
          if (m.status !== "Validé") {
            refuses.push({ id: m.id, motif: `statut « ${m.status} » : seuls les mouvements validés se documentent` });
            continue;
          }

          const { rows: existants } = await client.query(
            `SELECT id, document_number, document_type FROM documents
              WHERE company_id = $1 AND stock_movement_id = $2 AND cancelled_at IS NULL
              LIMIT 1`,
            [companyId, m.id]
          );
          if (existants[0]) {
            /* Rejouer le même lot ne crée rien de plus : le document existant
               est signalé, pas dupliqué. */
            refuses.push({
              id: m.id, motif: "un document actif existe déjà",
              document: existants[0],
            });
            continue;
          }

          const regle = TYPE_PAR_MOUVEMENT[m.type]
            || { type: "Document stock", prefixe: "DOC" };
          const numero = await nextShortDocumentNumber(regle.prefixe, companyId, client);

          const { rows: doc } = await client.query(
            `INSERT INTO documents
               (document_type, document_number, client_name, client_phone, client_address,
                total_amount, observation, created_by, company_id,
                related_entity_type, related_entity_id, stock_movement_id,
                warehouse_id, status)
             VALUES ($1,$2,'','','',0,$3,$4,$5,'stock_movement',$6,$6,$7,'Validé')
             RETURNING *`,
            [regle.type, numero,
             `Document généré depuis mouvement stock ID ${m.id} - ${m.type}`,
             m.created_by_name || nomDe(req), companyId, m.id, m.warehouse_id || null]
          );

          /* La quantité imprimée part de celle du mouvement, à l'unité près.
             C'est ce lien qui garantit qu'un bon ne cumule jamais l'ancienne
             sortie avec la nouvelle : un mouvement, un document, sa quantité. */
          await client.query(
            `INSERT INTO document_items
               (document_id, product_reference, product_name, quantity, unit_price, total_price)
             VALUES ($1,$2,$3,$4,0,0)`,
            [doc[0].id, m.product_reference, m.product_name, Number(m.quantity || 0)]
          );

          crees.push({
            documentId: doc[0].id, numero, type: regle.type,
            mouvementId: m.id, sens: m.type, quantite: Number(m.quantity || 0),
            produit: m.product_name,
          });
        }

        return { crees, refuses };
      });

      res.status(201).json({
        success: true,
        crees: out.crees.length,
        refuses: out.refuses.length,
        documents: out.crees,
        mouvementsRefuses: out.refuses,
      });
    } catch (e) { echec(res, e, "Erreur de génération groupée."); }
  });

  /* ═══════════════════════════ CORRIGER LE CONTENU IMPRIMÉ ══ */

  /**
   * Corrige le numéro et les quantités IMPRIMÉS. Rien d'autre.
   *
   * Aucune écriture ici ne touche `stock_movements`, `products.stock` ni
   * `stock_location_balances` : le papier était faux, la marchandise ne l'est
   * pas. Confondre les deux ferait « corriger » un stock que personne n'a
   * recompté.
   */
  router.patch("/documents/:id/content", authenticateToken, peutModifier, async (req, res) => {
    const companyId = societeDe(req);
    if (!companyId) return sansSociete(res);
    try {
      const out = await transaction(async (client) => {
        const { rows } = await client.query(
          `SELECT * FROM documents WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [Number(req.params.id), companyId]
        );
        const doc = rows[0];
        if (!doc) throw erreur("Document introuvable.", "NOT_FOUND", 404);
        if (doc.cancelled_at) {
          throw erreur("Ce document est annulé : corrigez son remplaçant.", "CANCELLED", 409);
        }

        const motif = String(req.body?.reason || "").trim();
        if (!motif) throw erreur("Un motif est obligatoire.", "REASON_REQUIRED");

        const nouveauNumero = String(req.body?.document_number || "").trim();
        if (!nouveauNumero) throw erreur("Le numéro du document est obligatoire.", "NUMBER_REQUIRED");

        const lignes = Array.isArray(req.body?.items) ? req.body.items : null;
        if (!lignes || lignes.length === 0) {
          throw erreur("Indiquez au moins une ligne.", "ITEMS_REQUIRED");
        }

        const dejaImprime = Number(doc.print_count || 0) > 0;
        if (dejaImprime) {
          /* Un bon déjà sorti a pu partir chez quelqu'un : le corriger demande
             un droit distinct de celui de corriger un brouillon. */
          const ctx = await permissionsService.chargerContexte(pool, req.user, companyId);
          const verdict = permissionsService.decider(ctx, "document", "reprint");
          if (!verdict.autorise) {
            throw erreur(
              "Ce document a déjà été imprimé : le corriger demande le droit de réimpression.",
              "REPRINT_REQUIRED", 403);
          }
        }

        /* Le numéro identifie le document pour toute l'entreprise. Deux bons
           du même numéro rendraient l'archivage inexploitable. */
        if (nouveauNumero !== doc.document_number) {
          const { rows: collision } = await client.query(
            `SELECT id FROM documents
              WHERE company_id = $1 AND document_number = $2 AND id <> $3 LIMIT 1`,
            [companyId, nouveauNumero, doc.id]
          );
          if (collision[0]) {
            throw erreur(
              `Le numéro « ${nouveauNumero} » est déjà porté par un autre document.`,
              "NUMBER_TAKEN", 409);
          }
        }

        const { rows: avant } = await client.query(
          `SELECT id, product_reference, product_name, quantity, unit_price, total_price
             FROM document_items WHERE document_id = $1 ORDER BY id`,
          [doc.id]
        );
        const parId = new Map(avant.map((l) => [l.id, l]));

        const apres = [];
        for (const ligne of lignes) {
          const id = Number(ligne.id);
          const ancienne = parId.get(id);
          if (!ancienne) throw erreur(`Ligne ${ligne.id} absente de ce document.`, "ITEM_UNKNOWN");

          const quantite = Number(ligne.quantity);
          if (!Number.isFinite(quantite) || quantite <= 0) {
            throw erreur(
              `Quantité invalide pour « ${ancienne.product_name} » : elle doit être strictement positive.`,
              "QUANTITY_INVALID");
          }

          await client.query(
            `UPDATE document_items SET quantity = $1 WHERE id = $2 AND document_id = $3`,
            [quantite, id, doc.id]
          );
          apres.push({ ...ancienne, quantity: quantite });
        }

        const revision = Number(doc.document_revision || 0) + 1;

        /* L'historique est écrit AVANT la mise à jour du document : si quoi
           que ce soit échoue ensuite, la transaction annule les deux, et on ne
           se retrouve jamais avec un contenu changé sans trace. */
        await client.query(
          `INSERT INTO document_content_revisions
             (company_id, document_id, revision, old_document_number, new_document_number,
              old_items, new_items, reason, was_printed, changed_by, changed_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [companyId, doc.id, revision, doc.document_number, nouveauNumero,
           JSON.stringify(avant), JSON.stringify(apres), motif, dejaImprime,
           req.user?.id || null, nomDe(req)]
        );

        const { rows: majs } = await client.query(
          `UPDATE documents
              SET document_number = $1, document_revision = $2, updated_at = now()
            WHERE id = $3
            RETURNING id, document_number, document_revision, print_count, printed_at`,
          [nouveauNumero, revision, doc.id]
        );

        return {
          document: majs[0], revision,
          ancienNumero: doc.document_number,
          lignesAvant: avant, lignesApres: apres,
          apresImpression: dejaImprime,
        };
      });

      res.json({
        success: true, ...out,
        note: "Seul le document a changé. Le mouvement, le stock du produit et "
            + "les balances d'emplacement sont intacts.",
      });
    } catch (e) { echec(res, e, "Erreur de correction du document."); }
  });

  router.get("/documents/:id/content-revisions", authenticateToken, peutVoir, async (req, res) => {
    const companyId = societeDe(req);
    if (!companyId) return sansSociete(res);
    try {
      const { rows } = await pool.query(
        `SELECT * FROM document_content_revisions
          WHERE document_id = $1 AND company_id = $2 ORDER BY revision`,
        [Number(req.params.id), companyId]
      );
      res.json({ success: true, revisions: rows });
    } catch (e) { echec(res, e, "Erreur de lecture de l'historique."); }
  });

  /* ═══════════════════════════════ ANNULER EN REMPLAÇANT ══ */

  /**
   * Marque un document comme annulé et, si on le demande, génère son
   * remplaçant depuis le même mouvement.
   *
   * On ne supprime jamais : un numéro déjà sorti a pu partir chez un
   * transporteur. Il reste consultable, marqué, et pointe vers son remplaçant.
   */
  router.post("/documents/:id/cancel-replace", authenticateToken, peutModifier,
    async (req, res) => {
      const companyId = societeDe(req);
      if (!companyId) return sansSociete(res);
      try {
        const out = await transaction(async (client) => {
          const { rows } = await client.query(
            `SELECT * FROM documents WHERE id = $1 AND company_id = $2 FOR UPDATE`,
            [Number(req.params.id), companyId]
          );
          const doc = rows[0];
          if (!doc) throw erreur("Document introuvable.", "NOT_FOUND", 404);
          if (doc.cancelled_at) throw erreur("Ce document est déjà annulé.", "ALREADY_CANCELLED", 409);

          const motif = String(req.body?.reason || "").trim();
          if (!motif) throw erreur("Un motif d'annulation est obligatoire.", "REASON_REQUIRED");

          const remplacer = req.body?.replace !== false;
          let remplacant = null;

          await client.query(
            `UPDATE documents
                SET cancelled_at = now(), cancelled_by = $1, cancelled_by_name = $2,
                    cancellation_reason = $3, status = 'Annulé', updated_at = now()
              WHERE id = $4`,
            [req.user?.id || null, nomDe(req), motif, doc.id]
          );

          if (remplacer && doc.stock_movement_id) {
            const { rows: mvts } = await client.query(
              `SELECT * FROM stock_movements WHERE id = $1 AND company_id = $2 FOR UPDATE`,
              [doc.stock_movement_id, companyId]
            );
            const m = mvts[0];
            if (!m) throw erreur("Le mouvement d'origine est introuvable.", "MOVEMENT_NOT_FOUND", 409);

            const regle = TYPE_PAR_MOUVEMENT[m.type] || { type: "Document stock", prefixe: "DOC" };
            const numero = await nextShortDocumentNumber(regle.prefixe, companyId, client);

            const { rows: nouveau } = await client.query(
              `INSERT INTO documents
                 (document_type, document_number, client_name, client_phone, client_address,
                  total_amount, observation, created_by, company_id,
                  related_entity_type, related_entity_id, stock_movement_id,
                  warehouse_id, status, replaces_document_id)
               VALUES ($1,$2,'','','',0,$3,$4,$5,'stock_movement',$6,$6,$7,'Validé',$8)
               RETURNING *`,
              [regle.type, numero,
               `Remplace ${doc.document_number} — ${motif}`,
               nomDe(req), companyId, m.id, m.warehouse_id || null, doc.id]
            );
            remplacant = nouveau[0];

            /* Le remplaçant reprend la quantité du MOUVEMENT, pas celle du
               document annulé : si l'ancien bon était faux, recopier son
               contenu reproduirait l'erreur. */
            await client.query(
              `INSERT INTO document_items
                 (document_id, product_reference, product_name, quantity, unit_price, total_price)
               VALUES ($1,$2,$3,$4,0,0)`,
              [remplacant.id, m.product_reference, m.product_name, Number(m.quantity || 0)]
            );

            await client.query(
              `UPDATE documents SET replaced_by_document_id = $1 WHERE id = $2`,
              [remplacant.id, doc.id]
            );
          }

          return {
            annule: {
              id: doc.id, numero: doc.document_number, type: doc.document_type,
              motif, par: nomDe(req),
            },
            remplacant: remplacant
              ? { id: remplacant.id, numero: remplacant.document_number,
                  type: remplacant.document_type }
              : null,
          };
        });

        res.json({
          success: true, ...out,
          note: "Le document annulé garde son numéro, sa date et ses lignes. "
              + "Il sort des impressions mais reste consultable.",
        });
      } catch (e) { echec(res, e, "Erreur d'annulation."); }
    });

  return router;
};

module.exports.TYPE_PAR_MOUVEMENT = TYPE_PAR_MOUVEMENT;
module.exports.PREFIXE_PAR_TYPE = PREFIXE_PAR_TYPE;
module.exports.MAX_PAR_LOT = MAX_PAR_LOT;
