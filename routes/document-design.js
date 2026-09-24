"use strict";

module.exports = function createDocumentDesignRouter({
  pool,
  authenticateToken,
  getEffectiveCompanyId,
  authorizeRoles,
}) {
  const express = require("express");
  const router = express.Router();

  const templates = new Set([
    "model1",
    "model2",
    "model3",
    "model4",
    "model5",
  ]);

  const fonts = new Set([
    "Arial",
    "Georgia",
    "Times New Roman",
    "Verdana",
    "Trebuchet MS",
  ]);

  const logoPositions = new Set([
    "left",
    "center",
    "right",
  ]);

  const densities = new Set([
    "compact",
    "normal",
    "airy",
  ]);

  const text = (v, max = 500) =>
    String(v ?? "").trim().slice(0, max);

  const bool = (v, fallback = false) =>
    typeof v === "boolean" ? v : fallback;

  const numberBetween = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n)
      ? Math.min(max, Math.max(min, n))
      : fallback;
  };

  const color = (v, fallback) => {
    const s = String(v || "");
    return /^#[0-9a-fA-F]{6}$/.test(s)
      ? s
      : fallback;
  };

  function defaultConfig(companyId) {
    if (Number(companyId) === 5) {
      return {
        primary_color: "#171717",
        secondary_color: "#B58A4B",
        accent_color: "#F3EBDD",
        font_family: "Georgia",
        title_size: 28,
        body_size: 11,
        logo_size: 95,
        logo_position: "left",
        density: "normal",

        logo_url: "",
        company_name_override: "",
        slogan_override: "",
        header_text: "",
        footer_text: "",

        whatsapp: "",
        nif: "",
        rccm: "",

        show_address: true,
        show_phone: true,
        show_email: true,
        show_website: true,
        show_slogan: true,
        show_signature: true,

        show_tax: false,
        tax_rate: 18,

        client_label: "Informations Client",
        description_label: "Description",
        total_label: "Total",
      };
    }

    return {
      primary_color: "#0B2D5B",
      secondary_color: "#1769AA",
      accent_color: "#E8F1FA",
      font_family: "Arial",
      title_size: 28,
      body_size: 11,
      logo_size: 95,
      logo_position: "left",
      density: "normal",

      logo_url: "",
      company_name_override: "",
      slogan_override: "",
      header_text: "",
      footer_text: "",

      whatsapp: "",
      nif: "",
      rccm: "",

      show_address: true,
      show_phone: true,
      show_email: true,
      show_website: true,
      show_slogan: true,
      show_signature: true,

      show_tax: false,
      tax_rate: 18,

      client_label: "Informations Client",
      description_label: "Description",
      total_label: "Total",
    };
  }

  function sanitizeConfig(raw, companyId) {
    const d = defaultConfig(companyId);
    const b = raw && typeof raw === "object" ? raw : {};

    return {
      primary_color:
        color(b.primary_color, d.primary_color),

      secondary_color:
        color(b.secondary_color, d.secondary_color),

      accent_color:
        color(b.accent_color, d.accent_color),

      font_family:
        fonts.has(b.font_family)
          ? b.font_family
          : d.font_family,

      title_size:
        numberBetween(
          b.title_size,
          18,
          42,
          d.title_size
        ),

      body_size:
        numberBetween(
          b.body_size,
          8,
          18,
          d.body_size
        ),

      logo_size:
        numberBetween(
          b.logo_size,
          40,
          180,
          d.logo_size
        ),

      logo_position:
        logoPositions.has(b.logo_position)
          ? b.logo_position
          : d.logo_position,

      density:
        densities.has(b.density)
          ? b.density
          : d.density,

      logo_url:
        text(b.logo_url, 1000),

      company_name_override:
        text(b.company_name_override, 150),

      slogan_override:
        text(b.slogan_override, 300),

      header_text:
        text(b.header_text, 600),

      footer_text:
        text(b.footer_text, 1000),

      whatsapp:
        text(b.whatsapp, 80),

      nif:
        text(b.nif, 100),

      rccm:
        text(b.rccm, 100),

      show_address:
        bool(b.show_address, d.show_address),

      show_phone:
        bool(b.show_phone, d.show_phone),

      show_email:
        bool(b.show_email, d.show_email),

      show_website:
        bool(b.show_website, d.show_website),

      show_slogan:
        bool(b.show_slogan, d.show_slogan),

      show_signature:
        bool(b.show_signature, d.show_signature),

      /*
       * TVA volontairement stockée mais non appliquée aux
       * montants comptables tant que le module fiscal n'est
       * pas activé dans le métier.
       */
      show_tax:
        bool(b.show_tax, false),

      tax_rate:
        numberBetween(
          b.tax_rate,
          0,
          100,
          d.tax_rate
        ),

      client_label:
        text(
          b.client_label ||
            d.client_label,
          80
        ),

      description_label:
        text(
          b.description_label ||
            d.description_label,
          80
        ),

      total_label:
        text(
          b.total_label ||
            d.total_label,
          80
        ),
    };
  }


  router.get(
    "/document-design/current",
    authenticateToken,
    async (req, res) => {
      try {
        const companyId =
          getEffectiveCompanyId(req);

        if (!companyId) {
          return res.status(400).json({
            error:
              "Sélectionnez une entreprise active.",
          });
        }

        const { rows } = await pool.query(
          `SELECT
             company_id,
             template_id,
             config,
             updated_at
           FROM document_design_settings
           WHERE company_id=$1`,
          [companyId]
        );

        const row = rows[0];

        if (!row) {
          return res.json({
            company_id: companyId,
            template_id:
              Number(companyId) === 5
                ? "model4"
                : "model1",
            config:
              defaultConfig(companyId),
          });
        }

        res.json({
          company_id: companyId,
          template_id: row.template_id,
          config: {
            ...defaultConfig(companyId),
            ...(row.config || {}),
          },
          updated_at: row.updated_at,
        });
      } catch (e) {
        console.error(
          "GET DOCUMENT DESIGN:",
          e
        );

        res.status(500).json({
          error:
            "Erreur chargement design documents.",
        });
      }
    }
  );


  router.put(
    "/document-design/current",
    authenticateToken,
    authorizeRoles(
      "admin",
      "super_admin"
    ),
    async (req, res) => {
      try {
        const companyId =
          getEffectiveCompanyId(req);

        if (!companyId) {
          return res.status(400).json({
            error:
              "Sélectionnez une entreprise active.",
          });
        }

        const templateId =
          templates.has(req.body?.template_id)
            ? req.body.template_id
            : null;

        if (!templateId) {
          return res.status(400).json({
            error:
              "Modèle de document invalide.",
          });
        }

        const config =
          sanitizeConfig(
            req.body?.config,
            companyId
          );

        const { rows } = await pool.query(
          `INSERT INTO document_design_settings
             (
               company_id,
               template_id,
               config,
               updated_by
             )
           VALUES ($1,$2,$3::jsonb,$4)

           ON CONFLICT (company_id)
           DO UPDATE SET
             template_id=EXCLUDED.template_id,
             config=EXCLUDED.config,
             updated_by=EXCLUDED.updated_by,
             updated_at=NOW()

           RETURNING
             company_id,
             template_id,
             config,
             updated_at`,
          [
            companyId,
            templateId,
            JSON.stringify(config),
            req.user?.id || null,
          ]
        );

        res.json({
          success: true,
          ...rows[0],
          message:
            "Modèle de documents enregistré.",
        });
      } catch (e) {
        console.error(
          "PUT DOCUMENT DESIGN:",
          e
        );

        res.status(500).json({
          error:
            "Erreur enregistrement design documents.",
        });
      }
    }
  );

  return router;
};
