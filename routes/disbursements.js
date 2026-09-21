"use strict";

/**
 * PHASES 13-22 — Demandes de décaissement (Triangle WMS).
 * RÉUTILISE la table existante `disbursement_requests` (aucune table dupliquée).
 *
 * RÈGLE ABSOLUE : la trésorerie ne bouge NI à la création, NI à la soumission,
 * NI à la validation Direction. Elle ne change QU'AU décaissement réel, qui
 * crée une transaction de trésorerie + des écritures comptables ÉQUILIBRÉES
 * (jamais de solde modifié directement).
 *
 * Aucun nom de personne codé en dur : tout passe par les rôles/permissions.
 */
const express = require("express");

const S = {
  DRAFT: "BROUILLON", SUBMITTED: "SOUMISE", WAITING_DIR: "EN_ATTENTE_DIRECTION",
  APPROVED: "VALIDEE_DIRECTION", REJECTED: "REFUSEE_DIRECTION",
  WAITING_DISB: "EN_ATTENTE_DECAISSEMENT", DISBURSED: "DECAISSEE",
  WAITING_RECEIPTS: "EN_ATTENTE_JUSTIFICATIFS", RECEIPTS_UPLOADED: "JUSTIFICATIFS_DEPOSES",
  IN_REVIEW: "EN_CONTROLE", CLOSED: "CLOTUREE", CANCELLED: "ANNULEE",
};

module.exports = function createDisbursementsRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission,
          createNotification, accounting, upload, rbacHelper } = deps;
  const router = express.Router();
  /*
   * Société EFFECTIVE de la demande.
   *
   * Le frontend envoie x-active-company-id lorsqu'un compte bascule
   * Triangle <-> FAT & MAT. getEffectiveCompanyId contrôle que cette société
   * fait réellement partie des sociétés autorisées du compte.
   *
   * On ne lit jamais req.body.company_id ici : le navigateur ne doit pas
   * pouvoir forcer arbitrairement la société d'une demande.
   */
  const companyOf = (req) => {
    const companyId = Number(
      getEffectiveCompanyId(req, req.user?.company_id)
    );

    if (!Number.isInteger(companyId) || companyId <= 0) {
      const error = new Error("Société active impossible à déterminer.");
      error.code = "ACTIVE_COMPANY_REQUIRED";
      throw error;
    }

    return companyId;
  };
  // Clés présentes dans le catalogue administrable :
  // demande = création/suivi/validation Direction ; comptabilite = décaissement réel.
  const permRequest = (a) => requirePermission("demande", a);
  const permDirection = (a) => requirePermission("demande", a);
  const permDisburse = (a) => requirePermission("comptabilite", a);

  async function notify(userIds, payload) {
    if (!createNotification) return;
    for (const uid of [...new Set((userIds || []).filter(Boolean))]) {
      try { await createNotification({ ...payload, user_id: uid }); } catch { /* non bloquant */ }
    }
  }
  /* Permission effective : exception personnelle, puis rôle de la société,
     puis rôles historiques seulement si aucune règle n'est configurée. */
  async function hasCapability(user, companyId, moduleKey, action, fallbackRoles) {
    if (rbacHelper && rbacHelper.isSuperAdmin(user)) return true;
    const { rows } = await pool.query(
      `SELECT
         upo.effect AS user_effect,
         rp.allowed AS role_allowed
       FROM (SELECT 1) base
       LEFT JOIN user_permission_overrides upo
         ON upo.company_id=$1 AND upo.user_id=$2
        AND upo.module_key=$3 AND upo.action=$4
       LEFT JOIN role_permissions rp
         ON rp.company_id=$1 AND lower(rp.role)=lower($5)
        AND rp.module_key=$3 AND rp.action=$4`,
      [companyId, user.id, moduleKey, action, String(user.role || "")]
    );
    const configured = rows[0] || {};
    if (configured.user_effect != null) return configured.user_effect === "ALLOW";
    if (configured.role_allowed != null) return configured.role_allowed === true;
    return fallbackRoles.includes(String(user.role || "").toLowerCase().trim());
  }

  /* Destinataires par capacité, avec la même priorité que /permissions/me. */
  async function usersWithCapability(companyId, moduleKey, fallbackRoles) {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id
         FROM users u
         LEFT JOIN user_permission_overrides upo
           ON upo.company_id=$1 AND upo.user_id=u.id
          AND upo.module_key=$2 AND upo.action='validate'
         LEFT JOIN role_permissions rp
           ON rp.company_id=$1 AND lower(rp.role)=lower(u.role)
          AND rp.module_key=$2 AND rp.action='validate'
        WHERE u.company_id=$1 AND u.is_active=true
          AND CASE
            WHEN upo.effect IS NOT NULL THEN upo.effect='ALLOW'
            WHEN rp.allowed IS NOT NULL THEN rp.allowed=true
            ELSE lower(u.role)=ANY($3)
          END`,
      [companyId, moduleKey, fallbackRoles]
    );
    return rows.map((r) => r.id);
  }
  const DIRECTION_ROLES = ["direction", "directeur", "admin", "super_admin", "gerant"];

  /* Voit-il TOUTES les demandes de l'entreprise ? Oui si une permission de
     Direction ou de Décaissement lui est accordée (explicitement ou par rôle).
     Sinon : il ne voit que les siennes (demande.view personnel). */
  async function canSeeAll(req) {
    if (rbacHelper && rbacHelper.isSuperAdmin(req.user)) return true;
    const companyId = companyOf(req);
    if (await hasCapability(req.user, companyId, "demande", "validate", DIRECTION_ROLES)) return true;
    return hasCapability(req.user, companyId, "comptabilite", "view", ACCOUNTING_ROLES);
  }

  /* Garde de périmètre : une demande hors périmètre renvoie 404 (on ne révèle
     pas son existence), même en changeant l'ID dans l'URL. */
  async function loadScoped(req, id) {
    const companyId = companyOf(req);
    const { rows } = await pool.query(
      `SELECT d.*,
              (
              SELECT
                string_agg(
                  DISTINCT c.code,
                  ', '
                  ORDER BY c.code
                )

              FROM disbursement_request_lines dl

              JOIN camions c
                ON c.id=dl.camion_id
               AND c.company_id=dl.company_id

              WHERE dl.request_id=d.id
                AND dl.company_id=d.company_id

            ) AS camion_code
         FROM disbursement_requests d
        WHERE d.id=$1 AND d.company_id=$2`,
      [id, companyId]
    );
    const row = rows[0];
    if (!row) return null;
    if (await canSeeAll(req)) return row;
    return Number(row.requester_id) === Number(req.user.id) ? row : null;
  }
  const ACCOUNTING_ROLES = ["comptable", "admin", "super_admin", "direction"];

  async function shortNumber(client, prefix, companyId) {
    const d = new Date();

    const stamp =
      String(d.getFullYear()).slice(2) +
      String(d.getMonth() + 1).padStart(2, "0") +
      String(d.getDate()).padStart(2, "0");

    const counterKey = `${prefix}#${stamp}`;

    /*
     * DISBURSEMENT_VOUCHER_NUMBER_V1
     *
     * DD :
     *   numéro de demande global, unique entre sociétés.
     *
     * BD :
     *   numéro de bon unique DANS chaque société,
     *   basé sur voucher_number et non request_number.
     */
    if (prefix === "BD") {

      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        [`triangle-voucher:${companyId}:${counterKey}`]
      );

      const voucherRows = await client.query(
        `SELECT
           COALESCE(
             MAX(
               substring(
                 voucher_number
                 FROM '([0-9]+)$'
               )::integer
             ),
             0
           ) AS last_seq
         FROM disbursement_requests
         WHERE company_id=$1
           AND voucher_number LIKE $2`,
        [
          companyId,
          `${prefix}-${stamp}-%`
        ]
      );

      const nextVoucherSeq =
        Number(
          voucherRows.rows[0]?.last_seq || 0
        ) + 1;

      await client.query(
        `INSERT INTO stock_request_counters
           (
             company_id,
             year,
             prefix,
             last_seq
           )
         VALUES ($1,$2,$3,$4)

         ON CONFLICT
           (company_id,year,prefix)

         DO UPDATE
           SET last_seq =
             GREATEST(
               stock_request_counters.last_seq,
               EXCLUDED.last_seq
             )`,
        [
          companyId,
          d.getFullYear(),
          counterKey,
          nextVoucherSeq
        ]
      );

      return (
        `${prefix}-${stamp}-` +
        String(nextVoucherSeq).padStart(3, "0")
      );
    }

    /*
     * DISBURSEMENT_GLOBAL_NUMBER_V1
     *
     * request_number possède une contrainte UNIQUE globale.
     * Il ne faut donc PAS générer DD-... séparément
     * pour Triangle et FAT & MAT.
     *
     * Le verrou transactionnel garantit que deux utilisateurs
     * ne reçoivent jamais le même numéro simultanément.
     */
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`triangle-disbursement:${counterKey}`]
    );

    const { rows } = await client.query(
      `SELECT
         COALESCE(
           MAX(
             substring(
               request_number
               FROM '([0-9]+)$'
             )::integer
           ),
           0
         ) AS last_seq
       FROM disbursement_requests
       WHERE request_number LIKE $1`,
      [`${prefix}-${stamp}-%`]
    );

    const nextSeq =
      Number(rows[0]?.last_seq || 0) + 1;

    /*
     * On resynchronise aussi le compteur historique
     * de l'entreprise, mais il ne décide plus du numéro.
     */
    await client.query(
      `INSERT INTO stock_request_counters
         (
           company_id,
           year,
           prefix,
           last_seq
         )
       VALUES ($1,$2,$3,$4)

       ON CONFLICT
         (company_id,year,prefix)

       DO UPDATE
         SET last_seq =
           GREATEST(
             stock_request_counters.last_seq,
             EXCLUDED.last_seq
           )`,
      [
        companyId,
        d.getFullYear(),
        counterKey,
        nextSeq
      ]
    );

    return (
      `${prefix}-${stamp}-` +
      String(nextSeq).padStart(3, "0")
    );
  }

  async function audit(client, companyId, userId, action, entityId, reference, oldV, newV, ip) {
    await client.query(
      `INSERT INTO stock_audit_logs (company_id, user_id, action, entity, entity_id, reference, old_value, new_value, ip)
       VALUES ($1,$2,$3,'disbursement_request',$4,$5,$6,$7,$8)`,
      [companyId, userId || null, action, entityId || null, reference || null,
       oldV ? JSON.stringify(oldV) : null, newV ? JSON.stringify(newV) : null, ip || null]
    ).catch(() => {});
  }

  // ---------- CRÉATION MULTI-LIGNES (aucun impact trésorerie) ----------

  /*
   * Camions disponibles pour une demande de décaissement.
   *
   * Important :
   * - pas besoin d'ouvrir le module général Camions ;
   * - on utilise l'entreprise ACTIVE de la session ;
   * - uniquement les camions ACTIFS de cette entreprise.
   */
  router.get(
    "/disbursement-camions",
    authenticateToken,
    async (req, res) => {

      try {

        const companyId = companyOf(req);

        if (!companyId) {
          return res.status(400).json({
            error: "Entreprise active introuvable."
          });
        }

        const { rows } = await pool.query(
          `SELECT
             id,
             code,
             statut
           FROM camions
           WHERE company_id=$1
             AND statut='ACTIF'
           ORDER BY code`,
          [companyId]
        );

        return res.json(rows);

      } catch (error) {

        console.error(
          "GET /disbursement-camions:",
          error
        );

        return res.status(500).json({
          error:
            "Erreur chargement des camions."
        });

      }
    }
  );


