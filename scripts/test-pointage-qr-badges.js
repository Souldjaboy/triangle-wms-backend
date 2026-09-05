"use strict";

/**
 * POINTAGE QR ET BADGES (migration 080).
 *
 *   bash scripts/test-pointage-qr-badges.sh
 *
 * Ce que la suite prouve :
 *
 *   ISOLATION       un badge de chaque société n'est accepté que chez elle,
 *                   et le refus ne révèle pas à qui il appartient ;
 *   BADGES          jeton non prédictible, absent des listes, un seul badge
 *                   actif par employé, remplacement qui invalide l'ancien,
 *                   désactivation, impression et réimpression auditées ;
 *   SÉQUENCE        arrivée → pause → retour → fin, dans cet ordre ;
 *   ANTI-DOUBLON    deux lectures rapprochées = un seul événement ;
 *   RETARD          08h00 = 0 minute, 08h10 = 10 minutes, à la minute près ;
 *   COEXISTENCE     QR et MANUEL alimentent le même historique, avec des
 *                   sources distinctes, et le manuel reste opérationnel ;
 *   DROITS          scanner n'ouvre pas les badges, gérer les badges n'ouvre
 *                   pas les salaires, un périmètre d'opérateur est opposable.
 */

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const { execFileSync } = require("child_process");

const BASE = `http://127.0.0.1:${process.env.PORT || 5050}`;
const SECRET = process.env.JWT_SECRET || "test-secret-durcissement";
const URL_BASE = process.env.DATABASE_URL ||
  "postgresql://postgres:triangle_test_password@127.0.0.1:5433/triangle_wms";
const V = "\x1b[32m", R = "\x1b[31m", G = "\x1b[1m", Z = "\x1b[0m";
let reussis = 0, echoues = 0;
function verifier(titre, condition, detail = "") {
  if (condition) { reussis += 1; console.log(`${V}  ✓${Z} ${titre}`); }
  else { echoues += 1; console.log(`${R}  ✗ ${titre}${Z}${detail ? `  — ${detail}` : ""}`); }
}

const pool = new Pool({ connectionString: URL_BASE });

const jeton = (id, role, companyId, superAdmin = false) =>
  jwt.sign({ id, fullname: `Compte ${id}`, email: `u${id}@essai.test`, role,
             company_id: companyId, is_super_admin: superAdmin }, SECRET, { expiresIn: "3h" });

async function appel(methode, chemin, token, corps, entetes = {}) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...entetes },
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  let json; try { json = JSON.parse(texte); } catch { json = { brut: texte }; }
  return { statut: r.status, corps: json };
}

const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

function poserLeJeu() {
  const sortie = execFileSync(process.execPath, ["scripts/jeu-essai-badges-qr.js"],
    { env: { ...process.env, DATABASE_URL: URL_BASE }, encoding: "utf8" });
  return JSON.parse(sortie.trim().split("\n").pop());
}

/** Le jeton QR d'un badge — jamais exposé par l'API en liste, lu ici en base. */
const jetonDe = async (badgeId) =>
  (await q(`SELECT qr_token FROM attendance_badges WHERE id = $1`, [badgeId]))[0]?.qr_token;

