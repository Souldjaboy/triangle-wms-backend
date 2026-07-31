"use strict";

/** Clôtures comptables mensuelles (Triangle). Isolé par le token. */
const express = require("express");
const XLSX = require("xlsx");
const closure = require("../import-center/closure");

module.exports = function createAccountingRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission } = deps;
  const router = express.Router();
  const perm = (action) => (requirePermission ? requirePermission("comptabilite", action) : (req, res, next) => next());
  const companyOf = (req) => getEffectiveCompanyId(req) || req.user.company_id;
  const ok = (v) => Number.isInteger(v) && v > 0;

  // Liste des clôtures (+ année courante).
  router.get("/closures", authenticateToken, perm("view"), async (req, res) => {
    try {
      const year = req.query.year ? Number(req.query.year) : null;
      res.json(await closure.listClosures(pool, companyOf(req), year));
    } catch (e) { console.error("closures list:", e); res.status(500).json({ error: "Erreur clôtures." }); }
  });

  // Prévisualisation d'un mois (aucune écriture).
  router.get("/closures/:year/:month/preview", authenticateToken, perm("view"), async (req, res) => {
    try {
      const y = Number(req.params.year), m = Number(req.params.month);
      if (!ok(y) || !(m >= 1 && m <= 12)) return res.status(400).json({ error: "Période invalide." });
      const snap = await closure.computeClosure(pool, companyOf(req), y, m);
      const existing = (await closure.listClosures(pool, companyOf(req), y)).find((c) => c.period_month === m);
      res.json({ ...snap, status: existing?.status || "open", closed_by: existing?.closed_by || null, closed_at: existing?.closed_at || null });
    } catch (e) { console.error("closure preview:", e); res.status(500).json({ error: "Erreur prévisualisation." }); }
  });

  // Clôturer un mois.
  router.post("/closures/:year/:month/close", authenticateToken, perm("validate"), async (req, res) => {
    try {
      const y = Number(req.params.year), m = Number(req.params.month);
      if (!ok(y) || !(m >= 1 && m <= 12)) return res.status(400).json({ error: "Période invalide." });
      const row = await closure.closePeriod(pool, companyOf(req), req.user.id, y, m, { force: req.body && req.body.force === true });
      res.json({ ok: true, closure: row });
    } catch (e) {
      if (e.statusCode === 409) return res.status(409).json({ error: e.message, code: "CLOSURE_BLOCKED", anomalies: e.anomalies, snapshot: e.snapshot });
      console.error("closure close:", e); res.status(500).json({ error: "Erreur clôture." });
    }
  });

  // Rouvrir un mois (permission spéciale + audité).
  router.post("/closures/:year/:month/reopen", authenticateToken, perm("cancel"), async (req, res) => {
    try {
      const y = Number(req.params.year), m = Number(req.params.month);
      const row = await closure.reopenPeriod(pool, companyOf(req), req.user.id, y, m);
      if (!row) return res.status(404).json({ error: "Aucune clôture à rouvrir." });
      res.json({ ok: true, closure: row });
    } catch (e) { console.error("closure reopen:", e); res.status(500).json({ error: "Erreur réouverture." }); }
  });

  // Rapport de clôture (XLSX).
  router.get("/closures/:year/:month/report", authenticateToken, perm("view"), async (req, res) => {
    try {
      const y = Number(req.params.year), m = Number(req.params.month);
      const snap = await closure.computeClosure(pool, companyOf(req), y, m);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ["Rapport de clôture", `${String(m).padStart(2, "0")}/${y}`],
        ["Solde initial", snap.opening_balance],
        ["Recettes", snap.total_income],
        ["Dépenses", snap.total_expense],
        ["Résultat", snap.result],
        ["Solde final", snap.closing_balance],
        ["Opérations non validées", snap.not_validated],
      ]), "Clôture");
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="cloture_${y}_${m}.xlsx"`);
      res.send(buf);
    } catch (e) { console.error("closure report:", e); res.status(500).json({ error: "Erreur rapport." }); }
  });

  return router;
};
