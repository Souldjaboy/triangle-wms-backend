"use strict";

/**
 * LE PDF D'UN BON DE LIVRAISON — un seul endroit, trois familles de bons.
 *
 *   GET /bons-livraison/sable/:id/pdf
 *   GET /bons-livraison/ciment/:id/pdf
 *   GET /bons-livraison/document/:id/pdf
 *
 * Toutes servent le MÊME document : celui que le navigateur télécharge, celui
 * que le téléphone partage, celui que l'email joint. Rien n'est fabriqué côté
 * navigateur — sans quoi le bon envoyé par WhatsApp finirait par différer de
 * celui du classeur, et personne ne s'en apercevrait avant qu'un client les
 * compare.
 *
 * `?disposition=inline` sert l'aperçu dans un onglet ; sans ce paramètre, le
 * navigateur télécharge. Le téléchargement est le défaut parce que c'est ce
 * qu'on attend d'un bouton nommé « Télécharger PDF ».
 */

const express = require("express");
const P = require("../services/pdf-bon-livraison");

module.exports = function createBonsLivraisonPdfRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission } = deps;
  const router = express.Router();

  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const echec = (res, e, message) => {
    console.error(message, e);
    res.status(e?.httpStatus || 500).json({ error: e?.message || message });
  };

  /** L'identité de la société, telle qu'elle doit apparaître en tête du bon. */
  async function societeDe(companyId) {
    const { rows } = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(s.company_name), ''), c.name) AS nom,
              s.address AS adresse, s.phone AS telephone, s.email,
              COALESCE(s.default_delivered_by, '') AS livreur_par_defaut
         FROM companies c
         LEFT JOIN company_settings s ON s.company_id = c.id
        WHERE c.id = $1
        LIMIT 1`,
      [companyId]
    );
    return rows[0] || { nom: "", adresse: "", telephone: "", email: "", livreur_par_defaut: "" };
  }

  /**
   * Envoie le PDF.
   *
   * Le nom du fichier est répété dans `filename*` au format RFC 5987 : sans
   * lui, un nom contenant un accent arrive tronqué ou abîmé selon le
   * navigateur. `filename` reste là pour les plus anciens.
   */
  function servir(res, buffer, nom, disposition) {
    const type = disposition === "inline" ? "inline" : "attachment";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader(
      "Content-Disposition",
      `${type}; filename="${nom}"; filename*=UTF-8''${encodeURIComponent(nom)}`
    );
    /* Sans cet en-tête, le navigateur CACHE `Content-Disposition` à la page
       en cross-origin : il n'est pas dans la liste des en-têtes exposés par
       défaut. Le frontend retombait alors sur un nom de secours — « BL_39.pdf »
       au lieu de « BL_00125_FAT_ET_MAT.pdf » —, et le client recevait un
       fichier nommé d'après un identifiant interne qui ne lui dit rien.
       Le serveur et l'application ne sont pas sur la même origine en
       production non plus : c'est le cas normal, pas une particularité du
       poste de développement. */
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

    /* Le bon peut être corrigé ou annulé : un cache le ferait ressortir
       inchangé après la correction. */
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SABLE
  // ═══════════════════════════════════════════════════════════════════════
  router.get(
    "/bons-livraison/sable/:id/pdf",
    authenticateToken,
    requirePermission("sable", "print"),
    async (req, res) => {
      const companyId = companyOf(req);
      if (!companyId) return res.status(409).json({ error: "Entreprise active requise." });
      try {
        const { rows } = await pool.query(
          `SELECT d.*, d.delivery_date::text AS date_livraison,
                  c.name AS client_nom, s.sale_number
             FROM sand_deliveries d
             LEFT JOIN sand_sales s ON s.id = d.sale_id
             LEFT JOIN sand_customers c ON c.id = s.customer_id
            WHERE d.id = $1 AND d.company_id = $2`,
          [Number(req.params.id), companyId]
        );
        const bl = rows[0];
        if (!bl) return res.status(404).json({ error: "Bon de livraison introuvable." });

        const societe = await societeDe(companyId);
        const buffer = await P.genererPdfBonLivraison({
          titre: "BON DE LIVRAISON",
          numero: bl.delivery_number,
          societe,
          infos: [
            ["Date de livraison", P.jour(bl.date_livraison)],
            ["Client", bl.client_nom],
            ["Destination", bl.destination],
            ["Camion", bl.truck],
            ["Chauffeur", bl.driver_name],
            ["Bon de pesée", bl.voucher_number],
          ],
          colonnes: [
            { cle: "designation", titre: "Désignation", largeur: 320 },
            { cle: "quantite", titre: "Quantité", largeur: 105, align: "right" },
            { cle: "unite", titre: "Unité", largeur: 90 },
          ],
          lignes: [{
            designation: "Sable",
            quantite: Number(bl.quantity_m3 || 0).toLocaleString("fr-FR"),
            unite: "m³",
          }],
          observation: bl.notes,
          recuPar: bl.received_by,
          /* Le nom déjà enregistré fait foi ; à défaut, le livreur réglé pour
             la société. On n'invente jamais un nom. */
          livrePar: bl.delivered_by || societe.livreur_par_defaut || "",
          annule: Boolean(bl.cancelled_at),
          motifAnnulation: bl.cancellation_reason,
        });

        servir(res, buffer,
          P.nomFichier({ numero: bl.delivery_number, societe: societe.nom }),
          req.query?.disposition);
      } catch (e) { echec(res, e, "Génération du PDF impossible."); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // CIMENT
  // ═══════════════════════════════════════════════════════════════════════
  router.get(
    "/bons-livraison/ciment/:id/pdf",
    authenticateToken,
    requirePermission("ciment", "print"),
    async (req, res) => {
      const companyId = companyOf(req);
      if (!companyId) return res.status(409).json({ error: "Entreprise active requise." });
      try {
        const { rows } = await pool.query(
          `SELECT d.*, d.delivery_date::text AS date_livraison, c.name AS client_nom
             FROM cement_deliveries d
             LEFT JOIN cement_sales s ON s.id = d.sale_id
             LEFT JOIN cement_customers c ON c.id = s.customer_id
            WHERE d.id = $1 AND d.company_id = $2`,
          [Number(req.params.id), companyId]
        );
        const bl = rows[0];
        if (!bl) return res.status(404).json({ error: "Bon de livraison introuvable." });

        const societe = await societeDe(companyId);
        const buffer = await P.genererPdfBonLivraison({
          titre: "BON DE LIVRAISON",
          numero: bl.delivery_number,
          societe,
          infos: [
            ["Date de livraison", P.jour(bl.date_livraison)],
            ["Client", bl.client_nom],
            ["Destination", bl.destination],
            ["Camion", bl.truck],
            ["Chauffeur", bl.driver_name],
            ["Bon de pesée", bl.tonnage_voucher_number],
          ],
          colonnes: [
            { cle: "designation", titre: "Désignation", largeur: 320 },
            { cle: "quantite", titre: "Quantité", largeur: 105, align: "right" },
            { cle: "unite", titre: "Unité", largeur: 90 },
          ],
          lignes: [{
            designation: "Ciment",
            quantite: Number(bl.tonnage || 0).toLocaleString("fr-FR"),
            unite: "t",
          }],
          observation: bl.notes,
          recuPar: bl.received_by_name,
          livrePar: bl.delivered_by_name || societe.livreur_par_defaut || "",
          annule: Boolean(bl.cancelled_at),
        });

        servir(res, buffer,
          P.nomFichier({ numero: bl.delivery_number, societe: societe.nom }),
          req.query?.disposition);
      } catch (e) { echec(res, e, "Génération du PDF impossible."); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // DOCUMENTS DE STOCK (bons de sortie, d'entrée, de livraison)
  // ═══════════════════════════════════════════════════════════════════════
  router.get(
    "/bons-livraison/document/:id/pdf",
    authenticateToken,
    requirePermission("document", "print"),
    async (req, res) => {
      const companyId = companyOf(req);
      if (!companyId) return res.status(409).json({ error: "Entreprise active requise." });
      try {
        const { rows } = await pool.query(
          `SELECT * FROM documents WHERE id = $1 AND company_id = $2`,
          [Number(req.params.id), companyId]
        );
        const bl = rows[0];
        if (!bl) return res.status(404).json({ error: "Document introuvable." });

        const { rows: lignes } = await pool.query(
          `SELECT * FROM document_items WHERE document_id = $1 ORDER BY id`,
          [bl.id]
        );

        const societe = await societeDe(companyId);
        const buffer = await P.genererPdfBonLivraison({
          titre: String(bl.document_type || "BON").toUpperCase(),
          numero: bl.document_number,
          societe,
          infos: [
            ["Date", P.jour(bl.document_datetime || bl.created_at)],
            ["Client", bl.client_name],
            ["Téléphone", bl.client_phone],
            ["Adresse", bl.client_address],
          ],
          colonnes: [
            { cle: "designation", titre: "Désignation", largeur: 245 },
            { cle: "quantite", titre: "Quantité", largeur: 80, align: "right" },
            { cle: "prix", titre: "Prix unitaire", largeur: 95, align: "right" },
            { cle: "montant", titre: "Montant", largeur: 95, align: "right" },
          ],
          lignes: lignes.map((l) => ({
            designation: l.product_name || l.designation || "—",
            quantite: Number(l.quantity || 0).toLocaleString("fr-FR"),
            prix: l.unit_price != null ? P.fcfa(l.unit_price) : "—",
            montant: l.total_price != null ? P.fcfa(l.total_price) : "—",
          })),
          total: bl.total_amount != null ? P.fcfa(bl.total_amount) : null,
          observation: bl.observation,
          livrePar: societe.livreur_par_defaut || "",
          annule: Boolean(bl.cancelled_at),
          motifAnnulation: bl.cancellation_reason,
        });

        servir(res, buffer,
          P.nomFichier({ numero: bl.document_number, societe: societe.nom }),
          req.query?.disposition);
      } catch (e) { echec(res, e, "Génération du PDF impossible."); }
    }
  );

  return router;
};
