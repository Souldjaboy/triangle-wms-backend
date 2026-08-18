"use strict";

/**
 * VÉRIFICATION DE LA REPRISE DES DROITS HISTORIQUES.
 *
 * La migration 063 transpose `user_permissions` en exceptions. Compter les
 * cellules d'un côté et les lignes de l'autre ne prouve rien : cinq colonnes
 * sur quarante-sept lignes font deux cent trente-cinq combinaisons, dont
 * beaucoup ne correspondent à aucune action applicable — « valider » sur un
 * module qui ne valide rien n'a pas à exister.
 *
 * On reconstruit donc la correspondance exacte, la même que celle de la
 * migration, et l'on compare ensemble attendu et ensemble réel. Toute cible
 * attendue et absente est nommée.
 *
 *   DATABASE_URL=… node scripts/verifier-reprise-permissions.js [--user=23] [--company=1]
 */

const { Pool } = require("pg");
const service = require("../services/permissions");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const arg = (nom, defaut) => {
  const t = process.argv.find((a) => a.startsWith(`--${nom}=`));
  return t ? t.split("=")[1] : defaut;
};

/* Colonnes historiques → actions du nouveau référentiel.
   `visible` suit `can_view` : un module qu'on avait le droit de consulter doit
   rester visible, sinon la reprise le ferait disparaître des menus. */
const COLONNES = [
  ["visible", "can_view"],
  ["view", "can_view"],
  ["create", "can_create"],
  ["update", "can_edit"],
  ["delete", "can_delete"],
  ["validate", "can_validate"],
];

