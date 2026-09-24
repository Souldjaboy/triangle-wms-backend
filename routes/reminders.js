const express = require("express");
const nodemailer = require("nodemailer");

module.exports = function createRemindersRouter(deps = {}) {
  const {
    pool,
    authenticateToken
  } = deps;

  if (!pool) {
    throw new Error("reminders.js : pool PostgreSQL manquant");
  }

  if (!authenticateToken) {
    throw new Error("reminders.js : authenticateToken manquant");
  }

  const router = express.Router();


  function cleanText(value) {
    return String(value ?? "").trim();
  }


  function isSuperAdmin(user) {
    return Boolean(
      user?.is_super_admin === true ||
      user?.isSuperAdmin === true ||
      String(user?.role || "").toLowerCase() === "super_admin"
    );
  }


  function companyIdFromRequest(req) {
    const active = Number(
      req.headers["x-active-company-id"] || 0
    );

    if (isSuperAdmin(req.user) && active > 0) {
      return active;
    }

    return Number(req.user?.company_id || 0);
  }


  function ensureCompany(req, res) {
    const companyId = companyIdFromRequest(req);

    if (!companyId) {
      res.status(400).json({
        error: "Entreprise active obligatoire."
      });

      return null;
    }

    return companyId;
  }


  function validRecurrence(value) {
    const r = cleanText(value).toLowerCase();

    return [
      "none",
      "weekly",
      "monthly",
      "quarterly",
      "yearly"
    ].includes(r)
      ? r
      : "none";
  }


  function parseDays(value) {
    const arr = Array.isArray(value)
      ? value
      : [5,3,0];

    return [...new Set(
      arr
        .map(Number)
        .filter(n =>
          Number.isInteger(n) &&
          n >= 0 &&
          n <= 365
        )
    )]
      .sort((a,b) => b-a);
  }


  function formatAmount(value) {
    return Number(value || 0)
      .toLocaleString(
        "fr-FR",
        { maximumFractionDigits: 0 }
      );
  }


  function dateOnly(value) {
    if (!value) return "";

    const d = new Date(value);

    if (Number.isNaN(d.getTime())) {
      return "";
    }

    return d.toISOString().slice(0,10);
  }


  function daysBetween(today, target) {
    const a = new Date(`${today}T00:00:00Z`);
    const b = new Date(`${target}T00:00:00Z`);

    return Math.round(
      (b.getTime() - a.getTime()) /
      86400000
    );
  }


  function mondayKey(date = new Date()) {
    const d = new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate()
      )
    );

    const day = d.getUTCDay() || 7;

    d.setUTCDate(
      d.getUTCDate() - day + 1
    );

    return d.toISOString().slice(0,10);
  }


  async function getRecipientUser(
    client,
    companyId,
    preferredId
  ) {
    if (preferredId) {
      const r = await client.query(
        `
        SELECT id,email
        FROM users
        WHERE id=$1
          AND (
            company_id=$2
            OR company_id IS NULL
          )
        LIMIT 1
        `,
        [preferredId,companyId]
      );

      if (r.rows[0]) {
        return r.rows[0];
      }
    }

    const r = await client.query(
      `
      SELECT id,email
      FROM users
      WHERE (
        company_id=$1
        OR (
          company_id IS NULL
          AND (
            is_super_admin=true
            OR LOWER(COALESCE(role,''))='super_admin'
          )
        )
      )
      AND is_active IS DISTINCT FROM FALSE
      ORDER BY
        CASE
          WHEN is_super_admin=true THEN 0
          WHEN LOWER(COALESCE(role,''))='super_admin' THEN 1
          WHEN LOWER(COALESCE(role,'')) IN (
            'admin',
            'direction',
            'directeur',
            'comptable'
          ) THEN 2
          ELSE 3
        END,
        id
      LIMIT 1
      `,
      [companyId]
    );

    return r.rows[0] || null;
  }


  async function dispatchExists(
    client,
    companyId,
    eventKey,
    channel
  ) {
    const r = await client.query(
      `
      SELECT 1
      FROM reminder_dispatch_log
      WHERE company_id=$1
        AND event_key=$2
        AND channel=$3
      LIMIT 1
      `,
      [
        companyId,
        eventKey,
        channel
      ]
    );

    return Boolean(r.rowCount);
  }


  async function logDispatch(
    client,
    {
      companyId,
      reminderId=null,
      eventKey,
      channel,
      recipient=""
    }
  ) {
    await client.query(
      `
      INSERT INTO reminder_dispatch_log (
        company_id,
        reminder_id,
        event_key,
        channel,
        recipient
      )
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (
        company_id,
        event_key,
        channel
      )
      DO NOTHING
      `,
      [
        companyId,
        reminderId,
        eventKey,
        channel,
        recipient || ""
      ]
    );
  }


  async function appNotification(
    client,
    {
      companyId,
      userId,
      title,
      message,
      priority="normal",
      eventKey,
      entityType="reminder",
      entityId=null,
      actionUrl="/rappels"
    }
  ) {
    if (
      await dispatchExists(
        client,
        companyId,
        eventKey,
        "app"
      )
    ) {
      return false;
    }

    await client.query(
      `
      INSERT INTO notifications (
        user_id,
        title,
        message,
        type,
        is_read,
        company_id,
        status,
        priority,
        related_entity_type,
        related_entity_id,
        action_url,
        created_by,
        assigned_to,
        tenant_id,
        event_key
      )
      VALUES (
        $1,$2,$3,
        'rappel',
        false,
        $4,
        'unread',
        $5,
        $6,
        $7,
        $8,
        $1,
        $1,
        'triangle',
        $9
      )
      `,
      [
        userId || null,
        title,
        message,
        companyId,
        priority,
        entityType,
        entityId,
        actionUrl,
        eventKey
      ]
    );

    await logDispatch(
      client,
      {
        companyId,
        reminderId:
          entityType === "reminder"
            ? entityId
            : null,
        eventKey,
        channel:"app",
        recipient:String(userId || "")
      }
    );

    return true;
  }


  function smtpReady() {
    return Boolean(
      process.env.SMTP_HOST &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS
    );
  }


  async function sendEmail({
    to,
    subject,
    text
  }) {
    if (!smtpReady() || !to) {
      return false;
    }

    const transporter =
      nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(
          process.env.SMTP_PORT || 587
        ),
        secure:
          Number(
            process.env.SMTP_PORT || 587
          ) === 465,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });

    await transporter.sendMail({
      from:
        process.env.SMTP_FROM ||
        process.env.SMTP_USER,
      to,
      subject,
      text
    });

    return true;
  }


  async function emailNotification(
    client,
    {
      companyId,
      reminderId=null,
      eventKey,
      email,
      subject,
      text
    }
  ) {
    if (!email) return false;

    if (
      await dispatchExists(
        client,
        companyId,
        eventKey,
        "email"
      )
    ) {
      return false;
    }

    const sent = await sendEmail({
      to:email,
      subject,
      text
    });

    if (sent) {
      await logDispatch(
        client,
        {
          companyId,
          reminderId,
          eventKey,
          channel:"email",
          recipient:email
        }
      );
    }

    return sent;
  }


  async function processManualReminders(
    client,
    companyId,
    settings
  ) {
    const today =
      new Date().toISOString().slice(0,10);

    const r = await client.query(
      `
      SELECT *
      FROM reminders
      WHERE company_id=$1
        AND status='active'
      ORDER BY due_date,id
      `,
      [companyId]
    );

    let appSent = 0;
    let emailSent = 0;

    for (const reminder of r.rows) {
      const due = dateOnly(
        reminder.due_date
      );

      if (!due) continue;

      const diff =
        daysBetween(today,due);

      const remindDays =
        Array.isArray(reminder.remind_days)
          ? reminder.remind_days.map(Number)
          : [5,3,0];

      let trigger = null;

      if (diff < 0) {
        trigger = "OVERDUE";
      } else if (
        remindDays.includes(diff)
      ) {
        trigger = String(diff);
      }

      if (trigger === null) {
        continue;
      }

      const recipient =
        await getRecipientUser(
          client,
          companyId,
          reminder.notify_user_id ||
          reminder.created_by
        );

      const eventKey =
        `reminder:${reminder.id}:${due}:${trigger}`;

      const title =
        diff < 0
          ? `⚠️ Rappel en retard : ${reminder.title}`
          : diff === 0
          ? `🔔 Échéance aujourd'hui : ${reminder.title}`
          : `⏰ Rappel J-${diff} : ${reminder.title}`;

      let message =
        `${reminder.title} — échéance ${due}.`;

      if (
        Number(reminder.amount || 0) > 0
      ) {
        message +=
          ` Montant : ${formatAmount(reminder.amount)} ${reminder.currency || "FCFA"}.`;
      }

      if (reminder.description) {
        message +=
          ` ${reminder.description}`;
      }

      if (recipient) {
        if (
          await appNotification(
            client,
            {
              companyId,
              userId:recipient.id,
              title,
              message,
              priority:
                diff <= 0
                  ? "high"
                  : "normal",
              eventKey,
              entityType:"reminder",
              entityId:reminder.id,
              actionUrl:"/rappels"
            }
          )
        ) {
          appSent++;
        }
      }

      const email =
        cleanText(reminder.email_to) ||
        cleanText(settings.default_email) ||
        cleanText(recipient?.email);

      if (
        reminder.email_enabled !== false &&
        settings.email_enabled !== false &&
        email
      ) {
        try {
          if (
            await emailNotification(
              client,
              {
                companyId,
                reminderId:reminder.id,
                eventKey,
                email,
                subject:`Triangle WMS — ${title}`,
                text:message
              }
            )
          ) {
            emailSent++;
          }
        } catch (error) {
          console.error(
            "[REMINDERS] email:",
            error.message
          );
        }
      }
    }

    return {
      appSent,
      emailSent
    };
  }


  async function processSupplierDebts(
    client,
    companyId,
    settings
  ) {
    if (
      settings.supplier_alerts_enabled === false
    ) {
      return 0;
    }

    const days =
      Math.max(
        1,
        Number(
          settings.supplier_unpaid_after_days || 7
        )
      );

    const r = await client.query(
      `
      SELECT
        id,
        purchase_number,
        supplier_name,
        total_amount,
        amount_paid,
        amount_due,
        created_at
      FROM purchases
      WHERE company_id=$1
        AND COALESCE(amount_due,0) > 0
        AND created_at
          <= CURRENT_TIMESTAMP
             - ($2::text || ' days')::interval
        AND LOWER(COALESCE(status,''))
          NOT IN (
            'paid',
            'payé',
            'paye',
            'annulé',
            'annule',
            'cancelled'
          )
      ORDER BY amount_due DESC,id
      `,
      [companyId,days]
    );

    if (!r.rowCount) {
      return 0;
    }

    const recipient =
      await getRecipientUser(
        client,
        companyId,
        null
      );

    if (!recipient) return 0;

    const key =
      `supplier-debts:${mondayKey()}`;

    const total =
      r.rows.reduce(
        (sum,row) =>
          sum + Number(row.amount_due || 0),
        0
      );

    const title =
      `💳 Fournisseurs non payés : ${r.rowCount}`;

    const message =
      `${r.rowCount} achat(s) fournisseur restent à payer. ` +
      `Dette totale : ${formatAmount(total)} FCFA. ` +
      `Vérifiez le module Achats / Fournisseurs.`;

    const sent =
      await appNotification(
        client,
        {
          companyId,
          userId:recipient.id,
          title,
          message,
          priority:"high",
          eventKey:key,
          entityType:"supplier_debt",
          entityId:null,
          actionUrl:"/partenaires"
        }
      );

    const email =
      cleanText(settings.default_email) ||
      cleanText(recipient.email);

    if (
      settings.email_enabled !== false &&
      email
    ) {
      try {
        await emailNotification(
          client,
          {
            companyId,
            eventKey:key,
            email,
            subject:
              "Triangle WMS — Fournisseurs non payés",
            text:message
          }
        );
      } catch (error) {
        console.error(
          "[REMINDERS supplier email]",
          error.message
        );
      }
    }

    return sent ? 1 : 0;
  }


  async function processLargeWithdrawals(
    client,
    companyId,
    settings
  ) {
    if (
      settings.withdrawal_alerts_enabled === false
    ) {
      return 0;
    }

    const threshold =
      Number(
        settings.large_withdrawal_threshold ||
        5000000
      );

    const r = await client.query(
      `
      SELECT
        t.id,
        t.transaction_number,
        t.amount,
        t.description,
        t.operation_date,
        b.bank_name
      FROM accounting_transactions t
      LEFT JOIN accounting_banks b
        ON b.id=t.bank_id
      WHERE t.company_id=$1
        AND LOWER(COALESCE(t.direction,''))
          IN ('sortie','out','debit')
        AND COALESCE(t.amount,0) >= $2
        AND COALESCE(
          t.operation_date,
          t.created_at::date
        ) >= CURRENT_DATE - 7
      ORDER BY t.id
      `,
      [companyId,threshold]
    );

    const recipient =
      await getRecipientUser(
        client,
        companyId,
        null
      );

    if (!recipient) return 0;

    let sentCount = 0;

    for (const tx of r.rows) {
      const key =
        `large-withdrawal:${tx.id}`;

      const title =
        `🏦 Gros retrait bancaire : ${formatAmount(tx.amount)} FCFA`;

      const message =
        `${tx.bank_name || "Banque"} — ` +
        `${formatAmount(tx.amount)} FCFA. ` +
        `Vérifiez les dépenses prioritaires et les fournisseurs non payés.` +
        (
          tx.description
            ? ` ${tx.description}`
            : ""
        );

      if (
        await appNotification(
          client,
          {
            companyId,
            userId:recipient.id,
            title,
            message,
            priority:"high",
            eventKey:key,
            entityType:"bank_transaction",
            entityId:tx.id,
            actionUrl:"/comptabilite"
          }
        )
      ) {
        sentCount++;
      }

      const email =
        cleanText(settings.default_email) ||
        cleanText(recipient.email);

      if (
        settings.email_enabled !== false &&
        email
      ) {
        try {
          await emailNotification(
            client,
            {
              companyId,
              eventKey:key,
              email,
              subject:`Triangle WMS — ${title}`,
              text:message
            }
          );
        } catch (error) {
          console.error(
            "[REMINDERS bank email]",
            error.message
          );
        }
      }
    }

    return sentCount;
  }


  async function ensureSettings(
    client,
    companyId
  ) {
    await client.query(
      `
      INSERT INTO reminder_settings (
        company_id
      )
      VALUES ($1)
      ON CONFLICT (company_id)
      DO NOTHING
      `,
      [companyId]
    );

    const r = await client.query(
      `
      SELECT *
      FROM reminder_settings
      WHERE company_id=$1
      `,
      [companyId]
    );

    return r.rows[0];
  }


  async function processCompany(
    companyId
  ) {
    const client =
      await pool.connect();

    try {
      const settings =
        await ensureSettings(
          client,
          companyId
        );

      const manual =
        await processManualReminders(
          client,
          companyId,
          settings
        );

      const supplier =
        await processSupplierDebts(
          client,
          companyId,
          settings
        );

      const withdrawals =
        await processLargeWithdrawals(
          client,
          companyId,
          settings
        );

      return {
        companyId,
        manual,
        supplier,
        withdrawals
      };
    } finally {
      client.release();
    }
  }


  async function processAllCompanies() {
    const r = await pool.query(
      `
      SELECT id
      FROM companies
      WHERE status IS DISTINCT FROM 'deleted'
      ORDER BY id
      `
    );

    const results = [];

    for (const row of r.rows) {
      try {
        results.push(
          await processCompany(
            Number(row.id)
          )
        );
      } catch (error) {
        console.error(
          `[REMINDERS company ${row.id}]`,
          error
        );
      }
    }

    return results;
  }


  router.get(
    "/",
    authenticateToken,
    async (req,res) => {
      try {
        const companyId =
          ensureCompany(req,res);

        if (!companyId) return;

        const r = await pool.query(
          `
          SELECT
            r.*,
            u.email AS notify_user_email
          FROM reminders r
          LEFT JOIN users u
            ON u.id=r.notify_user_id
          WHERE r.company_id=$1
          ORDER BY
            CASE
              WHEN r.status='active'
                THEN 0
              ELSE 1
            END,
            r.due_date,
            r.id DESC
          `,
          [companyId]
        );

        res.json(r.rows);
      } catch (error) {
        console.error(
          "GET /reminders",
          error
        );

        res.status(500).json({
          error:
            "Erreur lecture rappels."
        });
      }
    }
  );


  router.post(
    "/",
    authenticateToken,
    async (req,res) => {
      try {
        const companyId =
          ensureCompany(req,res);

        if (!companyId) return;

        const title =
          cleanText(req.body?.title);

        const dueDate =
          cleanText(req.body?.due_date);

        if (!title || !dueDate) {
          return res.status(400).json({
            error:
              "Titre et date d'échéance obligatoires."
          });
        }

        const result =
          await pool.query(
            `
            INSERT INTO reminders (
              company_id,
              title,
              category,
              description,
              amount,
              currency,
              due_date,
              recurrence,
              remind_days,
              notify_user_id,
              email_enabled,
              email_to,
              linked_entity_type,
              linked_entity_id,
              status,
              created_by
            )
            VALUES (
              $1,$2,$3,$4,$5,
              'FCFA',
              $6,$7,$8,
              $9,$10,$11,$12,$13,
              'active',$14
            )
            RETURNING *
            `,
            [
              companyId,
              title,
              cleanText(
                req.body?.category
              ) || "autre",
              cleanText(
                req.body?.description
              ),
              Number(
                req.body?.amount || 0
              ),
              dueDate,
              validRecurrence(
                req.body?.recurrence
              ),
              parseDays(
                req.body?.remind_days
              ),
              req.body?.notify_user_id
                ? Number(
                    req.body.notify_user_id
                  )
                : null,
              req.body?.email_enabled
                !== false,
              cleanText(
                req.body?.email_to
              ),
              cleanText(
                req.body?.linked_entity_type
              ),
              req.body?.linked_entity_id
                ? Number(
                    req.body.linked_entity_id
                  )
                : null,
              req.user?.id || null
            ]
          );

        res.status(201).json(
          result.rows[0]
        );
      } catch (error) {
        console.error(
          "POST /reminders",
          error
        );

        res.status(500).json({
          error:
            "Erreur création rappel."
        });
      }
    }
  );


  router.put(
    "/:id",
    authenticateToken,
    async (req,res) => {
      try {
        const companyId =
          ensureCompany(req,res);

        if (!companyId) return;

        const id =
          Number(req.params.id);

        const result =
          await pool.query(
            `
            UPDATE reminders
            SET
              title=$1,
              category=$2,
              description=$3,
              amount=$4,
              due_date=$5,
              recurrence=$6,
              remind_days=$7,
              email_enabled=$8,
              email_to=$9,
              status=$10,
              updated_at=CURRENT_TIMESTAMP
            WHERE id=$11
              AND company_id=$12
            RETURNING *
            `,
            [
              cleanText(req.body?.title),
              cleanText(req.body?.category)
                || "autre",
              cleanText(
                req.body?.description
              ),
              Number(
                req.body?.amount || 0
              ),
              cleanText(
                req.body?.due_date
              ),
              validRecurrence(
                req.body?.recurrence
              ),
              parseDays(
                req.body?.remind_days
              ),
              req.body?.email_enabled
                !== false,
              cleanText(
                req.body?.email_to
              ),
              cleanText(
                req.body?.status
              ) || "active",
              id,
              companyId
            ]
          );

        if (!result.rowCount) {
          return res.status(404).json({
            error:"Rappel introuvable."
          });
        }

        res.json(result.rows[0]);
      } catch (error) {
        console.error(
          "PUT /reminders/:id",
          error
        );

        res.status(500).json({
          error:
            "Erreur modification rappel."
        });
      }
    }
  );


  router.post(
    "/:id/pay",
    authenticateToken,
    async (req,res) => {
      const client =
        await pool.connect();

      try {
        const companyId =
          ensureCompany(req,res);

        if (!companyId) {
          client.release();
          return;
        }

        await client.query("BEGIN");

        const current =
          await client.query(
            `
            SELECT *
            FROM reminders
            WHERE id=$1
              AND company_id=$2
            FOR UPDATE
            `,
            [
              Number(req.params.id),
              companyId
            ]
          );

        if (!current.rowCount) {
          await client.query(
            "ROLLBACK"
          );

          return res.status(404).json({
            error:"Rappel introuvable."
          });
        }

        const r = current.rows[0];

        let sql;

        switch (r.recurrence) {
          case "weekly":
            sql = `
              due_date =
                due_date + INTERVAL '7 days',
              status='active'
            `;
            break;

          case "monthly":
            sql = `
              due_date =
                due_date + INTERVAL '1 month',
              status='active'
            `;
            break;

          case "quarterly":
            sql = `
              due_date =
                due_date + INTERVAL '3 months',
              status='active'
            `;
            break;

          case "yearly":
            sql = `
              due_date =
                due_date + INTERVAL '1 year',
              status='active'
            `;
            break;

          default:
            sql = `status='paid'`;
        }

        const updated =
          await client.query(
            `
            UPDATE reminders
            SET
              ${sql},
              last_paid_at=CURRENT_TIMESTAMP,
              updated_at=CURRENT_TIMESTAMP
            WHERE id=$1
              AND company_id=$2
            RETURNING *
            `,
            [
              r.id,
              companyId
            ]
          );

        await client.query("COMMIT");

        res.json(updated.rows[0]);
      } catch (error) {
        try {
          await client.query(
            "ROLLBACK"
          );
        } catch {}

        console.error(
          "POST /reminders/:id/pay",
          error
        );

        res.status(500).json({
          error:
            "Erreur validation paiement."
        });
      } finally {
        client.release();
      }
    }
  );


  router.delete(
    "/:id",
    authenticateToken,
    async (req,res) => {
      try {
        const companyId =
          ensureCompany(req,res);

        if (!companyId) return;

        const result =
          await pool.query(
            `
            DELETE FROM reminders
            WHERE id=$1
              AND company_id=$2
            RETURNING id
            `,
            [
              Number(req.params.id),
              companyId
            ]
          );

        if (!result.rowCount) {
          return res.status(404).json({
            error:"Rappel introuvable."
          });
        }

        res.json({
          success:true
        });
      } catch (error) {
        console.error(
          "DELETE /reminders/:id",
          error
        );

        res.status(500).json({
          error:
            "Erreur suppression rappel."
        });
      }
    }
  );


  router.get(
    "/settings/current",
    authenticateToken,
    async (req,res) => {
      const client =
        await pool.connect();

      try {
        const companyId =
          ensureCompany(req,res);

        if (!companyId) return;

        const settings =
          await ensureSettings(
            client,
            companyId
          );

        res.json(settings);
      } finally {
        client.release();
      }
    }
  );


  router.put(
    "/settings/current",
    authenticateToken,
    async (req,res) => {
      try {
        const companyId =
          ensureCompany(req,res);

        if (!companyId) return;

        const r = await pool.query(
          `
          INSERT INTO reminder_settings (
            company_id,
            large_withdrawal_threshold,
            supplier_unpaid_after_days,
            supplier_alerts_enabled,
            withdrawal_alerts_enabled,
            email_enabled,
            default_email,
            updated_at
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,
            CURRENT_TIMESTAMP
          )
          ON CONFLICT (company_id)
          DO UPDATE SET
            large_withdrawal_threshold=
              EXCLUDED.large_withdrawal_threshold,
            supplier_unpaid_after_days=
              EXCLUDED.supplier_unpaid_after_days,
            supplier_alerts_enabled=
              EXCLUDED.supplier_alerts_enabled,
            withdrawal_alerts_enabled=
              EXCLUDED.withdrawal_alerts_enabled,
            email_enabled=
              EXCLUDED.email_enabled,
            default_email=
              EXCLUDED.default_email,
            updated_at=CURRENT_TIMESTAMP
          RETURNING *
          `,
          [
            companyId,
            Number(
              req.body?.large_withdrawal_threshold ||
              5000000
            ),
            Math.max(
              1,
              Number(
                req.body?.supplier_unpaid_after_days ||
                7
              )
            ),
            req.body?.supplier_alerts_enabled
              !== false,
            req.body?.withdrawal_alerts_enabled
              !== false,
            req.body?.email_enabled
              !== false,
            cleanText(
              req.body?.default_email
            )
          ]
        );

        res.json(r.rows[0]);
      } catch (error) {
        console.error(
          "PUT reminder settings",
          error
        );

        res.status(500).json({
          error:
            "Erreur paramètres rappels."
        });
      }
    }
  );


  router.get(
    "/supplier-debts/current",
    authenticateToken,
    async (req,res) => {
      try {
        const companyId =
          ensureCompany(req,res);

        if (!companyId) return;

        const r = await pool.query(
          `
          SELECT
            id,
            purchase_number,
            supplier_name,
            total_amount,
            amount_paid,
            amount_due,
            status,
            created_at
          FROM purchases
          WHERE company_id=$1
            AND COALESCE(amount_due,0)>0
          ORDER BY amount_due DESC,id DESC
          `,
          [companyId]
        );

        const total =
          r.rows.reduce(
            (sum,row) =>
              sum + Number(
                row.amount_due || 0
              ),
            0
          );

        res.json({
          count:r.rowCount,
          total,
          rows:r.rows
        });
      } catch (error) {
        console.error(
          "supplier debts",
          error
        );

        res.status(500).json({
          error:
            "Erreur fournisseurs impayés."
        });
      }
    }
  );


  router.post(
    "/run-now",
    authenticateToken,
    async (req,res) => {
      try {
        const companyId =
          ensureCompany(req,res);

        if (!companyId) return;

        const result =
          await processCompany(
            companyId
          );

        res.json({
          success:true,
          result
        });
      } catch (error) {
        console.error(
          "run reminders",
          error
        );

        res.status(500).json({
          error:
            "Erreur traitement rappels."
        });
      }
    }
  );


  if (
    !global.__triangleReminderSchedulerStarted
  ) {
    global.__triangleReminderSchedulerStarted =
      true;

    const execute = async () => {
      try {
        await processAllCompanies();
      } catch (error) {
        console.error(
          "[REMINDERS scheduler]",
          error
        );
      }
    };

    const first =
      setTimeout(
        execute,
        20000
      );

    if (first.unref) {
      first.unref();
    }

    const timer =
      setInterval(
        execute,
        60 * 60 * 1000
      );

    if (timer.unref) {
      timer.unref();
    }

    console.log(
      "✅ Scheduler rappels Triangle actif (1h)"
    );
  }


  return router;
};
