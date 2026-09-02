"use strict";

/**
 * IMPORT D'UN CLASSEUR DE STOCK.
 *
 *   POST /stock/import-em2s/preview        lire un classeur, sans rien écrire
 *   POST /stock/import-em2s/execute        écrire les réceptions prévisualisées
 *   GET  /stock/import-em2s/batches        les lots déjà passés
 *   GET  /stock/import-em2s/batches/:id    un lot et ses anomalies
 *   GET  /stock/import-em2s/anomalies      ce qui attend une décision
 *   POST /stock/import-em2s/anomalies/:id/resolve   la décision prise
 *   POST /stock/import-em2s/batches/:id/cancel      annuler un lot
 *
 * L'entreprise vient TOUJOURS du contexte authentifié, jamais du corps de la
 * requête : sinon il suffirait de changer un champ pour écrire chez le
 * voisin. Chaque route porte sa permission ; l'écran n'est qu'un reflet.
 */

const express = require("express");
const P = require("../services/import-em2s");
const D = require("../services/import-em2s-db");
const contexteSociete = require("../services/company-context");

module.exports = function createImportEm2sRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission, upload } = deps;
  const router = express.Router();

  /**
   * L'entreprise vient du serveur, jamais du client. `resoudreSociete` lit le
   * contexte de travail PUIS vérifie qu'il fait partie des entreprises que ce
   * compte peut atteindre : un en-tête falsifié ne donne donc rien de plus
   * que ce à quoi la personne avait déjà droit.
   */
  const societeDe = async (req) => {
    const r = await contexteSociete.resoudreSociete(pool, req, getEffectiveCompanyId);
    return r.companyId;
  };
  const utilisateurDe = (req) => ({ id: req.user?.id, nom: req.user?.fullname || req.user?.email });

  const peutVoir     = requirePermission("stock.import", "view");
  const peutLire     = requirePermission("stock.import", "import_preview");
  const peutEcrire   = requirePermission("stock.import", "import_execute");
  const peutResoudre = requirePermission("stock.import", "import_resolve");
  const peutAnnuler  = requirePermission("stock.import", "import_cancel");

  const echec = (res, e, defaut) => {
    console.error(defaut, e);
    res.status(e.httpStatus || 500).json({ error: e.message || defaut, code: e.code });
  };

  const sansSociete = (res) =>
    res.status(409).json({ error: "Entreprise indéterminée.", code: "COMPANY_CONTEXT_REQUIRED" });

  /** Transaction : tout le lot passe, ou rien. */
  const transaction = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };

  const fichierDe = (req) => {
    if (!req.file || !req.file.buffer && !req.file.path) {
      const e = new Error("Aucun fichier reçu.");
      e.httpStatus = 400; e.code = "FILE_REQUIRED"; throw e;
    }
    const buffer = req.file.buffer || require("fs").readFileSync(req.file.path);
    return { buffer, nom: req.file.originalname || "classeur.xlsx" };
  };

  /* ─────────────────────────────────────────────── prévisualisation ── */

  router.post("/stock/import-em2s/preview", authenticateToken, peutLire,
    upload.single("file"), async (req, res) => {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      const client = await pool.connect();
      try {
        const { buffer, nom } = fichierDe(req);
        const apercu = await D.previsualiser(client, { companyId, buffer, nomFichier: nom });
        res.json({ success: true, ...apercu });
      } catch (e) { echec(res, e, "Erreur de lecture du classeur."); }
      finally { client.release(); }
    });

  /* ────────────────────────────────────────────────────── exécution ── */

  router.post("/stock/import-em2s/execute", authenticateToken, peutEcrire,
    upload.single("file"), async (req, res) => {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      try {
        const { buffer, nom } = fichierDe(req);

        /* L'appelant dit quelle empreinte il a validée. Si le fichier a changé
           entre la prévisualisation et la confirmation, on refuse : sinon on
           écrirait un contenu que personne n'a relu. */
        const attendue = String(req.body?.sha256 || "").trim().toLowerCase();

        const out = await transaction(async (client) => {
          const apercu = await D.previsualiser(client, { companyId, buffer, nomFichier: nom });
          if (attendue && attendue !== apercu.fichier.sha256) {
            const e = new Error(
              `Le fichier a changé depuis la prévisualisation : ${apercu.fichier.sha256} `
              + `au lieu de ${attendue}. Relancez la prévisualisation.`);
            e.httpStatus = 409; e.code = "FILE_CHANGED"; throw e;
          }

          const { rows: lots } = await client.query(
            `INSERT INTO stock_import_batches
               (company_id, file_name, file_sha256, file_size, status, sheets, summary, created_by, executed_at)
             VALUES ($1,$2,$3,$4,'EXECUTED',$5,$6,$7,now())
             RETURNING id`,
            [companyId, apercu.fichier.nom, apercu.fichier.sha256, apercu.fichier.taille,
             JSON.stringify(apercu.feuilles),
             JSON.stringify({
               receptions: apercu.receptions.total,
               fusionnees: apercu.receptions.fusionnees,
               mouvements: apercu.mouvements.total,
               bloques: apercu.mouvements.bloques,
               couleurs: apercu.couleurs,
             }),
             req.user?.id || null]
          );
          const batchId = lots[0].id;

          const receptions = await D.ecrireReceptions(client, {
            companyId, batchId, sha: apercu.fichier.sha256,
            apercu, utilisateur: utilisateurDe(req),
          });
          const anomalies = await D.ecrireAnomalies(client,
            { companyId, batchId, sha: apercu.fichier.sha256, apercu });

          return {
            batchId, fichier: apercu.fichier, receptions, anomalies,
            /* Aucun mouvement n'est écrit ici : une réception ne bouge pas le
               stock, et une ligne bloquée n'écrit rien du tout. La mise en
               stock est une action séparée, validée par quelqu'un. */
            mouvements: {
              importables: apercu.mouvements.importables,
              bloques: apercu.mouvements.bloques,
              ecrits: 0,
              note: "Les mouvements attendent la mise en stock et la levée des anomalies.",
            },
          };
        });

        res.status(201).json({ success: true, ...out });
      } catch (e) { echec(res, e, "Erreur d'import."); }
    });

  /* ──────────────────────────────────────────────────────── lecture ── */

  router.get("/stock/import-em2s/batches", authenticateToken, peutVoir, async (req, res) => {
    const companyId = await societeDe(req);
    if (!companyId) return sansSociete(res);
    try {
      const { rows } = await pool.query(
        `SELECT b.*,
                (SELECT count(*) FROM stock_import_anomalies a
                  WHERE a.batch_id = b.id AND a.status = 'OPEN')::int AS anomalies_ouvertes,
                (SELECT count(*) FROM stock_receptions r
                  WHERE r.import_batch_id = b.id)::int AS receptions
           FROM stock_import_batches b
          WHERE b.company_id = $1
          ORDER BY b.created_at DESC LIMIT 50`,
        [companyId]
      );
      res.json({ success: true, lots: rows });
    } catch (e) { echec(res, e, "Erreur de lecture des lots."); }
  });

  router.get("/stock/import-em2s/batches/:id", authenticateToken, peutVoir, async (req, res) => {
    const companyId = await societeDe(req);
    if (!companyId) return sansSociete(res);
    try {
      const { rows } = await pool.query(
        `SELECT * FROM stock_import_batches WHERE id = $1 AND company_id = $2`,
        [Number(req.params.id), companyId]
      );
      /* Un lot d'une autre entreprise n'existe pas de ce côté-ci. */
      if (!rows[0]) return res.status(404).json({ error: "Lot introuvable.", code: "NOT_FOUND" });

      const [anomalies, receptions] = await Promise.all([
        pool.query(`SELECT * FROM stock_import_anomalies WHERE batch_id = $1 AND company_id = $2
                     ORDER BY excel_row`, [rows[0].id, companyId]),
        pool.query(`SELECT id, reception_number, container_number, reception_date, status, warehouses
                      FROM stock_receptions WHERE import_batch_id = $1 AND company_id = $2
                     ORDER BY reception_date`, [rows[0].id, companyId]),
      ]);
      res.json({ success: true, lot: rows[0], anomalies: anomalies.rows, receptions: receptions.rows });
    } catch (e) { echec(res, e, "Erreur de lecture du lot."); }
  });

  router.get("/stock/import-em2s/anomalies", authenticateToken, peutVoir, async (req, res) => {
    const companyId = await societeDe(req);
    if (!companyId) return sansSociete(res);
    try {
      const conditions = ["a.company_id = $1"];
      const params = [companyId];
      if (req.query.type) conditions.push(`a.anomaly_type = $${params.push(req.query.type)}`);
      if (req.query.batch) conditions.push(`a.batch_id = $${params.push(Number(req.query.batch))}`);
      conditions.push(`a.status = $${params.push(String(req.query.status || "OPEN").toUpperCase())}`);

      const { rows } = await pool.query(
        `SELECT a.* FROM stock_import_anomalies a
          WHERE ${conditions.join(" AND ")}
          ORDER BY a.anomaly_type, a.excel_row
          LIMIT ${Math.min(Number(req.query.limit) || 500, 1000)}`,
        params
      );
      res.json({ success: true, anomalies: rows, total: rows.length });
    } catch (e) { echec(res, e, "Erreur de lecture des anomalies."); }
  });

  /* ───────────────────────────────────────────── lever une anomalie ── */

  router.post("/stock/import-em2s/anomalies/:id/resolve", authenticateToken, peutResoudre,
    async (req, res) => {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      try {
        const out = await transaction(async (client) => {
          const { rows } = await client.query(
            `SELECT * FROM stock_import_anomalies
              WHERE id = $1 AND company_id = $2 FOR UPDATE`,
            [Number(req.params.id), companyId]
          );
          const anomalie = rows[0];
          if (!anomalie) {
            const e = new Error("Anomalie introuvable."); e.httpStatus = 404; e.code = "NOT_FOUND"; throw e;
          }
          if (anomalie.status !== "OPEN") {
            const e = new Error("Cette anomalie est déjà tranchée.");
            e.httpStatus = 409; e.code = "ALREADY_RESOLVED"; throw e;
          }

          const resolution = req.body?.resolution || {};
          verifierResolution(anomalie, resolution);

          await client.query(
            `UPDATE stock_import_anomalies
                SET status = 'RESOLVED', resolution = $1, resolved_by = $2, resolved_at = now()
              WHERE id = $3`,
            [JSON.stringify(resolution), req.user?.id || null, anomalie.id]
          );
          return { id: anomalie.id, type: anomalie.anomaly_type, resolution };
        });
        res.json({ success: true, ...out });
      } catch (e) { echec(res, e, "Erreur de résolution."); }
    });

  /**
   * Une résolution doit être exacte, pas approchée.
   *
   * Pour une répartition par bac comme pour une ventilation par date, la
   * somme saisie doit égaler la quantité attendue — au strict. Accepter un
   * écart reviendrait à inventer les unités manquantes.
   */
  function verifierResolution(anomalie, resolution) {
    const refus = (message, code) => {
      const e = new Error(message); e.httpStatus = 400; e.code = code; throw e;
    };
    const charge = anomalie.payload || {};

    if (anomalie.anomaly_type === "MULTI_BIN") {
      const parBin = resolution.parBin;
      if (!parBin || typeof parBin !== "object") refus("Indiquez la quantité de chaque bac.", "BINS_REQUIRED");
      const attendue = Number(charge.quantiteAttendue);
      const bins = Array.isArray(charge.bins) ? charge.bins : [];
      const inconnus = Object.keys(parBin).filter((b) => !bins.includes(b));
      if (inconnus.length) refus(`Bac hors de cette ligne : ${inconnus.join(", ")}.`, "BIN_UNKNOWN");
      const somme = Object.values(parBin).reduce((s, q) => s + Number(q || 0), 0);
      if (Object.values(parBin).some((q) => Number(q) < 0)) refus("Une quantité ne peut pas être négative.", "NEGATIVE");
      if (!Number.isFinite(attendue)) refus("Quantité attendue inconnue pour cette ligne.", "EXPECTED_UNKNOWN");
      if (somme !== attendue) {
        refus(`La répartition totalise ${somme} alors que la ligne porte sur ${attendue}. `
            + "L'écart doit être nul.", "ALLOCATION_MISMATCH");
      }
      return;
    }

    if (anomalie.anomaly_type === "DATES_MULTIPLES") {
      const parDate = resolution.parDate;
      if (!parDate || typeof parDate !== "object") refus("Indiquez la quantité de chaque date.", "DATES_REQUIRED");
      const dates = Array.isArray(charge.dates) ? charge.dates : [];
      const inconnues = Object.keys(parDate).filter((d) => !dates.includes(d));
      if (inconnues.length) refus(`Date hors de cette cellule : ${inconnues.join(", ")}.`, "DATE_UNKNOWN");
      const somme = Object.values(parDate).reduce((s, q) => s + Number(q || 0), 0);
      const attendue = Number(resolution.quantiteTotale ?? charge.sorties ?? charge.entrees);
      if (!Number.isFinite(attendue)) refus("Quantité totale inconnue pour cette cellule.", "EXPECTED_UNKNOWN");
      if (somme !== attendue) {
        refus(`Les quantités par date totalisent ${somme} au lieu de ${attendue}.`, "DATE_SPLIT_MISMATCH");
      }
      return;
    }

    if (anomalie.anomaly_type === "NEW_STOCK_INCOHERENT") {
      /* On ne corrige pas la feuille à la place de son auteur : on demande
         quelle valeur fait foi, et on garde la trace de qui l'a dit. */
      if (!["ATTENDU", "AFFICHE"].includes(String(resolution.valeurRetenue || ""))) {
        refus("Précisez la valeur qui fait foi : « ATTENDU » ou « AFFICHE ».", "VALUE_REQUIRED");
      }
      if (!String(resolution.motif || "").trim()) refus("Un motif est obligatoire.", "REASON_REQUIRED");
      return;
    }

    if (!resolution || Object.keys(resolution).length === 0) {
      refus("Aucune décision fournie.", "RESOLUTION_REQUIRED");
    }
  }

  /* ────────────────────────────────────────────────────── annulation ── */

  router.post("/stock/import-em2s/batches/:id/cancel", authenticateToken, peutAnnuler,
    async (req, res) => {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      try {
        const { rows } = await pool.query(
          `UPDATE stock_import_batches
              SET status = 'CANCELLED', cancelled_at = now()
            WHERE id = $1 AND company_id = $2 AND status <> 'CANCELLED'
            RETURNING id, status`,
          [Number(req.params.id), companyId]
        );
        if (!rows[0]) return res.status(404).json({ error: "Lot introuvable ou déjà annulé.", code: "NOT_FOUND" });
        /* Annuler marque le lot ; cela n'efface aucune réception ni aucun
           mouvement déjà écrits — ceux-là se corrigent un par un, à la vue
           de tous. */
        res.json({ success: true, lot: rows[0],
                   note: "Le lot est marqué annulé. Les écritures déjà faites restent visibles." });
      } catch (e) { echec(res, e, "Erreur d'annulation."); }
    });

  /* ───────────────────────────────────── bon de réception imprimable ── */

  const echapperHtml = (v) => String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  /**
   * Date affichée à Bamako, quel que soit le fuseau du navigateur ou du
   * serveur. Une réception se date au JOUR : y accoler une heure inventée
   * ferait croire à une précision qui n'existe pas sur le quai.
   */
  const dateBamako = (valeur, avecHeure = false) => {
    if (!valeur) return "—";
    return new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Africa/Bamako", dateStyle: "long",
      ...(avecHeure ? { timeStyle: "short" } : {}),
    }).format(new Date(valeur));
  };

  const peutImprimer = requirePermission("reception", "print");

  router.get("/stock/receptions/:id/print", authenticateToken, peutImprimer, async (req, res) => {
    const companyId = await societeDe(req);
    if (!companyId) return sansSociete(res);
    try {
      const { rows } = await pool.query(
        `SELECT r.*, c.name AS societe FROM stock_receptions r
           LEFT JOIN companies c ON c.id = r.company_id
          WHERE r.id = $1 AND r.company_id = $2`,
        [Number(req.params.id), companyId]
      );
      const rec = rows[0];
      if (!rec) return res.status(404).json({ error: "Réception introuvable.", code: "NOT_FOUND" });

      const { rows: lignes } = await pool.query(
        `SELECT l.*, p.name AS produit FROM stock_reception_lines l
           LEFT JOIN products p ON p.id = l.product_id
          WHERE l.reception_id = $1 AND l.company_id = $2
          ORDER BY l.warehouse_code, l.line_no`,
        [rec.id, companyId]
      );

      /* Compter l'impression AVANT de rendre la page : un bon parti sans être
         compté rend l'historique faux. La réimpression exige son propre droit,
         vérifié ici plutôt qu'en refusant après coup. */
      const premiere = Number(rec.print_count || 0) === 0;
      if (!premiere) {
        const ctx = await require("../services/permissions").chargerContexte(pool, req.user);
        const verdict = require("../services/permissions").decider(ctx, "reception", "reprint");
        if (!verdict.autorise) {
          return res.status(403).json({
            error: "Ce bon a déjà été imprimé : la réimpression demande un droit distinct.",
            code: "REPRINT_FORBIDDEN",
          });
        }
      }
      await pool.query(
        `UPDATE stock_receptions SET printed_at = now(), print_count = COALESCE(print_count,0) + 1
          WHERE id = $1`, [rec.id]);

      const entrepots = [...new Set(lignes.map((l) => l.warehouse_code || "—"))].sort();
      const total = lignes.reduce((s, l) => s + Number(l.quantity_received || 0), 0);

      const section = (entrepot) => {
        const siennes = lignes.filter((l) => (l.warehouse_code || "—") === entrepot);
        const sous = siennes.reduce((s, l) => s + Number(l.quantity_received || 0), 0);
        return `<h2>Entrepôt ${echapperHtml(entrepot)}</h2>
          <table>
            <thead><tr><th>#</th><th>Article</th><th>Produit</th><th>Unité</th>
                       <th class="n">Quantité</th><th>Source</th></tr></thead>
            <tbody>${siennes.map((l) => `<tr>
              <td>${l.line_no || ""}</td>
              <td>${echapperHtml(l.received_label)}</td>
              <td>${echapperHtml(l.produit || "—")}</td>
              <td>${echapperHtml(l.unit || "")}</td>
              <td class="n">${Number(l.quantity_received).toLocaleString("fr-FR")}</td>
              <td class="src">${echapperHtml(l.excel_sheet || "")}${l.excel_row ? ":" + l.excel_row : ""}</td>
            </tr>`).join("")}</tbody>
            <tfoot><tr><td colspan="4">Sous-total entrepôt ${echapperHtml(entrepot)}</td>
                       <td class="n">${sous.toLocaleString("fr-FR")}</td><td></td></tr></tfoot>
          </table>`;
      };

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Bon de réception ${echapperHtml(rec.reception_number)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; color: #111; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 18px 0 6px; border-bottom: 2px solid #111; }
  .entete { display: flex; flex-wrap: wrap; gap: 24px; font-size: 12px; margin-bottom: 12px; }
  .entete div { min-width: 180px; }
  .cle { color: #666; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border-bottom: 1px solid #ddd; padding: 4px 6px; text-align: left; }
  .n { text-align: right; }
  .src { color: #999; font-size: 10px; }
  tfoot td { font-weight: bold; border-top: 2px solid #111; }
  .total { margin-top: 16px; font-size: 14px; font-weight: bold; }
  .note { margin-top: 18px; font-size: 11px; color: #666; }
  @media print { body { margin: 8mm; } .noprint { display: none; } }
</style></head><body>
<h1>Bon de réception ${echapperHtml(rec.reception_number)}</h1>
<div class="entete">
  <div><span class="cle">Conteneur</span><br><b>${echapperHtml(rec.container_number || "—")}</b></div>
  <div><span class="cle">Date réelle de réception</span><br><b>${dateBamako(rec.document_datetime || rec.operation_effective_at || rec.reception_date)}</b></div>
  <div><span class="cle">Date d'enregistrement</span><br>${dateBamako(rec.created_at, true)}</div>
  <div><span class="cle">Statut</span><br>${echapperHtml(rec.status)}</div>
  <div><span class="cle">Entreprise</span><br>${echapperHtml(rec.societe || "")}</div>
  <div><span class="cle">Fichier source</span><br>${echapperHtml(rec.source_file || "—")}
       <span class="src">${echapperHtml(String(rec.file_sha256 || "").slice(0, 16))}</span></div>
  <div><span class="cle">Impressions</span><br>${Number(rec.print_count || 0) + 1}
       — dernière : ${dateBamako(new Date(), true)}</div>
</div>
${entrepots.map(section).join("")}
<p class="total">Total général du conteneur : ${total.toLocaleString("fr-FR")} unité(s)
   sur ${lignes.length} ligne(s)</p>
<p class="note">
  Fuseau : Africa/Bamako. La date affichée est celle de l'opération réelle, jamais
  celle de la saisie. Une réception ne met rien en stock : les quantités
  deviennent disponibles à la mise en stock, validée séparément.
</p>
</body></html>`);
    } catch (e) { echec(res, e, "Erreur d'impression du bon."); }
  });

  /* ─────────────────────────────────────── couleurs de référence ── */

  router.get("/stock/import-em2s/couleurs", authenticateToken, peutVoir, (req, res) => {
    res.json({ success: true, couleurs: P.COULEURS, zonesSansRack: P.ZONES_SANS_RACK,
               niveauxValides: P.NIVEAUX_VALIDES });
  });

  return router;
};