async function main() {
  const companyId = Number(arg("company", 1));
  const cibleUser = Number(arg("user", 0));

  const { rows: modules } = await pool.query(
    `SELECT module_key, parent_key, actions FROM permission_modules`
  );
  const parCle = new Map(modules.map((m) => [m.module_key, m]));
  const enfantsDe = (k) => modules.filter((m) => m.parent_key === k);

  const { rows: legacy } = await pool.query(
    `SELECT up.user_id, u.fullname, u.role,
            COALESCE(u.is_super_admin,false) OR lower(trim(COALESCE(u.role,''))) = 'super_admin' AS est_super,
            up.module_key, up.can_view, up.can_create, up.can_edit, up.can_delete, up.can_validate
       FROM user_permissions up
       JOIN users u ON u.id = up.user_id
      WHERE u.company_id = $1 AND ($2::int = 0 OR up.user_id = $2::int)
      ORDER BY up.user_id, up.module_key`,
    [companyId, cibleUser]
  );

  /* Ce que le journal montre d'une décision prise APRÈS la reprise : le
     module sert précisément à modifier les droits, et un administrateur qui
     retire volontairement un accès ne doit pas faire échouer le déploiement
     suivant. Seul un droit ABSENT reste une anomalie. */
  const { rows: retouches } = await pool.query(
    `SELECT DISTINCT target_user_id AS user_id, module_key, action
       FROM permission_audit_log
      WHERE company_id = $1 AND origin <> 'migration'
        AND ($2::int = 0 OR target_user_id = $2::int)`,
    [companyId, cibleUser]
  );
  const modifieDepuis = new Set(
    retouches.map((r) => `${r.user_id}|${r.module_key}|${r.action}`)
  );

  const { rows: reels } = await pool.query(
    `SELECT user_id, module_key, action, effect FROM user_permission_overrides
      WHERE company_id = $1 AND ($2::int = 0 OR user_id = $2::int)`,
    [companyId, cibleUser]
  );
  const existant = new Map();
  reels.forEach((o) => existant.set(`${o.user_id}|${o.module_key}|${o.action}`, o.effect));

  /* Où ce droit doit-il atterrir ?
     Sur le module lui-même s'il connaît l'action ; sinon sur ceux de ses
     enfants qui la connaissent. L'ancien modèle était plat : « créer sur
     stocks » désignait la création de mouvements, que le nouveau répartit
     entre entrées, sorties, transferts, inventaires et emplacements. */
  function portee(cleModule, action) {
    const m = parCle.get(cleModule);
    if (!m) return [];
    if (m.actions.includes(action)) return [cleModule];
    return enfantsDe(cleModule).filter((e) => e.actions.includes(action)).map((e) => e.module_key);
  }

  const attendus = new Map(); // user|module|action -> Set d'effets attendus
  const inapplicables = [];
  const inconnus = new Set();

  for (const l of legacy) {
    const mappe = service.normaliser(l.module_key);
    if (!parCle.has(mappe)) { inconnus.add(`${l.module_key} → ${mappe}`); continue; }

    for (const [action, colonne] of COLONNES) {
      const valeur = l[colonne];
      if (valeur === null || valeur === undefined) continue;
      const cibles = portee(mappe, action);
      if (!cibles.length) {
        inapplicables.push(`${l.module_key}.${action} (aucun module ni sous-module ne déclare « ${action} »)`);
        continue;
      }
      /* §7.3 de la migration retire les DENY d'un super admin : un refus posé
         sur lui l'empêcherait de se rendre ses propres droits. */
      if (l.est_super && valeur === false) continue;

      for (const cible of cibles) {
        const k = `${l.user_id}|${cible}|${action}`;
        if (!attendus.has(k)) attendus.set(k, new Set());
        attendus.get(k).add(valeur ? "ALLOW" : "DENY");
      }
    }
  }

  const manquants = [];
  const divergents = [];
  const volontaires = [];
  for (const [k, effets] of attendus.entries()) {
    const [uid, module, action] = k.split("|");
    const reel = existant.get(k);
    if (!reel) { manquants.push({ uid, module, action, attendu: [...effets].join("|") }); continue; }
    /* Deux lignes historiques peuvent viser la même case avec des valeurs
       opposées ; la migration garde la première. On n'exige donc l'égalité
       que lorsque l'attente est sans ambiguïté. */
    if (effets.size === 1 && !effets.has(reel)) {
      const entry = { uid, module, action, attendu: [...effets][0], reel };
      if (modifieDepuis.has(k)) volontaires.push(entry);
      else divergents.push(entry);
    }
  }

  const parUtilisateur = new Map();
  legacy.forEach((l) => {
    if (!parUtilisateur.has(l.user_id)) {
      parUtilisateur.set(l.user_id, { nom: l.fullname, role: l.role, lignes: 0 });
    }
    parUtilisateur.get(l.user_id).lignes += 1;
  });

  console.log("\nCOUVERTURE DE LA REPRISE");
  for (const [uid, info] of parUtilisateur.entries()) {
    const att = [...attendus.keys()].filter((k) => k.startsWith(`${uid}|`)).length;
    const obt = att - manquants.filter((m) => Number(m.uid) === uid).length;
    const mods = new Set(
      [...attendus.keys()].filter((k) => k.startsWith(`${uid}|`)).map((k) => k.split("|")[1])
    ).size;
    const total = reels.filter((o) => o.user_id === uid).length;
    console.log(
      `  #${uid} ${info.nom} (${info.role}) : ${info.lignes} ligne(s) historique(s) → ` +
      `${obt}/${att} droit(s) attendu(s) repris sur ${mods} module(s), ${total} exception(s) au total`
    );
  }

  if (inconnus.size) {
    console.log("\nCLÉS HISTORIQUES SANS ÉQUIVALENT AU CATALOGUE (ignorées, non bloquantes)");
    [...inconnus].forEach((c) => console.log(`  ${c}`));
  }
  if (inapplicables.length) {
    const uniques = [...new Set(inapplicables)];
    console.log(`\nCOUPLES NON APPLICABLES (${uniques.length}) — normal, aucune route ne les utilise`);
    uniques.slice(0, 12).forEach((c) => console.log(`  ${c}`));
    if (uniques.length > 12) console.log(`  … et ${uniques.length - 12} autre(s)`);
  }

  if (manquants.length) {
    console.log(`\nDROITS ATTENDUS ET NON REPRIS (${manquants.length})`);
    manquants.forEach((m) => console.log(`  #${m.uid} ${m.module} / ${m.action} → ${m.attendu} ABSENT`));
  }
  if (volontaires.length) {
    console.log(`\nMODIFIÉS DEPUIS LA REPRISE (${volontaires.length}) — décisions d'administrateur, non bloquantes`);
    volontaires.slice(0, 10).forEach((d) =>
      console.log(`  #${d.uid} ${d.module} / ${d.action} : repris ${d.attendu}, aujourd'hui ${d.reel}`));
    if (volontaires.length > 10) console.log(`  … et ${volontaires.length - 10} autre(s)`);
  }
  if (divergents.length) {
    console.log(`\nEFFETS DIVERGENTS SANS TRACE AU JOURNAL (${divergents.length})`);
    divergents.forEach((d) => console.log(`  #${d.uid} ${d.module} / ${d.action} : attendu ${d.attendu}, trouvé ${d.reel}`));
  }

  const total = attendus.size;
  const repris = total - manquants.length;
  console.log(
    `\n${repris}/${total} droit(s) attendu(s) repris` +
    (manquants.length || divergents.length ? " — REPRISE INCOMPLÈTE" : " — reprise complète")
  );

  await pool.end();
  process.exit(manquants.length || divergents.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("ÉCHEC :", e.message || e);
  await pool.end().catch(() => {});
  process.exit(2);
});
