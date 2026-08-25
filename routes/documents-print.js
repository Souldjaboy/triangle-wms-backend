"use strict";

/**
 * IMPRESSION GROUPÉE DE DOCUMENTS — LECTURE SEULE.
 *
 * Ces routes ne font que LIRE. Aucun document créé, renuméroté ou supprimé,
 * aucune quantité touchée, aucun mouvement de stock, aucune balance.
 *
 *   GET /documents/print/author-preview  quels documents viennent du dernier
 *                                        import Excel — comptages seulement
 *   GET /documents/print/batch?ids=…     documents + lignes pour une impression
 *                                        groupée en un seul travail
 *
 * SUBSTITUTION D'AUTEUR : le compte technique ayant servi à l'import n'est pas
 * l'auteur métier des bons. Le nom affiché est donc remplacé À L'IMPRESSION,
 * pour les seuls documents issus du dernier import. La colonne created_by
 * n'est JAMAIS réécrite : l'historique reste intact et la substitution reste
 * réversible en changeant une constante.
 */

const express = require("express");
const D = require("../services/document-dates");

/* Compte technique de l'import, et identité métier à afficher à sa place.
   « fonction » est le libellé lisible porté sur le bon papier ; « role » est
   l'identifiant technique du rôle, gardé ici pour que les deux ne divergent
   pas. Le badge rend le bon opposable : il désigne un agent, pas un compte. */
const AUTEUR_IMPORT = "diallogcif@gmail.com";
const AUTEUR_AFFICHE = {
  nom: "Amary Zerbo",
  fonction: "Responsable d'entrepôt",
  role: "responsable_entrepot",
  badge: "TRIANGLE-EMP-23",
  email: "amazerbo@trianglelti.com",
};

const TYPE_RECEPTION = "RECEPTION";
const TYPE_SORTIE = "SORTIE";

/* Le libellé de type est du texte libre selon l'origine du document : on le
   normalise pour filtrer, sans jamais le réécrire en base. */
function familleDocument(type) {
  const t = String(type || "").toUpperCase();
  if (/RECEPTION|RÉCEPTION|ENTR[EÉ]E|RECU|REÇU/.test(t)) return TYPE_RECEPTION;
  if (/SORTIE|LIVRAISON|BON DE SORTIE|EXIT/.test(t)) return TYPE_SORTIE;
  return "AUTRE";
}

