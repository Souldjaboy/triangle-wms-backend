"use strict";

/** Modules Factures & Camions (saisie directe + consultation), isolés par le token. */
const express = require("express");
const ic = require("../import-center");
const { executeCashbook } = require("../import-center/executor-cashbook");
const closure = require("../import-center/closure");

module.exports = function createFacturesCamionsRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission, accounting } = deps;
  const router = express.Router();
  const perm = (mod, action) => (requirePermission ? requirePermission(mod, action) : (req, res, next) => next());
  const companyOf = (req) => getEffectiveCompanyId(req) || req.user.company_id;
  const invoiceStatus = (inv, pd) => (inv > 0 && pd >= inv ? "paye" : pd <= 0 ? "impaye" : "partiel");
  const acctHelpers = { ...(accounting || {}), isPeriodClosed: closure.isPeriodClosed };

  // Saisie manuelle -> écriture comptable équilibrée, en réutilisant l'exécuteur cashbook testé.
  async function postCashLine(companyId, userId, profileKey, mapped) {
    const profile = ic.registry.getProfile(profileKey);
    const row = { __row: 1, status: "new", mapped };
    return executeCashbook(pool, companyId, userId, profile, [row], {}, acctHelpers);
  }

  // ---------- FACTURES ----------
  router.get("/factures", authenticateToken, perm("comptabilite", "view"), async (req, res) => {
    try {
      const params = [companyOf(req)];
      let where = "company_id=$1";
      if (req.query.status) { params.push(req.query.status); where += ` AND status=$${params.length}`; }
      const { rows } = await pool.query(
        `SELECT id, numero, reference, invoice_date, site, description, invoiced_amount, paid_amount, remaining_amount, payment_date, status, observations, created_at
           FROM factures WHERE ${where} ORDER BY invoice_date DESC NULLS LAST, id DESC LIMIT 500`,
        params
      );
      const totals = (await pool.query(
        `SELECT COALESCE(SUM(invoiced_amount),0) inv, COALESCE(SUM(paid_amount),0) paid, COALESCE(SUM(remaining_amount),0) rem,
                COUNT(*) FILTER (WHERE status='paye') paye, COUNT(*) FILTER (WHERE status='partiel') partiel, COUNT(*) FILTER (WHERE status='impaye') impaye
           FROM factures WHERE company_id=$1`, [companyOf(req)]
      )).rows[0];
      res.json({ factures: rows, totals });
    } catch (e) { console.error("factures list:", e); res.status(500).json({ error: "Erreur factures." }); }
  });

  router.post("/factures", authenticateToken, perm("comptabilite", "create"), async (req, res) => {
    try {
      const b = req.body || {};
      const inv = Number(b.invoiced_amount) || 0, pd = Number(b.paid_amount) || 0;
      const { rows } = await pool.query(
        `INSERT INTO factures (company_id, numero, reference, invoice_date, site, description, invoiced_amount, paid_amount, remaining_amount, payment_date, status, observations, source_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual',$13) RETURNING *`,
        [companyOf(req), b.numero || null, b.reference || null, b.invoice_date || null, b.site || null, b.description || null,
         inv, pd, Math.max(0, inv - pd), b.payment_date || null, invoiceStatus(inv, pd), b.observations || null, req.user.id]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error("factures create:", e); res.status(500).json({ error: "Erreur création facture." }); }
  });

  // ---------- CAMIONS ----------
  router.get("/camions", authenticateToken, perm("comptabilite", "view"), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT c.*,
                COALESCE((SELECT SUM(recette) FROM camion_operations o WHERE o.camion_id=c.id),0) AS total_recette,
                COALESCE((SELECT SUM(depense) FROM camion_operations o WHERE o.camion_id=c.id),0) AS total_depense,
                (SELECT COUNT(*) FROM camion_operations o WHERE o.camion_id=c.id) AS operations
           FROM camions c WHERE c.company_id=$1 ORDER BY c.code`,
        [companyOf(req)]
      );
      res.json(rows);
    } catch (e) { console.error("camions list:", e); res.status(500).json({ error: "Erreur camions." }); }
  });

  router.post("/camions", authenticateToken, perm("comptabilite", "create"), async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.code) return res.status(400).json({ error: "Code camion requis." });
      const { rows } = await pool.query(
        `INSERT INTO camions (company_id, code, immatriculation, chauffeur, statut, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (company_id, code) DO UPDATE SET immatriculation=COALESCE(EXCLUDED.immatriculation, camions.immatriculation),
           chauffeur=COALESCE(EXCLUDED.chauffeur, camions.chauffeur), statut=COALESCE(EXCLUDED.statut, camions.statut), updated_at=NOW()
         RETURNING *`,
        [companyOf(req), String(b.code).trim(), b.immatriculation || null, b.chauffeur || null, b.statut || "actif", b.notes || null, req.user.id]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error("camions create:", e); res.status(500).json({ error: "Erreur création camion." }); }
  });

  // Saisie manuelle d'une opération de trésorerie (recette/dépense) -> écriture équilibrée.
  router.post("/tresorerie", authenticateToken, perm("comptabilite", "create"), async (req, res) => {
    try {
      const b = req.body || {};
      const income = Number(b.income) || 0, expense = Number(b.expense) || 0;
      if (income <= 0 && expense <= 0) return res.status(400).json({ error: "Renseignez une entrée ou une sortie." });
      const r = await postCashLine(companyOf(req), req.user.id, "triangle.tresorerie", { op_date: b.op_date || null, libelle: b.libelle || null, income, expense });
      res.status(201).json({ ok: true, report: r.report });
    } catch (e) { console.error("tresorerie create:", e); res.status(500).json({ error: "Erreur trésorerie." }); }
  });

  // Saisie manuelle d'une opération camion -> camion_operation + écriture équilibrée.
  router.post("/camions/:id/operations", authenticateToken, perm("comptabilite", "create"), async (req, res) => {
    try {
      const cam = (await pool.query(`SELECT id, code FROM camions WHERE id=$1 AND company_id=$2`, [req.params.id, companyOf(req)])).rows[0];
      if (!cam) return res.status(404).json({ error: "Camion introuvable." });
      const b = req.body || {};
      const recette = Number(b.recette) || 0, depense = Number(b.depense) || 0;
      if (recette <= 0 && depense <= 0) return res.status(400).json({ error: "Renseignez une recette ou une dépense." });
      const r = await postCashLine(companyOf(req), req.user.id, "triangle.suivi", {
        op_date: b.op_date || null, libelle: b.libelle || null, camion: cam.code, piece_ref: b.piece_ref || null, income: recette, expense: depense,
      });
      res.status(201).json({ ok: true, report: r.report });
    } catch (e) { console.error("camion op create:", e); res.status(500).json({ error: "Erreur opération camion." }); }
  });

  router.get("/camions/:id/operations", authenticateToken, perm("comptabilite", "view"), async (req, res) => {
    try {
      const cam = (await pool.query(`SELECT * FROM camions WHERE id=$1 AND company_id=$2`, [req.params.id, companyOf(req)])).rows[0];
      if (!cam) return res.status(404).json({ error: "Camion introuvable." });
      const ops = (await pool.query(
        `SELECT op_date, libelle, recette, depense, piece_ref, source_type, created_at FROM camion_operations
          WHERE camion_id=$1 AND company_id=$2 ORDER BY op_date DESC NULLS LAST, id DESC LIMIT 500`,
        [req.params.id, companyOf(req)]
      )).rows;
      res.json({ camion: cam, operations: ops });
    } catch (e) { console.error("camion ops:", e); res.status(500).json({ error: "Erreur opérations." }); }
  });

  return router;
};
