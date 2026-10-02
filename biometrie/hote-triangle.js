"use strict";

/**
 * ADAPTATEUR TRIANGLE WMS du noyau biométrique.
 *
 * Ce que Triangle décide pour le noyau :
 *   • les droits : traduits en couples module|action du centre des droits
 *     (`services/permissions.js`, migration 104) ; sans ligne explicite, seuls
 *     les rôles d'administration ont accès ;
 *   • le sujet : une FICHE EMPLOYÉ (`attendance_employees`) active de LA
 *     société — jamais un compte. Un employé rattaché à un compte
 *     (`attendance_employees.user_id`) est « soi » pour ce compte ;
 *   • le badge : le badge QR v2 (`attendance_badges.qr_token`, jeton
 *     aléatoire), actif, de LA société ;
 *   • le pointage : le moteur v2 (`services/attendance-workforce.js`) avec
 *     les MÊMES garde-fous que le scan QR : verrou de l'employé, périmètre
 *     d'opérateur, anti-rebond, ordre des étapes, jour travaillé, périodes et
 *     paie alimentées par la même table.
 */

const { BiometrieError } = require("./core/erreurs");

const CARTE_DROITS = {
  "biometrie.voir": ["biometrie", "view"],
  "biometrie.enroler": ["biometrie", "enroll"],
  "biometrie.verifier": ["biometrie", "verify"],
  "biometrie.revoquer": ["biometrie", "revoke"],
  "biometrie.audit": ["biometrie", "audit"],
  "biometrie.appareils": ["biometrie", "devices"],
  "biometrie.parametres": ["biometrie", "configure"],
  "pointage.biometrie": ["pointage.biometrie", "scan"],
};

/* Le noyau parle la langue des terminaux (checkin…) ; le moteur v2, celle
   de ses colonnes. Sans action, l'étape suivante est déduite de la journée. */
const ACTIONS = {
  checkin: "CHECK_IN", pause_start: "BREAK_OUT", pause_end: "BREAK_IN", checkout: "CHECK_OUT",
  check_in: "CHECK_IN", break_out: "BREAK_OUT", break_in: "BREAK_IN", check_out: "CHECK_OUT",
};
const LIBELLES = {
  CHECK_IN: "Arrivée", BREAK_OUT: "Début de pause", BREAK_IN: "Retour de pause", CHECK_OUT: "Fin de journée",
};

/* Deux vérifications du même employé à quelques secondes d'écart sont une
   seule intention : même fenêtre que le scan QR. */
const ANTI_REBOND_SECONDES = 20;

function jetonBadge(valeur) {
  const brut = String(valeur || "").trim();
  try {
    const objet = JSON.parse(brut);
    if (objet && typeof objet === "object") return String(objet.qr_token || objet.badge_token || "").trim().slice(0, 160);
  } catch { /* texte brut : c'est le cas normal, le QR v2 ne porte que le jeton */ }
  return brut.slice(0, 160);
}

function actionV2(action) {
  if (action === undefined || action === null || action === "" || String(action).toLowerCase() === "auto") return null;
  const brut = String(action).trim();
  const v2 = ACTIONS[brut.toLowerCase()] || brut.toUpperCase();
  if (!LIBELLES[v2]) throw new BiometrieError("Action de pointage invalide.", "ACTION_INVALIDE", 400);
  return v2;
}