module.exports = function createDocumentsPrintRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission } = deps;
  const router = express.Router();
  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const canView = requirePermission("document", "view");

  const fail = (res, e, defaut) => {
    console.error(defaut, e);
    res.status(e.httpStatus || 500).json({ error: e.message || defaut, code: e.code });
  };

  /* Documents issus du DERNIER import : le lien est prouvé par
     stock_movements.import_id, pas deviné à partir d'une date. */
  const SQL_DERNIER_IMPORT = `
    WITH dernier AS (
      SELECT id, file_name, imported_at
        FROM inventory_imports
       WHERE company_id = $1 AND COALESCE(status,'') <> 'ROLLED_BACK'
       ORDER BY id DESC LIMIT 1
    )
    SELECT d.id, d.document_number, d.document_type, d.created_at, d.created_by,
           d.operation_effective_at, d.document_datetime, d.document_revision,
           (SELECT id FROM dernier) AS import_id,
           (SELECT file_name FROM dernier) AS import_file
      FROM documents d
      JOIN stock_movements m ON m.id = d.stock_movement_id
     WHERE d.company_id = $1
       AND m.import_id = (SELECT id FROM dernier)`;

  /**
   * PREVIEW — strictement informatif, aucune écriture.
   * Dit exactement quels documents seraient concernés par la substitution.
   */
  router.get("/documents/print/author-preview", authenticateToken, canView, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const { rows } = await pool.query(`${SQL_DERNIER_IMPORT} ORDER BY d.id`, [companyId]);

      const parFamille = { RECEPTION: [], SORTIE: [], AUTRE: [] };
      rows.forEach((d) => parFamille[familleDocument(d.document_type)].push(d));
      const bornes = (l) => l.length
        ? {
            premier: l[0].document_number, dernier: l[l.length - 1].document_number,
            du: l[0].created_at, au: l[l.length - 1].created_at,
          }
        : null;

      /* Un document déjà signé par quelqu'un d'autre n'est pas concerné : on ne
         réécrit que ce qui porte le compte technique de l'import. */
      const concernes = rows.filter(
        (d) => String(d.created_by || "").trim().toLowerCase() === AUTEUR_IMPORT
      );

      res.json({
        import: rows[0] ? { id: rows[0].import_id, fichier: rows[0].import_file } : null,
        total: rows.length,
        receptions: { nombre: parFamille.RECEPTION.length, ...bornes(parFamille.RECEPTION) },
        sorties: { nombre: parFamille.SORTIE.length, ...bornes(parFamille.SORTIE) },
        autres: parFamille.AUTRE.length,
        auteur_actuel: AUTEUR_IMPORT,
        auteur_affiche: AUTEUR_AFFICHE,
        documents_concernes: concernes.length,
        documents_non_concernes: rows.length - concernes.length,
        /* Preuve que rien n'est modifié : la substitution est un rendu. */
        modification_base: false,
        documents: rows.map((d) => ({
          id: d.id, numero: d.document_number, type: d.document_type,
          famille: familleDocument(d.document_type),
          date: D.dateAAfficher(d).instant,
          date_affichee: D.versLocal(D.dateAAfficher(d).instant),
          auteur_actuel: d.created_by,
          sera_remplace: String(d.created_by || "").trim().toLowerCase() === AUTEUR_IMPORT,
        })),
      });
    } catch (e) { fail(res, e, "Erreur d'analyse des documents importés."); }
  });

  /**
   * LOT À IMPRIMER — documents complets et leurs lignes, tels qu'ils existent.
   * Numéro, date, produits, quantités, prix, total et observations sont rendus
   * à l'identique ; seul le nom affiché de l'auteur peut être substitué.
   */
  router.get("/documents/print/batch", authenticateToken, canView, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const ids = String(req.query.ids || "").split(",")
        .map((x) => Number(String(x).trim())).filter(Boolean).slice(0, 500);
      if (!ids.length) return res.status(400).json({ error: "Aucun document sélectionné." });

      const { rows: documents } = await pool.query(
        `SELECT d.*, m.type AS mouvement_type, m.quantity AS mouvement_quantite,
                m.status AS mouvement_statut, m.stock_before, m.stock_after,
                m.location_code AS mouvement_emplacement, m.import_id
           FROM documents d
           LEFT JOIN stock_movements m ON m.id = d.stock_movement_id
          WHERE d.company_id = $1 AND d.id = ANY($2::int[])
          ORDER BY d.document_type, d.document_number, d.id`,
        [companyId, ids]
      );
      if (!documents.length) return res.status(404).json({ error: "Aucun document trouvé." });

      const { rows: lignes } = await pool.query(
        `SELECT * FROM document_items WHERE document_id = ANY($1::int[]) ORDER BY document_id, id`,
        [documents.map((d) => d.id)]
      );
      const parDocument = new Map();
      lignes.forEach((l) => {
        if (!parDocument.has(l.document_id)) parDocument.set(l.document_id, []);
        parDocument.get(l.document_id).push(l);
      });

      /* Identifiants des documents du dernier import : c'est le seul critère
         qui autorise la substitution d'auteur. */
      const { rows: importes } = await pool.query(`${SQL_DERNIER_IMPORT}`, [companyId]);
      const duDernierImport = new Set(importes.map((d) => d.id));

      const societe = (await pool.query(
        `SELECT * FROM company_settings WHERE company_id = $1 LIMIT 1`, [companyId]
      ).catch(() => ({ rows: [] }))).rows[0] || {};

      res.json({
        company: societe,
        documents: documents.map((d) => {
          const substitue = duDernierImport.has(d.id)
            && String(d.created_by || "").trim().toLowerCase() === AUTEUR_IMPORT;
          /* La date imprimée est la date MÉTIER, à l'heure de Bamako. Le lot
             et le bon unitaire doivent afficher la même chose : deux règles
             de date pour un même document, c'est deux documents. */
          const dateAffichee = D.dateAAfficher(d);
          return {
            ...d,
            famille: familleDocument(d.document_type),
            items: parDocument.get(d.id) || [],
            date_affichee: D.versLocal(dateAffichee.instant),
            source_date_affichee: dateAffichee.source,
            fuseau: D.FUSEAU,
            /* L'auteur affiché ; created_by reste tel quel dans la réponse,
               pour que l'écran puisse montrer les deux si besoin. */
            auteur_affiche: substitue ? AUTEUR_AFFICHE : {
              /* Hors substitution, on n'affiche que ce que la base sait : pas
                 de fonction ni de badge inventés pour un compte inconnu. */
              nom: d.created_by || "", fonction: "", role: "", badge: "", email: "",
            },
            auteur_substitue: substitue,
          };
        }),
        totaux: {
          documents: documents.length,
          receptions: documents.filter((d) => familleDocument(d.document_type) === TYPE_RECEPTION).length,
          sorties: documents.filter((d) => familleDocument(d.document_type) === TYPE_SORTIE).length,
        },
      });
    } catch (e) { fail(res, e, "Erreur de préparation de l'impression."); }
  });

  return router;
};
