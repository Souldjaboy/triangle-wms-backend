"use strict";

/**
 * LE TÉLÉCHARGEMENT DES PIÈCES JOINTES DU CHAT, SOUS CONTRÔLE.
 *
 *   GET /chat/attachments/:fichier        télécharger
 *   GET /chat/attachments/:fichier/apercu afficher dans le navigateur
 *   GET /uploads/chat/:fichier            ← l'ANCIENNE adresse, désormais gardée
 *   GET /chat/attachments-journal         qui a ouvert quoi (direction)
 *
 * POURQUOI L'ANCIENNE ADRESSE EST GARDÉE PLUTÔT QUE SUPPRIMÉE.
 *
 * Les messages déjà envoyés portent « /uploads/chat/<nom> » dans leur
 * `file_url`. Supprimer cette route casserait tout l'historique du chat. Ce
 * routeur l'intercepte donc AVANT `express.static`, applique les mêmes
 * contrôles, et sert le fichier — ou le refuse. L'historique continue de
 * fonctionner, et il cesse d'être public.
 *
 * L'ORDRE DE MONTAGE EST LA CORRECTION ELLE-MÊME. Monté après
 * `express.static`, ce routeur ne serait jamais atteint : le fichier serait
 * déjà parti, sans jeton. Il se monte donc juste avant, et server.js porte un
 * commentaire qui le dit.
 */

const fs = require("fs");
const P = require("../services/pieces-jointes-chat");

module.exports = function createPiecesJointesChatRouter(deps) {
  const express = require("express");
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission } = deps;
  const router = express.Router();

  const utilisateurDe = (req) => ({
    id: req.user?.id || null,
    name: req.user?.fullname || req.user?.email || "Utilisateur",
  });
  const ipDe = (req) =>
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "";

  async function servir(req, res, { enLigne }) {
    const companyId = Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
    const nomFichier = req.params.fichier;
    const utilisateur = utilisateurDe(req);

    if (!companyId) {
      return res.status(409).json({ error: "Entreprise active requise.", code: "COMPANY_REQUIRED" });
    }

    let r;
    try {
      r = await P.resoudre(pool, { companyId, userId: utilisateur.id, nomFichier });
    } catch (e) {
      console.error("pièce jointe — résolution :", e);
      return res.status(500).json({ error: "Lecture impossible.", code: "ATTACHMENT_LOOKUP_FAILED" });
    }

    await P.journaliser(pool, {
      companyId, message: r.message, nomFichier, resultat: r.resultat,
      utilisateur, ip: ipDe(req),
    });

    if (r.resultat !== P.RESULTATS.SERVI) {
      /* UN SEUL MESSAGE POUR TOUS LES REFUS, ET LE MÊME CODE.
         Distinguer « ce fichier n'existe pas » de « ce fichier existe mais
         n'est pas pour vous » apprendrait à un curieux quels noms sont
         valides. Le journal, lui, garde la vraie raison. */
      return res.status(404).json({
        error: "Pièce jointe introuvable.",
        code: "ATTACHMENT_NOT_FOUND",
      });
    }

    const mime = r.message.file_mime || "application/octet-stream";
    const afficher = enLigne && P.AFFICHABLES.has(String(mime).split(";")[0].trim());
    P.entetes(res, {
      nomOrigine: r.message.file_name || r.nom,
      mime, taille: r.message.file_size, enLigne: afficher,
    });

    const flux = fs.createReadStream(r.chemin);
    flux.on("error", (e) => {
      console.error("pièce jointe — lecture du fichier :", e.message);
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    flux.pipe(res);
  }

  router.get("/chat/attachments/:fichier/apercu", authenticateToken,
    (req, res) => servir(req, res, { enLigne: true }));

  router.get("/chat/attachments/:fichier", authenticateToken,
    (req, res) => servir(req, res, { enLigne: false }));

  /* L'ancienne adresse, pour l'historique déjà enregistré. Mêmes contrôles.
     Elle sert en ligne lorsque le type s'y prête, car c'est ce que les
     messages existants attendent : une image s'affichait, elle doit
     continuer de s'afficher. */
  router.get("/uploads/chat/:fichier", authenticateToken,
    (req, res) => servir(req, res, { enLigne: true }));

  /* ─────────────────── QUI A OUVERT QUOI ─────────────────── */
  router.get("/chat/attachments-journal",
    authenticateToken, requirePermission("chat", "view"),
    async (req, res) => {
      const companyId = Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
      if (!companyId) return res.status(409).json({ error: "Entreprise active requise." });
      try {
        const params = [companyId];
        let filtre = "";
        if (req.query.refus === "1") filtre = "AND a.outcome <> 'SERVI'";
        const { rows } = await pool.query(
          `SELECT a.*, m.file_name AS nom_origine
             FROM chat_attachment_access a
             LEFT JOIN messages m ON m.id = a.message_id
            WHERE a.company_id = $1 ${filtre}
            ORDER BY a.accessed_at DESC
            LIMIT 200`, params);
        res.json({ acces: rows });
      } catch (e) {
        console.error("journal des pièces jointes :", e);
        res.status(500).json({ error: "Lecture du journal impossible." });
      }
    });

  return router;
};
