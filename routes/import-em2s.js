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
const M = require("../services/import-em2s-mouvements");
const E = require("../services/import-em2s-emplacements");
const permissionsService = require("../services/permissions");

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

      /* Deux questions distinctes vivent sur cette même ligne : où repose le
         stock, et par quel bac le mouvement est passé. La seconde est
         facultative — sans elle le mouvement attend — mais si elle est donnée,
         elle doit tomber juste elle aussi. */
      const parBinMouvement = resolution.parBinMouvement;
      if (parBinMouvement) {
        if (typeof parBinMouvement !== "object") {
          refus("La répartition du mouvement doit donner une quantité par bac.", "MOVE_BINS_INVALID");
        }
        const binsMvt = Object.keys(parBinMouvement);
        const horsLigne = binsMvt.filter((b) => !(charge.bins || []).includes(b));
        if (horsLigne.length) refus(`Bac hors de cette ligne : ${horsLigne.join(", ")}.`, "BIN_UNKNOWN");
        if (Object.values(parBinMouvement).some((q) => Number(q) < 0)) {
          refus("Une quantité ne peut pas être négative.", "NEGATIVE");
        }
        const sommeMvt = Object.values(parBinMouvement).reduce((s, q) => s + Number(q || 0), 0);
        const attenduMvt = Number(resolution.quantiteMouvement
          ?? charge.entrees ?? charge.sorties);
        if (Number.isFinite(attenduMvt) && sommeMvt !== attenduMvt) {
          refus(`La répartition du mouvement totalise ${sommeMvt} au lieu de ${attenduMvt}.`,
                "MOVE_ALLOCATION_MISMATCH");
        }
      }
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

  /* ──────────────────────────────── lever plusieurs anomalies d'un coup ── */

  /**
   * Cent soixante-cinq lignes à répartir : les enregistrer une par une ferait
   * cent soixante-cinq allers-retours. Ici, tout le lot passe ou rien — une
   * saisie à moitié enregistrée laisserait l'opérateur sans savoir où il en est.
   */
  router.post("/stock/import-em2s/anomalies/bulk-resolve", authenticateToken, peutResoudre,
    async (req, res) => {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);

      const entrees = Array.isArray(req.body?.resolutions) ? req.body.resolutions : [];
      if (entrees.length === 0) {
        return res.status(400).json({ error: "Aucune résolution fournie.", code: "EMPTY" });
      }
      if (entrees.length > 500) {
        return res.status(400).json({ error: "Trop de lignes en une fois (500 au plus).", code: "TOO_MANY" });
      }

      try {
        const out = await transaction(async (client) => {
          const faites = [];
          for (const entree of entrees) {
            const { rows } = await client.query(
              `SELECT * FROM stock_import_anomalies
                WHERE id = $1 AND company_id = $2 FOR UPDATE`,
              [Number(entree.id), companyId]
            );
            const anomalie = rows[0];
            if (!anomalie) {
              const e = new Error(`Anomalie ${entree.id} introuvable.`);
              e.httpStatus = 404; e.code = "NOT_FOUND"; throw e;
            }
            if (anomalie.status !== "OPEN") {
              const e = new Error(`L'anomalie ${anomalie.id} (ligne ${anomalie.excel_row}) est déjà tranchée.`);
              e.httpStatus = 409; e.code = "ALREADY_RESOLVED"; throw e;
            }

            /* Le même contrôle de somme que pour une résolution isolée : une
               saisie en masse n'a pas le droit d'être plus permissive. */
            verifierResolution(anomalie, entree.resolution || {});

            await client.query(
              `UPDATE stock_import_anomalies
                  SET status = 'RESOLVED', resolution = $1, resolved_by = $2, resolved_at = now()
                WHERE id = $3`,
              [JSON.stringify(entree.resolution), req.user?.id || null, anomalie.id]
            );
            faites.push({ id: anomalie.id, ligne: anomalie.excel_row, type: anomalie.anomaly_type });
          }
          return { tranchees: faites.length, detail: faites };
        });
        res.json({ success: true, ...out });
      } catch (e) { echec(res, e, "Erreur de résolution groupée."); }
    });

  /* ──────────────────────────── la hiérarchie décrite par le classeur ── */

  /** Ce que la création d'emplacements produirait, sans rien écrire. */
  router.post("/stock/import-em2s/locations/preview", authenticateToken, peutLire,
    upload.single("file"), async (req, res) => {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      const client = await pool.connect();
      try {
        const { buffer, nom } = fichierDe(req);
        const lecture = P.lireClasseur(buffer, { nomFichier: nom });
        const analyse = await E.analyser(client, {
          companyId, lecture,
          entrepotParDefaut: String(req.body?.entrepot || "A").trim().toUpperCase(),
        });
        res.json({ success: true, fichier: lecture.fichier, emplacements: analyse });
      } catch (e) { echec(res, e, "Erreur d'analyse des emplacements."); }
      finally { client.release(); }
    });

  /**
   * Crée les emplacements manquants. Ni suppression, ni renommage, ni
   * archivage : un identifiant d'emplacement est cité par des balances, des
   * mouvements et des étiquettes collées sur des racks.
   */
  router.post("/stock/import-em2s/locations", authenticateToken, peutEcrire,
    upload.single("file"), async (req, res) => {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      try {
        const { buffer, nom } = fichierDe(req);
        const attendue = String(req.body?.sha256 || "").trim().toLowerCase();

        const out = await transaction(async (client) => {
          const lecture = P.lireClasseur(buffer, { nomFichier: nom });
          if (attendue && attendue !== lecture.fichier.sha256) {
            const e = new Error("Le fichier a changé depuis la prévisualisation.");
            e.httpStatus = 409; e.code = "FILE_CHANGED"; throw e;
          }

          const avant = await client.query(
            `SELECT (SELECT COALESCE(SUM(quantity),0)::numeric FROM stock_location_balances
                      WHERE company_id = $1) AS stock,
                    (SELECT count(*)::int FROM stock_movements WHERE company_id = $1) AS mouvements`,
            [companyId]);

          const analyse = await E.analyser(client, {
            companyId, lecture,
            entrepotParDefaut: String(req.body?.entrepot || "A").trim().toUpperCase(),
          });
          const rapport = await E.creer(client, { companyId, analyse, utilisateur: utilisateurDe(req) });

          const apres = await client.query(
            `SELECT (SELECT COALESCE(SUM(quantity),0)::numeric FROM stock_location_balances
                      WHERE company_id = $1) AS stock,
                    (SELECT count(*)::int FROM stock_movements WHERE company_id = $1) AS mouvements`,
            [companyId]);

          /* Créer un contenant ne place aucune marchandise dedans. Si le stock
             ou les mouvements ont bougé, c'est un défaut de notre côté : on
             annule plutôt que de le constater après coup. */
          if (Number(avant.rows[0].stock) !== Number(apres.rows[0].stock)
              || avant.rows[0].mouvements !== apres.rows[0].mouvements) {
            const e = new Error("La création d'emplacements a touché au stock : annulation.");
            e.httpStatus = 500; e.code = "STOCK_TOUCHED"; throw e;
          }

          return { rapport, resume: {
            total: analyse.total, existants: analyse.existants, aCreer: analyse.aCreer,
            ambigus: analyse.ambigus, invalides: analyse.invalides,
            structure: analyse.structure,
          }, stock: Number(apres.rows[0].stock), mouvements: apres.rows[0].mouvements };
        });

        res.status(201).json({ success: true, ...out });
      } catch (e) { echec(res, e, "Erreur de création des emplacements."); }
    });

  /* ─────────────────────────────────── créer les produits manquants ── */

  /**
   * Étape distincte, et volontairement : créer un produit engage le
   * catalogue. On ne le fait pas en passant, au milieu d'un import de
   * réceptions, sans que personne ait regardé la liste.
   */
  router.post("/stock/import-em2s/products", authenticateToken, peutEcrire,
    upload.single("file"), async (req, res) => {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      try {
        const { buffer, nom } = fichierDe(req);
        const attendue = String(req.body?.sha256 || "").trim().toLowerCase();

        const out = await transaction(async (client) => {
          const apercu = await D.previsualiser(client, { companyId, buffer, nomFichier: nom });
          if (attendue && attendue !== apercu.fichier.sha256) {
            const e = new Error("Le fichier a changé depuis la prévisualisation.");
            e.httpStatus = 409; e.code = "FILE_CHANGED"; throw e;
          }
          const { rows: lots } = await client.query(
            `SELECT id FROM stock_import_batches
              WHERE company_id = $1 AND file_sha256 = $2 AND status <> 'CANCELLED'
              ORDER BY id DESC LIMIT 1`,
            [companyId, apercu.fichier.sha256]);
          if (!lots[0]) {
            const e = new Error("Ce fichier n'a pas encore été importé.");
            e.httpStatus = 409; e.code = "BATCH_REQUIRED"; throw e;
          }
          return D.creerProduitsManquants(client, {
            companyId, batchId: lots[0].id, sha: apercu.fichier.sha256,
            apercu, utilisateur: utilisateurDe(req),
          });
        });
        res.status(201).json({ success: true, ...out });
      } catch (e) { echec(res, e, "Erreur de création des produits."); }
    });

  /* ─────────────────────────── écrire les mouvements enfin exploitables ── */

  /**
   * La seule route de tout l'import qui touche au stock. Elle vient après que
   * tout a été tranché : une ligne encore bloquée n'écrit rien.
   */
  router.post("/stock/import-em2s/movements", authenticateToken, peutEcrire,
    upload.single("file"), async (req, res) => {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      try {
        const { buffer, nom } = fichierDe(req);
        const attendue = String(req.body?.sha256 || "").trim().toLowerCase();
        const simulation = String(req.body?.simulation || "") === "1";

        const out = await transaction(async (client) => {
          const apercu = await D.previsualiser(client, { companyId, buffer, nomFichier: nom });
          if (attendue && attendue !== apercu.fichier.sha256) {
            const e = new Error("Le fichier a changé depuis la prévisualisation.");
            e.httpStatus = 409; e.code = "FILE_CHANGED"; throw e;
          }

          const { rows: lots } = await client.query(
            `SELECT id FROM stock_import_batches
              WHERE company_id = $1 AND file_sha256 = $2 AND status <> 'CANCELLED'
              ORDER BY id DESC LIMIT 1`,
            [companyId, apercu.fichier.sha256]
          );
          if (!lots[0]) {
            const e = new Error("Ce fichier n'a pas encore été importé : lancez d'abord l'import des réceptions.");
            e.httpStatus = 409; e.code = "BATCH_REQUIRED"; throw e;
          }

          const avant = await client.query(
            `SELECT COALESCE(SUM(quantity),0)::numeric AS stock FROM stock_location_balances
              WHERE company_id = $1`, [companyId]);

          const rapport = await M.ecrireMouvements(client, {
            companyId, batchId: lots[0].id, sha: apercu.fichier.sha256,
            apercu, utilisateur: utilisateurDe(req),
          });

          const apres = await client.query(
            `SELECT COALESCE(SUM(quantity),0)::numeric AS stock FROM stock_location_balances
              WHERE company_id = $1`, [companyId]);

          const reconciliation = await M.reconcilier(client, { companyId, apercu });

          /* Une simulation lit tout, écrit tout, puis annule : c'est la seule
             façon de montrer le résultat exact sans le subir. */
          if (simulation) {
            const e = new Error("SIMULATION");
            e.simulation = { rapport, reconciliation,
              stockAvant: Number(avant.rows[0].stock), stockApres: Number(apres.rows[0].stock) };
            throw e;
          }

          return { batchId: lots[0].id, rapport, reconciliation,
                   stockAvant: Number(avant.rows[0].stock),
                   stockApres: Number(apres.rows[0].stock) };
        }).catch((e) => {
          if (e.simulation) return { simulation: true, ...e.simulation };
          throw e;
        });

        res.status(out.simulation ? 200 : 201).json({ success: true, ...out });
      } catch (e) { echec(res, e, "Erreur d'écriture des mouvements."); }
    });

  /* ───────────────────────────────────────────────── réconciliation ── */

  router.post("/stock/import-em2s/reconciliation", authenticateToken, peutVoir,
    upload.single("file"), async (req, res) => {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      const client = await pool.connect();
      try {
        const { buffer, nom } = fichierDe(req);
        const apercu = await D.previsualiser(client, { companyId, buffer, nomFichier: nom });
        const reconciliation = await M.reconcilier(client, { companyId, apercu });
        res.json({ success: true, fichier: apercu.fichier, reconciliation });
      } catch (e) { echec(res, e, "Erreur de réconciliation."); }
      finally { client.release(); }
    });

  /* ──────────────────────── corriger la date d'un bon déjà imprimé ── */

  /**
   * Avant impression, corriger une date est une correction de saisie. Après,
   * c'est autre chose : le bon est parti quelque part, et l'écart doit
   * pouvoir s'expliquer. D'où le motif obligatoire, la révision, et
   * l'ancienne valeur conservée.
   */
  router.patch("/stock/receptions/:id/dates", authenticateToken,
    requirePermission("reception", "update"), async (req, res) => {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      try {
        const out = await transaction(async (client) => {
          const { rows } = await client.query(
            `SELECT * FROM stock_receptions WHERE id = $1 AND company_id = $2 FOR UPDATE`,
            [Number(req.params.id), companyId]
          );
          const rec = rows[0];
          if (!rec) { const e = new Error("Réception introuvable."); e.httpStatus = 404; e.code = "NOT_FOUND"; throw e; }

          const nouvelle = String(req.body?.document_datetime || "").trim();
          if (!nouvelle) {
            const e = new Error("Indiquez la date métier du bon.");
            e.httpStatus = 400; e.code = "DATE_REQUIRED"; throw e;
          }
          const instant = new Date(nouvelle);
          if (Number.isNaN(instant.getTime())) {
            const e = new Error("Date illisible."); e.httpStatus = 400; e.code = "DATE_INVALID"; throw e;
          }

          const dejaImprime = Number(rec.print_count || 0) > 0;
          const motif = String(req.body?.reason || "").trim();

          if (dejaImprime) {
            if (!motif) {
              const e = new Error("Ce bon a déjà été imprimé : un motif est obligatoire pour corriger sa date.");
              e.httpStatus = 400; e.code = "REASON_REQUIRED"; throw e;
            }
            const ctx = await permissionsService.chargerContexte(pool, req.user);
            const verdict = permissionsService.decider(ctx, "reception", "edit_date_after_print");
            if (!verdict.autorise) {
              const e = new Error("Corriger la date d'un bon déjà imprimé demande un droit distinct.");
              e.httpStatus = 403; e.code = "AFTER_PRINT_FORBIDDEN"; throw e;
            }
          }

          const revision = Number(rec.document_revision || 0) + 1;

          /* L'ancienne valeur est écrite AVANT la nouvelle : si quoi que ce
             soit échoue ensuite, la transaction annule les deux, et on ne se
             retrouve jamais avec une date changée sans trace. */
          await client.query(
            `INSERT INTO stock_reception_date_revisions
               (company_id, reception_id, revision, field, old_value, new_value,
                reason, after_print, changed_by, changed_by_name)
             VALUES ($1,$2,$3,'document_datetime',$4,$5,$6,$7,$8,$9)`,
            [companyId, rec.id, revision, rec.document_datetime, instant,
             motif || null, dejaImprime, req.user?.id || null,
             req.user?.fullname || req.user?.email || null]
          );

          const { rows: apres } = await client.query(
            `UPDATE stock_receptions
                SET document_datetime = $1, operation_effective_at = $1,
                    document_revision = $2, updated_at = now()
              WHERE id = $3
              RETURNING id, reception_number, document_datetime, created_at,
                        document_revision, print_count, printed_at`,
            [instant, revision, rec.id]
          );

          /* `created_at` n'est jamais touché : il dit quand la ligne est née
             dans la base, et cette vérité-là ne se corrige pas. */
          return { reception: apres[0], revision, apresImpression: dejaImprime,
                   ancienneValeur: rec.document_datetime };
        });
        res.json({ success: true, ...out });
      } catch (e) { echec(res, e, "Erreur de correction de date."); }
    });

  router.get("/stock/receptions/:id/date-revisions", authenticateToken, peutVoir,
    async (req, res) => {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      try {
        const { rows } = await pool.query(
          `SELECT * FROM stock_reception_date_revisions
            WHERE reception_id = $1 AND company_id = $2 ORDER BY revision`,
          [Number(req.params.id), companyId]
        );
        res.json({ success: true, revisions: rows });
      } catch (e) { echec(res, e, "Erreur de lecture des révisions."); }
    });

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
        const ctx = await permissionsService.chargerContexte(pool, req.user);
        const verdict = permissionsService.decider(ctx, "reception", "reprint");
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
