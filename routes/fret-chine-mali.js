const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

module.exports = function createFretRouter({
  pool,
  authenticateToken,
  getEffectiveCompanyId,
  requirePermission,
}) {
  const router = express.Router();

  const uploadDir = path.join(__dirname, "..", "uploads", "fret");
  fs.mkdirSync(uploadDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),

    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      cb(
        null,
        `${Date.now()}-${crypto.randomBytes(10).toString("hex")}${ext}`
      );
    },
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: 15 * 1024 * 1024,
      files: 30,
    },
    fileFilter: (_req, file, cb) => {
      const allowed = [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/heic",
        "image/heif",
      ];

      if (!allowed.includes(file.mimetype)) {
        return cb(
          new Error(
            "Format image non autorisé. JPEG, PNG, WEBP, HEIC uniquement."
          )
        );
      }

      cb(null, true);
    },
  });

  router.use(
    "/uploads/fret",
    authenticateToken,
    requirePermission("fret_chine_mali", "view"),
    express.static(uploadDir)
  );

  /* Toutes les routes internes du fret sont fermées par défaut. La route de
     suivi public `/public/fret/...` reste séparée et limitée par son jeton. */
  router.use(
    "/fret",
    authenticateToken,
    requirePermission("fret_chine_mali", "view")
  );

  function companyOf(req) {
    const value =
      typeof getEffectiveCompanyId === "function"
        ? getEffectiveCompanyId(req)
        : req.user?.company_id;

    return (
      Number(value) ||
      Number(req.user?.company_id || 0) ||
      null
    );
  }

  function n(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  async function getRate(db, companyId) {
    const { rows } = await db.query(
      `
      SELECT *
      FROM freight_rates
      WHERE company_id=$1
        AND active=true
      ORDER BY effective_from DESC,id DESC
      LIMIT 1
      `,
      [companyId]
    );

    return rows[0] || null;
  }

  async function nextTracking(db) {
    const { rows } = await db.query(
      `SELECT nextval('freight_tracking_seq') AS n`
    );

    const year = new Date().getFullYear();
    const value = String(rows[0].n).padStart(6, "0");

    return {
      receptionNo: `RC-CN-${year}-${value}`,
      trackingCode: `TR-CN-${year}-${value}`,
    };
  }

  router.get(
    "/fret/customers",
    authenticateToken,
    async (req, res) => {
      try {
        const companyId = companyOf(req);

        const { rows } = await pool.query(
          `
          SELECT *
          FROM freight_customers
          WHERE company_id=$1
            AND active=true
          ORDER BY full_name
          `,
          [companyId]
        );

        res.json(rows);
      } catch (error) {
        console.error("FRET CUSTOMERS", error);

        res.status(500).json({
          error: "Erreur lecture clients fret.",
        });
      }
    }
  );

  router.post(
    "/fret/customers",
    authenticateToken,
    requirePermission("fret_chine_mali", "create"),
    async (req, res) => {
      try {
        const companyId = companyOf(req);
        const fullName = String(req.body?.full_name || "").trim();

        if (!fullName) {
          return res.status(400).json({
            error: "Nom du client obligatoire.",
          });
        }

        const codeResult = await pool.query(
          `
          SELECT COUNT(*)::int + 1 AS n
          FROM freight_customers
          WHERE company_id=$1
          `,
          [companyId]
        );

        const customerCode =
          `TR-FRET-${String(codeResult.rows[0].n).padStart(6, "0")}`;

        const { rows } = await pool.query(
          `
          INSERT INTO freight_customers
          (
            company_id,
            customer_code,
            full_name,
            phone,
            whatsapp,
            email,
            address,
            notes,
            created_by
          )
          VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING *
          `,
          [
            companyId,
            customerCode,
            fullName,
            String(req.body?.phone || ""),
            String(req.body?.whatsapp || ""),
            String(req.body?.email || ""),
            String(req.body?.address || ""),
            String(req.body?.notes || ""),
            Number(req.user.id),
          ]
        );

        res.status(201).json(rows[0]);
      } catch (error) {
        console.error("FRET CUSTOMER CREATE", error);

        res.status(500).json({
          error: "Erreur création client.",
        });
      }
    }
  );

  router.get(
    "/fret/v2/dashboard",
    authenticateToken,
    async (req, res) => {
      try {
        const companyId = companyOf(req);
        const rate = await getRate(pool, companyId);

        const stats = await pool.query(
          `
          SELECT
            COUNT(*)::int AS total,

            COUNT(*) FILTER (
              WHERE status='WAITING_DEPART'
            )::int AS attente,

            COUNT(*) FILTER (
              WHERE status='LOADED'
            )::int AS charges,

            COUNT(*) FILTER (
              WHERE status='IN_TRANSIT'
            )::int AS transit,

            COUNT(*) FILTER (
              WHERE status='ARRIVED_MALI'
            )::int AS arrives,

            COUNT(*) FILTER (
              WHERE status='AVAILABLE'
            )::int AS disponibles,

            COUNT(*) FILTER (
              WHERE status='DELIVERED'
            )::int AS livres,

            COALESCE(SUM(total_cbm),0) AS total_cbm,
            COALESCE(SUM(total_amount),0) AS montant_total,
            COALESCE(SUM(amount_paid),0) AS total_paye,
            COALESCE(SUM(balance),0) AS reste_total

          FROM freight_receptions
          WHERE company_id=$1
          `,
          [companyId]
        );

        const receptions = await pool.query(
          `
          SELECT
            r.*,
            c.customer_code,
            c.full_name AS customer_name,
            c.phone AS customer_phone,

            (
              SELECT COUNT(*)::int
              FROM freight_reception_items i
              WHERE i.reception_id=r.id
            ) AS item_lines,

            (
              SELECT COALESCE(SUM(i.package_count),0)::int
              FROM freight_reception_items i
              WHERE i.reception_id=r.id
            ) AS packages

          FROM freight_receptions r

          JOIN freight_customers c
            ON c.id=r.customer_id

          WHERE r.company_id=$1

          ORDER BY r.id DESC
          LIMIT 300
          `,
          [companyId]
        );

        const settings = await pool.query(
          `
          SELECT *
          FROM freight_settings
          WHERE company_id=$1
          `,
          [companyId]
        );

        res.json({
          rate,
          stats: stats.rows[0],
          receptions: receptions.rows,
          settings: settings.rows[0] || null,
        });
      } catch (error) {
        console.error("FRET V2 DASHBOARD", error);

        res.status(500).json({
          error: "Erreur chargement fret.",
        });
      }
    }
  );

  router.post(
    "/fret/v2/receptions",
    authenticateToken,
    requirePermission("fret_chine_mali", "create"),
    async (req, res) => {
      const db = await pool.connect();

      try {
        const companyId = companyOf(req);
        const customerId = Number(req.body?.customer_id);

        const rawItems = Array.isArray(req.body?.items)
          ? req.body.items
          : [];

        if (!customerId) {
          return res.status(400).json({
            error: "Client obligatoire.",
          });
        }

        if (!rawItems.length) {
          return res.status(400).json({
            error: "Ajoutez au moins une ligne de marchandise.",
          });
        }

        const customer = await db.query(
          `
          SELECT id
          FROM freight_customers
          WHERE id=$1
            AND company_id=$2
            AND active=true
          `,
          [customerId, companyId]
        );

        if (!customer.rows.length) {
          return res.status(400).json({
            error: "Client invalide.",
          });
        }

        const rate = await getRate(db, companyId);

        if (!rate) {
          return res.status(409).json({
            error: "Aucun tarif fret actif.",
          });
        }

        const items = [];
        let totalCbm = 0;

        for (let index = 0; index < rawItems.length; index++) {
          const raw = rawItems[index];

          const description = String(
            raw?.description || ""
          ).trim();

          const packageCount = Math.max(
            1,
            Math.floor(n(raw?.package_count, 1))
          );

          const length = n(raw?.length_cm);
          const width = n(raw?.width_cm);
          const height = n(raw?.height_cm);

          if (
            !description ||
            length <= 0 ||
            width <= 0 ||
            height <= 0
          ) {
            return res.status(400).json({
              error:
                `Ligne ${index + 1}: description et dimensions obligatoires.`,
            });
          }

          const cbm =
            (
              length *
              width *
              height *
              packageCount
            ) / 1000000;

          totalCbm += cbm;

          items.push({
            lineNo: index + 1,
            description,
            packageCount,
            length,
            width,
            height,
            weightKg: n(raw?.weight_kg) || null,
            cbm,
            supplierReference: String(
              raw?.supplier_reference || ""
            ),
            notes: String(raw?.notes || ""),
          });
        }

        const ratePerCbm = Number(rate.price_per_unit);
        const freightAmount = totalCbm * ratePerCbm;

        const extraFees = Math.max(
          0,
          n(req.body?.extra_fees)
        );

        const amountPaid = Math.max(
          0,
          n(req.body?.amount_paid)
        );

        const totalAmount =
          freightAmount + extraFees;

        if (amountPaid > totalAmount) {
          return res.status(400).json({
            error:
              "Le montant payé ne peut pas dépasser le total.",
          });
        }

        const balance =
          totalAmount - amountPaid;

        await db.query("BEGIN");

        const numbers =
          await nextTracking(db);

        const publicToken =
          crypto.randomBytes(32).toString("hex");

        const receptionResult = await db.query(
          `
          INSERT INTO freight_receptions
          (
            company_id,
            reception_no,
            tracking_code,
            public_token,
            customer_id,

            status,

            rate_per_cbm,
            total_cbm,
            freight_amount,
            extra_fees,
            total_amount,
            amount_paid,
            balance,

            supplier_reference,
            notes,

            received_at,
            created_by,
            updated_by
          )
          VALUES
          (
            $1,$2,$3,$4,$5,
            'WAITING_DEPART',
            $6,$7,$8,$9,$10,$11,$12,
            $13,$14,
            CURRENT_TIMESTAMP,
            $15,$15
          )
          RETURNING *
          `,
          [
            companyId,
            numbers.receptionNo,
            numbers.trackingCode,
            publicToken,
            customerId,

            ratePerCbm,
            totalCbm,
            freightAmount,
            extraFees,
            totalAmount,
            amountPaid,
            balance,

            String(req.body?.supplier_reference || ""),
            String(req.body?.notes || ""),

            Number(req.user.id),
          ]
        );

        const reception =
          receptionResult.rows[0];

        const createdItems = [];

        for (const item of items) {
          const itemCode =
            `${reception.tracking_code}-${String(
              item.lineNo
            ).padStart(2, "0")}`;

          const itemResult = await db.query(
            `
            INSERT INTO freight_reception_items
            (
              company_id,
              reception_id,
              line_no,
              item_code,

              description,
              quantity,
              package_count,

              length_cm,
              width_cm,
              height_cm,

              weight_kg,
              cbm,

              supplier_reference,
              notes
            )
            VALUES
            (
              $1,$2,$3,$4,
              $5,$6,$7,
              $8,$9,$10,
              $11,$12,
              $13,$14
            )
            RETURNING *
            `,
            [
              companyId,
              reception.id,
              item.lineNo,
              itemCode,

              item.description,
              item.packageCount,
              item.packageCount,

              item.length,
              item.width,
              item.height,

              item.weightKg,
              item.cbm,

              item.supplierReference,
              item.notes,
            ]
          );

          createdItems.push(
            itemResult.rows[0]
          );
        }

        await db.query(
          `
          INSERT INTO freight_status_events
          (
            company_id,
            reception_id,
            event_code,
            label,
            location_label,
            comment,
            created_by
          )
          VALUES
          (
            $1,$2,
            'RECEIVED_MEASURED',
            'Reçu et mesuré en Chine',
            'Foshan, Chine',
            'Réception et mesure enregistrées.',
            $3
          ),
          (
            $1,$2,
            'WAITING_DEPART',
            'En attente de départ',
            'Foshan, Chine',
            'Marchandise en attente de chargement.',
            $3
          )
          `,
          [
            companyId,
            reception.id,
            Number(req.user.id),
          ]
        );

        await db.query("COMMIT");

        res.status(201).json({
          reception,
          items: createdItems,
          public_url:
            `/suivi-fret/${encodeURIComponent(
              reception.tracking_code
            )}/${encodeURIComponent(publicToken)}`,
        });
      } catch (error) {
        await db.query("ROLLBACK").catch(() => {});

        console.error("FRET V2 CREATE", error);

        res.status(500).json({
          error: "Erreur création réception.",
        });
      } finally {
        db.release();
      }
    }
  );

  router.post(
    "/fret/v2/receptions/:receptionId/items/:itemId/photos",
    authenticateToken,
    requirePermission("fret_chine_mali", "update"),
    upload.array("photos", 30),
    async (req, res) => {
      try {
        const companyId = companyOf(req);
        const receptionId = Number(req.params.receptionId);
        const itemId = Number(req.params.itemId);

        const check = await pool.query(
          `
          SELECT i.id
          FROM freight_reception_items i

          JOIN freight_receptions r
            ON r.id=i.reception_id

          WHERE i.id=$1
            AND i.reception_id=$2
            AND r.company_id=$3
          `,
          [
            itemId,
            receptionId,
            companyId,
          ]
        );

        if (!check.rows.length) {
          return res.status(404).json({
            error: "Ligne de marchandise introuvable.",
          });
        }

        const result = [];

        for (const file of req.files || []) {
          const fileUrl =
            `/api/uploads/fret/${file.filename}`;

          const { rows } = await pool.query(
            `
            INSERT INTO freight_item_photos
            (
              company_id,
              reception_id,
              item_id,
              file_url,
              file_name,
              file_size,
              mime_type,
              created_by
            )
            VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8)
            RETURNING *
            `,
            [
              companyId,
              receptionId,
              itemId,
              fileUrl,
              file.originalname,
              file.size,
              file.mimetype,
              Number(req.user.id),
            ]
          );

          result.push(rows[0]);
        }

        res.status(201).json(result);
      } catch (error) {
        console.error("FRET PHOTOS", error);

        res.status(500).json({
          error: "Erreur ajout photos.",
        });
      }
    }
  );

  router.get(
    "/fret/v2/receptions/:id",
    authenticateToken,
    async (req, res) => {
      try {
        const companyId = companyOf(req);
        const id = Number(req.params.id);

        const reception = await pool.query(
          `
          SELECT
            r.*,
            c.customer_code,
            c.full_name AS customer_name,
            c.phone AS customer_phone,
            c.whatsapp AS customer_whatsapp

          FROM freight_receptions r

          JOIN freight_customers c
            ON c.id=r.customer_id

          WHERE r.id=$1
            AND r.company_id=$2
          `,
          [
            id,
            companyId,
          ]
        );

        if (!reception.rows.length) {
          return res.status(404).json({
            error: "Réception introuvable.",
          });
        }

        const items = await pool.query(
          `
          SELECT *
          FROM freight_reception_items
          WHERE reception_id=$1
          ORDER BY line_no
          `,
          [id]
        );

        const photos = await pool.query(
          `
          SELECT *
          FROM freight_item_photos
          WHERE reception_id=$1
          ORDER BY id
          `,
          [id]
        );

        const events = await pool.query(
          `
          SELECT *
          FROM freight_status_events
          WHERE reception_id=$1
          ORDER BY created_at,id
          `,
          [id]
        );

        res.json({
          reception:
            reception.rows[0],

          items:
            items.rows.map((item) => ({
              ...item,

              photos:
                photos.rows.filter(
                  (photo) =>
                    Number(photo.item_id) ===
                    Number(item.id)
                ),
            })),

          events:
            events.rows,
        });
      } catch (error) {
        console.error("FRET DETAIL", error);

        res.status(500).json({
          error: "Erreur lecture réception.",
        });
      }
    }
  );

  router.post(
    "/fret/v2/receptions/:id/next",
    authenticateToken,
    requirePermission("fret_chine_mali", "update"),
    async (req, res) => {
      const db = await pool.connect();

      try {
        const companyId = companyOf(req);
        const id = Number(req.params.id);

        await db.query("BEGIN");

        const result = await db.query(
          `
          SELECT *
          FROM freight_receptions
          WHERE id=$1
            AND company_id=$2
          FOR UPDATE
          `,
          [
            id,
            companyId,
          ]
        );

        if (!result.rows.length) {
          await db.query("ROLLBACK");

          return res.status(404).json({
            error: "Réception introuvable.",
          });
        }

        const current =
          result.rows[0];

        const rules = {
          WAITING_DEPART: {
            action: "LOAD",
            next: "LOADED",
            event: "LOADED",
            label: "Chargé",
            location: "Entrepôt Chine",
          },

          LOADED: {
            action: "DEPART",
            next: "IN_TRANSIT",
            event: "DEPARTED_CHINA",
            label: "Départ Chine — En transit",
            location: "Chine",
          },

          IN_TRANSIT: {
            action: "ARRIVE",
            next: "ARRIVED_MALI",
            event: "ARRIVED_MALI",
            label: "Arrivé au Mali",
            location: "Bamako, Mali",
          },

          ARRIVED_MALI: {
            action: "MAKE_AVAILABLE",
            next: "AVAILABLE",
            event: "AVAILABLE",
            label: "Disponible au retrait",
            location: "Bamako, Mali",
          },

          AVAILABLE: {
            action: "DELIVER",
            next: "DELIVERED",
            event: "DELIVERED",
            label: "Livré au client",
            location: "Bamako, Mali",
          },
        };

        const rule =
          rules[current.status];

        if (!rule) {
          await db.query("ROLLBACK");

          return res.status(409).json({
            error:
              "Aucune nouvelle étape autorisée.",
          });
        }

        const action = String(
          req.body?.action || ""
        ).toUpperCase();

        if (action !== rule.action) {
          await db.query("ROLLBACK");

          return res.status(409).json({
            error:
              `Action refusée. Action attendue : ${rule.action}.`,
          });
        }

        let sql = `
          UPDATE freight_receptions
          SET
            status=$3,
            updated_by=$4,
            updated_at=CURRENT_TIMESTAMP
        `;

        const params = [
          id,
          companyId,
          rule.next,
          Number(req.user.id),
        ];

        if (action === "DEPART") {
          const rate =
            await getRate(db, companyId);

          const minDays =
            Number(rate?.min_transit_days || 45);

          const maxDays =
            Number(rate?.max_transit_days || 60);

          sql += `,
            departed_at=CURRENT_TIMESTAMP,
            eta_min=(
              CURRENT_DATE +
              INTERVAL '${minDays} days'
            )::date,
            eta_max=(
              CURRENT_DATE +
              INTERVAL '${maxDays} days'
            )::date
          `;
        }

        if (action === "ARRIVE") {
          sql += `,
            arrived_mali_at=CURRENT_TIMESTAMP
          `;
        }

        if (action === "MAKE_AVAILABLE") {
          sql += `,
            available_at=CURRENT_TIMESTAMP
          `;
        }

        if (action === "DELIVER") {
          const deliveredTo =
            String(
              req.body?.delivered_to || ""
            ).trim();

          if (!deliveredTo) {
            await db.query("ROLLBACK");

            return res.status(400).json({
              error:
                "Nom du bénéficiaire obligatoire.",
            });
          }

          params.push(
            deliveredTo,
            String(
              req.body?.delivered_phone || ""
            )
          );

          sql += `,
            delivered_at=CURRENT_TIMESTAMP,
            delivered_to=$5,
            delivered_phone=$6
          `;
        }

        sql += `
          WHERE id=$1
            AND company_id=$2
          RETURNING *
        `;

        const update =
          await db.query(sql, params);

        await db.query(
          `
          INSERT INTO freight_status_events
          (
            company_id,
            reception_id,
            event_code,
            label,
            location_label,
            comment,
            created_by
          )
          VALUES
          ($1,$2,$3,$4,$5,$6,$7)
          `,
          [
            companyId,
            id,
            rule.event,
            rule.label,
            String(
              req.body?.location_label ||
              rule.location
            ),
            String(
              req.body?.comment || ""
            ),
            Number(req.user.id),
          ]
        );

        await db.query("COMMIT");

        res.json(update.rows[0]);
      } catch (error) {
        await db.query("ROLLBACK").catch(() => {});

        console.error("FRET WORKFLOW", error);

        res.status(500).json({
          error:
            "Erreur changement d'étape.",
        });
      } finally {
        db.release();
      }
    }
  );

  router.get(
    "/public/fret/track/:tracking/:token",
    async (req, res) => {
      try {
        const tracking =
          String(req.params.tracking || "");

        const token =
          String(req.params.token || "");

        const reception = await pool.query(
          `
          SELECT
            r.id,
            r.reception_no,
            r.tracking_code,
            r.status,

            r.rate_per_cbm,
            r.total_cbm,

            r.freight_amount,
            r.extra_fees,
            r.total_amount,
            r.amount_paid,
            r.balance,

            r.received_at,
            r.departed_at,

            r.eta_min,
            r.eta_max,

            r.arrived_mali_at,
            r.available_at,
            r.delivered_at,

            c.full_name AS customer_name

          FROM freight_receptions r

          JOIN freight_customers c
            ON c.id=r.customer_id

          WHERE r.tracking_code=$1
            AND r.public_token=$2

          LIMIT 1
          `,
          [
            tracking,
            token,
          ]
        );

        if (!reception.rows.length) {
          return res.status(404).json({
            error: "Lien de suivi invalide.",
          });
        }

        const r =
          reception.rows[0];

        const items = await pool.query(
          `
          SELECT
            id,
            line_no,
            item_code,
            description,
            quantity,
            package_count,
            length_cm,
            width_cm,
            height_cm,
            weight_kg,
            cbm

          FROM freight_reception_items
          WHERE reception_id=$1
          ORDER BY line_no
          `,
          [r.id]
        );

        const photos = await pool.query(
          `
          SELECT
            item_id,
            file_url

          FROM freight_item_photos
          WHERE reception_id=$1
          ORDER BY id
          `,
          [r.id]
        );

        const events = await pool.query(
          `
          SELECT
            event_code,
            label,
            location_label,
            comment,
            created_at

          FROM freight_status_events
          WHERE reception_id=$1
          ORDER BY created_at,id
          `,
          [r.id]
        );

        res.json({
          reception: r,

          items:
            items.rows.map((item) => ({
              ...item,

              photos:
                photos.rows
                  .filter(
                    (photo) =>
                      Number(photo.item_id) ===
                      Number(item.id)
                  )
                  .map(
                    (photo) =>
                      photo.file_url
                  ),
            })),

          events:
            events.rows,
        });
      } catch (error) {
        console.error("PUBLIC FRET", error);

        res.status(500).json({
          error: "Erreur suivi fret.",
        });
      }
    }
  );

  return router;
};