router.post("/disbursements", authenticateToken, permRequest("create"), async (req, res) => {
    const client = await pool.connect();

    try {
      const b = req.body || {};

      // MULTI_CAMION_LINES_V2
      const detailedPricingRequired =
        [1,5].includes(Number(companyOf(req)));

      /*
       * Compatibilité :
       * - nouveau frontend : b.lines[]
       * - ancien frontend/API : amount/category/reason
       */
      const explicitLines = Array.isArray(b.lines) && b.lines.length > 0;

      const rawLines = explicitLines
        ? b.lines
        : [{
            category: b.category || null,
            label: b.reason || "",
            amount: b.amount,
          }];

      if (rawLines.length > 50) {
        return res.status(400).json({
          error: "Une demande ne peut pas contenir plus de 50 lignes."
        });
      }

      const lines = [];

      for (let i = 0; i < rawLines.length; i += 1) {
        const raw = rawLines[i] || {};

        const category =
          String(raw.category || "").trim() || "Non catégorisé";

        const label =
          String(
            raw.label ||
            raw.reason ||
            raw.description ||
            ""
          ).trim();

        const quantity = Number(raw.quantity);
        const unitPrice = Number(raw.unit_price);

        const lineCamionId =
          raw.camion_id !== undefined &&
          raw.camion_id !== null &&
          String(raw.camion_id).trim() !== ""
            ? Number(raw.camion_id)
            : null;

        const lineAmount =
          detailedPricingRequired
            ? quantity * unitPrice
            : (
                quantity > 0 && unitPrice > 0
                  ? quantity * unitPrice
                  : Number(raw.amount)
              );

        if (!label) {
          return res.status(400).json({
            error: `Libellé obligatoire à la ligne ${i + 1}.`
          });
        }

        if (detailedPricingRequired) {

          if (!(quantity > 0)) {
            return res.status(400).json({
              error:
                `Quantité obligatoire et supérieure à zéro à la ligne ${i + 1}.`
            });
          }

          if (!(unitPrice > 0)) {
            return res.status(400).json({
              error:
                `Prix unitaire obligatoire et supérieur à zéro à la ligne ${i + 1}.`
            });
          }
        }

        if (!(lineAmount > 0)) {
          return res.status(400).json({
            error: `Montant invalide à la ligne ${i + 1}.`
          });
        }

        lines.push({
          line_no: i + 1,
          category,
          label,
          quantity:
            Number.isFinite(quantity)
              ? quantity
              : null,
          unit_price:
            Number.isFinite(unitPrice)
              ? unitPrice
              : null,
          camion_id: lineCamionId,
          amount: lineAmount,
        });
      }

      if (lines.length === 0) {
        return res.status(400).json({
          error: "Ajoutez au moins une ligne à la demande."
        });
      }

      const amount = lines.reduce(
        (sum, line) => sum + Number(line.amount),
        0
      );

      if (!(amount > 0)) {
        return res.status(400).json({
          error: "Montant total invalide."
        });
      }

      const reason =
        String(b.reason || "").trim() ||
        lines[0].label;

      if (!reason) {
        return res.status(400).json({
          error: "Objet / motif obligatoire."
        });
      }

      const companyId = companyOf(req);

      // CAMION PAR LIGNE

      /*
       * DISBURSEMENT_TRUCK_OPTIONAL_BACK_V3
       *
       * Aucun camion n'est obligatoire.
       * S'il est renseigné, le contrôle
       * société + statut ACTIF ci-dessous
       * reste entièrement appliqué.
       */

      /*
       * Vérifier tous les camions choisis contre
       * l'entreprise active.
       */
      const selectedTruckIds =
        [
          ...new Set(
            lines
              .map(
                (line) =>
                  Number(line.camion_id || 0)
              )
              .filter(Boolean)
          )
        ];


      if (selectedTruckIds.length > 0) {

        const truckRows = (
          await client.query(
            `SELECT id
               FROM camions
              WHERE company_id=$1
                AND statut='ACTIF'
                AND id=ANY($2::int[])`,
            [
              companyId,
              selectedTruckIds
            ]
          )
        ).rows;


        const validTruckIds =
          new Set(
            truckRows.map(
              (row) => Number(row.id)
            )
          );


        const invalidTruck =
          selectedTruckIds.find(
            (id) =>
              !validTruckIds.has(Number(id))
          );


        if (invalidTruck) {

          return res.status(400).json({
            error:
              "Un camion sélectionné n'appartient pas à cette entreprise ou est inactif."
          });

        }
      }


      await client.query("BEGIN");

      const number = await shortNumber(
        client,
        "DD",
        companyId
      );

      const me = (
        await client.query(
          `SELECT fullname, role
             FROM users
            WHERE id=$1`,
          [req.user.id]
        )
      ).rows[0] || {};

      const status =
        b.submit === true
          ? S.WAITING_DIR
          : S.DRAFT;

      const parentCategory =
        lines.length === 1
          ? lines[0].category
          : "Multi-catégories";

      const { rows } = await client.query(
        `INSERT INTO disbursement_requests
           (
             company_id,
             request_number,
             requester_id,
             requester_name,
             requester_role,
             beneficiary_name,
             amount,
             category,
             urgency,
             reason,
             status,
             payment_method,
             initial_attachment_url,
             camion_id
           )
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          companyId,
          number,
          req.user.id,
          me.fullname || null,
          me.role || null,
          String(b.beneficiary_name || "").trim() || null,
          amount,
          parentCategory,
          b.urgency || "normale",
          reason,
          status,
          b.payment_method || null,
          b.initial_attachment_url || null,
          null,
        ]
      );

      const request = rows[0];

      for (const line of lines) {

        await client.query(

          `INSERT INTO disbursement_request_lines
             (
               company_id,
               request_id,
               line_no,
               category,
               label,
               quantity,
               unit_price,
               camion_id,
               amount
             )

           VALUES
             ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,

          [
            companyId,
            request.id,
            line.line_no,
            line.category,
            line.label,
            line.quantity,
            line.unit_price,
            line.camion_id,
            line.amount,
          ]

        );

      }


      await audit(
        client,
        companyId,
        req.user.id,
        "create",
        request.id,
        number,
        null,
        {
          status,
          amount,
          lines,
        },
        req.ip
      );

      await client.query("COMMIT");

      if (status === S.WAITING_DIR) {
        await notify(
          await usersWithCapability(
            companyId,
            "finance.direction",
            DIRECTION_ROLES
          ),
          {
            company_id: companyId,
            type: "finance",
            title: "Demande de décaissement à valider",
            message:
              `${number} — ${amount} FCFA — ` +
              `${lines.length} ligne(s) — ` +
              `${reason.slice(0, 60)}`,
            related_entity_type: "disbursement_request",
            related_entity_id: request.id,
            action_url: `/direction?id=${request.id}`,
            created_by: req.user.id,
            priority: "high",
          }
        );
      }

      res.status(201).json({
        ...request,
        lines,
        treasury_impacted: false,
      });

    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("disbursements create:", e);

      res.status(500).json({
        error: "Erreur création de la demande."
      });

    } finally {
      client.release();
    }
  });

  // ---------- LISTE / DÉTAIL ----------
  router.get("/disbursements", authenticateToken, permRequest("view"), async (req, res) => {
    try {
      const params = [companyOf(req)];
      let where = "company_id=$1";
      if (req.query.status) { params.push(req.query.status); where += ` AND status=$${params.length}`; }
      // Périmètre : seuls les profils habilités (Direction / Comptabilité) voient
      // TOUTES les demandes. Sinon l'utilisateur ne voit que les siennes.
      const seeAll = await canSeeAll(req);
      if (req.query.mine === "1" || !seeAll) { params.push(req.user.id); where += ` AND requester_id=$${params.length}`; }
      const { rows } = await pool.query(
        `SELECT d.*,
                  (
            SELECT
              string_agg(
                DISTINCT c.code,
                ', '
                ORDER BY c.code
              )

            FROM disbursement_request_lines dl

            JOIN camions c
              ON c.id=dl.camion_id
             AND c.company_id=dl.company_id

            WHERE dl.request_id=d.id
              AND dl.company_id=d.company_id

          ) AS camion_code
             FROM disbursement_requests d
            WHERE ${where}
            ORDER BY d.created_at DESC
            LIMIT 300`, params
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur demandes." }); }
  });

  router.get("/disbursements/:id", authenticateToken, permRequest("view"), async (req, res) => {
    const row = await loadScoped(req, req.params.id);
    if (!row) return res.status(404).json({ error: "Demande introuvable." });
    res.json(row);
  });


  /*
   * DISBURSEMENT_EDIT_NO_DESCRIPTION_V6
   * DISBURSEMENT_EDIT_BEFORE_DIRECTION_V1
   *
   * Le demandeur peut modifier :
   * - BROUILLON
   * - EN_ATTENTE_DIRECTION
   *
   * Dès validation Direction :
   * verrouillage définitif du contenu financier.
   */
  router.put(
    "/disbursements/:id",
    authenticateToken,
    permRequest("update"),
    async (req, res) => {

      const client =
        await pool.connect();

      try {

        const companyId =
          companyOf(req);

        const b =
          req.body || {};

        await client.query("BEGIN");


        const cur = (
          await client.query(
            `SELECT *
               FROM disbursement_requests
              WHERE id=$1
                AND company_id=$2
              FOR UPDATE`,
            [
              req.params.id,
              companyId
            ]
          )
        ).rows[0];


        if (!cur) {

          await client.query("ROLLBACK");

          return res
            .status(404)
            .json({
              error:
                "Demande introuvable."
            });
        }


        /*
         * Seul le créateur modifie sa demande.
         */
        if (
          Number(cur.requester_id) !==
          Number(req.user.id)
        ) {

          await client.query("ROLLBACK");

          return res
            .status(403)
            .json({
              error:
                "Seul le demandeur peut modifier cette demande."
            });
        }


        if (
          ![
            S.DRAFT,
            S.WAITING_DIR
          ].includes(cur.status)
        ) {

          await client.query("ROLLBACK");

          return res
            .status(409)
            .json({
              error:
                "Cette demande a déjà été traitée par la Direction et ne peut plus être modifiée.",
              code:
                "REQUEST_LOCKED"
            });
        }


        const rawLines =
          Array.isArray(b.lines)
            ? b.lines
            : [];


        if (
          rawLines.length < 1 ||
          rawLines.length > 50
        ) {

          await client.query("ROLLBACK");

          return res
            .status(400)
            .json({
              error:
                "La demande doit contenir entre 1 et 50 lignes."
            });
        }


        const lines = [];

        for (
          let i = 0;
          i < rawLines.length;
          i += 1
        ) {

          const raw =
            rawLines[i] || {};

          const category =
            String(
              raw.category || ""
            ).trim();

          const label =
            String(
              raw.label || ""
            ).trim();

          const quantity =
            Number(raw.quantity);

          const unitPrice =
            Number(raw.unit_price);

          const camionId =
            raw.camion_id !== undefined &&
            raw.camion_id !== null &&
            String(raw.camion_id).trim() !== ""
              ? Number(raw.camion_id)
              : null;


          if (!category) {

            await client.query("ROLLBACK");

            return res
              .status(400)
              .json({
                error:
                  `Catégorie obligatoire à la ligne ${i + 1}.`
              });
          }


          if (!label) {

            await client.query("ROLLBACK");

            return res
              .status(400)
              .json({
                error:
                  `Libellé obligatoire à la ligne ${i + 1}.`
              });
          }


          if (!(quantity > 0)) {

            await client.query("ROLLBACK");

            return res
              .status(400)
              .json({
                error:
                  `Quantité obligatoire à la ligne ${i + 1}.`
              });
          }


          if (!(unitPrice > 0)) {

            await client.query("ROLLBACK");

            return res
              .status(400)
              .json({
                error:
                  `Prix unitaire obligatoire à la ligne ${i + 1}.`
              });
          }


          const amount =
            quantity *
            unitPrice;


          if (!(amount > 0)) {

            await client.query("ROLLBACK");

            return res
              .status(400)
              .json({
                error:
                  `Montant invalide à la ligne ${i + 1}.`
              });
          }


          lines.push({
            line_no:
              i + 1,
            category,
            label,
            quantity,
            unit_price:
              unitPrice,
            camion_id:
              camionId,
            amount
          });
        }


        /*
         * Vérifier uniquement les camions
         * réellement sélectionnés.
         */
        const selectedTruckIds =
          [
            ...new Set(
              lines
                .map(
                  (line) =>
                    Number(
                      line.camion_id || 0
                    )
                )
                .filter(Boolean)
            )
          ];


        if (
          selectedTruckIds.length > 0
        ) {

          const truckRows = (
            await client.query(
              `SELECT id
                 FROM camions
                WHERE company_id=$1
                  AND statut='ACTIF'
                  AND id=ANY($2::int[])`,
              [
                companyId,
                selectedTruckIds
              ]
            )
          ).rows;


          const validIds =
            new Set(
              truckRows.map(
                (row) =>
                  Number(row.id)
              )
            );


          const invalid =
            selectedTruckIds.find(
              (id) =>
                !validIds.has(
                  Number(id)
                )
            );


          if (invalid) {

            await client.query("ROLLBACK");

            return res
              .status(400)
              .json({
                error:
                  "Un camion sélectionné n'appartient pas à cette entreprise ou est inactif."
              });
          }
        }


        const amount =
          lines.reduce(
            (sum, line) =>
              sum +
              Number(line.amount),
            0
          );


        const reason =
          String(
            b.reason || ""
          ).trim();


        if (!reason) {

          await client.query("ROLLBACK");

          return res
            .status(400)
            .json({
              error:
                "Objet / motif obligatoire."
            });
        }


        const before = {
          reason:
            cur.reason,
          amount:
            cur.amount,
          beneficiary_name:
            cur.beneficiary_name,
          urgency:
            cur.urgency,
          payment_method:
            cur.payment_method,
          status:
            cur.status
        };


        const updated = (
          await client.query(
            `UPDATE disbursement_requests
                SET beneficiary_name=$3,
                    amount=$4,
                    category=$5,
                    urgency=$6,
                    reason=$7,
                    payment_method=$8,
                    updated_at=NOW()
              WHERE id=$1
                AND company_id=$2
              RETURNING *`,
            [
              cur.id,
              companyId,
              String(
                b.beneficiary_name || ""
              ).trim() || null,
              amount,
              lines.length === 1
                ? lines[0].category
                : "Multi-catégories",
              b.urgency ||
                "normale",
              reason,
              b.payment_method ||
                null
            ]
          )
        ).rows[0];


        /*
         * Remplacer uniquement les lignes
         * tant que Direction n'a pas validé.
         */
        await client.query(
          `DELETE FROM disbursement_request_lines
            WHERE request_id=$1
              AND company_id=$2`,
          [
            cur.id,
            companyId
          ]
        );


        for (
          const line of lines
        ) {

          await client.query(
            `INSERT INTO disbursement_request_lines
               (
                 company_id,
                 request_id,
                 line_no,
                 category,
                 label,
                 quantity,
                 unit_price,
                 camion_id,
                 amount
               )
             VALUES
               ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              companyId,
              cur.id,
              line.line_no,
              line.category,
              line.label,
              line.quantity,
              line.unit_price,
              line.camion_id,
              line.amount
            ]
          );
        }


        await audit(
          client,
          companyId,
          req.user.id,
          "update",
          cur.id,
          cur.request_number,
          before,
          {
            reason:
              updated.reason,
            amount:
              updated.amount,
            beneficiary_name:
              updated.beneficiary_name,
            urgency:
              updated.urgency,
            payment_method:
              updated.payment_method,
            description:
              updated.description,
            status:
              updated.status,
            lines
          },
          req.ip
        );


        await client.query("COMMIT");


        /*
         * Si déjà soumise,
         * prévenir à nouveau la Direction.
         */
        if (
          cur.status ===
          S.WAITING_DIR
        ) {

          await notify(
            await usersWithCapability(
              companyId,
              "demande",
              DIRECTION_ROLES
            ),
            {
              company_id:
                companyId,
              type:
                "finance",
              title:
                "Demande modifiée avant validation",
              message:
                `${cur.request_number} a été modifiée par le demandeur — ${amount} FCFA`,
              related_entity_type:
                "disbursement_request",
              related_entity_id:
                cur.id,
              action_url:
                `/direction?id=${cur.id}`,
              created_by:
                req.user.id,
              priority:
                "high"
            }
          );
        }


        return res.json({
          ...updated,
          lines,
          treasury_impacted:
            false
        });


      } catch (e) {

        await client
          .query("ROLLBACK")
          .catch(() => {});

        console.error(
          "disbursements update:",
          e
        );

        return res
          .status(500)
          .json({
            error:
              "Erreur modification de la demande."
          });

      } finally {

        client.release();
      }

    }
  );


  
  /*
   * DISBURSEMENT_REQUESTER_DELETE_CORRECTION_V1
   *
   * REGLES :
   * - Le demandeur peut supprimer/annuler sa propre demande
   *   tant qu'elle n'a PAS été validée par la Direction.
   * - La suppression est logique : statut ANNULEE.
   *   Aucun historique financier n'est détruit.
   * - La Direction peut demander une correction uniquement
   *   sur EN_ATTENTE_DIRECTION.
   * - Une demande à corriger revient en BROUILLON afin que
   *   le demandeur puisse la modifier puis la soumettre à nouveau.
   */

  router.delete(
    "/disbursements/:id",
    authenticateToken,
    permRequest("update"),
    async (req, res) => {
      const client = await pool.connect();

      try {
        const companyId = companyOf(req);

        await client.query("BEGIN");

        const cur = (
          await client.query(
            `SELECT *
               FROM disbursement_requests
              WHERE id=$1
                AND company_id=$2
              FOR UPDATE`,
            [req.params.id, companyId]
          )
        ).rows[0];

        if (!cur) {
          await client.query("ROLLBACK");
          return res.status(404).json({
            error: "Demande introuvable."
          });
        }

        if (
          Number(cur.requester_id) !==
          Number(req.user.id)
        ) {
          await client.query("ROLLBACK");
          return res.status(403).json({
            error:
              "Seul le demandeur peut supprimer cette demande."
          });
        }

        if (
          ![
            S.DRAFT,
            S.WAITING_DIR
          ].includes(cur.status)
        ) {
          await client.query("ROLLBACK");

          return res.status(409).json({
            error:
              "Cette demande a déjà été traitée par la Direction et ne peut plus être supprimée.",
            code: "REQUEST_LOCKED"
          });
        }

        const row = (
          await client.query(
            `UPDATE disbursement_requests
                SET status=$3,
                    updated_at=NOW()
              WHERE id=$1
                AND company_id=$2
          RETURNING *`,
            [
              cur.id,
              companyId,
              S.CANCELLED
            ]
          )
        ).rows[0];

        await audit(
          client,
          companyId,
          req.user.id,
          "cancel_by_requester",
          cur.id,
          cur.request_number,
          { status: cur.status },
          { status: S.CANCELLED },
          req.ip
        );

        await client.query("COMMIT");

        return res.json({
          ...row,
          deleted: true,
          treasury_impacted: false
        });

      } catch (e) {
        await client
          .query("ROLLBACK")
          .catch(() => {});

        console.error(
          "Erreur annulation demande:",
          e
        );

        return res.status(500).json({
          error:
            "Erreur lors de la suppression de la demande."
        });

      } finally {
        client.release();
      }
    }
  );


  router.post(
    "/disbursements/:id/correction",
    authenticateToken,
    permDirection("validate"),
    async (req, res) => {
      const client = await pool.connect();

      try {
        const companyId = companyOf(req);

        const comment =
          String(
            req.body?.comment ||
            req.body?.reason ||
            ""
          ).trim();

        if (!comment) {
          return res.status(400).json({
            error:
              "Le motif de correction est obligatoire."
          });
        }

        await client.query("BEGIN");

        const cur = (
          await client.query(
            `SELECT *
               FROM disbursement_requests
              WHERE id=$1
                AND company_id=$2
              FOR UPDATE`,
            [req.params.id, companyId]
          )
        ).rows[0];

        if (!cur) {
          await client.query("ROLLBACK");
          return res.status(404).json({
            error: "Demande introuvable."
          });
        }

        if (cur.status !== S.WAITING_DIR) {
          await client.query("ROLLBACK");

          return res.status(409).json({
            error:
              "Une correction ne peut être demandée que pour une demande en attente de validation Direction.",
            code: "REQUEST_NOT_WAITING_DIRECTION"
          });
        }

        const correctionComment =
          `CORRECTION DEMANDÉE : ${comment}`;

        const row = (
          await client.query(
            `UPDATE disbursement_requests
                SET status=$3,
                    approval_comment=$4,
                    approved_by=NULL,
                    approved_at=NULL,
                    updated_at=NOW()
              WHERE id=$1
                AND company_id=$2
          RETURNING *`,
            [
              cur.id,
              companyId,
              S.DRAFT,
              correctionComment
            ]
          )
        ).rows[0];

        await audit(
          client,
          companyId,
          req.user.id,
          "correction_requested",
          cur.id,
          cur.request_number,
          {
            status: cur.status,
            approval_comment:
              cur.approval_comment
          },
          {
            status: S.DRAFT,
            approval_comment:
              correctionComment
          },
          req.ip
        );

        await client.query("COMMIT");

        return res.json({
          ...row,
          correction_requested: true,
          treasury_impacted: false
        });

      } catch (e) {
        await client
          .query("ROLLBACK")
          .catch(() => {});

        console.error(
          "Erreur demande correction:",
          e
        );

        return res.status(500).json({
          error:
            "Erreur lors de la demande de correction."
        });

      } finally {
        client.release();
      }
    }
  );


// ---------- SOUMISSION ----------
  router.post("/disbursements/:id/submit", authenticateToken, permRequest("update"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM disbursement_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Demande introuvable." }); }
      if (cur.status !== S.DRAFT) { await client.query("ROLLBACK"); return res.status(409).json({ error: `Demande déjà ${cur.status}.`, code: "ALREADY_PROCESSED" }); }
      const { rows } = await client.query(`UPDATE disbursement_requests SET status=$3, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`, [cur.id, companyId, S.WAITING_DIR]);
      await audit(client, companyId, req.user.id, "submit", cur.id, cur.request_number, { status: cur.status }, { status: S.WAITING_DIR }, req.ip);
      await client.query("COMMIT");
      await notify(await usersWithCapability(companyId, "demande", DIRECTION_ROLES), {
        company_id: companyId, type: "finance", title: "Demande de décaissement à valider",
        message: `${cur.request_number} — ${cur.amount} FCFA`, related_entity_type: "disbursement_request",
        related_entity_id: cur.id, action_url: `/direction?id=${cur.id}`, created_by: req.user.id, priority: "high",
      });
      res.json({ ...rows[0], treasury_impacted: false });
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error(e); res.status(500).json({ error: "Erreur soumission." }); }
    finally { client.release(); }
  });

  // ---------- VALIDATION DIRECTION (aucun impact trésorerie) ----------
  router.post("/disbursements/:id/approve", authenticateToken, permDirection("validate"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM disbursement_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Demande introuvable." }); }
      if (![S.SUBMITTED, S.WAITING_DIR].includes(cur.status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Validation impossible : demande ${cur.status}.`, code: "ALREADY_PROCESSED" });
      }
      const me = (await client.query(`SELECT fullname FROM users WHERE id=$1`, [req.user.id])).rows[0] || {};
      const { rows } = await client.query(
        `UPDATE disbursement_requests SET status=$3, approved_by=$4, approved_by_name=$5, approved_at=NOW(),
           approval_comment=$6, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`,
        [cur.id, companyId, S.WAITING_DISB, req.user.id, me.fullname || null, req.body?.comment || null]
      );
      await audit(client, companyId, req.user.id, "approve", cur.id, cur.request_number, { status: cur.status }, { status: S.WAITING_DISB }, req.ip);
      await client.query("COMMIT");
      // La demande apparaît AUTOMATIQUEMENT chez le comptable (statut EN_ATTENTE_DECAISSEMENT).
      await notify([cur.requester_id, ...(await usersWithCapability(companyId, "comptabilite", ACCOUNTING_ROLES))], {
        company_id: companyId, type: "finance", title: "Décaissement à effectuer",
        message: `${cur.request_number} validée par la Direction — ${cur.amount} FCFA à décaisser.`,
        related_entity_type: "disbursement_request", related_entity_id: cur.id,
        action_url: `/decaissements?id=${cur.id}`, created_by: req.user.id, priority: "high",
      });
      res.json({ ...rows[0], treasury_impacted: false });
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error(e); res.status(500).json({ error: "Erreur validation." }); }
    finally { client.release(); }
  });

  // ---------- REFUS DIRECTION (motif obligatoire) ----------
  router.post("/disbursements/:id/reject", authenticateToken, permDirection("validate"), async (req, res) => {
    const client = await pool.connect();
    try {
      const reason = String(req.body?.reason || "").trim();
      if (!reason) return res.status(400).json({ error: "Motif de refus obligatoire." });
      const companyId = companyOf(req);
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM disbursement_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Demande introuvable." }); }
      if (![S.SUBMITTED, S.WAITING_DIR].includes(cur.status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Refus impossible : demande ${cur.status}.`, code: "ALREADY_PROCESSED" });
      }
      const me = (await client.query(`SELECT fullname FROM users WHERE id=$1`, [req.user.id])).rows[0] || {};
      const { rows } = await client.query(
        `UPDATE disbursement_requests SET status=$3, approved_by=$4, approved_by_name=$5, approved_at=NOW(),
           approval_comment=$6, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`,
        [cur.id, companyId, S.REJECTED, req.user.id, me.fullname || null, reason]
      );
      await audit(client, companyId, req.user.id, "reject", cur.id, cur.request_number, { status: cur.status }, { status: S.REJECTED, reason }, req.ip);
      await client.query("COMMIT");
      await notify([cur.requester_id], {
        company_id: companyId, type: "finance", title: "Demande de décaissement refusée",
        message: `${cur.request_number} refusée. Motif : ${reason}`,
        related_entity_type: "disbursement_request", related_entity_id: cur.id,
        action_url: `/decaissements?id=${cur.id}`, created_by: req.user.id, priority: "high",
      });
      res.json({ ...rows[0], treasury_impacted: false });
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error(e); res.status(500).json({ error: "Erreur refus." }); }
    finally { client.release(); }
  });

  // ---------- DÉCAISSEMENT RÉEL — SEUL POINT QUI TOUCHE LA TRÉSORERIE ----------
  router.post("/disbursements/:id/disburse", authenticateToken, permDisburse("validate"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      const b = req.body || {};
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM disbursement_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Demande introuvable." }); }
      // Anti double décaissement (double clic / double appel API).
      if (cur.status !== S.WAITING_DISB) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Décaissement impossible : demande ${cur.status}.`, code: "ALREADY_PROCESSED", status: cur.status });
      }
      const validated = Number(cur.amount) || 0;
      const real = b.amount_disbursed != null ? Number(b.amount_disbursed) : validated;
      if (!(real > 0)) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Montant décaissé invalide." }); }
      // Écart -> justification obligatoire ; dépassement -> refusé.
      if (real !== validated && !String(b.justification || "").trim()) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Montant différent du montant validé (${validated}) : justification obligatoire.`, code: "JUSTIFICATION_REQUIRED" });
      }
      if (real > validated && b.allow_over !== true) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Montant décaissé (${real}) supérieur au montant validé (${validated}).`, code: "OVER_AMOUNT" });
      }

      // Trésorerie : transaction + écritures ÉQUILIBRÉES (jamais de solde isolé).
      const num = await accounting.nextAccountingNumber(client, "accounting_transactions", "transaction_number", "DEC", companyId);
      const tx = await client.query(
        `INSERT INTO accounting_transactions (company_id, transaction_number, transaction_type, source_type, source_id,
           amount, currency, direction, category, partner_name, description, status, created_by, validated_by, validated_at, created_at, updated_at)
         VALUES ($1,$2,'decaissement','disbursement_request',$3,$4,'FCFA','sortie',$5,$6,$7,'validé',$8,$8,NOW(),NOW(),NOW()) RETURNING id`,
        [companyId, num, cur.id, real, cur.category || "Décaissement", cur.beneficiary_name || null,
         `Décaissement ${cur.request_number} — ${String(cur.reason || "").slice(0, 80)}`, req.user.id]
      );
      await client.query(
        `INSERT INTO treasury_accounts (company_id, currency, initial_balance, current_balance, updated_by)
         SELECT $1,'FCFA',0,0,$2 WHERE NOT EXISTS (SELECT 1 FROM treasury_accounts WHERE company_id=$1)`,
        [companyId, req.user.id]
      );
      await client.query(
        `UPDATE treasury_accounts SET current_balance = COALESCE(current_balance,0) - $1, updated_by=$2, updated_at=NOW() WHERE company_id=$3`,
        [real, req.user.id, companyId]
      );
      await accounting.createAccountingEntry(client, { companyId, sourceType: "disbursement_request", sourceId: tx.rows[0].id,
        accountLabel: "Charges / Décaissements", debit: real, credit: 0, description: `Décaissement ${cur.request_number}`, createdBy: req.user.id });
      await accounting.createAccountingEntry(client, { companyId, sourceType: "disbursement_request", sourceId: tx.rows[0].id,
        accountLabel: b.account_label || "Caisse", debit: 0, credit: real, description: `Décaissement ${cur.request_number}`, createdBy: req.user.id });

      const me = (await client.query(`SELECT fullname FROM users WHERE id=$1`, [req.user.id])).rows[0] || {};

      const voucher = await shortNumber(client, "BD", companyId);


      const { rows } = await client.query(
        `UPDATE disbursement_requests SET status=$3, amount_disbursed=$4, disbursed_by=$5, disbursed_by_name=$6,
           disbursed_at=NOW(), payment_method=COALESCE($7, payment_method),
           disbursement_comment=$8, voucher_number=$9, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`,
        [cur.id, companyId, S.WAITING_RECEIPTS, real, req.user.id, me.fullname || null,
         b.payment_method || null,
         [b.justification, b.payment_reference ? `Réf. ${b.payment_reference}` : null].filter(Boolean).join(" — ") || null,
         voucher]
      );
      await audit(client, companyId, req.user.id, "disburse", cur.id, cur.request_number, { status: cur.status }, { status: S.WAITING_RECEIPTS, amount: real, voucher, transaction_id: tx.rows[0].id }, req.ip);
      await client.query("COMMIT");
      await notify([cur.requester_id, cur.approved_by], {
        company_id: companyId, type: "finance", title: "Décaissement effectué",
        message: `${cur.request_number} : ${real} FCFA décaissés. Justificatifs attendus.`,
        related_entity_type: "disbursement_request", related_entity_id: cur.id,
        action_url: `/decaissements?id=${cur.id}`, created_by: req.user.id,
      });
      res.json({ ...rows[0], voucher_number: voucher, transaction_id: tx.rows[0].id, treasury_impacted: true });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("disburse:", e);
      res.status(500).json({ error: "Erreur décaissement." });
    } finally { client.release(); }
  });

  // ---------- JUSTIFICATIFS ----------
  const receiptUpload = upload ? upload.single("file") : (req, res, next) => next();
  router.post("/disbursements/:id/receipt", authenticateToken, permRequest("update"), receiptUpload, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const url = req.file ? `/uploads/disbursements/${req.file.filename}` : (req.body?.receipt_url || null);
      if (!url) return res.status(400).json({ error: "Aucun justificatif fourni (PDF, JPG, JPEG ou PNG)." });
      const { rows } = await pool.query(
        `UPDATE disbursement_requests SET receipt_url=$3, receipt_uploaded_at=NOW(),
           status=CASE WHEN status=$4 THEN $5 ELSE status END, updated_at=NOW()
         WHERE id=$1 AND company_id=$2 RETURNING *`,
        [req.params.id, companyId, url, S.WAITING_RECEIPTS, S.RECEIPTS_UPLOADED]
      );
      if (!rows[0]) return res.status(404).json({ error: "Demande introuvable." });
      await notify(await usersWithCapability(companyId, "comptabilite", ACCOUNTING_ROLES), {
        company_id: companyId, type: "finance", title: "Justificatif déposé",
        message: `${rows[0].request_number} : justificatif à contrôler.`,
        related_entity_type: "disbursement_request", related_entity_id: rows[0].id,
        action_url: `/decaissements?id=${cur.id}`, created_by: req.user.id,
      });
      res.json({ ...rows[0], treasury_impacted: false });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur justificatif." }); }
  });

  /* Synthèse des montants d'une demande : décaissé / justifié / remboursé /
     reste à justifier. Un justificatif REFUSÉ ne compte pas. */
  async function amountsOf(companyId, requestId, client = pool) {
    const req = (await client.query(`SELECT amount, amount_disbursed FROM disbursement_requests WHERE id=$1 AND company_id=$2`, [requestId, companyId])).rows[0];
    if (!req) return null;
    const justified = Number((await client.query(
      `SELECT COALESCE(SUM(amount),0) s FROM disbursement_receipts
        WHERE request_id=$1
          AND company_id=$2
          AND review_status <> 'REFUSE'
          AND COALESCE(receipt_type,'FILE') <> 'PENDING'`, [requestId, companyId]
    )).rows[0].s) || 0;
    const refunded = Number((await client.query(
      `SELECT COALESCE(SUM(amount),0) s FROM disbursement_refunds WHERE request_id=$1 AND company_id=$2`, [requestId, companyId]
    )).rows[0].s) || 0;
    const disbursed = Number(req.amount_disbursed) || 0;
    const remaining = Math.max(0, disbursed - justified - refunded);
    return { disbursed, justified, refunded, remaining, fully_justified: remaining <= 0.009 };
  }

  // Détail complet : demande + justificatifs + remboursements + montants.
  router.get("/disbursements/:id/details", authenticateToken, permRequest("view"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const request = await loadScoped(req, req.params.id);
      if (!request) return res.status(404).json({ error: "Demande introuvable." });
      const receipts = (await pool.query(
        `SELECT r.*, COALESCE(u.fullname,'') AS uploaded_by_name FROM disbursement_receipts r
           LEFT JOIN users u ON u.id=r.uploaded_by
          WHERE r.request_id=$1 AND r.company_id=$2 ORDER BY r.uploaded_at DESC`, [req.params.id, companyId]
      )).rows;
      const refunds = (await pool.query(`SELECT * FROM disbursement_refunds WHERE request_id=$1 AND company_id=$2 ORDER BY created_at DESC`, [req.params.id, companyId])).rows;
      const history = (await pool.query(
        `SELECT a.action, a.new_value, a.created_at, COALESCE(u.fullname,'') AS user_name FROM stock_audit_logs a
           LEFT JOIN users u ON u.id=a.user_id
          WHERE a.company_id=$1 AND a.entity='disbursement_request' AND a.entity_id=$2 ORDER BY a.created_at`, [companyId, req.params.id]
      )).rows;
      const lines = (await pool.query(
        `SELECT
           id,
           line_no,
           category,
           label,
           quantity,
           unit_price,
           camion_id,
           amount
         FROM disbursement_request_lines
         WHERE request_id=$1
           AND company_id=$2
         ORDER BY line_no`,
        [req.params.id, companyId]
      )).rows;

      res.json({
        request: { ...request, lines },
        lines,
        receipts,
        refunds,
        amounts: await amountsOf(companyId, req.params.id),
        history
      });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur détail." }); }
  });

  // Dépôt d'un justificatif :
  // FILE = photo / fichier,
  // PENDING = reçu promis pour plus tard,
  // DECLARATION = aucun reçu physique, déclaration interne.
  router.post("/disbursements/:id/receipts", authenticateToken, permRequest("update"), receiptUpload, async (req, res) => {
    try {
      const companyId = companyOf(req);

      const cur = (
        await pool.query(
          `SELECT * FROM disbursement_requests
            WHERE id=$1 AND company_id=$2`,
          [req.params.id, companyId]
        )
      ).rows[0];

      if (!cur) {
        return res.status(404).json({
          error: "Demande introuvable."
        });
      }

      const initialReceipt =
        ["1", "true", "yes", "on"].includes(
          String(req.body?.initial || "")
            .trim()
            .toLowerCase()
        );

      /*
       * JUSTIFICATIF INITIAL :
       * - autorisé AVANT le décaissement ;
       * - montant toujours égal à 0 ;
       * - simple pièce de dossier ;
       * - ne justifie aucune somme ;
       * - ne change aucun statut financier.
       *
       * JUSTIFICATIF NORMAL :
       * - reste interdit avant décaissement.
       */
      if (
        !initialReceipt &&
        !(Number(cur.amount_disbursed) > 0)
      ) {
        return res.status(409).json({
          error: "Aucun justificatif financier ne peut être ajouté avant le décaissement."
        });
      }

      if (
        initialReceipt &&
        Number(cur.amount_disbursed) > 0
      ) {
        return res.status(409).json({
          error: "Une pièce initiale ne peut être ajoutée qu'avant le décaissement."
        });
      }

      const receiptType =
        String(req.body?.receipt_type || "FILE")
          .trim()
          .toUpperCase();

      if (!["FILE", "PENDING", "DECLARATION"].includes(receiptType)) {
        return res.status(400).json({
          error: "Type de justificatif invalide."
        });
      }

      const amount = Number(req.body?.amount) || 0;
      const label = String(req.body?.label || "").trim() || null;

      if (initialReceipt && amount !== 0) {
        return res.status(400).json({
          error: "Une pièce initiale doit avoir un montant égal à 0."
        });
      }

      let url =
        req.file
          ? `/uploads/disbursements/${req.file.filename}`
          : (req.body?.file_url || null);

      let expectedDate = null;
      let declarationText = null;
      let supplierName = null;

      if (receiptType === "FILE") {
        if (!url) {
          return res.status(400).json({
            error: "Prenez une photo ou choisissez un fichier."
          });
        }

        if (
          !initialReceipt &&
          !(amount > 0)
        ) {
          return res.status(400).json({
            error: "Le montant justifié est obligatoire."
          });
        }
      }

      if (receiptType === "PENDING") {
        expectedDate =
          String(req.body?.expected_date || "").trim() || null;

        if (!expectedDate) {
          return res.status(400).json({
            error: "Indiquez la date prévue de remise du reçu."
          });
        }

        url = null;
      }

      if (receiptType === "DECLARATION") {
        declarationText =
          String(req.body?.declaration_text || "").trim();

        supplierName =
          String(req.body?.supplier_name || "").trim();

        if (
          !initialReceipt &&
          !(amount > 0)
        ) {
          return res.status(400).json({
            error: "Le montant de la déclaration est obligatoire."
          });
        }

        if (supplierName.length < 2) {
          return res.status(400).json({
            error: "Nom de la personne ou du fournisseur obligatoire."
          });
        }

        if (declarationText.length < 10) {
          return res.status(400).json({
            error: "La déclaration doit expliquer l'achat et l'absence de reçu."
          });
        }

        url = null;
      }

      const { rows } = await pool.query(
        `INSERT INTO disbursement_receipts
           (
             company_id,
             request_id,
             file_url,
             file_name,
             mime_type,
             amount,
             label,
             receipt_type,
             expected_date,
             declaration_text,
             supplier_name,
             uploaded_by
           )
         VALUES
           ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          companyId,
          cur.id,
          url,
          req.file
            ? req.file.originalname
            : (
                receiptType === "PENDING"
                  ? "Reçu à fournir plus tard"
                  : receiptType === "DECLARATION"
                    ? "Déclaration sans reçu"
                    : null
              ),
          req.file ? req.file.mimetype : null,
          amount,
          label,
          receiptType,
          expectedDate,
          declarationText,
          supplierName,
          req.user.id
        ]
      );

      /*
       * PENDING ne justifie encore aucun montant et
       * ne change pas l'état en JUSTIFICATIFS_DEPOSES.
       */
      if (
        !initialReceipt &&
        receiptType !== "PENDING"
      ) {
        await pool.query(
          `UPDATE disbursement_requests
              SET receipt_url=COALESCE(receipt_url,$3),
                  receipt_uploaded_at=NOW(),
                  status=CASE
                    WHEN status=$4 THEN $5
                    ELSE status
                  END,
                  updated_at=NOW()
            WHERE id=$1
              AND company_id=$2`,
          [
            cur.id,
            companyId,
            url,
            S.WAITING_RECEIPTS,
            S.RECEIPTS_UPLOADED
          ]
        );
      }

      await notify(
        await usersWithCapability(
          companyId,
          "comptabilite",
          ACCOUNTING_ROLES
        ),
        {
          company_id: companyId,
          type: "finance",
          title:
            receiptType === "PENDING"
              ? "Reçu annoncé pour plus tard"
              : "Justificatif à contrôler",
          message:
            receiptType === "PENDING"
              ? `${cur.request_number} : reçu attendu le ${expectedDate}.`
              : `${cur.request_number} : justificatif de ${amount} FCFA déposé.`,
          related_entity_type: "disbursement_request",
          related_entity_id: cur.id,
          action_url: `/decaissements?id=${cur.id}`,
          created_by: req.user.id
        }
      );

      res.status(201).json({
        receipt: rows[0],
        amounts: await amountsOf(companyId, cur.id),
        treasury_impacted: false
      });

    } catch (e) {
      console.error("receipts:", e);
      res.status(500).json({
        error: "Erreur justificatif."
      });
    }
  });

  // Contrôle d'un justificatif par le comptable.
  router.patch("/disbursement-receipts/:id/review", authenticateToken, permDisburse("validate"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const decision = String(req.body?.review_status || "").toUpperCase();
      if (!["ACCEPTE", "REFUSE", "COMPLEMENT"].includes(decision)) {
        return res.status(400).json({ error: "Décision invalide (ACCEPTE, REFUSE ou COMPLEMENT)." });
      }
      const { rows } = await pool.query(
        `UPDATE disbursement_receipts SET review_status=$3, review_comment=$4, reviewed_by=$5, reviewed_at=NOW()
          WHERE id=$1 AND company_id=$2 RETURNING *`,
        [req.params.id, companyId, decision, req.body?.comment || null, req.user.id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Justificatif introuvable." });
      await pool.query(`UPDATE disbursement_requests SET status=$3, updated_at=NOW() WHERE id=$1 AND company_id=$2 AND status=$4`,
        [rows[0].request_id, companyId, S.IN_REVIEW, S.RECEIPTS_UPLOADED]);
      res.json({ receipt: rows[0], amounts: await amountsOf(companyId, rows[0].request_id) });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur contrôle." }); }
  });

  /* REMBOURSEMENT du reliquat — crée une VRAIE entrée de trésorerie
     + écritures équilibrées (jamais de solde modifié directement). */
  router.post("/disbursements/:id/refund", authenticateToken, permDisburse("validate"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      const amount = Number(req.body?.amount);
      if (!(amount > 0)) return res.status(400).json({ error: "Montant de remboursement invalide." });
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM disbursement_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Demande introuvable." }); }
      const before = await amountsOf(companyId, cur.id, client);
      if (amount > before.remaining + 0.009) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Remboursement (${amount}) supérieur au reste à justifier (${before.remaining}).`, code: "OVER_REFUND" });
      }
      const num = await accounting.nextAccountingNumber(client, "accounting_transactions", "transaction_number", "REMB", companyId);
      const tx = await client.query(
        `INSERT INTO accounting_transactions (company_id, transaction_number, transaction_type, source_type, source_id,
           amount, currency, direction, category, description, status, created_by, validated_by, validated_at, created_at, updated_at)
         VALUES ($1,$2,'remboursement','disbursement_request',$3,$4,'FCFA','entrée','Remboursement reliquat',$5,'validé',$6,$6,NOW(),NOW(),NOW()) RETURNING id`,
        [companyId, num, cur.id, amount, `Remboursement ${cur.request_number}`, req.user.id]
      );
      await client.query(`UPDATE treasury_accounts SET current_balance=COALESCE(current_balance,0)+$1, updated_by=$2, updated_at=NOW() WHERE company_id=$3`,
        [amount, req.user.id, companyId]);
      await accounting.createAccountingEntry(client, { companyId, sourceType: "disbursement_refund", sourceId: tx.rows[0].id,
        accountLabel: "Caisse", debit: amount, credit: 0, description: `Remboursement ${cur.request_number}`, createdBy: req.user.id });
      await accounting.createAccountingEntry(client, { companyId, sourceType: "disbursement_refund", sourceId: tx.rows[0].id,
        accountLabel: "Charges / Décaissements", debit: 0, credit: amount, description: `Remboursement ${cur.request_number}`, createdBy: req.user.id });
      const { rows } = await client.query(
        `INSERT INTO disbursement_refunds (company_id, request_id, amount, method, reference, accounting_transaction_id, comment, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [companyId, cur.id, amount, req.body?.method || null, req.body?.reference || null, tx.rows[0].id, req.body?.comment || null, req.user.id]
      );
      await audit(client, companyId, req.user.id, "refund", cur.id, cur.request_number, { remaining: before.remaining }, { amount, transaction_id: tx.rows[0].id }, req.ip);
      await client.query("COMMIT");
      res.status(201).json({ refund: rows[0], amounts: await amountsOf(companyId, cur.id), treasury_impacted: true });
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error("refund:", e); res.status(500).json({ error: "Erreur remboursement." }); }
    finally { client.release(); }
  });

  // ---------- CLÔTURE (contrôle comptable) ----------
  router.post("/disbursements/:id/close", authenticateToken, permDisburse("validate"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      await client.query("BEGIN");
      const cur = (await client.query(`SELECT * FROM disbursement_requests WHERE id=$1 AND company_id=$2 FOR UPDATE`, [req.params.id, companyId])).rows[0];
      if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Demande introuvable." }); }
      if (![S.RECEIPTS_UPLOADED, S.IN_REVIEW, S.WAITING_RECEIPTS].includes(cur.status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Clôture impossible : demande ${cur.status}.`, code: "INVALID_STATE" });
      }
      // Clôture autorisée seulement si tout est justifié (ou remboursé).
      const amt = await amountsOf(companyId, cur.id, client);
      if (amt && !amt.fully_justified && req.body?.force !== true) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `Clôture impossible : reste à justifier ${amt.remaining} FCFA (décaissé ${amt.disbursed}, justifié ${amt.justified}, remboursé ${amt.refunded}).`,
          code: "NOT_FULLY_JUSTIFIED", amounts: amt,
        });
      }
      const me = (await client.query(`SELECT fullname FROM users WHERE id=$1`, [req.user.id])).rows[0] || {};
      const { rows } = await client.query(
        `UPDATE disbursement_requests SET status=$3, closed_by=$4, closed_by_name=$5, closed_at=NOW(),
           closure_comment=$6, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`,
        [cur.id, companyId, S.CLOSED, req.user.id, me.fullname || null, req.body?.comment || null]
      );
      await audit(client, companyId, req.user.id, "close", cur.id, cur.request_number, { status: cur.status }, { status: S.CLOSED }, req.ip);
      await client.query("COMMIT");
      await notify([cur.requester_id], {
        company_id: companyId, type: "finance", title: "Demande clôturée",
        message: `${cur.request_number} est clôturée.`, related_entity_type: "disbursement_request",
        related_entity_id: cur.id, action_url: `/decaissements?id=${cur.id}`, created_by: req.user.id,
      });
      res.json({ ...rows[0], treasury_impacted: false });
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error(e); res.status(500).json({ error: "Erreur clôture." }); }
    finally { client.release(); }
  });

  // ---------- TABLEAU DE BORD DIRECTION ----------
  router.get("/direction/dashboard", authenticateToken, permDirection("view"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const { rows } = await pool.query(
        `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS total,
                COALESCE(SUM(amount_disbursed),0) AS total_disbursed
           FROM disbursement_requests WHERE company_id=$1 GROUP BY status`, [companyId]
      );
      const byStatus = Object.fromEntries(rows.map((r) => [r.status, r]));
      const missing = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM disbursement_requests
          WHERE company_id=$1 AND status IN ($2,$3) AND receipt_url IS NULL`,
        [companyId, S.WAITING_RECEIPTS, S.IN_REVIEW]
      )).rows[0].n;
      const treasury = (await pool.query(`SELECT COALESCE(SUM(current_balance),0) AS b FROM treasury_accounts WHERE company_id=$1`, [companyId])).rows[0].b;
      res.json({ by_status: byStatus, missing_receipts: missing, treasury_balance: Number(treasury), statuses: S });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur tableau de bord Direction." }); }
  });

  return router;
};
module.exports.STATUS = S;
