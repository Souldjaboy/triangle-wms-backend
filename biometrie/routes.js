"use strict";

/**
 * ROUTES BIOMÉTRIQUES ET PASSKEYS — communes aux trois systèmes.
 *
 * Chaque route passe par : authentification, société (et tenant) imposées par
 * l'hôte, droit vérifié par le moteur de droits de l'hôte, journal. Aucune
 * réponse ne contient de gabarit, d'image ou de secret (sauf le secret d'un
 * appareil, montré UNE fois à sa déclaration).
 *
 * Permissions (noms communs, traduits par chaque hôte dans son moteur) :
 *   biometrie.voir · biometrie.enroler · biometrie.verifier · biometrie.revoquer
 *   biometrie.audit · biometrie.appareils · biometrie.parametres · pointage.biometrie
 *
 *   GET  /biometrics/config                 état, fournisseurs, texte de consentement
 *   GET  /biometrics/settings               PUT /biometrics/settings
 *   GET  /biometrics/status                 (soi, ou biometrie.voir)
 *   GET  /biometrics/profiles               GET /biometrics/events   GET /biometrics/people
 *   POST /biometrics/consents               POST /biometrics/consents/:id/withdraw
 *   POST /biometrics/challenges
 *   POST /biometrics/enroll-face            POST /biometrics/verify-face
 *   POST /biometrics/enroll-fingerprint     POST /biometrics/verify-fingerprint
 *   POST /biometrics/identify               POST /biometrics/revoke
 *   POST /biometrics/profiles/:id/status    POST /biometrics/attendance
 *   GET|POST /biometrics/devices            POST /biometrics/devices/:id/(status|secret)
 *   POST /biometrics/devices/events         (terminal / agent — signature HMAC, sans session)
 *   POST /biometrics/purge
 *
 *   POST /auth/passkeys/register/options|verify   GET /auth/passkeys
 *   PATCH|DELETE /auth/passkeys/:id
 *   POST /auth/passkeys/login/options|verify      (sans session, limité)
 *   POST /auth/step-up/options|verify             validation renforcée 5 min
 */

const express = require("express");
const { BiometrieError } = require("./core/erreurs");
const registre = require("./providers/registre");
const coffre = require("./crypto/coffre");

const PERMISSIONS = [
  "biometrie.voir", "biometrie.enroler", "biometrie.verifier", "biometrie.revoquer",
  "biometrie.audit", "biometrie.appareils", "biometrie.parametres", "pointage.biometrie",
];