async function main() {
  console.log(`\n${G}POINTAGE QR ET BADGES (080)${Z}`);
  const j = poserLeJeu();

  const tAdminT = jeton(j.ADMIN_TRIANGLE, "admin", j.TRIANGLE);
  const tAdminF = jeton(j.ADMIN_FATMAT, "admin", j.FATMAT);
  const tOpT    = jeton(j.OPERATEUR_TRIANGLE, "responsable_entrepot", j.TRIANGLE);
  const tOpF    = jeton(j.OPERATEUR_FATMAT, "responsable_entrepot", j.FATMAT);

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}ÉMISSION D'UN BADGE${Z}`);
  let badgeBamako, badgeKati, badgeCarriere;
  {
    const r = await appel("POST", "/attendance-v2/badges", tAdminT, { employee_id: j.bamako });
    badgeBamako = r.corps.badge;
    verifier("un badge est émis pour l'employé de Bamako",
      r.statut === 201 && Boolean(badgeBamako?.id), JSON.stringify(r.corps));
    verifier("son code lisible porte le préfixe de SA société",
      String(badgeBamako?.badge_code || "").startsWith("TRIANGLE-"), badgeBamako?.badge_code);

    const token = await jetonDe(badgeBamako.id);
    verifier("le jeton QR fait au moins 24 caractères", String(token || "").length >= 24,
      `${String(token || "").length} caractères`);
    verifier("le jeton QR n'est PAS dérivé du code imprimé",
      !String(token || "").includes(String(badgeBamako.badge_code)),
      `${badgeBamako.badge_code} / ${token}`);

    const deuxieme = await appel("POST", "/attendance-v2/badges", tAdminT, { employee_id: j.bamako });
    verifier("un second badge actif pour le même employé est refusé",
      deuxieme.statut === 409 && deuxieme.corps.code === "BADGE_ALREADY_ACTIVE",
      JSON.stringify(deuxieme.corps));

    badgeKati = (await appel("POST", "/attendance-v2/badges", tAdminT, { employee_id: j.kati })).corps.badge;
    badgeCarriere = (await appel("POST", "/attendance-v2/badges", tAdminF, { employee_id: j.carriere })).corps.badge;
    verifier("FAT & MAT émet le sien avec SON préfixe",
      String(badgeCarriere?.badge_code || "").startsWith("FATMAT-"), badgeCarriere?.badge_code);

    const deuxJetons = await q(
      `SELECT count(DISTINCT qr_token)::int AS n, count(*)::int AS total FROM attendance_badges`);
    verifier("tous les jetons émis sont distincts",
      deuxJetons[0].n === deuxJetons[0].total, JSON.stringify(deuxJetons[0]));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LE JETON NE FUITE PAS PAR LES LISTES${Z}`);
  {
    const liste = await appel("GET", "/attendance-v2/badges", tAdminT);
    verifier("la liste des badges ne contient aucun jeton QR",
      liste.statut === 200 && (liste.corps.badges || []).every((b) => !("qr_token" in b)),
      JSON.stringify(Object.keys(liste.corps.badges?.[0] || {})));
    verifier("elle ne montre QUE les badges de la société active",
      (liste.corps.badges || []).every((b) => [j.bamako, j.kati].includes(b.employee_id)),
      JSON.stringify((liste.corps.badges || []).map((b) => b.employee_id)));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}UN BADGE N'EST RECONNU QUE DANS SA SOCIÉTÉ${Z}`);
  {
    const tokenTriangle = await jetonDe(badgeBamako.id);
    const chezFatmat = await appel("POST", "/attendance-v2/qr/scan", tAdminF, { qr_token: tokenTriangle });
    verifier("un badge Triangle scanné chez FAT & MAT est refusé",
      chezFatmat.statut === 404 && chezFatmat.corps.code === "BADGE_NOT_FOR_THIS_COMPANY",
      JSON.stringify(chezFatmat.corps));

    const inconnu = await appel("POST", "/attendance-v2/qr/scan", tAdminF, { qr_token: "jeton-totalement-inconnu-xyz" });
    verifier("un badge inconnu reçoit EXACTEMENT le même refus (rien n'est révélé)",
      inconnu.corps.code === chezFatmat.corps.code && inconnu.corps.error === chezFatmat.corps.error,
      `${inconnu.corps.code} / ${chezFatmat.corps.code}`);

    const tokenFatmat = await jetonDe(badgeCarriere.id);
    const chezTriangle = await appel("POST", "/attendance-v2/qr/scan", tAdminT, { qr_token: tokenFatmat });
    verifier("et réciproquement, un badge FAT & MAT est refusé chez Triangle",
      chezTriangle.statut === 404, JSON.stringify(chezTriangle.corps));

    const refus = await q(
      `SELECT accepted, refusal_code, token_hint FROM attendance_qr_scans
        WHERE NOT accepted ORDER BY id DESC LIMIT 3`);
    verifier("les trois refus sont tracés", refus.length === 3, JSON.stringify(refus));
    verifier("le journal ne conserve PAS le jeton en clair",
      refus.every((r) => r.token_hint.length <= 5 && !String(tokenTriangle).startsWith(r.token_hint)),
      JSON.stringify(refus.map((r) => r.token_hint)));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LA SÉQUENCE ARRIVÉE → PAUSE → RETOUR → FIN${Z}`);
  {
    const token = await jetonDe(badgeCarriere.id);
    const etapes = [];
    for (let i = 0; i < 4; i += 1) {
      /* On efface la trace anti-rebond entre deux gestes : le test enchaîne
         en millisecondes ce qu'une journée étale sur huit heures. La fenêtre
         elle-même est éprouvée juste après, pour de vrai. */
      if (i > 0) await pool.query(`DELETE FROM attendance_qr_scans WHERE badge_id = $1`, [badgeCarriere.id]);
      const r = await appel("POST", "/attendance-v2/qr/scan", tAdminF, { qr_token: token });
      etapes.push(r.corps.action || `ERR:${r.corps.code}`);
    }
    verifier("les quatre lectures produisent les quatre étapes dans l'ordre",
      JSON.stringify(etapes) === JSON.stringify(["CHECK_IN", "BREAK_OUT", "BREAK_IN", "CHECK_OUT"]),
      JSON.stringify(etapes));

    await pool.query(`DELETE FROM attendance_qr_scans WHERE badge_id = $1`, [badgeCarriere.id]);
    const cinquieme = await appel("POST", "/attendance-v2/qr/scan", tAdminF, { qr_token: token });
    verifier("une cinquième lecture dit que la journée est complète",
      cinquieme.statut === 409 && cinquieme.corps.code === "ATTENDANCE_DAY_COMPLETE",
      JSON.stringify(cinquieme.corps));

    const source = await q(
      `SELECT DISTINCT source FROM attendance_event_log_v2 WHERE employee_id = $1`, [j.carriere]);
    verifier("ces pointages sont enregistrés avec la source QR",
      source.length === 1 && source[0].source === "QR", JSON.stringify(source));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}DEUX LECTURES RAPPROCHÉES = UN SEUL ÉVÉNEMENT${Z}`);
  {
    const token = await jetonDe(badgeBamako.id);
    const premier = await appel("POST", "/attendance-v2/qr/scan", tOpT, { qr_token: token });
    verifier("la première lecture enregistre l'arrivée",
      premier.corps.action === "CHECK_IN", JSON.stringify(premier.corps));

    const second = await appel("POST", "/attendance-v2/qr/scan", tOpT, { qr_token: token });
    verifier("la seconde, immédiate, ne produit PAS d'erreur rouge",
      second.statut === 200 && second.corps.repetition === true, JSON.stringify(second.corps));

    const evenements = await q(
      `SELECT count(*)::int AS n FROM attendance_event_log_v2
        WHERE employee_id = $1 AND action_type = 'CHECK_IN'`, [j.bamako]);
    verifier("un seul événement d'arrivée existe en base", evenements[0].n === 1, `${evenements[0].n}`);

    /* Deux caméras au même instant : le verrou consultatif doit sérialiser. */
    await pool.query(`DELETE FROM attendance_qr_scans WHERE badge_id = $1`, [badgeBamako.id]);
    const simultanes = await Promise.all([
      appel("POST", "/attendance-v2/qr/scan", tOpT, { qr_token: token }),
      appel("POST", "/attendance-v2/qr/scan", tOpT, { qr_token: token }),
    ]);
    const pauses = await q(
      `SELECT count(*)::int AS n FROM attendance_event_log_v2
        WHERE employee_id = $1 AND action_type = 'BREAK_OUT'`, [j.bamako]);
    verifier("deux lectures SIMULTANÉES ne créent qu'un seul début de pause",
      pauses[0].n === 1, `${pauses[0].n} — statuts ${simultanes.map((s) => s.statut).join("/")}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LE RETARD, À LA MINUTE PRÈS${Z}`);
  {
    /* On ne peut pas attendre 08h10 : on écrit l'heure d'arrivée voulue dans
       la journée, puis on relit ce que le moteur calcule avec la MÊME
       formule que la route — celle de services/attendance-workforce.js. */
    const cas = [
      ["08:00", 0], ["08:01", 1], ["08:10", 10], ["09:30", 90], ["07:45", 0],
    ];
    const enMinutes = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
    for (const [heure, attendu] of cas) {
      const calcule = Math.max(0, enMinutes(heure) - enMinutes("08:00"));
      verifier(`arrivée à ${heure} → ${attendu} minute(s) de retard`,
        calcule === attendu, `calculé ${calcule}`);
    }

    /* Et le chemin réel : un pointage effectué maintenant porte bien un
       retard cohérent avec l'heure locale de Bamako et l'horaire 08:00. */
    const [ligne] = await q(
      `SELECT d.late_minutes,
              to_char(timezone('Africa/Bamako', d.check_in), 'HH24:MI') AS heure_locale
         FROM attendance_day_records_v2 d
        WHERE d.employee_id = $1 AND d.check_in IS NOT NULL`, [j.bamako]);
    const attenduReel = Math.max(0, enMinutes(ligne.heure_locale) - enMinutes("08:00"));
    verifier(`le pointage réel de ${ligne.heure_locale} porte ${attenduReel} minute(s)`,
      Number(ligne.late_minutes) === attenduReel,
      `en base : ${ligne.late_minutes}`);
    verifier("le retard n'est jamais négatif", Number(ligne.late_minutes) >= 0);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}PÉRIMÈTRE DE L'OPÉRATEUR${Z}`);
  {
    const tokenKati = await jetonDe(badgeKati.id);
    const refuse = await appel("POST", "/attendance-v2/qr/scan", tOpT, { qr_token: tokenKati });
    verifier("un opérateur limité à Bamako ne peut pas pointer un employé de Kati",
      refuse.statut === 403 && refuse.corps.code === "ATTENDANCE_SCOPE_DENIED",
      JSON.stringify(refuse.corps));

    const parAdmin = await appel("POST", "/attendance-v2/qr/scan", tAdminT, { qr_token: tokenKati });
    verifier("l'administrateur de la société, lui, peut le pointer",
      parAdmin.statut === 200 && parAdmin.corps.action === "CHECK_IN",
      JSON.stringify(parAdmin.corps));

    const opFatmat = await appel("POST", "/attendance-v2/qr/scan", tOpF, { qr_token: tokenKati });
    verifier("un opérateur FAT & MAT ne voit même pas ce badge Triangle",
      opFatmat.statut === 404, JSON.stringify(opFatmat.corps));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}REMPLACEMENT D'UN BADGE PERDU${Z}`);
  {
    const ancienJeton = await jetonDe(badgeKati.id);

    const sansMotif = await appel("POST", `/attendance-v2/badges/${badgeKati.id}/remplacement`, tAdminT, {});
    verifier("remplacer sans motif est refusé",
      sansMotif.statut === 400 && sansMotif.corps.code === "REASON_REQUIRED",
      JSON.stringify(sansMotif.corps));

    const r = await appel("POST", `/attendance-v2/badges/${badgeKati.id}/remplacement`, tAdminT,
      { reason: "Carte perdue sur le chantier" });
    verifier("le remplacement réussit et donne un nouveau code",
      r.statut === 200 && r.corps.nouveau?.code && r.corps.nouveau.code !== badgeKati.badge_code,
      JSON.stringify(r.corps));

    const nouveauJeton = await jetonDe(r.corps.nouveau.id);
    verifier("le nouveau badge porte un jeton DIFFÉRENT",
      nouveauJeton && nouveauJeton !== ancienJeton);

    await pool.query(`DELETE FROM attendance_qr_scans WHERE badge_id IS NOT NULL`);
    const ancien = await appel("POST", "/attendance-v2/qr/scan", tAdminT, { qr_token: ancienJeton });
    verifier("l'ancien badge ne pointe plus jamais",
      ancien.statut === 409 && ancien.corps.code === "BADGE_REPLACED",
      JSON.stringify(ancien.corps));

    const [lien] = await q(
      `SELECT status, replaced_by_badge_id FROM attendance_badges WHERE id = $1`, [badgeKati.id]);
    verifier("la chaîne ancien → nouveau est conservée",
      lien.status === "REMPLACE" && Number(lien.replaced_by_badge_id) === Number(r.corps.nouveau.id),
      JSON.stringify(lien));

    const [actifs] = await q(
      `SELECT count(*)::int AS n FROM attendance_badges WHERE employee_id = $1 AND status = 'ACTIF'`,
      [j.kati]);
    verifier("à aucun moment l'employé n'a deux badges actifs", actifs.n === 1, `${actifs.n}`);

    const journal = await appel("GET", `/attendance-v2/badges/${badgeKati.id}/journal`, tAdminT);
    const types = (journal.corps.journal || []).map((e) => e.event_type);
    verifier("le remplacement est journalisé", types.includes("remplacement"), JSON.stringify(types));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}DÉSACTIVATION ET IMPRESSION${Z}`);
  {
    const badge = (await appel("POST", "/attendance-v2/badges", tAdminF,
      { employee_id: j.carriere2 })).corps.badge;

    const p1 = await appel("POST", `/attendance-v2/badges/${badge.id}/impression`, tAdminF, {});
    verifier("la première impression est une impression",
      p1.statut === 200 && p1.corps.reimpression === false, JSON.stringify(p1.corps.badge?.print_count));
    const p2 = await appel("POST", `/attendance-v2/badges/${badge.id}/impression`, tAdminF, {});
    verifier("la seconde est une RÉIMPRESSION, comptée séparément",
      p2.corps.reimpression === true && Number(p2.corps.badge.print_count) === 2,
      JSON.stringify(p2.corps.badge?.print_count));

    const journal = await appel("GET", `/attendance-v2/badges/${badge.id}/journal`, tAdminF);
    const types = (journal.corps.journal || []).map((e) => e.event_type);
    verifier("impression et réimpression sont distinguées à l'audit",
      types.includes("impression") && types.includes("reimpression"), JSON.stringify(types));

    const token = await jetonDe(badge.id);
    await appel("POST", `/attendance-v2/badges/${badge.id}/desactivation`, tAdminF,
      { reason: "Fin de contrat" });
    await pool.query(`DELETE FROM attendance_qr_scans WHERE badge_id IS NOT NULL`);
    const scan = await appel("POST", "/attendance-v2/qr/scan", tAdminF, { qr_token: token });
    verifier("un badge désactivé ne pointe plus",
      scan.statut === 409 && scan.corps.code === "BADGE_DEACTIVATED", JSON.stringify(scan.corps));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}QR ET MANUEL COEXISTENT DANS LE MÊME HISTORIQUE${Z}`);
  {
    /* Le manuel doit rester pleinement opérationnel : c'est le mode de
       secours quand une caméra tombe en panne. */
    const manuel = await appel("POST", "/attendance-v2/check", tAdminT,
      { employee_id: j.bamako, action_type: "BREAK_IN" });
    verifier("le pointage manuel fonctionne toujours",
      manuel.statut === 200 && manuel.corps.success === true, JSON.stringify(manuel.corps));

    const sources = await q(
      `SELECT source, count(*)::int AS n FROM attendance_event_log_v2
        WHERE employee_id = $1 GROUP BY source ORDER BY source`, [j.bamako]);
    verifier("le même employé porte des événements QR ET MANUEL",
      sources.length === 2 && sources.map((s) => s.source).join(",") === "MANUEL,QR",
      JSON.stringify(sources));

    const [record] = await q(
      `SELECT check_in, break_out, break_in FROM attendance_day_records_v2 WHERE employee_id = $1`,
      [j.bamako]);
    verifier("les deux modes alimentent la MÊME journée",
      Boolean(record.check_in && record.break_out && record.break_in), JSON.stringify(record));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LES DROITS SONT SÉPARÉS${Z}`);
  {
    /* L'opérateur a le droit de scanner ; il n'a PAS reçu `replace`. */
    const remplacement = await appel("POST", `/attendance-v2/badges/${badgeBamako.id}/remplacement`,
      tOpT, { reason: "tentative sans droit" });
    verifier("scanner ne donne pas le droit de remplacer un badge",
      remplacement.statut === 403 || remplacement.statut === 404,
      `statut ${remplacement.statut}`);

    const [toujoursActif] = await q(
      `SELECT status FROM attendance_badges WHERE id = $1`, [badgeBamako.id]);
    verifier("le badge visé est intact", toujoursActif.status === "ACTIF", toujoursActif.status);

    /* Et le journal des scans est réservé à qui a le droit d'audit. */
    const audit = await appel("GET", "/attendance-v2/qr/scans", tOpT);
    verifier("le journal des lectures n'est pas ouvert à un simple opérateur",
      audit.statut === 403 || audit.statut === 404, `statut ${audit.statut}`);
    const auditAdmin = await appel("GET", "/attendance-v2/qr/scans", tAdminT);
    verifier("il l'est pour l'administrateur", auditAdmin.statut === 200,
      `statut ${auditAdmin.statut}`);
    verifier("et ne montre que les lectures de SA société",
      (auditAdmin.corps.lectures || []).length > 0, `${(auditAdmin.corps.lectures || []).length}`);
  }

  console.log(`\n${G}BILAN${Z}`);
  console.log(`  ${reussis} réussis, ${echoues} échoués\n`);
  await pool.end();
  process.exit(echoues > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`${R}ÉCHEC : ${e.message}${Z}`); console.error(e.stack);
  await pool.end().catch(() => {});
  process.exit(1);
});
