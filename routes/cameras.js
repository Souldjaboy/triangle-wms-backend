const express = require("express");

module.exports = function createCameraRouter({
  pool,
  authenticateToken,
  getEffectiveCompanyId,
  requirePermission,
}) {
  const router = express.Router();

  function companyOf(req) {
    return (
      Number(
        typeof getEffectiveCompanyId === "function"
          ? getEffectiveCompanyId(req)
          : req.user?.company_id
      ) ||
      Number(req.user?.company_id || 0) ||
      null
    );
  }

  router.get(
    "/cameras/sites",
    authenticateToken,
    requirePermission("centre_camera", "view"),
    async (req, res) => {
      try {
        const companyId = companyOf(req);

        const { rows } = await pool.query(
          `
          SELECT
            cs.*,
            COUNT(cc.id)::int AS cameras
          FROM camera_sites cs
          LEFT JOIN camera_channels cc
            ON cc.site_id=cs.id
           AND cc.active=true
          WHERE cs.company_id=$1
          GROUP BY cs.id
          ORDER BY cs.name
          `,
          [companyId]
        );

        res.json(rows);
      } catch (error) {
        console.error("CAMERA SITES:", error);

        res.status(500).json({
          error: "Erreur lecture sites caméra.",
        });
      }
    }
  );


  router.post(
    "/cameras/sites",
    authenticateToken,
    requirePermission("centre_camera", "create"),
    async (req, res) => {
      const client = await pool.connect();

      try {
        const companyId = companyOf(req);

        const name =
          String(req.body?.name || "").trim();

        if (!name) {
          return res.status(400).json({
            error: "Nom du site obligatoire.",
          });
        }

        const channelCount = Math.max(
          1,
          Math.min(
            64,
            Number(req.body?.channel_count || 4)
          )
        );

        await client.query("BEGIN");

        const { rows } = await client.query(
          `
          INSERT INTO camera_sites
          (
            company_id,
            name,
            location_label,
            recorder_type,
            recorder_model,
            recorder_app,
            channel_count,
            lan_ip,
            http_port,
            rtsp_port,
            onvif_port,
            connection_mode,
            gateway_url,
            status,
            notes,
            created_by
          )
          VALUES
          (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
            $12,$13,$14,$15,$16
          )
          RETURNING *
          `,
          [
            companyId,
            name,
            String(req.body?.location_label || ""),
            String(req.body?.recorder_type || "DVR"),
            String(req.body?.recorder_model || ""),
            String(req.body?.recorder_app || ""),
            channelCount,
            String(req.body?.lan_ip || ""),
            req.body?.http_port
              ? Number(req.body.http_port)
              : null,
            req.body?.rtsp_port
              ? Number(req.body.rtsp_port)
              : null,
            req.body?.onvif_port
              ? Number(req.body.onvif_port)
              : null,
            String(req.body?.connection_mode || "LOCAL"),
            String(req.body?.gateway_url || ""),
            "A_CONFIGURER",
            String(req.body?.notes || ""),
            Number(req.user.id),
          ]
        );

        const site = rows[0];

        for (let i=1; i<=channelCount; i++) {
          await client.query(
            `
            INSERT INTO camera_channels
            (
              company_id,
              site_id,
              channel_number,
              name,
              zone_label,
              created_by
            )
            VALUES
            ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (site_id,channel_number)
            DO NOTHING
            `,
            [
              companyId,
              site.id,
              i,
              `Caméra ${i}`,
              "",
              Number(req.user.id),
            ]
          );
        }

        await client.query("COMMIT");

        res.status(201).json(site);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});

        console.error("CAMERA CREATE SITE:", error);

        res.status(500).json({
          error: "Erreur création site caméra.",
        });
      } finally {
        client.release();
      }
    }
  );


  router.get(
    "/cameras/sites/:id/channels",
    authenticateToken,
    requirePermission("centre_camera", "view"),
    async (req, res) => {
      try {
        const companyId = companyOf(req);

        const { rows } = await pool.query(
          `
          SELECT cc.*
          FROM camera_channels cc
          JOIN camera_sites cs
            ON cs.id=cc.site_id
          WHERE cc.site_id=$1
            AND cs.company_id=$2
          ORDER BY cc.channel_number
          `,
          [
            Number(req.params.id),
            companyId,
          ]
        );

        await pool.query(
          `
          INSERT INTO camera_access_logs
          (
            company_id,
            site_id,
            user_id,
            action
          )
          VALUES
          ($1,$2,$3,'OPEN_SITE')
          `,
          [
            companyId,
            Number(req.params.id),
            Number(req.user.id),
          ]
        );

        res.json(rows);
      } catch (error) {
        res.status(500).json({
          error: "Erreur lecture caméras.",
        });
      }
    }
  );


  router.put(
    "/cameras/channels/:id",
    authenticateToken,
    requirePermission("centre_camera", "update"),
    async (req, res) => {
      try {
        const companyId = companyOf(req);

        const { rows } = await pool.query(
          `
          UPDATE camera_channels cc
          SET
            name=$3,
            zone_label=$4,
            stream_type=$5,
            stream_url=$6,
            active=$7,
            updated_at=CURRENT_TIMESTAMP
          FROM camera_sites cs
          WHERE cc.id=$1
            AND cc.site_id=cs.id
            AND cs.company_id=$2
          RETURNING cc.*
          `,
          [
            Number(req.params.id),
            companyId,
            String(req.body?.name || "Caméra"),
            String(req.body?.zone_label || ""),
            String(req.body?.stream_type || "UNCONFIGURED"),
            String(req.body?.stream_url || ""),
            req.body?.active !== false,
          ]
        );

        if (!rows.length) {
          return res.status(404).json({
            error: "Caméra introuvable.",
          });
        }

        res.json(rows[0]);
      } catch (error) {
        console.error("CAMERA UPDATE:", error);

        res.status(500).json({
          error: "Erreur mise à jour caméra.",
        });
      }
    }
  );

  return router;
};