function creerRouteurBiometrie({ hote, service, passkeys, limiteur, env = process.env }) {
  const router = express.Router();
  const auth = hote.authenticateToken;
  const limite = limiteur || ((req, res, next) => next());

  const repondreErreur = (res, e, contexte) => {
    if (e instanceof BiometrieError) {
      return res.status(e.httpStatus).json({ error: e.message, code: e.code, ...(e.details ? { details: e.details } : {}) });
    }
    console.error(`biometrie ${contexte} :`, e.message);
    return res.status(500).json({ error: "Erreur interne de la biométrie.", code: "ERREUR_INTERNE" });
  };

  const ctx = (req) => {
    const companyId = Number(hote.societe(req) || 0);
    if (!companyId) throw new BiometrieError("Choisissez d'abord une entreprise.", "SOCIETE_REQUISE", 400);
    return { companyId, tenantId: hote.tenant(req), par: req.user.id, ip: req.ip };
  };

  const exiger = async (req, permission) => {
    if (await hote.autoriser(req, permission)) return;
    throw new BiometrieError(`Droit requis : ${permission}.`, "PERMISSION_REFUSEE", 403);
  };

  /** Le sujet visé ; par défaut, soi-même. */
  const sujetDe = (req, source) => hote.sujetDeLaRequete(req, source || {});
  /* « Soi » : le compte connecté EST la personne visée. Pour un sujet
     « employé » (fiche sans compte propre, Triangle), l'hôte indique le compte
     rattaché dans `compteId`, lu dans SA base — jamais dans la requête. */
  const estSoi = (req, sujet) => {
    if (!sujet) return false;
    const compte = sujet.type === "user" ? sujet.userId : sujet.compteId;
    return Number(compte || 0) > 0 && Number(compte) === Number(req.user.id);
  };

  /** Même question pour une ligne déjà enregistrée (consentement, profil). */
  async function ligneEstSoi(req, companyId, ligne) {
    if (ligne.subject_type === "user") return Number(ligne.user_id) === Number(req.user.id);
    if (typeof hote.compteDuSujet !== "function") return false;
    const compte = await hote.compteDuSujet(companyId,
      { type: ligne.subject_type, userId: ligne.user_id, employeeId: ligne.employee_id });
    return Number(compte || 0) > 0 && Number(compte) === Number(req.user.id);
  }

  /** Validation renforcée : exigée si la société l'impose ou si l'utilisateur a une passkey. */
  async function controlerStepUp(req, scope) {
    if (hote.estSuperAdmin(req) && !(await passkeys.aDesPasskeys(req.user.id))) return;
    if (await passkeys.stepUpValide(req.user.id, req.headers["x-step-up-token"], scope)) return;
    const companyId = Number(hote.societe(req) || 0);
    const imposee = companyId ? (await service.reglages(companyId)).stepup_required : false;
    if (imposee || (await passkeys.aDesPasskeys(req.user.id))) {
      throw new BiometrieError(
        "Validation renforcée requise : confirmez avec votre passkey (Face ID, Touch ID, Windows Hello…).",
        "STEP_UP_REQUIS", 403, { scope });
    }
  }

  const exigerStepUp = (scope) => async (req, res, next) => {
    try {
      await controlerStepUp(req, scope);
      return next();
    } catch (e) {
      return repondreErreur(res, e, "step-up");
    }
  };

  // ══════════════════════════════════════════════════════════ LECTURE

  router.get("/biometrics/config", auth, async (req, res) => {
    try {
      const c = ctx(req);
      const r = await service.reglages(c.companyId);
      const droits = {};
      for (const p of PERMISSIONS) droits[p] = await hote.autoriser(req, p);
      let passkeysActives = true;
      try {
        passkeys.configuration();
      } catch {
        passkeysActives = false;
      }
      res.json({
        modalites: { face: r.face_enabled, fingerprint: r.fingerprint_enabled },
        fournisseurs: registre.catalogue(env),
        reglages: droits["biometrie.voir"] || droits["biometrie.parametres"] ? r : undefined,
        auto_enrolement: r.self_enrollment,
        chiffrement_configure: coffre.disponible(env),
        passkeys_configurees: passkeysActives,
        consentement: service.texteConsentement(r.consent_text_version),
        droits,
        alternative: "Le badge QR et le pointage manuel restent toujours disponibles.",
      });
    } catch (e) {
      repondreErreur(res, e, "config");
    }
  });

  router.get("/biometrics/settings", auth, async (req, res) => {
    try {
      const c = ctx(req);
      if (!(await hote.autoriser(req, "biometrie.voir")) && !(await hote.autoriser(req, "biometrie.parametres"))) {
        throw new BiometrieError("Droit requis : biometrie.voir.", "PERMISSION_REFUSEE", 403);
      }
      res.json({ reglages: await service.reglages(c.companyId) });
    } catch (e) {
      repondreErreur(res, e, "settings");
    }
  });

  router.put("/biometrics/settings", auth, exigerStepUp("biometrie.parametres"), async (req, res) => {
    try {
      const c = ctx(req);
      await exiger(req, "biometrie.parametres");
      res.json({ reglages: await service.majReglages(c.companyId, c.tenantId, req.body || {}, c.par, c.ip) });
    } catch (e) {
      repondreErreur(res, e, "settings maj");
    }
  });

  router.get("/biometrics/status", auth, async (req, res) => {
    try {
      const c = ctx(req);
      const sujet = await sujetDe(req, req.query);
      if (!estSoi(req, sujet)) await exiger(req, "biometrie.voir");
      res.json(await service.statut(c.companyId, sujet));
    } catch (e) {
      repondreErreur(res, e, "status");
    }
  });

  router.get("/biometrics/profiles", auth, async (req, res) => {
    try {
      const c = ctx(req);
      await exiger(req, "biometrie.voir");
      res.json({ profils: await service.listerProfils(c.companyId, { statut: req.query.status || null }) });
    } catch (e) {
      repondreErreur(res, e, "profiles");
    }
  });

  router.get("/biometrics/people", auth, async (req, res) => {
    try {
      const c = ctx(req);
      await exiger(req, "biometrie.voir");
      res.json({ personnes: await service.personnes(c.companyId) });
    } catch (e) {
      repondreErreur(res, e, "people");
    }
  });

  router.get("/biometrics/events", auth, async (req, res) => {
    try {
      const c = ctx(req);
      await exiger(req, "biometrie.audit");
      res.json({ evenements: await service.evenements(c.companyId, {
        limite: req.query.limit, action: req.query.action || null, resultat: req.query.result || null }) });
    } catch (e) {
      repondreErreur(res, e, "events");
    }
  });

  // ═══════════════════════════════════════════════════════ CONSENTEMENTS

  router.post("/biometrics/consents", auth, async (req, res) => {
    try {
      const c = ctx(req);
      const b = req.body || {};
      const sujet = await sujetDe(req, b.subject || {});
      const methode = String(b.method || "ecran");
      if (!estSoi(req, sujet)) {
        // Pour autrui : seulement un formulaire PAPIER signé, référencé.
        await exiger(req, "biometrie.enroler");
        if (methode !== "papier") {
          throw new BiometrieError("Le consentement d'une autre personne s'enregistre depuis son formulaire signé (papier).",
            "CONSENTEMENT_PERSONNEL", 403);
        }
      } else if (methode !== "ecran") {
        throw new BiometrieError("Votre propre consentement se donne à l'écran.", "CONSENTEMENT_INVALIDE", 400);
      }
      if (b.accepte !== true) {
        throw new BiometrieError("Le texte de consentement doit être accepté explicitement.", "CONSENTEMENT_NON_ACCEPTE", 400);
      }
      const consent = await service.donnerConsentement({ ...c, sujet, modalites: b.modalities, finalites: b.purposes,
        methode, referencePapier: b.paper_reference });
      res.status(201).json({ consentement: consent });
    } catch (e) {
      repondreErreur(res, e, "consents");
    }
  });

  router.post("/biometrics/consents/:id/withdraw", auth, async (req, res) => {
    try {
      const c = ctx(req);
      const { rows } = await hote.pool.query(
        `SELECT subject_type, user_id, employee_id FROM biometric_consents WHERE id = $1 AND company_id = $2`,
        [Number(req.params.id), c.companyId]);
      if (!rows[0]) throw new BiometrieError("Consentement introuvable.", "CONSENTEMENT_INTROUVABLE", 404);
      const soi = await ligneEstSoi(req, c.companyId, rows[0]);
      if (!soi) await exiger(req, "biometrie.revoquer");
      res.json(await service.retirerConsentement({ ...c, consentId: Number(req.params.id), motif: req.body?.reason }));
    } catch (e) {
      repondreErreur(res, e, "consents withdraw");
    }
  });

  // ══════════════════════════════════════════════════════════════ DÉFIS

  router.post("/biometrics/challenges", auth, limite, async (req, res) => {
    try {
      const c = ctx(req);
      const b = req.body || {};
      let sujet = null;
      if (b.badge) {
        sujet = await hote.sujetDepuisBadge(c.companyId, b.badge);
        if (!sujet) throw new BiometrieError("Badge inconnu ou non valable pour cette entreprise.", "BADGE_INCONNU", 404);
      } else if (b.purpose !== "identification") {
        sujet = await sujetDe(req, b.subject || {});
      }
      if (!sujet || !estSoi(req, sujet)) {
        const ok = (await hote.autoriser(req, "biometrie.verifier")) || (await hote.autoriser(req, "pointage.biometrie"));
        if (!ok) throw new BiometrieError("Droit requis : biometrie.verifier.", "PERMISSION_REFUSEE", 403);
      }
      const r = await service.reglages(c.companyId);
      let appareilId = null;
      if (b.device_id || r.require_known_device) {
        const a = await service.authentifierAppareil(c.companyId, b.device_id, b.device_key);
        if (!a) throw new BiometrieError("Appareil inconnu, désactivé ou non autorisé.", "APPAREIL_INCONNU", 403);
        appareilId = a.id;
      }
      const defi = await service.creerDefi({ ...c, demandePar: c.par, sujet, deviceId: appareilId,
        type: b.biometric_type, finalite: b.purpose, action: b.action });
      res.status(201).json({ ...defi, subject: sujet ? { type: sujet.type, user_id: sujet.userId || null,
        employee_id: sujet.employeeId || null } : null });
    } catch (e) {
      repondreErreur(res, e, "challenges");
    }
  });

  // ══════════════════════════════════════════════════════════ ENRÔLEMENT

  async function routeEnrolement(req, res, type) {
    try {
      const c = ctx(req);
      const b = req.body || {};
      const sujet = await sujetDe(req, b.subject || {});
      const r = await service.reglages(c.companyId);
      if (!(estSoi(req, sujet) && type === "face" && r.self_enrollment)) await exiger(req, "biometrie.enroler");
      const profil = await service.enroler({ ...c, sujet, type, capture: b.capture, doigt: b.finger_index,
        deviceId: b.device_id, cleAppareil: b.device_key, referenceExterne: b.external_reference,
        renouveler: b.replace === true });
      res.status(201).json({ profil });
    } catch (e) {
      repondreErreur(res, e, `enroll ${type}`);
    }
  }

  router.post("/biometrics/enroll-face", auth, limite, (req, res) => routeEnrolement(req, res, "face"));
  router.post("/biometrics/enroll-fingerprint", auth, limite, (req, res) => routeEnrolement(req, res, "fingerprint"));

  // ════════════════════════════════════════════════════════ VÉRIFICATION

  async function routeVerification(req, res, type) {
    try {
      const c = ctx(req);
      const b = req.body || {};
      const sujet = await sujetDe(req, b.subject || {});
      const finalite = String(b.purpose || "controle_acces");
      if (!estSoi(req, sujet)) await exiger(req, "biometrie.verifier");
      const resultat = await service.verifier({ ...c, sujet, type, capture: b.capture, doigt: b.finger_index,
        defi: b.challenge, deviceId: b.device_id, cleAppareil: b.device_key, finalite });
      let stepUp;
      if (resultat.verifie && finalite === "action_sensible" && estSoi(req, sujet)) {
        stepUp = await passkeys.accorderStepUp({ userId: req.user.id, companyId: c.companyId,
          methode: type === "face" ? "visage" : "empreinte", scope: String(b.scope || "") });
      }
      res.status(resultat.verifie ? 200 : 401).json({
        verified: resultat.verifie, confidence: resultat.score, threshold: resultat.seuil,
        profile_id: resultat.profile_id, ...(stepUp ? { step_up: stepUp } : {}),
        ...(resultat.verifie ? {} : { code: "NON_CORRESPONDANT", error: "Identité non confirmée." }),
      });
    } catch (e) {
      repondreErreur(res, e, `verify ${type}`);
    }
  }

  router.post("/biometrics/verify-face", auth, limite, (req, res) => routeVerification(req, res, "face"));
  router.post("/biometrics/verify-fingerprint", auth, limite, (req, res) => routeVerification(req, res, "fingerprint"));

  router.post("/biometrics/identify", auth, limite, async (req, res) => {
    try {
      const c = ctx(req);
      const b = req.body || {};
      await exiger(req, "biometrie.verifier");
      const r = await service.identifier({ ...c, type: b.biometric_type, capture: b.capture, defi: b.challenge,
        deviceId: b.device_id, cleAppareil: b.device_key });
      if (!r.identifie) return res.status(404).json({ identified: false, code: "NON_IDENTIFIE", error: "Personne non identifiée." });
      res.json({ identified: true, confidence: r.score,
        subject: { type: r.sujet.type, user_id: r.sujet.userId || null, employee_id: r.sujet.employeeId || null } });
    } catch (e) {
      repondreErreur(res, e, "identify");
    }
  });

  // ════════════════════════════════════════════════════════ RÉVOCATION

  router.post("/biometrics/revoke", auth, async (req, res) => {
    try {
      const c = ctx(req);
      const profil = await service.profilDe(c.companyId, req.body?.profile_id);
      if (!profil) throw new BiometrieError("Profil introuvable.", "PROFIL_INTROUVABLE", 404);
      const soi = await ligneEstSoi(req, c.companyId, profil);
      if (!soi) {
        await exiger(req, "biometrie.revoquer");
        await controlerStepUp(req, "biometrie.revoquer");
      }
      res.json({ profil: await service.changerStatut({ ...c, profileId: profil.id, statut: "revoque",
        motif: req.body?.reason || (soi ? "revocation_personnelle" : "revocation_administrateur") }) });
    } catch (e) {
      repondreErreur(res, e, "revoke");
    }
  });

  router.post("/biometrics/profiles/:id/status", auth, async (req, res) => {
    try {
      const c = ctx(req);
      await exiger(req, "biometrie.revoquer");
      const statut = String(req.body?.status || "");
      if (!["actif", "inactif"].includes(statut)) {
        throw new BiometrieError("Statut attendu : actif ou inactif (la révocation passe par /biometrics/revoke).",
          "STATUT_INVALIDE", 400);
      }
      res.json({ profil: await service.changerStatut({ ...c, profileId: req.params.id, statut, motif: req.body?.reason }) });
    } catch (e) {
      repondreErreur(res, e, "profile status");
    }
  });

  // ══════════════════════════════════════════════════ POINTAGE BIOMÉTRIQUE

  /**
   * Mode recommandé : badge QR (qui désigne la personne) + vérification 1:1
   * du visage ou de l'empreinte, sur un appareil déclaré, avec un défi.
   */
  router.post("/biometrics/attendance", auth, limite, async (req, res) => {
    try {
      const c = ctx(req);
      const b = req.body || {};
      const type = String(b.biometric_type || "face");
      let sujet;
      if (b.badge) {
        sujet = await hote.sujetDepuisBadge(c.companyId, b.badge);
        if (!sujet) throw new BiometrieError("Badge inconnu ou non valable pour cette entreprise.", "BADGE_INCONNU", 404);
      } else {
        sujet = await sujetDe(req, b.subject || {});
      }
      if (!estSoi(req, sujet)) await exiger(req, "pointage.biometrie");
      const v = await service.verifier({ ...c, sujet, type, capture: b.capture, doigt: b.finger_index,
        defi: b.challenge, deviceId: b.device_id, cleAppareil: b.device_key, finalite: "pointage" });
      if (!v.verifie) {
        return res.status(401).json({ error: "Identité non confirmée : pointage refusé. Utilisez le badge ou le pointage manuel.",
          code: "NON_CORRESPONDANT", confidence: v.score, threshold: v.seuil });
      }
      const pointage = await hote.enregistrerPointage({
        companyId: c.companyId, tenantId: c.tenantId, sujet: v.sujet, action: b.action,
        methode: type === "face" ? "VISAGE" : "EMPREINTE", deviceId: v.appareil?.id || null,
        siteId: v.appareil?.site_id || null, confidence: v.score, createdBy: req.user.id,
        metadata: { biometric_profile_id: v.profile_id, challenge_id: v.defi_id },
      });
      res.json({ success: true, statut: pointage.statut, action: pointage.libelle || pointage.action,
        confidence: v.score, employee: pointage.personne || null, attendance: pointage.fiche || null });
    } catch (e) {
      repondreErreur(res, e, "attendance");
    }
  });

  // ═══════════════════════════════════════════════════════════ APPAREILS

  router.get("/biometrics/devices", auth, async (req, res) => {
    try {
      const c = ctx(req);
      await exiger(req, "biometrie.appareils");
      res.json({ appareils: await service.listerAppareils(c.companyId) });
    } catch (e) {
      repondreErreur(res, e, "devices");
    }
  });

  router.post("/biometrics/devices", auth, async (req, res) => {
    try {
      const c = ctx(req);
      await exiger(req, "biometrie.appareils");
      const b = req.body || {};
      const r = await service.enregistrerAppareil({ ...c, siteId: b.site_id, nom: b.name, type: b.device_type,
        serial: b.serial, fournisseur: b.provider });
      res.status(201).json({ ...r, avertissement: "Notez ce secret maintenant : il ne sera plus jamais affiché." });
    } catch (e) {
      repondreErreur(res, e, "devices create");
    }
  });

  router.post("/biometrics/devices/:id/status", auth, async (req, res) => {
    try {
      const c = ctx(req);
      await exiger(req, "biometrie.appareils");
      res.json({ appareil: await service.activerAppareil({ ...c, deviceId: Number(req.params.id), actif: req.body?.enabled === true }) });
    } catch (e) {
      repondreErreur(res, e, "devices status");
    }
  });

  router.post("/biometrics/devices/:id/secret", auth, exigerStepUp("biometrie.appareils"), async (req, res) => {
    try {
      const c = ctx(req);
      await exiger(req, "biometrie.appareils");
      res.json({ ...(await service.regenererSecret({ ...c, deviceId: Number(req.params.id) })),
        avertissement: "Notez ce secret maintenant : il ne sera plus jamais affiché." });
    } catch (e) {
      repondreErreur(res, e, "devices secret");
    }
  });

  /* Terminal ou agent local : pas de session, une signature HMAC du corps
     brut. Le corps brut est capturé par l'hôte (req.rawBody). */
  router.post("/biometrics/devices/events", limite, async (req, res) => {
    try {
      const appareil = await service.authentifierRequeteAppareil({
        deviceId: req.headers["x-biometric-device"],
        horodatage: req.headers["x-biometric-timestamp"],
        signature: req.headers["x-biometric-signature"],
        corpsBrut: req.rawBody,
      });
      const resultats = await service.traiterEvenementsAppareil(appareil, req.body?.events, req.ip);
      res.json({ resultats });
    } catch (e) {
      repondreErreur(res, e, "device events");
    }
  });

  router.post("/biometrics/purge", auth, async (req, res) => {
    try {
      const c = ctx(req);
      await exiger(req, "biometrie.parametres");
      res.json(await service.purger(c.companyId));
    } catch (e) {
      repondreErreur(res, e, "purge");
    }
  });

  // ════════════════════════════════════════════════════════════ PASSKEYS

  router.post("/auth/passkeys/register/options", auth, async (req, res) => {
    try {
      const u = await hote.utilisateurCourant(req);
      res.json(await passkeys.optionsEnregistrement(u, hote.tenant(req)));
    } catch (e) {
      repondreErreur(res, e, "passkey register options");
    }
  });

  router.post("/auth/passkeys/register/verify", auth, async (req, res) => {
    try {
      const u = await hote.utilisateurCourant(req);
      const p = await passkeys.verifierEnregistrement(u, req.body?.response, req.body?.name,
        { companyId: u.company_id, tenantId: hote.tenant(req) });
      await hote.journalAudit(req, "passkey_ajoutee", { passkey_id: p.id });
      res.status(201).json({ passkey: p });
    } catch (e) {
      repondreErreur(res, e, "passkey register verify");
    }
  });

  router.get("/auth/passkeys", auth, async (req, res) => {
    try {
      res.json({ passkeys: await passkeys.lister(req.user.id) });
    } catch (e) {
      repondreErreur(res, e, "passkeys");
    }
  });

  router.patch("/auth/passkeys/:id", auth, async (req, res) => {
    try {
      res.json({ passkey: await passkeys.renommer(req.user.id, req.params.id, req.body?.name) });
    } catch (e) {
      repondreErreur(res, e, "passkey rename");
    }
  });

  router.delete("/auth/passkeys/:id", auth, async (req, res) => {
    try {
      const r = await passkeys.supprimer(req.user.id, req.params.id);
      await hote.journalAudit(req, "passkey_supprimee", { passkey_id: Number(req.params.id) });
      res.json(r);
    } catch (e) {
      repondreErreur(res, e, "passkey delete");
    }
  });

  router.post("/auth/passkeys/login/options", limite, async (req, res) => {
    try {
      res.json(await passkeys.optionsAuthentification({ purpose: "connexion", tenantId: hote.tenant(req) }));
    } catch (e) {
      repondreErreur(res, e, "passkey login options");
    }
  });

  router.post("/auth/passkeys/login/verify", limite, async (req, res) => {
    try {
      const passkey = await passkeys.verifierAuthentification(req.body?.response, { purpose: "connexion" });
      // L'hôte applique EXACTEMENT les mêmes contrôles qu'une connexion par mot de passe.
      await hote.finaliserConnexion(req, res, passkey.user_id, "passkey");
    } catch (e) {
      repondreErreur(res, e, "passkey login verify");
    }
  });

  router.post("/auth/step-up/options", auth, async (req, res) => {
    try {
      res.json(await passkeys.optionsAuthentification({ purpose: "step_up", userId: req.user.id,
        tenantId: hote.tenant(req), scope: String(req.body?.scope || "") }));
    } catch (e) {
      repondreErreur(res, e, "step-up options");
    }
  });

  router.post("/auth/step-up/verify", auth, async (req, res) => {
    try {
      const scope = String(req.body?.scope || "");
      await passkeys.verifierAuthentification(req.body?.response, { purpose: "step_up", userId: req.user.id, scope });
      const grant = await passkeys.accorderStepUp({ userId: req.user.id, companyId: hote.societe(req) || null,
        methode: "passkey", scope });
      await hote.journalAudit(req, "step_up", { scope, method: "passkey" });
      res.json(grant);
    } catch (e) {
      repondreErreur(res, e, "step-up verify");
    }
  });

  return { router, exigerStepUp, controlerStepUp };
}

module.exports = { creerRouteurBiometrie, PERMISSIONS };
