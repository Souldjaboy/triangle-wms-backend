"use strict";

/**
 * FISCALITÉ ET COTISATIONS.
 *
 *   GET  /fiscalite/catalogue              les types d'obligation
 *   GET  /fiscalite/profil                 le profil fiscal de la société
 *   PUT  /fiscalite/profil                 le configurer
 *   POST /fiscalite/obligations            activer/désactiver une obligation
 *   GET  /fiscalite/regles                 les règles et leur état de vérification
 *   POST /fiscalite/regles                 créer une règle (À VÉRIFIER par défaut)
 *   POST /fiscalite/regles/:id/verifier    la marquer vérifiée — source exigée
 *   GET  /fiscalite/declarations           les déclarations, avec les retards
 *   POST /fiscalite/declarations           déclarer : crée une DETTE, sans débit
 *   POST /fiscalite/declarations/:id/paiement   payer, partiellement ou en tout
 *   GET  /fiscalite/calendrier             les échéances à venir et en retard
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DEUX RÈGLES QUI NE SE NÉGOCIENT PAS
 *
 *   1. Une règle non VÉRIFIÉE ne calcule rien. Le montant doit alors être
 *      saisi à la main, et l'application dit pourquoi. Mieux vaut demander un
 *      chiffre que d'en inventer un qui sera déclaré à l'administration.
 *
 *   2. Une pénalité ne s'invente jamais. Sans règle de pénalité validée, la
 *      réponse porte le message convenu :
 *      « Taux de pénalité non configuré — vérifier auprès de la DGI ou du
 *      comptable. »
 */

const express = require("express");
const T = require("../services/tresorerie");

const MESSAGE_PENALITE =
  "Taux de pénalité non configuré — vérifier auprès de la DGI ou du comptable.";

