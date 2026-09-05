"use strict";

/**
 * BADGES QR DE POINTAGE.
 *
 * Un badge porte deux identifiants, et la distinction est le cœur du module :
 *
 *   • `badge_code` — ce qui est IMPRIMÉ en clair sur la carte
 *     (TRIANGLE-EMP-007). Lisible, prévisible, sans valeur d'authentification.
 *   • `qr_token`   — ce que le QR ENCODE. Tiré au hasard, jamais dérivé du
 *     code ni d'une séquence. C'est lui, et lui seul, qui vaut pointage.
 *
 * L'ancien modèle confondait les deux : `users.badge_code` servait à la fois
 * d'étiquette et de clé de scan. Le badge suivant se devinait donc en
 * ajoutant 1, ce qui suffisait à pointer pour quelqu'un d'autre.
 *
 * Le QR ne contient QUE le jeton : ni nom, ni matricule, ni société, ni
 * identifiant d'employé. Une carte photographiée n'apprend rien à qui la
 * regarde, et le serveur reste seul à savoir ce qu'elle désigne.
 */

const crypto = require("crypto");
const companyContext = require("./company-context");

const LONGUEUR_JETON = 32;

/**
 * 24 octets aléatoires en base64url ≈ 32 caractères, ~192 bits.
 * `randomBytes` et non `Math.random` : ce jeton est un secret d'accès, pas
 * un identifiant de commodité.
 */
function genererJeton() {
  return crypto.randomBytes(24).toString("base64url").slice(0, LONGUEUR_JETON);
}

/**
 * De quoi rapprocher deux lectures dans un journal, sans pouvoir en rejouer
 * une. On garde les quatre derniers caractères : assez pour reconnaître,
 * trop peu pour reconstituer.
 */
function indiceJeton(jeton) {
  const t = String(jeton || "");
  return t.length <= 4 ? "" : `…${t.slice(-4)}`;
}

function erreur(message, code, httpStatus) {
  const e = new Error(message);
  e.code = code;
  e.httpStatus = httpStatus;
  return e;
}

/**
 * Le prochain code lisible de la société.
 *
 * Réutilise la séquence de `companies` — la même que celle des badges de
 * comptes (services/company-context.js) — pour qu'une société n'ait pas deux
 * numérotations concurrentes qui finiraient par se croiser. La ligne est
 * verrouillée le temps de l'opération : deux émissions simultanées obtiennent
 * deux numéros.
 */
async function prochainCodeLisible(client, companyId) {
  /* Une société sans préfixe verrait ses cartes porter « ENT2 », que
     personne ne rattache à FAT & MAT en le lisant. On le déduit du nom une
     seule fois puis on le garde — avec la MÊME règle que les badges de
     comptes (company-context.js), pour que les deux numérotations d'une
     société ne divergent jamais. */
  const { rows: avant } = await client.query(
    `SELECT name, badge_prefix FROM companies WHERE id = $1 FOR UPDATE`, [companyId]
  );
  if (!avant[0]) throw erreur("Société introuvable.", "COMPANY_NOT_FOUND", 404);
  if (!String(avant[0].badge_prefix || "").trim()) {
    await client.query(
      `UPDATE companies SET badge_prefix = $1 WHERE id = $2`,
      [companyContext.prefixeDepuisNom(avant[0].name, companyId), companyId]
    );
  }

  const { rows } = await client.query(
    `UPDATE companies
        SET badge_sequence = COALESCE(badge_sequence, 0) + 1
      WHERE id = $1
      RETURNING COALESCE(NULLIF(TRIM(badge_prefix), ''), 'ENT' || id) AS prefixe, badge_sequence`,
    [companyId]
  );
  return `${rows[0].prefixe}-EMP-${String(rows[0].badge_sequence).padStart(3, "0")}`;
}