module.exports = function creerHoteTriangle(d) {
  const { pool, authenticateToken, getEffectiveCompanyIdStrict, isSuperAdminUser, permissionsService,
    attendance: A, finaliserConnexionParId, logAudit } = d;

  const societe = (req) => Number(getEffectiveCompanyIdStrict(req, req.user?.company_id) || 0) || null;

  async function employe(db, companyId, employeeId) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) throw new BiometrieError("Employé invalide.", "SUJET_INVALIDE", 400);
    const { rows } = await (db || pool).query(
      `SELECT id, full_name, user_id, site_id, active, employee_number, job_title
         FROM attendance_employees WHERE id = $1 AND company_id = $2`,
      [id, Number(companyId)]);
    return rows[0] || null;
  }

  const sujetDe = (e) => ({
    type: "employee", userId: null, employeeId: e.id, compteId: e.user_id || null,
    nom: e.full_name, siteId: e.site_id || null,
  });

  async function verifierPersonnel(db, companyId, sujet) {
    if (!sujet || sujet.type !== "employee") {
      throw new BiometrieError("Triangle : la biométrie vise une fiche employé.", "SUJET_INVALIDE", 400);
    }
    const e = await employe(db, companyId, sujet.employeeId);
    // Même réponse pour un employé d'une autre société que pour un employé inexistant.
    if (!e) throw new BiometrieError("Employé introuvable dans cette entreprise.", "PERSONNE_INTROUVABLE", 404);
    if (!e.active) throw new BiometrieError("Employé inactif.", "PERSONNE_INACTIVE", 403);
    return sujetDe(e);
  }

  /** La fiche employé rattachée à un compte, dans la société active. */
  async function ficheDuCompte(companyId, userId) {
    const { rows } = await pool.query(
      `SELECT id, full_name, user_id, site_id, active FROM attendance_employees
        WHERE company_id = $1 AND user_id = $2 AND active = true ORDER BY id LIMIT 1`,
      [Number(companyId), Number(userId)]);
    return rows[0] || null;
  }

  async function autoriser(req, permission) {
    if (isSuperAdminUser(req.user)) return true;
    const cible = CARTE_DROITS[permission];
    if (!cible) return false;
    const companyId = societe(req);
    if (!companyId) return false;
    /* Un contexte par requête : /biometrics/config interroge huit droits. */
    if (!req._contexteDroitsBiometrie || req._contexteDroitsBiometrie.companyId !== companyId) {
      req._contexteDroitsBiometrie = await permissionsService.chargerContexte(pool, req.user, companyId);
    }
    return permissionsService.decider(req._contexteDroitsBiometrie, cible[0], cible[1]).autorise === true;
  }

  async function fournisseurDe(db, o) {
    const profilId = Number(o.metadata?.biometric_profile_id || 0);
    if (profilId) {
      const { rows } = await db.query(`SELECT provider FROM biometric_profiles WHERE id = $1 AND company_id = $2`,
        [profilId, o.companyId]);
      if (rows[0]) return rows[0].provider;
    }
    if (o.deviceId) {
      const { rows } = await db.query(`SELECT provider FROM biometric_devices WHERE id = $1 AND company_id = $2`,
        [o.deviceId, o.companyId]);
      if (rows[0]) return rows[0].provider;
    }
    return null;
  }

  const ficheCourte = (r) => (r ? {
    work_date: r.work_date, status: r.status, check_in: r.check_in, break_out: r.break_out,
    break_in: r.break_in, check_out: r.check_out, late_minutes: r.late_minutes,
  } : null);

  /**
   * Pointage biométrique : exactement le chemin du scan QR, avec la preuve
   * biométrique à la place du badge.
   */
  async function enregistrerPointage(o) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      /* Verrou de l'employé (FOR UPDATE) : QR, manuel et biométrie
         s'attendent les uns les autres pour un même employé. */
      const emp = await A.chargerEmployePourPointage(client, o.companyId, o.sujet.employeeId);
      if (!emp) throw new BiometrieError("Employé introuvable ou inactif.", "EMPLOYEE_NOT_FOUND", 404);

      /* Un appareil rattaché à un site ne pointe que les employés de ce site. */
      if (o.siteId && emp.site_id && Number(o.siteId) !== Number(emp.site_id)) {
        throw new BiometrieError("Cet appareil n'est pas sur le site de cet employé.", "APPAREIL_HORS_SITE", 403);
      }

      let operateur = null;
      if (o.createdBy) {
        const { rows } = await client.query(
          `SELECT id, fullname, email, role, company_id, is_super_admin FROM users WHERE id = $1`, [o.createdBy]);
        operateur = rows[0] || null;
        /* Même règle que le QR : le droit ouvre l'écran, le périmètre
           d'opérateur décide de QUI l'on peut pointer. */
        if (!operateur || !(await A.canPunchEmployee(client, o.companyId, operateur, emp))) {
          throw new BiometrieError("Vous ne pouvez pas pointer cet employé.", "ATTENDANCE_SCOPE_DENIED", 403);
        }
      }

      const personne = { id: emp.id, nom: emp.full_name, matricule: emp.employee_number, poste: emp.job_title };

      const { rows: recentes } = await client.query(
        `SELECT action_type FROM attendance_event_log_v2
          WHERE company_id = $1 AND employee_id = $2
            AND created_at > now() - ($3 || ' seconds')::interval
          ORDER BY created_at DESC LIMIT 1`,
        [o.companyId, emp.id, String(ANTI_REBOND_SECONDES)]);
      if (recentes[0]) {
        const { rows: jour } = await client.query(
          `SELECT * FROM attendance_day_records_v2 WHERE company_id = $1 AND employee_id = $2 AND work_date = $3`,
          [o.companyId, emp.id, emp.local_date]);
        await client.query("COMMIT");
        return { statut: "deja_enregistre", repetition: true, action: recentes[0].action_type,
          libelle: LIBELLES[recentes[0].action_type], personne, fiche: ficheCourte(jour[0]) };
      }

      const { rows: dejaLa } = await client.query(
        `SELECT * FROM attendance_day_records_v2 WHERE company_id = $1 AND employee_id = $2 AND work_date = $3`,
        [o.companyId, emp.id, emp.local_date]);
      const etape = actionV2(o.action) || A.prochaineEtape(dejaLa[0]);
      if (!etape) throw new BiometrieError("La journée de cet employé est déjà complète.", "ATTENDANCE_DAY_COMPLETE", 409);

      const jour = await A.chargerJourTravaille(client, emp.schedule_id, emp.local_date);
      const resultat = await A.enregistrerPointage(client, {
        companyId: o.companyId, employee: emp, day: jour, action: etape, user: operateur,
        source: o.methode === "EMPREINTE" ? "EMPREINTE" : "VISAGE",
        deviceId: o.deviceId || null,
        biometricScore: o.confidence ?? null,
        biometricProvider: await fournisseurDe(client, o),
        challengeId: Number(o.metadata?.challenge_id || 0) || null,
        metadata: {
          biometric_profile_id: o.metadata?.biometric_profile_id || null,
          biometric_event_id: o.metadata?.biometric_event_id || null,
        },
      });
      await client.query("COMMIT");
      return { statut: "enregistre", action: resultat.action, libelle: LIBELLES[resultat.action],
        retard_minutes: resultat.late, personne, fiche: ficheCourte(resultat.record) };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e instanceof BiometrieError) throw e;
      if (e.httpStatus) throw new BiometrieError(e.message, e.code, e.httpStatus);
      throw e;
    } finally {
      client.release();
    }
  }

  return {
    pool,
    authenticateToken,
    societe,
    tenant: () => "triangle",
    estSuperAdmin: (req) => isSuperAdminUser(req.user),
    autoriser,

    /**
     * Le sujet visé par une requête. Par défaut : la fiche employé du compte
     * connecté. Sinon l'employé désigné (`employee_id`), ou la fiche d'un
     * compte désigné (`user_id`). Le compte rattaché est toujours lu en base.
     */
    async sujetDeLaRequete(req, source) {
      const companyId = societe(req);
      if (!companyId) throw new BiometrieError("Choisissez d'abord une entreprise.", "SOCIETE_REQUISE", 400);
      const employeeId = source.employee_id || source.employeeId;
      if (employeeId) {
        const e = await employe(pool, companyId, employeeId);
        if (!e) throw new BiometrieError("Employé introuvable dans cette entreprise.", "PERSONNE_INTROUVABLE", 404);
        return sujetDe(e);
      }
      const compte = Number(source.user_id || source.userId || req.user.id);
      if (!Number.isInteger(compte) || compte <= 0) throw new BiometrieError("Personne invalide.", "SUJET_INVALIDE", 400);
      const e = await ficheDuCompte(companyId, compte);
      if (!e) {
        throw new BiometrieError(
          compte === Number(req.user.id)
            ? "Aucune fiche employé n'est rattachée à votre compte dans cette entreprise."
            : "Aucune fiche employé n'est rattachée à ce compte dans cette entreprise.",
          "SANS_FICHE_EMPLOYE", 404);
      }
      return sujetDe(e);
    },

    /** Badge QR v2 (jeton aléatoire) → employé actif de LA société. */
    async sujetDepuisBadge(companyId, badge) {
      const jeton = jetonBadge(badge);
      if (jeton.length < 8) return null;
      const { rows } = await pool.query(
        `SELECT e.id, e.full_name, e.user_id, e.site_id, e.active
           FROM attendance_badges b JOIN attendance_employees e ON e.id = b.employee_id AND e.company_id = b.company_id
          WHERE b.qr_token = $1 AND b.company_id = $2 AND b.status = 'ACTIF' AND e.active = true
          LIMIT 1`,
        [jeton, Number(companyId)]);
      return rows[0] ? sujetDe(rows[0]) : null;
    },

    async compteDuSujet(companyId, sujet) {
      if (!sujet || sujet.type !== "employee") return null;
      const e = await employe(pool, companyId, sujet.employeeId).catch(() => null);
      return e?.user_id || null;
    },

    verifierPersonnel,

    async listerPersonnel(companyId) {
      const { rows } = await pool.query(
        `SELECT id, full_name, job_title, user_id FROM attendance_employees
          WHERE company_id = $1 AND active = true ORDER BY full_name LIMIT 1000`, [companyId]);
      return rows.map((e) => ({ type: "employee", userId: null, employeeId: e.id, nom: e.full_name, role: e.job_title || "" }));
    },

    async nomsSujets(companyId, sujets) {
      const ids = [...new Set(sujets.filter((s) => s.type === "employee" && s.employeeId).map((s) => Number(s.employeeId)))];
      if (!ids.length) return new Map();
      const { rows } = await pool.query(
        `SELECT id, full_name FROM attendance_employees WHERE company_id = $1 AND id = ANY($2)`, [companyId, ids]);
      return new Map(rows.map((e) => [`employee:${e.id}`, e.full_name]));
    },

    enregistrerPointage,

    async utilisateurCourant(req) {
      const { rows } = await pool.query(`SELECT id, email, fullname, company_id FROM users WHERE id = $1`, [req.user.id]);
      if (!rows[0]) throw new BiometrieError("Compte introuvable.", "COMPTE_INTROUVABLE", 404);
      return rows[0];
    },

    finaliserConnexion: (req, res, userId, methode) => finaliserConnexionParId(req, res, userId, methode),

    async journalAudit(req, action, details) {
      try {
        await logAudit(req, action, "biometrie", req.user?.id || null, details || {});
      } catch (e) {
        console.error("audit biométrie :", e.message);
      }
    },
  };
};
