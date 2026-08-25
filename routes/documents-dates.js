"use strict";

/**
 * DATE ET HEURE MÉTIER DES DOCUMENTS — API.
 *
 * Un bon peut être imprimé plusieurs jours après l'opération qu'il décrit.
 * Jusqu'ici tous les écrans imprimaient `created_at`, c'est-à-dire l'instant
 * où la ligne est entrée en base — un fait technique présenté comme un fait
 * métier. Ces routes permettent de corriger ce qui est IMPRIMÉ sans jamais
 * toucher à ce qui est ENREGISTRÉ.
 *
 *   GET  /documents/:id/dates          les quatre dates + révisions
 *   PUT  /documents/:id/dates          corriger la date affichée
 *   GET  /documents/:id/revisions      historique des corrections
 *   POST /documents/:id/printed        enregistrer une impression réelle
 *   PUT  /stock-movements/:id/operation-date   date de terrain d'un mouvement
 *
 * `created_at` n'est modifiable par AUCUNE de ces routes. C'est volontaire :
 * une date technique qu'on peut réécrire ne prouve plus rien.
 */

const express = require("express");
const D = require("../services/document-dates");

module.exports = function createDocumentDatesRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission } = deps;
  const router = express.Router();

  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const nomDe = (req) => req.user?.fullname || req.user?.email || `#${req.user?.id}`;

  const canView = requirePermission("document", "view");
  const canUpdate = requirePermission("document", "update");
  const canReprint = requirePermission("document", "reprint");
  const canPrint = requirePermission("document", "print");
  const canAudit = requirePermission("document", "audit");

  const fail = (res, e, defaut) => {
    console.error(defaut, e.message || e);
    res.status(e.httpStatus || 500).json({ error: e.message || defaut, code: e.code, details: e.details });
  };

  const tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { client.release(); }
  };

  /**
   * Le document visé, à condition qu'il appartienne à l'entreprise appelante.
   * Un identifiant d'une autre société répond 404 : dire « interdit »
   * confirmerait déjà que ce document existe.
   */
  async function documentDe(runner, companyId, id, { verrou = false } = {}) {
    const { rows } = await runner.query(
      `SELECT d.id, d.company_id, d.document_type, d.document_number,
              d.created_at, d.operation_effective_at, d.document_datetime,
              d.printed_at, d.print_count, d.document_revision,
              d.stock_movement_id,
              m.created_at            AS mouvement_cree_le,
              m.operation_effective_at AS mouvement_effectue_le,
              m.type                  AS mouvement_type
         FROM documents d
         LEFT JOIN stock_movements m ON m.id = d.stock_movement_id
        WHERE d.id = $1 AND d.company_id = $2 ${verrou ? "FOR UPDATE OF d" : ""}`,
      [Number(id) || 0, companyId]
    );
    if (!rows[0]) {
      const e = new Error("Document introuvable.");
      e.httpStatus = 404; e.code = "DOCUMENT_NOT_FOUND";
      throw e;
    }
    return rows[0];
  }

  /** Les quatre dates d'un document, prêtes pour l'écran. */
  const vue = (doc) => {
    const affichee = D.dateAAfficher(doc);
    return {
      id: doc.id,
      document_number: doc.document_number,
      document_type: doc.document_type,
      revision: doc.document_revision,
      print_count: doc.print_count,
      fuseau: D.FUSEAU,
      dates: {
        /* Lecture seule, toujours. C'est le repère qui ne bouge pas. */
        creation_technique: D.versLocal(doc.created_at),
        operation_effective: D.versLocal(doc.operation_effective_at),
        document_affiche: D.versLocal(affichee.instant),
        derniere_impression: D.versLocal(doc.printed_at),
      },
      source_date_affichee: affichee.source,
      /* Tant qu'aucune date métier n'est posée, le bon montre la date de
         création : l'écran doit le dire plutôt que de le laisser croire. */
      date_metier_confirmee: affichee.source !== "creation",
      mouvement: doc.stock_movement_id
        ? {
            id: doc.stock_movement_id, type: doc.mouvement_type,
            creation_technique: D.versLocal(doc.mouvement_cree_le),
            operation_effective: D.versLocal(doc.mouvement_effectue_le),
          }
        : null,
      deja_imprime: Number(doc.print_count || 0) > 0 || Boolean(doc.printed_at),
    };
  };

  /* ─────────────────────────────── LECTURE ─────────────────────────── */

  router.get("/documents/:id/dates", authenticateToken, canView, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const doc = await documentDe(pool, companyId, req.params.id);
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM document_date_revisions
          WHERE company_id = $1 AND document_id = $2`,
        [companyId, doc.id]
      );
      res.json({ ...vue(doc), revisions: rows[0].n });
    } catch (e) { fail(res, e, "Erreur de lecture des dates du document."); }
  });

  router.get("/documents/:id/revisions", authenticateToken, canAudit, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const doc = await documentDe(pool, companyId, req.params.id);
      const { rows } = await pool.query(
        `SELECT id, revision, field, old_value, new_value, reason, was_printed,
                changed_by, changed_by_name, context, changed_at
           FROM document_date_revisions
          WHERE company_id = $1 AND document_id = $2
          ORDER BY revision DESC, id DESC`,
        [companyId, doc.id]
      );
      res.json({
        document_id: doc.id,
        revision_courante: doc.document_revision,
        entries: rows.map((r) => ({
          ...r,
          ancienne: D.versLocal(r.old_value),
          nouvelle: D.versLocal(r.new_value),
        })),
      });
    } catch (e) { fail(res, e, "Erreur de lecture des révisions."); }
  });

  /* ─────────────────────────────── ÉCRITURE ────────────────────────── */

  /**
   * CORRIGER LA DATE AFFICHÉE.
   *
   * Corps : { date: "2026-08-22", time: "10:30", reason, apply_to_operation }
   *
   * Un document déjà imprimé exige le droit « réimprimer » EN PLUS du droit de
   * modification : corriger un bon qui circule déjà n'est pas le même geste
   * que corriger un brouillon. Le motif devient alors obligatoire.
   */
  router.put("/documents/:id/dates", authenticateToken, canUpdate, async (req, res, next) => {
    /* Le contrôle supplémentaire ne peut se décider qu'en connaissant l'état
       du document : on le lit avant de choisir le second garde. */
    try {
      const doc = await documentDe(pool, companyOf(req), req.params.id);
      req.documentCible = doc;
      const dejaImprime = Number(doc.print_count || 0) > 0 || Boolean(doc.printed_at);
      return dejaImprime ? canReprint(req, res, next) : next();
    } catch (e) { return fail(res, e, "Erreur de lecture du document."); }
  }, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const b = req.body || {};
      const motif = String(b.reason || "").trim();

      const out = await tx(async (client) => {
        const doc = await documentDe(client, companyId, req.params.id, { verrou: true });
        const dejaImprime = Number(doc.print_count || 0) > 0 || Boolean(doc.printed_at);

        /* Le motif n'est exigé que lorsqu'il sert réellement : sur un bon déjà
           diffusé, ou sur une date déjà corrigée une fois. Le réclamer dès la
           première saisie n'apprendrait rien à personne. */
        if ((dejaImprime || doc.document_revision > 1) && !motif) {
          throw Object.assign(new Error(
            dejaImprime
              ? "Ce document a déjà été imprimé : indiquez le motif de la correction."
              : "Ce document a déjà été corrigé : indiquez le motif de cette nouvelle correction."
          ), { httpStatus: 400, code: "REASON_REQUIRED" });
        }

        const instant = D.verifierPlage(D.versInstant({ date: b.date, time: b.time, iso: b.iso }));
        const ancienne = doc.document_datetime;
        const revision = Number(doc.document_revision || 1) + 1;

        await client.query(
          `UPDATE documents
              SET document_datetime = $2,
                  operation_effective_at = CASE WHEN $3::bool
                       THEN $2 ELSE operation_effective_at END,
                  document_revision = $4,
                  updated_at = now()
            WHERE id = $1 AND company_id = $5`,
          [doc.id, instant.toISOString(), b.apply_to_operation !== false, revision, companyId]
        );

        /* La révision s'ajoute, elle n'écrase rien : l'ancienne valeur reste
           lisible, avec son auteur et son motif. */
        await client.query(
          `INSERT INTO document_date_revisions
             (company_id, document_id, movement_id, revision, field,
              old_value, new_value, reason, was_printed,
              changed_by, changed_by_name, context)
           VALUES ($1,$2,$3,$4,'document_datetime',$5,$6,$7,$8,$9,$10,$11)`,
          [companyId, doc.id, doc.stock_movement_id || null, revision,
           ancienne, instant.toISOString(), motif, dejaImprime,
           req.user?.id || null, nomDe(req), String(b.context || "")]
        );

        /* Le mouvement porte la même réalité de terrain que son bon : sans
           cela, deux documents issus du même mouvement se contrediraient. */
        if (doc.stock_movement_id && b.apply_to_operation !== false) {
          await client.query(
            `UPDATE stock_movements SET operation_effective_at = $2, updated_at = now()
              WHERE id = $1 AND company_id = $3`,
            [doc.stock_movement_id, instant.toISOString(), companyId]
          );
        }

        return documentDe(client, companyId, doc.id);
      });

      res.json({ success: true, ...vue(out) });
    } catch (e) { fail(res, e, "Erreur de modification de la date du document."); }
  });

  /**
   * RÉTABLIR LA DATE D'ORIGINE.
   *
   * Efface la date choisie : le bon retombe sur la date de l'opération, ou à
   * défaut sur sa date de création. On ne « remet » donc pas created_at dans
   * une colonne — on retire une surcharge, ce qui n'est pas la même chose.
   */
  router.post("/documents/:id/dates/reset", authenticateToken, canUpdate, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const motif = String(req.body?.reason || "").trim();
      const out = await tx(async (client) => {
        const doc = await documentDe(client, companyId, req.params.id, { verrou: true });
        const dejaImprime = Number(doc.print_count || 0) > 0 || Boolean(doc.printed_at);
        if (dejaImprime && !motif) {
          throw Object.assign(new Error("Ce document a déjà été imprimé : indiquez le motif."),
            { httpStatus: 400, code: "REASON_REQUIRED" });
        }
        const revision = Number(doc.document_revision || 1) + 1;
        await client.query(
          `UPDATE documents SET document_datetime = NULL, document_revision = $2, updated_at = now()
            WHERE id = $1 AND company_id = $3`,
          [doc.id, revision, companyId]
        );
        await client.query(
          `INSERT INTO document_date_revisions
             (company_id, document_id, movement_id, revision, field,
              old_value, new_value, reason, was_printed, changed_by, changed_by_name, context)
           VALUES ($1,$2,$3,$4,'document_datetime',$5,NULL,$6,$7,$8,$9,'reset')`,
          [companyId, doc.id, doc.stock_movement_id || null, revision,
           doc.document_datetime, motif || "Rétablissement de la date d'origine",
           dejaImprime, req.user?.id || null, nomDe(req)]
        );
        return documentDe(client, companyId, doc.id);
      });
      res.json({ success: true, ...vue(out) });
    } catch (e) { fail(res, e, "Erreur de rétablissement de la date."); }
  });

  /**
   * ENREGISTRER UNE IMPRESSION.
   *
   * `printed_at` n'est pas la date du document : c'est la date à laquelle il
   * est sorti. Les deux se ressemblent trop pour partager une colonne.
   */
  router.post("/documents/:id/printed", authenticateToken, canPrint, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const out = await tx(async (client) => {
        const doc = await documentDe(client, companyId, req.params.id, { verrou: true });
        await client.query(
          `UPDATE documents SET printed_at = now(), print_count = COALESCE(print_count,0) + 1,
                  updated_at = now()
            WHERE id = $1 AND company_id = $2`,
          [doc.id, companyId]
        );
        return documentDe(client, companyId, doc.id);
      });
      res.json({ success: true, ...vue(out) });
    } catch (e) { fail(res, e, "Erreur d'enregistrement de l'impression."); }
  });

  /**
   * DATE DE TERRAIN D'UN MOUVEMENT.
   *
   * Entrée, sortie, transfert, inventaire : tous passent par
   * `stock_movements`. Dater le mouvement donne sa date par défaut à chaque
   * bon qui en découle, y compris ceux édités plus tard.
   */
  router.put("/stock-movements/:id/operation-date", authenticateToken, canUpdate, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const b = req.body || {};
      const out = await tx(async (client) => {
        const { rows } = await client.query(
          `SELECT id, company_id, type, created_at, operation_effective_at
             FROM stock_movements WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [Number(req.params.id) || 0, companyId]
        );
        const mvt = rows[0];
        if (!mvt) {
          throw Object.assign(new Error("Mouvement introuvable."),
            { httpStatus: 404, code: "MOVEMENT_NOT_FOUND" });
        }
        const instant = D.verifierPlage(D.versInstant({ date: b.date, time: b.time, iso: b.iso }));
        await client.query(
          `UPDATE stock_movements SET operation_effective_at = $2, updated_at = now()
            WHERE id = $1 AND company_id = $3`,
          [mvt.id, instant.toISOString(), companyId]
        );
        await client.query(
          `INSERT INTO document_date_revisions
             (company_id, document_id, movement_id, revision, field,
              old_value, new_value, reason, changed_by, changed_by_name, context)
           VALUES ($1,NULL,$2,1,'operation_effective_at',$3,$4,$5,$6,$7,'movement')`,
          [companyId, mvt.id, mvt.operation_effective_at, instant.toISOString(),
           String(b.reason || ""), req.user?.id || null, nomDe(req)]
        );
        return { ...mvt, operation_effective_at: instant.toISOString() };
      });
      res.json({
        success: true, id: out.id, type: out.type,
        fuseau: D.FUSEAU,
        creation_technique: D.versLocal(out.created_at),
        operation_effective: D.versLocal(out.operation_effective_at),
      });
    } catch (e) { fail(res, e, "Erreur de modification de la date du mouvement."); }
  });

  return router;
};
