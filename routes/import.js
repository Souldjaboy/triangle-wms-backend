"use strict";

/**
 * Router du Centre d'importation. Isolation stricte via le token
 * (company_id, product_code). Aucune écriture métier avant /confirm.
 */
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const XLSX = require("xlsx");
const ic = require("../import-center");
const { executeStock, simulateTransfer, executeTransfer, rollbackTransfer } = require("../import-center/executor");
const { rollbackStock } = require("../import-center/rollback");
const { simulateStock } = require("../import-center/simulator");
const { executeAccounting, simulateAccounting, reverseAccounting } = require("../import-center/executor-accounting");
const { executeEntity, simulateEntity, rollbackEntity } = require("../import-center/executor-entity");
const { executeFactures, simulateFactures, rollbackFactures } = require("../import-center/executor-factures");
const { executeCashbook, simulateCashbook, rollbackCashbook } = require("../import-center/executor-cashbook");
const { recognizeWorkbook } = require("../import-center/recognizer");
const closure = require("../import-center/closure");

module.exports = function createImportRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, isSuperAdminUser, requirePermission, accounting } = deps;
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ic.security.MAX_FILE_SIZE } });

  const STORE_DIR = path.join(__dirname, "..", "uploads", "imports");
  fs.mkdirSync(STORE_DIR, { recursive: true });

  // Garde de permission (défaut autorisé si RBAC non fourni).
  const perm = (action) => (requirePermission ? requirePermission("import", action) : (req, res, next) => next());

  const companyOf = (req) => getEffectiveCompanyId(req) || req.user.company_id;
  const productOf = (req) => String(req.headers["x-app-product"] || req.tenant_id || req.body.product_code || "triangle").toLowerCase();

  // Empreinte stable des en-têtes d'un fichier (pour l'auto-suggestion de mapping).
  const headerSignature = (header) => crypto.createHash("sha256")
    .update((header || []).map((h) => String(h).trim().toLowerCase()).sort().join("|")).digest("hex").slice(0, 24);
  const isTransfer = (profile) => !!profile.isTransfer;
  const isFactures = (profile) => profile.kind === "factures";
  const isCashbook = (profile) => profile.kind === "cashbook";
  const isStock = (profile) => profile.module_key === "logistique" && !isTransfer(profile);
  const isAccounting = (profile) => profile.module_key === "comptabilite" && !isFactures(profile) && !isCashbook(profile);
  const isEntity = (profile) => !!profile.entity;
  const acctHelpers = { ...(accounting || {}), isPeriodClosed: closure.isPeriodClosed };
  const hasAcct = accounting && accounting.nextAccountingNumber;
  const executable = (profile) =>
    isStock(profile) || isTransfer(profile) || isEntity(profile) || isFactures(profile) ||
    (isCashbook(profile) && hasAcct) || (isAccounting(profile) && hasAcct);

  async function audit(jobId, companyId, productCode, action, userId, detail) {
    await pool.query(
      `INSERT INTO import_audit_logs (job_id, company_id, product_code, action, user_id, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
      [jobId, companyId, productCode, action, userId, JSON.stringify(detail || {})]
    ).catch(() => {});
  }

  async function loadJob(req) {
    const companyId = companyOf(req);
    const { rows } = await pool.query(`SELECT * FROM import_jobs WHERE job_uid=$1`, [req.params.uid]);
    const job = rows[0];
    if (!job) return { error: 404 };
    if (!isSuperAdminUser(req.user) && Number(job.company_id) !== Number(companyId)) return { error: 403 };
    return { job, companyId };
  }

  // Liste des profils disponibles.
  router.get("/profiles", authenticateToken, perm("view"), (req, res) => {
    res.json(ic.registry.listProfiles(req.query.product_code || null));
  });

  // ÉTAPE 2-5 : upload + analyse (aucune donnée métier écrite).
  router.post("/jobs", authenticateToken, perm("create"), upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu." });
      const check = ic.security.validateUpload({ originalName: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size, buffer: req.file.buffer });
      if (!check.ok) return res.status(400).json({ error: check.error });

      const companyId = companyOf(req);
      const productCode = productOf(req);

      // RECONNAISSANCE AUTOMATIQUE : import_type absent ou "auto".
      let profileKey = String(req.body.import_type || "").trim();
      let autoSheet = req.body.sheet || null, autoHeaderRow = req.body.header_row != null ? Number(req.body.header_row) : null, autoMapping = null, recognizedSheets = null;
      if (!profileKey || profileKey === "auto") {
        if (check.kind === "docx") return res.status(400).json({ error: "L'import automatique ne gère pas encore les DOCX ; choisissez le type." });
        recognizedSheets = recognizeWorkbook(req.file.buffer, productCode);
        const usable = recognizedSheets.filter((s) => s.recognized);
        if (usable.length === 0) return res.status(400).json({ error: "Type de fichier non reconnu automatiquement. Choisissez le type manuellement.", recognizedSheets });
        const chosen = autoSheet ? usable.find((s) => s.sheet === autoSheet) : usable[0];
        if (!chosen) return res.status(400).json({ error: "Feuille non reconnue.", recognizedSheets });
        profileKey = chosen.profileKey; autoSheet = chosen.sheet; autoHeaderRow = chosen.headerRow; autoMapping = chosen.mapping;
      }
      const profile = ic.registry.getProfile(profileKey);
      if (!profile) return res.status(400).json({ error: "Type d'importation inconnu." });

      const hash = ic.security.fileHash(req.file.buffer);

      // Anti double import : fichier déjà importé avec succès ?
      const dup = await pool.query(
        `SELECT job_uid, created_at, created_by, status FROM import_jobs
          WHERE company_id=$1 AND file_hash=$2 AND status='imported' ORDER BY created_at DESC LIMIT 1`,
        [companyId, hash]
      );

      const analysis = await ic.analyzeBuffer(req.file.buffer, check.kind, { sheet: autoSheet, headerRow: autoHeaderRow });
      const stored = ic.security.safeStoredName(req.file.originalname);
      fs.writeFileSync(path.join(STORE_DIR, stored), req.file.buffer);

      const fileMeta = { sheets: analysis.sheets, activeSheet: analysis.activeSheet, headerRowIndex: analysis.headerRowIndex, header: analysis.header, columns: analysis.columns, rowCount: analysis.rowCount };
      const uid = crypto.randomUUID();
      const { rows } = await pool.query(
        `INSERT INTO import_jobs (job_uid, company_id, tenant_id, product_code, module_key, submodule_key, import_type,
            original_filename, stored_filename, file_hash, file_size, mime_type, status, file_meta, total_rows, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'analyzed',$13,$14,$15) RETURNING id, job_uid, status`,
        [uid, companyId, req.tenant_id || productCode, productCode, profile.module_key, profile.submodule_key || null, profileKey,
         req.file.originalname, stored, hash, req.file.size, req.file.mimetype, JSON.stringify(fileMeta), analysis.rowCount, req.user.id]
      );
      await audit(rows[0].id, companyId, productCode, "upload", req.user.id, { filename: req.file.originalname, rows: analysis.rowCount });

      const suggestion = ic.suggestMapping(analysis, profileKey);
      // Auto-suggestion : mapping enregistré correspondant aux mêmes en-têtes, sinon défaut du profil.
      const sig = headerSignature(analysis.header);
      const saved = (await pool.query(
        `SELECT id, name, mapping, is_default FROM import_mapping_templates
          WHERE company_id=$1 AND profile_key=$2 ORDER BY (header_signature=$3) DESC, is_default DESC, updated_at DESC`,
        [companyId, profileKey, sig]
      )).rows;
      const matched = saved.find((s) => true) || null;
      res.status(201).json({
        job_uid: uid, status: "analyzed",
        profile: { key: profile.key, name: profile.name, requiredFields: profile.requiredFields, optionalFields: profile.optionalFields },
        analysis: fileMeta, preview: analysis.previewRows,
        suggestedMapping: autoMapping || (matched && matched.mapping) || suggestion.mapping, columns: suggestion.columns,
        savedMappings: saved.map((s) => ({ id: s.id, name: s.name, is_default: s.is_default })),
        appliedMapping: autoMapping ? "détection automatique" : (matched ? matched.name : null),
        autoDetected: !!autoMapping,
        recognizedSheets: recognizedSheets ? recognizedSheets.map((s) => ({ sheet: s.sheet, recognized: s.recognized, profileKey: s.profileKey || null })) : null,
        headerSignature: sig,
        alreadyImported: dup.rows[0] || null,
      });
    } catch (e) {
      console.error("import/jobs:", e);
      res.status(e.statusCode === 400 ? 400 : 500).json({ error: e.statusCode === 400 ? e.message : "Erreur d'analyse du fichier." });
    }
  });

  // Re-lit le fichier stocké et ré-extrait la feuille/tableau (async pour DOCX).
  async function reanalyze(job) {
    const buf = fs.readFileSync(path.join(STORE_DIR, job.stored_filename));
    const kind = job.stored_filename.endsWith(".csv") ? "csv" : job.stored_filename.endsWith(".docx") ? "docx" : "excel";
    const meta = job.file_meta || {};
    return ic.analyzeBuffer(buf, kind, { sheet: meta.activeSheet || null, headerRow: meta.headerRowIndex != null ? meta.headerRowIndex : null, tableIndex: meta.tableIndex });
  }

  // ÉTAPE 6-7 : mapping + validation (staging import_rows).
  router.post("/jobs/:uid/mapping", authenticateToken, perm("create"), async (req, res) => {
    try {
      const { job, companyId, error } = await loadJob(req);
      if (error) return res.status(error).json({ error: error === 404 ? "Import introuvable" : "Import d'une autre entreprise." });
      const profile = ic.registry.getProfile(job.import_type);
      const mapping = req.body.mapping || {};
      const options = req.body.options || {};
      const analysis = await reanalyze(job);
      // Anti-doublons PERSISTANT : empreintes déjà importées (même entreprise + profil),
      // hors imports annulés / hors ce job. Permet l'import incrémental d'un même mois.
      const existing = await pool.query(
        `SELECT DISTINCT r.fingerprint FROM import_rows r JOIN import_jobs j ON j.id=r.job_id
          WHERE r.company_id=$1 AND j.import_type=$2 AND j.status='imported'
            AND r.status='imported' AND r.fingerprint IS NOT NULL AND j.id<>$3`,
        [companyId, job.import_type, job.id]
      );
      options.existingFingerprints = new Set(existing.rows.map((x) => x.fingerprint));
      const result = ic.validate(analysis, job.import_type, mapping, companyId, options);

      await pool.query(`DELETE FROM import_rows WHERE job_id=$1`, [job.id]);
      await pool.query(`DELETE FROM import_errors WHERE job_id=$1`, [job.id]);
      for (const r of result.rows) {
        await pool.query(
          `INSERT INTO import_rows (job_id, company_id, sheet_name, row_index, raw, mapped, fingerprint, status, messages)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [job.id, companyId, analysis.activeSheet, r.__row, JSON.stringify(r.raw), JSON.stringify(r.mapped), r.fingerprint, r.status, JSON.stringify(r.messages)]
        );
        for (const msg of r.messages) {
          await pool.query(
            `INSERT INTO import_errors (job_id, company_id, row_index, field, code, message, severity) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [job.id, companyId, r.__row, msg.field || null, msg.code || null, msg.message || "", msg.severity || "error"]
          );
        }
      }
      await pool.query(
        `UPDATE import_jobs SET status='validated', mapping=$2, options=$3, summary=$4,
           total_rows=$5, valid_rows=$6, invalid_rows=$7, duplicate_rows=$8, validated_by=$9, validated_at=NOW() WHERE id=$1`,
        [job.id, JSON.stringify(mapping), JSON.stringify(options), JSON.stringify(result.summary),
         result.summary.total, result.summary.valid, result.summary.invalid, result.summary.duplicates, req.user.id]
      );
      await audit(job.id, companyId, job.product_code, "validate", req.user.id, result.summary);
      res.json({ status: "validated", summary: result.summary, rows: result.rows.slice(0, 200), profile: { key: profile.key, module_key: profile.module_key } });
    } catch (e) { console.error("import mapping:", e); res.status(500).json({ error: "Erreur de validation." }); }
  });

  // ÉTAPE 8 : simulation (aucune écriture).
  router.post("/jobs/:uid/simulate", authenticateToken, perm("view"), async (req, res) => {
    try {
      const { job, companyId, error } = await loadJob(req);
      if (error) return res.status(error).json({ error: "Accès refusé." });
      const profile = ic.registry.getProfile(job.import_type);
      const rows = (await pool.query(`SELECT row_index AS "__row", mapped, status FROM import_rows WHERE job_id=$1 ORDER BY row_index`, [job.id])).rows;
      let simulation;
      if (isTransfer(profile)) {
        simulation = await simulateTransfer(pool, companyId, profile, rows);
      } else if (isFactures(profile)) {
        simulation = await simulateFactures(pool, companyId, profile, rows);
      } else if (isCashbook(profile)) {
        simulation = await simulateCashbook(pool, companyId, profile, rows);
      } else if (isStock(profile)) {
        simulation = await simulateStock(pool, companyId, profile, rows, job.options || {});
      } else if (isAccounting(profile)) {
        simulation = await simulateAccounting(pool, companyId, profile, rows);
      } else if (isEntity(profile)) {
        simulation = await simulateEntity(pool, companyId, profile, rows);
      } else {
        const valid = rows.filter((r) => ["new", "warning"].includes(r.status)).length;
        simulation = { rows: [], totals: { willCreate: valid }, note: "Simulation détaillée disponible pour le stock et la comptabilité ; autres profils en phase ultérieure." };
      }
      await pool.query(`UPDATE import_jobs SET status='simulated', summary = summary || $2 WHERE id=$1`, [job.id, JSON.stringify({ simulation: simulation.totals })]);
      await audit(job.id, companyId, job.product_code, "simulate", req.user.id, simulation.totals);
      res.json({ status: "simulated", ...simulation, executable: executable(profile) });
    } catch (e) { console.error("import simulate:", e); res.status(500).json({ error: "Erreur de simulation." }); }
  });

  // ÉTAPE 9-10 : confirmation + exécution transactionnelle.
  router.post("/jobs/:uid/confirm", authenticateToken, perm("import"), async (req, res) => {
    try {
      const { job, companyId, error } = await loadJob(req);
      if (error) return res.status(error).json({ error: "Accès refusé." });
      if (job.status === "imported") return res.status(409).json({ error: "Import déjà exécuté." });
      const profile = ic.registry.getProfile(job.import_type);
      if (!executable(profile)) return res.status(400).json({ error: "L'exécution de ce profil sera disponible dans une phase ultérieure. Seule la simulation est possible." });

      const rows = (await pool.query(`SELECT id, row_index AS "__row", mapped, status FROM import_rows WHERE job_id=$1 ORDER BY row_index`, [job.id])).rows;
      const opts = { ...(job.options || {}), jobId: job.id };
      const { report, rowResults } = isTransfer(profile)
        ? await executeTransfer(pool, companyId, req.user.id, profile, rows)
        : isFactures(profile)
          ? await executeFactures(pool, companyId, req.user.id, profile, rows, opts)
          : isCashbook(profile)
            ? await executeCashbook(pool, companyId, req.user.id, profile, rows, opts, acctHelpers)
            : isAccounting(profile)
              ? await executeAccounting(pool, companyId, req.user.id, profile, rows, job.options || {}, acctHelpers)
              : isEntity(profile)
                ? await executeEntity(pool, companyId, req.user.id, profile, rows, job.options || {})
                : await executeStock(pool, companyId, req.user.id, profile, rows, job.options || {});

      for (const rr of rowResults) {
        await pool.query(`UPDATE import_rows SET status=$3, result_ref=$4 WHERE job_id=$1 AND row_index=$2`,
          [job.id, rr.__row, rr.status, JSON.stringify(rr.result_ref || {})]);
      }
      await pool.query(
        `UPDATE import_jobs SET status='imported', imported_rows=$2, summary = summary || $3, executed_by=$4, executed_at=NOW() WHERE id=$1`,
        [job.id, report.imported, JSON.stringify({ report }), req.user.id]
      );
      await audit(job.id, companyId, job.product_code, "execute", req.user.id, report);
      res.json({ status: "imported", job_uid: job.job_uid, report });
    } catch (e) { console.error("import confirm:", e); res.status(500).json({ error: "Erreur d'exécution." }); }
  });

  // ÉTAPE 12 : rollback (si techniquement possible).
  router.post("/jobs/:uid/rollback", authenticateToken, perm("cancel"), async (req, res) => {
    try {
      const { job, companyId, error } = await loadJob(req);
      if (error) return res.status(error).json({ error: "Accès refusé." });
      if (job.status !== "imported") return res.status(400).json({ error: "Seul un import exécuté peut être annulé." });
      const profile = ic.registry.getProfile(job.import_type);
      if (!executable(profile)) return res.status(400).json({ error: "Rollback non disponible pour ce profil." });
      const rows = (await pool.query(`SELECT row_index, result_ref FROM import_rows WHERE job_id=$1 AND status='imported'`, [job.id])).rows;
      const result = isTransfer(profile)
        ? await rollbackTransfer(pool, companyId, req.user.id, job, rows)
        : isFactures(profile)
          ? await rollbackFactures(pool, companyId, req.user.id, profile, job, rows)
          : isCashbook(profile)
            ? await rollbackCashbook(pool, companyId, req.user.id, job, rows, acctHelpers)
            : isAccounting(profile)
              ? await reverseAccounting(pool, companyId, req.user.id, job, rows, acctHelpers)
              : isEntity(profile)
                ? await rollbackEntity(pool, companyId, req.user.id, profile, job, rows)
                : await rollbackStock(pool, companyId, req.user.id, job, rows);
      await audit(job.id, companyId, job.product_code, "rollback", req.user.id, result.detail);
      res.json({ status: "rolled_back", ...result });
    } catch (e) { console.error("import rollback:", e); res.status(500).json({ error: "Erreur de rollback." }); }
  });

  // ÉTAPE 11 / Historique.
  router.get("/jobs", authenticateToken, perm("view"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const params = [companyId];
      let where = "company_id=$1";
      if (req.query.product_code) { params.push(req.query.product_code); where += ` AND product_code=$${params.length}`; }
      if (req.query.status) { params.push(req.query.status); where += ` AND status=$${params.length}`; }
      if (req.query.module_key) { params.push(req.query.module_key); where += ` AND module_key=$${params.length}`; }
      const { rows } = await pool.query(
        `SELECT job_uid, product_code, module_key, import_type, original_filename, status,
                total_rows, valid_rows, invalid_rows, imported_rows, duplicate_rows, created_by, created_at, executed_at, rolled_back_at
           FROM import_jobs WHERE ${where} ORDER BY created_at DESC LIMIT 200`,
        params
      );
      res.json(rows);
    } catch (e) { console.error("import history:", e); res.status(500).json({ error: "Erreur historique." }); }
  });

  router.get("/jobs/:uid", authenticateToken, perm("view"), async (req, res) => {
    const { job, error } = await loadJob(req);
    if (error) return res.status(error).json({ error: "Accès refusé." });
    const errors = (await pool.query(`SELECT row_index, field, code, message, severity FROM import_errors WHERE job_id=$1 ORDER BY row_index LIMIT 500`, [job.id])).rows;
    res.json({ ...job, errors });
  });

  // ÉTAPE 0 : modèle Excel d'un profil.
  router.get("/template/:profileKey", authenticateToken, perm("view"), (req, res) => {
    const profile = ic.registry.getProfile(req.params.profileKey);
    if (!profile) return res.status(404).json({ error: "Profil inconnu." });
    const cols = [...(profile.requiredFields || []), ...(profile.optionalFields || [])];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cols, cols.map(() => "")]), "Données");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Instructions"], [`Profil : ${profile.name}`],
      ["Champs obligatoires : " + (profile.requiredFields || []).join(", ")],
      ["Champs facultatifs : " + (profile.optionalFields || []).join(", ")],
      ["Ne modifiez pas la ligne d'en-tête de la feuille « Données »."],
    ]), "Instructions");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="modele_${profile.key}.xlsx"`);
    res.send(buf);
  });

  // ---------- MAPPINGS RÉUTILISABLES (isolés company/product/profil) ----------
  router.get("/mappings", authenticateToken, perm("view"), async (req, res) => {
    try {
      const params = [companyOf(req)];
      let where = "company_id=$1";
      if (req.query.profile_key) { params.push(req.query.profile_key); where += ` AND profile_key=$${params.length}`; }
      const { rows } = await pool.query(
        `SELECT id, product_code, module_key, profile_key, name, mapping, is_default, created_at
           FROM import_mapping_templates WHERE ${where} ORDER BY is_default DESC, name`,
        params
      );
      res.json(rows);
    } catch (e) { console.error("mappings list:", e); res.status(500).json({ error: "Erreur mappings." }); }
  });

  router.post("/mappings", authenticateToken, perm("create"), async (req, res) => {
    try {
      const b = req.body || {};
      const profileKey = String(b.profile_key || "").trim();
      const profile = ic.registry.getProfile(profileKey);
      if (!profile) return res.status(400).json({ error: "Profil inconnu." });
      if (!b.name || !b.mapping) return res.status(400).json({ error: "Nom et mapping requis." });
      const companyId = companyOf(req);
      if (b.is_default) await pool.query(`UPDATE import_mapping_templates SET is_default=FALSE WHERE company_id=$1 AND profile_key=$2`, [companyId, profileKey]);
      const { rows } = await pool.query(
        `INSERT INTO import_mapping_templates (company_id, tenant_id, product_code, module_key, profile_key, name, mapping, header_signature, is_default, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (company_id, profile_key, name) DO UPDATE SET mapping=EXCLUDED.mapping, header_signature=EXCLUDED.header_signature, is_default=EXCLUDED.is_default, updated_at=NOW()
         RETURNING id, name, is_default`,
        [companyId, req.tenant_id || productOf(req), profile.product_code, profile.module_key, profileKey, String(b.name).trim(), JSON.stringify(b.mapping), b.header_signature || null, !!b.is_default, req.user.id]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error("mappings save:", e); res.status(500).json({ error: "Erreur enregistrement mapping." }); }
  });

  router.patch("/mappings/:id", authenticateToken, perm("create"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const owned = (await pool.query(`SELECT profile_key FROM import_mapping_templates WHERE id=$1 AND company_id=$2`, [req.params.id, companyId])).rows[0];
      if (!owned) return res.status(404).json({ error: "Mapping introuvable." });
      const b = req.body || {};
      if (b.is_default === true) await pool.query(`UPDATE import_mapping_templates SET is_default=FALSE WHERE company_id=$1 AND profile_key=$2`, [companyId, owned.profile_key]);
      const { rows } = await pool.query(
        `UPDATE import_mapping_templates SET name=COALESCE($3,name), is_default=COALESCE($4,is_default), updated_at=NOW()
          WHERE id=$1 AND company_id=$2 RETURNING id, name, is_default`,
        [req.params.id, companyId, b.name ? String(b.name).trim() : null, typeof b.is_default === "boolean" ? b.is_default : null]
      );
      res.json(rows[0]);
    } catch (e) { console.error("mappings patch:", e); res.status(500).json({ error: "Erreur mapping." }); }
  });

  router.delete("/mappings/:id", authenticateToken, perm("create"), async (req, res) => {
    try {
      const r = await pool.query(`DELETE FROM import_mapping_templates WHERE id=$1 AND company_id=$2`, [req.params.id, companyOf(req)]);
      if (!r.rowCount) return res.status(404).json({ error: "Mapping introuvable." });
      res.json({ ok: true });
    } catch (e) { console.error("mappings delete:", e); res.status(500).json({ error: "Erreur suppression mapping." }); }
  });

  // ---------- RAPPORT DÉTAILLÉ (XLSX / CSV) ----------
  router.get("/jobs/:uid/report", authenticateToken, perm("view"), async (req, res) => {
    try {
      const { job, error } = await loadJob(req);
      if (error) return res.status(error).json({ error: "Accès refusé." });
      const rows = (await pool.query(
        `SELECT row_index, raw, mapped, status, fingerprint, messages, result_ref FROM import_rows WHERE job_id=$1 ORDER BY row_index`,
        [job.id]
      )).rows;
      const s = job.summary || {};
      const summary = [
        ["Rapport d'importation"], ["Entreprise (id)", job.company_id], ["Produit", job.product_code],
        ["Module", job.module_key], ["Profil", job.import_type], ["Fichier", job.original_filename],
        ["Créé par (id)", job.created_by], ["Date", job.created_at], ["Statut", job.status],
        ["Total", job.total_rows], ["Valides", job.valid_rows], ["Invalides", job.invalid_rows],
        ["Doublons", job.duplicate_rows], ["Importées", job.imported_rows],
        ["Résumé exécution", JSON.stringify(s.report || {})],
      ];
      const detailHeader = ["Ligne", "Données originales", "Mapping", "Statut", "Message", "Identifiant créé"];
      const detail = rows.map((r) => [
        r.row_index, JSON.stringify(r.raw), JSON.stringify(r.mapped), r.status,
        (Array.isArray(r.messages) ? r.messages : []).map((m) => m.message).join(" ; "),
        (r.result_ref && (r.result_ref.id || r.result_ref.movement_id || r.result_ref.transaction_id)) || "",
      ]);

      if (String(req.query.format).toLowerCase() === "csv") {
        const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const csv = [detailHeader.map(esc).join(",")].concat(detail.map((d) => d.map(esc).join(","))).join("\n");
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="rapport_import_${job.job_uid}.csv"`);
        return res.send("﻿" + csv);
      }
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), "Résumé");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([detailHeader, ...detail]), "Détail");
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="rapport_import_${job.job_uid}.xlsx"`);
      res.send(buf);
    } catch (e) { console.error("import report:", e); res.status(500).json({ error: "Erreur rapport." }); }
  });

  return router;
};