module.exports = function createFiscaliteRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission,
          nextAccountingNumber, createAccountingEntry } = deps;
  const router = express.Router();

  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const nomDe = (req) => req.user?.fullname || req.user?.email || "Utilisateur";
  const requireCompany = (req, res) => {
    const id = companyOf(req);
    if (!id) { res.status(409).json({ error: "Entreprise active requise.", code: "COMPANY_REQUIRED" }); return 0; }
    return id;
  };
  const fail = (res, e, secours) => {
    if (!e.httpStatus) console.error(secours, e);
    res.status(e.httpStatus || 500).json({
      error: e.message || secours, code: e.code,
      ...(e.disponible !== undefined ? { disponible: e.disponible, manquant: e.manquant } : {}),
    });
  };

  /** La règle applicable à une date — la plus récente qui couvre cette date. */
  async function regleApplicable(client, { companyId, taxTypeId, date }) {
    const { rows } = await client.query(
      `SELECT * FROM tax_rules
        WHERE tax_type_id = $1
          AND (company_id IS NULL OR company_id = $2)
          AND effective_from <= $3::date
          AND (effective_to IS NULL OR effective_to >= $3::date)
        ORDER BY (company_id IS NOT NULL) DESC, effective_from DESC
        LIMIT 1`,
      [taxTypeId, companyId, date]);
    return rows[0] || null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  router.get(
    "/fiscalite/catalogue", authenticateToken, requirePermission("fiscalite", "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `SELECT t.*,
                  COALESCE(o.active, false) AS obligation_active,
                  o.exemption_reason,
                  (SELECT count(*)::int FROM tax_rules r
                    WHERE r.tax_type_id = t.id
                      AND (r.company_id IS NULL OR r.company_id = $1)
                      AND r.verification_status = 'VERIFIEE') AS regles_verifiees
             FROM tax_types t
             LEFT JOIN company_tax_obligations o ON o.tax_type_id = t.id AND o.company_id = $1
            WHERE t.is_active
            ORDER BY t.category, t.code`,
          [companyId]);
        res.json({
          catalogue: rows,
          avertissement: rows.every((t) => t.regles_verifiees === 0)
            ? "Aucun taux n'est vérifié : les montants devront être saisis à la main tant qu'une règle n'aura pas été validée avec sa source."
            : null,
        });
      } catch (e) { fail(res, e, "Impossible de lire le catalogue."); }
    }
  );

  router.get(
    "/fiscalite/profil", authenticateToken, requirePermission("fiscalite", "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `SELECT * FROM company_tax_profiles WHERE company_id = $1`, [companyId]);
        res.json({
          profil: rows[0] || null,
          configure: Boolean(rows[0]?.configured_at),
          message: rows[0]?.configured_at ? null
            : "Le profil fiscal n'est pas configuré : régime, activité et assujettissement à la TVA doivent être renseignés avant toute déclaration.",
        });
      } catch (e) { fail(res, e, "Impossible de lire le profil fiscal."); }
    }
  );

  router.put(
    "/fiscalite/profil", authenticateToken, requirePermission("fiscalite", "configure"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const regime = String(req.body?.regime || "").trim().toUpperCase();
        const permis = ["REEL_NORMAL", "REEL_SIMPLIFIE", "SYNTHETIQUE", "NON_DEFINI"];
        if (!permis.includes(regime)) {
          throw T.erreur(`Régime attendu : ${permis.join(", ")}.`, "REGIME_INVALID", 400);
        }
        const { rows } = await pool.query(
          `INSERT INTO company_tax_profiles
             (company_id, regime, activity, vat_liable, location, tax_id, configured_by, configured_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, now())
           ON CONFLICT (company_id) DO UPDATE
             SET regime = EXCLUDED.regime, activity = EXCLUDED.activity,
                 vat_liable = EXCLUDED.vat_liable, location = EXCLUDED.location,
                 tax_id = EXCLUDED.tax_id, configured_by = EXCLUDED.configured_by,
                 configured_at = now(), updated_at = now()
           RETURNING *`,
          [companyId, regime, String(req.body?.activity || ""),
           req.body?.vat_liable === true, String(req.body?.location || ""),
           String(req.body?.tax_id || ""), req.user?.id || null]);
        res.json({ profil: rows[0] });
      } catch (e) { fail(res, e, "Configuration du profil impossible."); }
    }
  );

  router.post(
    "/fiscalite/obligations", authenticateToken, requirePermission("fiscalite", "configure"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const code = String(req.body?.code || "").trim().toUpperCase();
        const actif = req.body?.active === true;
        const { rows: types } = await pool.query(`SELECT id, name FROM tax_types WHERE code = $1`, [code]);
        if (!types[0]) throw T.erreur("Type d'obligation inconnu.", "TAX_TYPE_NOT_FOUND", 404);

        const { rows } = await pool.query(
          `INSERT INTO company_tax_obligations
             (company_id, tax_type_id, active, activated_by, activated_at, exemption_reason, notes)
           VALUES ($1,$2,$3,$4, CASE WHEN $3 THEN now() ELSE NULL END, $5, $6)
           ON CONFLICT (company_id, tax_type_id) DO UPDATE
             SET active = EXCLUDED.active, activated_by = EXCLUDED.activated_by,
                 activated_at = CASE WHEN EXCLUDED.active THEN now() ELSE NULL END,
                 exemption_reason = EXCLUDED.exemption_reason, updated_at = now()
           RETURNING *`,
          [companyId, types[0].id, actif, req.user?.id || null,
           String(req.body?.exemption_reason || ""), String(req.body?.notes || "")]);
        res.json({
          obligation: rows[0],
          message: actif
            ? `${types[0].name} est désormais une obligation active de cette société.`
            : `${types[0].name} n'est plus suivie pour cette société.`,
        });
      } catch (e) { fail(res, e, "Activation impossible."); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // LES RÈGLES
  // ═══════════════════════════════════════════════════════════════════════
  router.get(
    "/fiscalite/regles", authenticateToken, requirePermission("fiscalite", "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `SELECT r.*, t.code, t.name, u.fullname AS verifiee_par
             FROM tax_rules r
             JOIN tax_types t ON t.id = r.tax_type_id
             LEFT JOIN users u ON u.id = r.verified_by
            WHERE r.company_id IS NULL OR r.company_id = $1
            ORDER BY t.code, r.effective_from DESC`,
          [companyId]);
        res.json({
          regles: rows,
          non_verifiees: rows.filter((r) => r.verification_status !== "VERIFIEE").length,
        });
      } catch (e) { fail(res, e, "Impossible de lire les règles."); }
    }
  );

  router.post(
    "/fiscalite/regles", authenticateToken, requirePermission("fiscalite", "configure"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const code = String(req.body?.code || "").trim().toUpperCase();
        const { rows: types } = await pool.query(`SELECT id FROM tax_types WHERE code = $1`, [code]);
        if (!types[0]) throw T.erreur("Type d'obligation inconnu.", "TAX_TYPE_NOT_FOUND", 404);
        if (!req.body?.effective_from) {
          throw T.erreur("Une règle vaut à partir d'une date : elle est obligatoire.", "DATE_REQUIRED", 400);
        }

        /* Une règle naît TOUJOURS « à vérifier », quoi qu'envoie le client :
           un statut vérifié ne s'obtient que par le geste explicite de la
           route dédiée, qui exige la source. */
        const { rows } = await pool.query(
          `INSERT INTO tax_rules
             (tax_type_id, company_id, rate_percent, fixed_amount, min_amount, max_amount,
              brackets, effective_from, effective_to, source_reference, source_url,
              notes, verification_status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11,$12,'A_VERIFIER',$13)
           RETURNING *`,
          [types[0].id, req.body?.global === true ? null : companyId,
           req.body?.rate_percent ?? null, req.body?.fixed_amount ?? null,
           req.body?.min_amount ?? null, req.body?.max_amount ?? null,
           req.body?.brackets ? JSON.stringify(req.body.brackets) : null,
           req.body.effective_from, req.body?.effective_to || null,
           String(req.body?.source_reference || ""), String(req.body?.source_url || ""),
           String(req.body?.notes || ""), req.user?.id || null]);
        res.status(201).json({
          regle: rows[0],
          message: "Règle enregistrée comme À VÉRIFIER. Elle ne calculera rien tant qu'elle n'aura pas été validée avec sa source officielle.",
        });
      } catch (e) { fail(res, e, "Création de la règle impossible."); }
    }
  );

  router.post(
    "/fiscalite/regles/:id/verifier", authenticateToken, requirePermission("fiscalite", "validate"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const reference = String(req.body?.source_reference || "").trim();
        const url = String(req.body?.source_url || "").trim();
        /* Sans référence de texte, « vérifiée » ne veut rien dire : c'est
           précisément ce qu'on veut pouvoir relire dans six mois. */
        if (reference.length < 5) {
          throw T.erreur(
            "La référence du texte officiel est obligatoire pour valider une règle (loi de finances, article du CGI, circulaire…).",
            "SOURCE_REQUIRED", 400);
        }
        const { rows } = await pool.query(
          `UPDATE tax_rules
              SET verification_status = 'VERIFIEE', source_reference = $1, source_url = $2,
                  verified_at = COALESCE($3::date, CURRENT_DATE), verified_by = $4, updated_at = now()
            WHERE id = $5 AND (company_id IS NULL OR company_id = $6)
            RETURNING *`,
          [reference, url, req.body?.verified_at || null, req.user?.id || null,
           Number(req.params.id), companyId]);
        if (!rows[0]) return res.status(404).json({ error: "Règle introuvable." });
        res.json({ regle: rows[0], message: "Règle validée : elle peut désormais servir au calcul." });
      } catch (e) { fail(res, e, "Validation impossible."); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // LES DÉCLARATIONS
  // ═══════════════════════════════════════════════════════════════════════
  router.get(
    "/fiscalite/declarations", authenticateToken, requirePermission("fiscalite", "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `SELECT d.*, t.code, t.name,
                  (d.due_date IS NOT NULL AND d.due_date < CURRENT_DATE
                   AND d.status NOT IN ('PAYEE','EXONEREE','ANNULEE')) AS en_retard
             FROM tax_declarations d
             JOIN tax_types t ON t.id = d.tax_type_id
            WHERE d.company_id = $1
            ORDER BY d.period_start DESC, t.code
            LIMIT 300`, [companyId]);
        res.json({
          declarations: rows,
          total_du: rows.reduce((s, d) => s + T.francs(d.remaining_amount), 0),
          en_retard: rows.filter((d) => d.en_retard).length,
        });
      } catch (e) { fail(res, e, "Impossible de lire les déclarations."); }
    }
  );

  router.post(
    "/fiscalite/declarations", authenticateToken, requirePermission("fiscalite", "create"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const code = String(req.body?.code || "").trim().toUpperCase();
        const periode = String(req.body?.period_code || "").trim();
        if (!/^\d{4}(-\d{2})?$/.test(periode)) {
          throw T.erreur("Période attendue au format AAAA-MM ou AAAA.", "PERIOD_CODE_INVALID", 400);
        }

        await client.query("BEGIN");
        const { rows: types } = await client.query(
          `SELECT * FROM tax_types WHERE code = $1`, [code]);
        if (!types[0]) throw T.erreur("Type d'obligation inconnu.", "TAX_TYPE_NOT_FOUND", 404);
        const type = types[0];

        const { rows: obligations } = await client.query(
          `SELECT active FROM company_tax_obligations WHERE company_id = $1 AND tax_type_id = $2`,
          [companyId, type.id]);
        if (!obligations[0]?.active) {
          throw T.erreur(
            `${type.name} n'est pas une obligation active de cette société. Activez-la d'abord dans le profil fiscal.`,
            "OBLIGATION_NOT_ACTIVE", 409);
        }

        const debut = periode.length === 4 ? `${periode}-01-01` : `${periode}-01`;
        const { rows: bornes } = await client.query(
          `SELECT $1::date AS debut,
                  ($1::date + ($2::text)::interval - interval '1 day')::date AS fin`,
          [debut, periode.length === 4 ? "1 year" : "1 month"]);

        const base = T.francs(req.body?.base_amount || 0);
        const regle = await regleApplicable(client, {
          companyId, taxTypeId: type.id, date: bornes[0].fin });

        /* Le montant n'est calculé QUE si une règle vérifiée le permet.
           Sinon on prend celui que la personne a saisi, et on le dit. */
        let montant = null;
        let calcul = "saisi";
        if (regle && regle.verification_status === "VERIFIEE") {
          if (regle.rate_percent != null && base > 0) {
            montant = Math.round(base * Number(regle.rate_percent) / 100);
            calcul = `taux ${regle.rate_percent} % sur ${base.toLocaleString("fr-FR")} FCFA`;
          } else if (regle.fixed_amount != null) {
            montant = T.francs(regle.fixed_amount);
            calcul = "montant fixe de la règle";
          }
          if (montant != null && regle.min_amount != null) montant = Math.max(montant, T.francs(regle.min_amount));
          if (montant != null && regle.max_amount != null) montant = Math.min(montant, T.francs(regle.max_amount));
        }
        if (montant == null) {
          montant = req.body?.declared_amount != null ? T.francs(req.body.declared_amount) : null;
          if (montant == null) {
            throw T.erreur(
              `Aucune règle vérifiée pour ${type.name} à cette date : saisissez le montant à déclarer, ou validez d'abord la règle avec sa source officielle.`,
              "NO_VERIFIED_RULE", 409);
          }
        }

        const reference = await nextAccountingNumber(
          client, "tax_declarations", "reference", "DECL", companyId);

        const echeance = type.due_day
          ? `${bornes[0].fin}`
          : null;

        const { rows } = await client.query(
          `INSERT INTO tax_declarations
             (company_id, tax_type_id, tax_rule_id, reference, period_code, period_start,
              period_end, due_date, base_amount, declared_amount, remaining_amount,
              status, notes, declared_by, declared_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,
                   CASE WHEN $8::int IS NULL THEN NULL ELSE ($7::date + $8::int) END,
                   $9,$10,$10,'DECLAREE',$11,$12, now(), $12)
           RETURNING *`,
          [companyId, type.id, regle?.id || null, reference, periode,
           bornes[0].debut, bornes[0].fin, type.due_day || null,
           base, montant, String(req.body?.notes || ""), req.user?.id || null]);

        /* Déclarer crée une DETTE : on écrit les deux écritures, mais AUCUN
           compte financier n'est touché. La trésorerie ne bougera qu'au
           paiement. */
        for (const ecriture of [
          { accountLabel: `Charge fiscale ${type.code}`, debit: montant, credit: 0 },
          { accountLabel: "Dettes fiscales et sociales", debit: 0, credit: montant },
        ]) {
          await createAccountingEntry(client, {
            companyId, sourceType: "tax_declaration", sourceId: rows[0].id, ...ecriture,
            description: `Déclaration ${type.code} ${periode}`, createdBy: req.user?.id || null,
          });
        }

        await client.query("COMMIT");
        res.status(201).json({
          declaration: rows[0], calcul,
          regle_utilisee: regle && regle.verification_status === "VERIFIEE"
            ? { reference: regle.source_reference, taux: regle.rate_percent } : null,
          avertissement: regle && regle.verification_status !== "VERIFIEE"
            ? "Une règle existe pour cet impôt mais n'est pas vérifiée : le montant retenu est celui que vous avez saisi."
            : null,
          penalite: MESSAGE_PENALITE,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        if (e.code === "23505") {
          return res.status(409).json({
            error: "Cet impôt est déjà déclaré pour cette période.",
            code: "DECLARATION_ALREADY_EXISTS",
          });
        }
        fail(res, e, "Déclaration impossible.");
      } finally { client.release(); }
    }
  );

  router.post(
    "/fiscalite/declarations/:id/paiement", authenticateToken, requirePermission("fiscalite", "pay"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const montant = T.francs(req.body?.amount);
        if (!(montant > 0)) throw T.erreur("Le montant doit être supérieur à zéro.", "AMOUNT_INVALID", 400);

        await client.query("BEGIN");
        const { rows: declarations } = await client.query(
          `SELECT d.*, t.code, t.name FROM tax_declarations d
             JOIN tax_types t ON t.id = d.tax_type_id
            WHERE d.id = $1 AND d.company_id = $2 FOR UPDATE OF d`,
          [Number(req.params.id), companyId]);
        const declaration = declarations[0];
        if (!declaration) throw T.erreur("Déclaration introuvable.", "DECLARATION_NOT_FOUND", 404);
        if (["ANNULEE", "EXONEREE"].includes(declaration.status)) {
          throw T.erreur(`Une déclaration « ${declaration.status} » ne se paie pas.`, "DECLARATION_NOT_PAYABLE", 409);
        }

        const du = T.francs(declaration.declared_amount) + T.francs(declaration.penalty_amount || 0);
        const dejaPaye = T.francs(declaration.paid_amount);
        if (dejaPaye + montant > du) {
          throw T.erreur(
            `Il ne reste que ${(du - dejaPaye).toLocaleString("fr-FR")} FCFA à payer sur cette déclaration.`,
            "PAYMENT_ABOVE_DUE", 409);
        }

        const mouvement = await T.debiter(client, {
          companyId, montant,
          bankId: req.body?.bank_id ? Number(req.body.bank_id) : null,
          caisseId: req.body?.caisse_id ? Number(req.body.caisse_id) : null,
          prefixe: "PAI-FISC",
          typeOperation: "paiement_impot",
          sourceType: "tax_payment", sourceId: declaration.id,
          description: `Paiement ${declaration.code} ${declaration.period_code}`,
          compteCharge: "Dettes fiscales et sociales",
          partenaire: declaration.name,
          reference: String(req.body?.reference || ""),
          userId: req.user?.id || null,
          nextAccountingNumber, createAccountingEntry,
        });

        const apres = dejaPaye + montant;
        const { rows: lignes } = await client.query(
          `INSERT INTO tax_payments
             (company_id, declaration_id, amount, paid_before, paid_after, payment_date,
              bank_id, caisse_id, accounting_transaction_id, receipt_number, receipt_url,
              reference, performed_by, performed_by_name)
           VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, CURRENT_DATE),$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING *`,
          [companyId, declaration.id, montant, dejaPaye, apres, req.body?.payment_date || null,
           req.body?.bank_id ? Number(req.body.bank_id) : null,
           req.body?.caisse_id ? Number(req.body.caisse_id) : null,
           mouvement.transaction.id, String(req.body?.receipt_number || ""),
           String(req.body?.receipt_url || ""), String(req.body?.reference || ""),
           req.user?.id || null, nomDe(req)]);

        await client.query(
          `UPDATE tax_declarations
              SET paid_amount = $1::numeric, remaining_amount = $2::numeric,
                  status = CASE WHEN $2::numeric <= 0 THEN 'PAYEE' ELSE 'PARTIELLEMENT_PAYEE' END,
                  updated_at = now()
            WHERE id = $3`, [apres, du - apres, declaration.id]);

        await client.query("COMMIT");
        res.json({
          paiement: lignes[0], reste_du: du - apres,
          quittance: mouvement.transaction.transaction_number,
          solde_compte_apres: mouvement.solde_apres,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Paiement impossible.");
      } finally { client.release(); }
    }
  );

  router.get(
    "/fiscalite/calendrier", authenticateToken, requirePermission("fiscalite", "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `SELECT d.id, d.reference, d.period_code, d.due_date, d.declared_amount,
                  d.remaining_amount, d.status, t.code, t.name,
                  (d.due_date - CURRENT_DATE) AS jours_restants
             FROM tax_declarations d
             JOIN tax_types t ON t.id = d.tax_type_id
            WHERE d.company_id = $1
              AND d.status NOT IN ('PAYEE','EXONEREE','ANNULEE')
              AND d.due_date IS NOT NULL
            ORDER BY d.due_date`, [companyId]);

        /* Rappels J-15, J-7, J-3, J-1 et le jour même : on ne les invente pas,
           on marque simplement les échéances qui tombent dessus. */
        const jalons = [15, 7, 3, 1, 0];
        res.json({
          echeances: rows.map((e) => ({
            ...e,
            en_retard: Number(e.jours_restants) < 0,
            rappel: jalons.includes(Number(e.jours_restants)) ? `J-${e.jours_restants}` : null,
          })),
          en_retard: rows.filter((e) => Number(e.jours_restants) < 0).length,
          penalite: MESSAGE_PENALITE,
        });
      } catch (e) { fail(res, e, "Impossible de lire le calendrier fiscal."); }
    }
  );

  return router;
};