async function journaliser(client, { companyId, badgeId, employeeId, type, reason, performedBy, performedByName }) {
  await client.query(
    `INSERT INTO attendance_badge_events
       (company_id, badge_id, employee_id, event_type, reason, performed_by, performed_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [companyId, badgeId, employeeId, type, String(reason || ""),
     performedBy || null, String(performedByName || "")]
  );
}

/**
 * Émet le badge d'un employé.
 *
 * Refuse si l'employé en a déjà un actif : c'est l'index partiel qui garantit
 * la règle, mais un message clair vaut mieux qu'une violation de contrainte.
 * Pour donner une nouvelle carte, on passe par `remplacer()` — qui invalide
 * l'ancienne au lieu de laisser deux cartes valides circuler.
 */
async function emettre(client, { companyId, employeeId, performedBy, performedByName, reason = "" }) {
  const { rows: employes } = await client.query(
    `SELECT id, company_id, full_name, active FROM attendance_employees
      WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [employeeId, companyId]
  );
  const employe = employes[0];
  if (!employe) throw erreur("Employé introuvable dans cette société.", "EMPLOYEE_NOT_FOUND", 404);
  if (!employe.active) throw erreur("Cet employé n'est plus actif.", "EMPLOYEE_INACTIVE", 409);

  const { rows: actifs } = await client.query(
    `SELECT id, badge_code FROM attendance_badges WHERE employee_id = $1 AND status = 'ACTIF'`,
    [employeeId]
  );
  if (actifs[0]) {
    throw erreur(
      `Cet employé porte déjà le badge ${actifs[0].badge_code}. Utilisez le remplacement pour lui en donner un autre.`,
      "BADGE_ALREADY_ACTIVE", 409
    );
  }

  const code = await prochainCodeLisible(client, companyId);
  const { rows } = await client.query(
    `INSERT INTO attendance_badges (company_id, employee_id, badge_code, qr_token, issued_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [companyId, employeeId, code, genererJeton(), performedBy || null]
  );
  const badge = rows[0];
  await journaliser(client, {
    companyId, badgeId: badge.id, employeeId, type: "emission",
    reason, performedBy, performedByName,
  });
  return badge;
}

/** Désactive un badge — perdu, volé, ou salarié parti. Il ne pointe plus. */
async function desactiver(client, { companyId, badgeId, reason, performedBy, performedByName }) {
  const { rows } = await client.query(
    `UPDATE attendance_badges
        SET status = 'DESACTIVE', deactivated_at = now(), deactivated_by = $1,
            deactivation_reason = $2, updated_at = now()
      WHERE id = $3 AND company_id = $4 AND status = 'ACTIF'
      RETURNING *`,
    [performedBy || null, String(reason || ""), badgeId, companyId]
  );
  if (!rows[0]) throw erreur("Aucun badge actif à désactiver.", "BADGE_NOT_ACTIVE", 404);
  await journaliser(client, {
    companyId, badgeId, employeeId: rows[0].employee_id, type: "desactivation",
    reason, performedBy, performedByName,
  });
  return rows[0];
}

/**
 * Remplace un badge : l'ancien devient REMPLACE, un nouveau jeton est émis,
 * et le lien entre les deux est conservé.
 *
 * En une seule transaction, et dans cet ordre : l'ancien cesse d'être actif
 * AVANT que le nouveau ne le devienne. L'index partiel « un seul badge actif
 * par employé » refuserait l'inverse — et c'est très bien ainsi : à aucun
 * instant deux cartes ne doivent valoir.
 */
async function remplacer(client, { companyId, badgeId, reason, performedBy, performedByName }) {
  const { rows: anciens } = await client.query(
    `SELECT * FROM attendance_badges WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [badgeId, companyId]
  );
  const ancien = anciens[0];
  if (!ancien) throw erreur("Badge introuvable dans cette société.", "BADGE_NOT_FOUND", 404);
  if (ancien.status !== "ACTIF") {
    throw erreur("Ce badge n'est plus actif : il n'y a rien à remplacer.", "BADGE_NOT_ACTIVE", 409);
  }

  await client.query(
    `UPDATE attendance_badges
        SET status = 'REMPLACE', deactivated_at = now(), deactivated_by = $1,
            deactivation_reason = $2, updated_at = now()
      WHERE id = $3`,
    [performedBy || null, String(reason || ""), badgeId]
  );

  const code = await prochainCodeLisible(client, companyId);
  const { rows: neufs } = await client.query(
    `INSERT INTO attendance_badges (company_id, employee_id, badge_code, qr_token, issued_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [companyId, ancien.employee_id, code, genererJeton(), performedBy || null]
  );
  const neuf = neufs[0];

  await client.query(
    `UPDATE attendance_badges SET replaced_by_badge_id = $1, updated_at = now() WHERE id = $2`,
    [neuf.id, badgeId]
  );

  await journaliser(client, {
    companyId, badgeId, employeeId: ancien.employee_id, type: "remplacement",
    reason: `${reason || ""} → nouveau badge ${neuf.badge_code}`.trim(),
    performedBy, performedByName,
  });
  await journaliser(client, {
    companyId, badgeId: neuf.id, employeeId: ancien.employee_id, type: "emission",
    reason: `Remplace ${ancien.badge_code}`, performedBy, performedByName,
  });

  return { ancien: { ...ancien, status: "REMPLACE", replaced_by_badge_id: neuf.id }, nouveau: neuf };
}

/** Compte une impression. La première est une émission papier, les suivantes des réimpressions. */
async function marquerImprime(client, { companyId, badgeId, performedBy, performedByName }) {
  const { rows } = await client.query(
    `UPDATE attendance_badges
        SET print_count = print_count + 1, last_printed_at = now(), updated_at = now()
      WHERE id = $1 AND company_id = $2
      RETURNING *`,
    [badgeId, companyId]
  );
  if (!rows[0]) throw erreur("Badge introuvable dans cette société.", "BADGE_NOT_FOUND", 404);
  await journaliser(client, {
    companyId, badgeId, employeeId: rows[0].employee_id,
    type: rows[0].print_count > 1 ? "reimpression" : "impression",
    reason: "", performedBy, performedByName,
  });
  return rows[0];
}

/**
 * RÉSOUDRE UN SCAN.
 *
 * Renvoie `{ badge, employe }` ou lève une erreur portant un code de refus.
 * L'ordre des contrôles est délibéré : on vérifie l'appartenance à la société
 * AVANT de dire quoi que ce soit de l'employé. Un badge Triangle scanné sur
 * un poste FAT & MAT doit être refusé sans révéler à qui il appartient.
 */
async function resoudreScan(client, { qrToken, companyId }) {
  const jeton = String(qrToken || "").trim();
  if (jeton.length < 8) throw erreur("Badge illisible.", "BADGE_TOKEN_INVALID", 400);

  const { rows } = await client.query(
    `SELECT b.*, e.full_name, e.site_id, e.schedule_id, e.active AS employee_active,
            e.employee_number, e.job_title, e.user_id
       FROM attendance_badges b
       JOIN attendance_employees e ON e.id = b.employee_id
      WHERE b.qr_token = $1`,
    [jeton]
  );
  const badge = rows[0];

  /* Badge inconnu et badge d'une autre société renvoient le MÊME message.
     Distinguer les deux apprendrait à un curieux que le badge existe
     ailleurs — et donc, en scannant sur les deux postes, à quelle société
     appartient chaque carte trouvée par terre. */
  if (!badge || Number(badge.company_id) !== Number(companyId)) {
    throw erreur("Ce badge n'est pas reconnu ici.", "BADGE_NOT_FOR_THIS_COMPANY", 404);
  }
  if (badge.status === "REMPLACE") {
    throw erreur("Ce badge a été remplacé : utilisez la nouvelle carte.", "BADGE_REPLACED", 409);
  }
  if (badge.status !== "ACTIF") {
    throw erreur("Ce badge est désactivé.", "BADGE_DEACTIVATED", 409);
  }
  if (!badge.employee_active) {
    throw erreur("Cet employé n'est plus actif.", "EMPLOYEE_INACTIVE", 409);
  }

  return {
    badge,
    employe: {
      id: badge.employee_id, full_name: badge.full_name, site_id: badge.site_id,
      schedule_id: badge.schedule_id, employee_number: badge.employee_number,
      job_title: badge.job_title, user_id: badge.user_id,
    },
  };
}

/** Trace toute lecture, acceptée ou non. Un refus non tracé est un refus qu'on ne saura pas expliquer. */
async function tracerScan(clientOuPool, {
  companyId, badgeId, employeeId, actionType, accepted, refusalCode,
  qrToken, scannedBy, scannedByName, siteId,
}) {
  await clientOuPool.query(
    `INSERT INTO attendance_qr_scans
       (company_id, badge_id, employee_id, action_type, accepted, refusal_code,
        token_hint, scanned_by, scanned_by_name, site_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [companyId || null, badgeId || null, employeeId || null, actionType || null,
     Boolean(accepted), String(refusalCode || ""), indiceJeton(qrToken),
     scannedBy || null, String(scannedByName || ""), siteId || null]
  );
}

module.exports = {
  LONGUEUR_JETON, genererJeton, indiceJeton, erreur,
  prochainCodeLisible, emettre, desactiver, remplacer, marquerImprime,
  resoudreScan, tracerScan, journaliser,
};
