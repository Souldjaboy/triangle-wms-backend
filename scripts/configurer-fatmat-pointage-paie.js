"use strict";

/**
 * CONFIGURER LE POINTAGE ET LA PAIE DE FAT & MAT — HORAIRE, 9 EMPLOYÉS, ISSA.
 *
 *   node scripts/configurer-fatmat-pointage-paie.js --preview
 *
 *   node scripts/configurer-fatmat-pointage-paie.js --apply \
 *        --confirmer=OUI-JE-CONFIGURE-FATMAT
 *
 * ── CE QUE CE SCRIPT NE FAIT PAS EN LE DEVINANT ────────────────────────────
 *
 * Aucun id de société, d'utilisateur ou d'employé n'est écrit en dur ici.
 * FAT & MAT, le compte d'Issa Diallo et les employés existants sont
 * retrouvés AU MOMENT DE L'EXÉCUTION — jamais par ressemblance de nom seule.
 * Une ambiguïté (zéro correspondance, ou plusieurs) arrête tout avant la
 * moindre écriture ; le script dit alors précisément ce qu'il a trouvé, pour
 * qu'une personne tranche.
 *
 *   • FAT & MAT       : company.name contient « FAT » et « MAT » (insensible
 *                       à la casse et aux accents). Refus si 0 ou > 1.
 *   • Issa Diallo     : un compte `users` de CETTE société dont le téléphone
 *                       normalisé correspond EXACTEMENT à 77 11 30 98. Refus
 *                       si 0 ou > 1 — jamais choisi sur le seul nom.
 *   • Les 8 autres    : d'abord par téléphone exact (6 des 9 en ont un) ;
 *                       à défaut, par nom complet exact dans le périmètre de
 *                       FAT & MAT (les 3 apprentis sans téléphone). Refus sur
 *                       ambiguïté, jamais un rapprochement approximatif.
 *
 * ── CE QU'IL ÉCRIT ─────────────────────────────────────────────────────────
 *
 *   1. Un groupe horaire FAT & MAT (attendance_work_schedules +
 *      attendance_schedule_days) : 08h00-13h00 / 14h00-17h00, lundi à
 *      samedi. Réutilisé s'il existe déjà (même société, même code) — jamais
 *      dupliqué.
 *   2. Un site de travail FAT & MAT (attendance_work_sites), si aucun
 *      n'existe encore.
 *   3. La configuration horaire de la société (attendance_company_configuration)
 *      — fuseau Africa/Bamako, date de démarrage du pointage — si absente.
 *   4. Les 9 employés (attendance_employees + attendance_salary_settings_v2) :
 *      créés s'ils n'existent pas, mis à jour (salaire, poste) s'ils existent
 *      déjà sous une identité certaine. Jamais de doublon.
 *   5. Issa Diallo comme OPÉRATEUR de pointage (attendance_operator_scopes,
 *      can_punch=true) sur le site FAT & MAT — jamais comme lecteur de
 *      salaires (attendance_salary_viewers n'est jamais touché pour lui).
 *
 * Total net certifié : 775 000 FCFA (595 000 de base + 180 000
 * d'indemnités/rations). Le script refuse d'écrire si son propre calcul, à
 * partir de la liste ci-dessous, ne tombe pas exactement sur ce total —
 * c'est le même garde-fou que les scripts EM2S : mieux vaut s'arrêter que
 * d'écrire un chiffre qu'on n'a pas vérifié soi-même.
 */

const { Pool } = require("pg");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[1m", Z = "\x1b[0m";

const PHRASE = "OUI-JE-CONFIGURE-FATMAT";
const TOTAL_BASE_CERTIFIE = 595000;
const TOTAL_INDEMNITES_CERTIFIE = 180000;
const TOTAL_NET_CERTIFIE = 775000;

/* La liste certifiée. Le document photographié portait encore Djoulédé à
   10 000 FCFA et un total de 760 000 : ce sont d'anciennes valeurs. Les
   valeurs métier définitives sont celles-ci — 25 000 pour Djoulédé,
   775 000 au total. */
const EMPLOYES_CERTIFIES = [
  { nom: "Issa Diallo", telephone: "77 11 30 98", poste: "Responsable de FAT & MAT",
    base: 125000, indemnite: 0, estIssa: true },
  { nom: "Drissa Togo", telephone: "93 99 43 02", poste: "Chauffeur", base: 100000, indemnite: 30000 },
  { nom: "Moussa Boujare", telephone: "79 15 43 63", poste: "Chauffeur", base: 100000, indemnite: 30000 },
  { nom: "Sidiki Dembele", telephone: null, poste: "Apprenti", base: 15000, indemnite: 0 },
  { nom: "Moussa Coulibali", telephone: null, poste: "Apprenti", base: 15000, indemnite: 0 },
  { nom: "Abou Coulibali", telephone: null, poste: "Apprenti", base: 15000, indemnite: 0 },
  { nom: "Dougakoro Coulibali", telephone: "71 11 80 84", poste: "Chauffeur", base: 100000, indemnite: 90000 },
  { nom: "Siaka Dembele", telephone: "79 79 78 49", poste: "Chauffeur", base: 100000, indemnite: 30000 },
  { nom: "Djoulédé Traoré", telephone: "91 91 64 79", poste: "Stagiaire", base: 25000, indemnite: 0 },
];

const HORAIRE = { code: "FATMAT-STD", nom: "Horaire standard FAT & MAT",
  debut: "08:00:00", pauseDebut: "13:00:00", pauseFin: "14:00:00", fin: "17:00:00" };
/* La consigne donne un seul créneau, sans préciser les jours couverts. Une
   activité de sable/transport travaille en général six jours : l'hypothèse
   retenue est LUNDI-SAMEDI, même horaire chaque jour, dimanche non travaillé.
   C'est une donnée additive (attendance_schedule_days) : un jour peut être
   corrigé après coup sans toucher au reste. */
const JOURS_TRAVAILLES = [1, 2, 3, 4, 5, 6]; // ISO : 1=lundi … 6=samedi, 7=dimanche off

const args = process.argv.slice(2);
const PREVIEW = args.includes("--preview");
const APPLY = args.includes("--apply");
const opt = (nom) => { const t = args.find((a) => a.startsWith(`--${nom}=`)); return t ? t.slice(nom.length + 3) : null; };

function stop(message) { console.error(`${R}${message}${Z}`); process.exit(1); }
if (PREVIEW === APPLY) stop("Indiquez exactement un mode : --preview ou --apply.");
if (APPLY && opt("confirmer") !== PHRASE) {
  stop(`--apply crée des employés et des comptes de paie. Confirmez explicitement :\n  --apply --confirmer=${PHRASE}`);
}
if (!process.env.DATABASE_URL) stop("DATABASE_URL manquant.");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const compacter = (v) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/\s+/g, " ").trim().toUpperCase();
const normaliserTel = (v) => String(v ?? "").replace(/[^\d]/g, "");

/** FAT & MAT — jamais un id codé en dur. Refuse sur 0 ou plusieurs. */
async function resoudreSociete(client) {
  const { rows } = await client.query(
    `SELECT id, name FROM companies
      WHERE name ILIKE '%FAT%' AND name ILIKE '%MAT%'
      ORDER BY id`);
  if (rows.length === 0) stop("Aucune société ne contient « FAT » et « MAT » dans son nom. Arrêt.");
  if (rows.length > 1) {
    stop(`${rows.length} sociétés correspondent à « FAT & MAT » : `
      + rows.map((r) => `#${r.id} « ${r.name} »`).join(", ") + ". Ambiguïté : arrêt.");
  }
  return rows[0];
}

/**
 * Retrouve un compte `users` de la société par téléphone EXACT (normalisé).
 * Ne compare jamais les noms pour identifier un compte de connexion — un
 * homonyme existerait, et l'erreur serait irréversible une fois les droits
 * accordés.
 */
async function resoudreUtilisateurParTelephone(client, companyId, telephoneAttendu) {
  const cible = normaliserTel(telephoneAttendu);
  const { rows } = await client.query(
    `SELECT id, fullname, email, phone, role FROM users WHERE company_id = $1`, [companyId]);
  const correspondances = rows.filter((u) => normaliserTel(u.phone) === cible && cible.length >= 8);
  return { correspondances, tous: rows };
}

/** Un employé attendance_employees existant, par téléphone puis par nom exact. */
async function resoudreEmploye(client, companyId, personne) {
  const { rows } = await client.query(
    `SELECT * FROM attendance_employees WHERE company_id = $1 AND active = true`, [companyId]);
  if (personne.telephone) {
    const cible = normaliserTel(personne.telephone);
    const parTel = rows.filter((e) => normaliserTel(e.phone) === cible && cible.length >= 8);
    if (parTel.length) return { trouve: parTel, methode: "téléphone" };
  }
  const parNom = rows.filter((e) => compacter(e.full_name) === compacter(personne.nom));
  return { trouve: parNom, methode: "nom exact" };
}

async function main() {
  const totalBase = EMPLOYES_CERTIFIES.reduce((s, e) => s + e.base, 0);
  const totalIndemnites = EMPLOYES_CERTIFIES.reduce((s, e) => s + e.indemnite, 0);
  const totalNet = totalBase + totalIndemnites;

  console.log(`\n${G}CONFIGURATION POINTAGE ET PAIE — FAT & MAT${Z}`);
  console.log(`Base   : ${String(process.env.DATABASE_URL).replace(/:\/\/[^@]*@/, "://***@")}`);
  console.log(`Mode   : ${PREVIEW ? "PRÉVISUALISATION — aucune écriture" : "APPLICATION"}`);

  console.log(`\n${G}CONTRÔLE DES TOTAUX CERTIFIÉS${Z}`);
  console.log(`  base       : ${totalBase} (attendu ${TOTAL_BASE_CERTIFIE}) ${totalBase === TOTAL_BASE_CERTIFIE ? V + "✓" : R + "✗"}${Z}`);
  console.log(`  indemnités : ${totalIndemnites} (attendu ${TOTAL_INDEMNITES_CERTIFIE}) ${totalIndemnites === TOTAL_INDEMNITES_CERTIFIE ? V + "✓" : R + "✗"}${Z}`);
  console.log(`  net total  : ${totalNet} (attendu ${TOTAL_NET_CERTIFIE}) ${totalNet === TOTAL_NET_CERTIFIE ? V + "✓" : R + "✗"}${Z}`);
  if (totalBase !== TOTAL_BASE_CERTIFIE || totalIndemnites !== TOTAL_INDEMNITES_CERTIFIE || totalNet !== TOTAL_NET_CERTIFIE) {
    stop("\nLes totaux calculés depuis la liste ne correspondent pas aux totaux certifiés. Arrêt.");
  }
  if (EMPLOYES_CERTIFIES.length !== 9) stop("La liste ne compte pas exactement 9 employés. Arrêt.");

  const client = await pool.connect();
  try {
    const societe = await resoudreSociete(client);
    console.log(`\n${G}SOCIÉTÉ CIBLÉE${Z}`);
    console.log(`  #${societe.id} — ${societe.name}`);

    const issaCertifie = EMPLOYES_CERTIFIES.find((e) => e.estIssa);
    const { correspondances: issaComptes } = await resoudreUtilisateurParTelephone(
      client, societe.id, issaCertifie.telephone);

    console.log(`\n${G}COMPTE D'ISSA DIALLO${Z}`);
    if (issaComptes.length === 0) {
      console.log(`  ${J}Aucun compte de la société #${societe.id} n'a le téléphone ${issaCertifie.telephone}.${Z}`);
      console.log(`  Il sera créé sans compte de connexion lié ; l'accès opérateur ne pourra pas`);
      console.log(`  être accordé tant qu'aucun compte ne portera ce téléphone.`);
    } else if (issaComptes.length > 1) {
      stop(`  Plusieurs comptes de la société #${societe.id} portent le téléphone `
        + `${issaCertifie.telephone} : ${issaComptes.map((u) => `#${u.id} ${u.fullname} <${u.email}>`).join(", ")}. `
        + "Ambiguïté : arrêt, aucune écriture.");
    } else {
      console.log(`  ${V}#${issaComptes[0].id} — ${issaComptes[0].fullname} <${issaComptes[0].email}> `
        + `— rôle ${issaComptes[0].role}${Z}`);
    }
    const issaUserId = issaComptes[0]?.id || null;

    // ── Horaire ─────────────────────────────────────────────────────────
    console.log(`\n${G}GROUPE HORAIRE${Z}`);
    const { rows: horaireExistant } = await client.query(
      `SELECT * FROM attendance_work_schedules WHERE company_id = $1 AND code = $2`,
      [societe.id, HORAIRE.code]);
    if (horaireExistant[0]) {
      console.log(`  ${V}réutilisé${Z} : #${horaireExistant[0].id} — ${horaireExistant[0].name}`);
    } else {
      console.log(`  ${J}à créer${Z} : ${HORAIRE.nom} (${HORAIRE.debut}-${HORAIRE.fin}, `
        + `pause ${HORAIRE.pauseDebut}-${HORAIRE.pauseFin}, lundi à samedi)`);
    }

    // ── Site ────────────────────────────────────────────────────────────
    console.log(`\n${G}SITE DE TRAVAIL${Z}`);
    const { rows: siteExistant } = await client.query(
      `SELECT * FROM attendance_work_sites WHERE company_id = $1 ORDER BY id LIMIT 1`, [societe.id]);
    if (siteExistant[0]) {
      console.log(`  ${V}réutilisé${Z} : #${siteExistant[0].id} — ${siteExistant[0].name}`);
    } else {
      console.log(`  ${J}à créer${Z} : Site principal FAT & MAT`);
    }

    // ── Configuration société ──────────────────────────────────────────
    const { rows: configExistante } = await client.query(
      `SELECT * FROM attendance_company_configuration WHERE company_id = $1`, [societe.id]);
    console.log(`\n${G}CONFIGURATION DE SOCIÉTÉ (fuseau, démarrage)${Z}`);
    console.log(configExistante[0]
      ? `  ${V}déjà configurée${Z} : démarrage ${configExistante[0].official_start_at}, fuseau ${configExistante[0].timezone}`
      : `  ${J}à créer${Z} : démarrage maintenant, fuseau Africa/Bamako`);

    // ── Les 9 employés ──────────────────────────────────────────────────
    console.log(`\n${G}LES 9 EMPLOYÉS${Z}`);
    const plan = [];
    for (const personne of EMPLOYES_CERTIFIES) {
      const { trouve, methode } = await resoudreEmploye(client, societe.id, personne);
      if (trouve.length > 1) {
        stop(`\nPlusieurs employés de FAT & MAT correspondent à « ${personne.nom} » par ${methode} : `
          + trouve.map((e) => `#${e.id} ${e.full_name} (${e.phone || "sans tél."})`).join(", ")
          + ". Ambiguïté : arrêt, aucune écriture.");
      }
      const existant = trouve[0] || null;
      const netAttendu = personne.base + personne.indemnite;
      const netExistant = existant
        ? Number((await client.query(
            `SELECT monthly_salary FROM attendance_salary_settings_v2
              WHERE employee_id = $1 ORDER BY effective_from DESC LIMIT 1`, [existant.id])).rows[0]?.monthly_salary || 0)
        : null;
      plan.push({ personne, existant, netAttendu, netExistant, changeSalaire: existant && netExistant !== netAttendu });

      const etat = existant ? `${V}réutilisé (#${existant.id}, par ${methode})${Z}` : `${J}à créer${Z}`;
      console.log(`  ${personne.nom.padEnd(22)} ${personne.poste.padEnd(16)} `
        + `base ${String(personne.base).padStart(7)} + indemnité ${String(personne.indemnite).padStart(6)} `
        + `= net ${String(netAttendu).padStart(7)}  ${etat}`);
      if (existant && netExistant !== netAttendu) {
        console.log(`      ${J}salaire à corriger : ${netExistant ?? "non défini"} → ${netAttendu}${Z}`);
      }
      if (personne.estIssa && existant && issaUserId && existant.user_id && Number(existant.user_id) !== Number(issaUserId)) {
        stop(`\nL'employé Issa Diallo (#${existant.id}) est déjà lié à un AUTRE compte `
          + `(#${existant.user_id}) que celui trouvé par téléphone (#${issaUserId}). Ambiguïté : arrêt.`);
      }
    }

    // ── Opérateur : Issa peut pointer, jamais automatiquement les salaires ──
    console.log(`\n${G}DROIT D'OPÉRATEUR D'ISSA (pointer, jamais voir les salaires)${Z}`);
    if (!issaUserId) {
      console.log(`  ${J}ignoré : aucun compte utilisateur résolu pour Issa (voir plus haut).${Z}`);
    } else {
      const { rows: scopeExistant } = await client.query(
        `SELECT * FROM attendance_operator_scopes
          WHERE company_id = $1 AND operator_user_id = $2`, [societe.id, issaUserId]);
      const { rows: dejaSalaire } = await client.query(
        `SELECT 1 FROM attendance_salary_viewers WHERE company_id = $1 AND user_id = $2`,
        [societe.id, issaUserId]);
      console.log(scopeExistant.length
        ? `  ${V}déjà opérateur${Z} sur ${scopeExistant.length} site(s)`
        : `  ${J}à accorder${Z} : opérateur (can_punch) sur le site FAT & MAT`);
      console.log(dejaSalaire.length
        ? `  ${R}attention : Issa a par ailleurs déjà un accès aux salaires (attendance_salary_viewers) — `
          + `non touché par ce script, à vérifier séparément si ce n'est pas voulu.${Z}`
        : `  ${V}confirmé${Z} : aucun accès aux salaires ne sera accordé à Issa par ce script.`);
    }

    if (PREVIEW) {
      console.log(`\n${G}RÉSUMÉ${Z}`);
      console.log(`  employés à créer    : ${plan.filter((p) => !p.existant).length}`);
      console.log(`  employés réutilisés : ${plan.filter((p) => p.existant).length}`);
      console.log(`  salaires à corriger : ${plan.filter((p) => p.changeSalaire).length}`);
      console.log(`  autre société touchée : 0 (tout est filtré par company_id = ${societe.id})`);
      console.log(`\n${V}Prévisualisation terminée. Rien n'a été écrit.${Z}`);
      console.log(`Pour appliquer : --apply --confirmer=${PHRASE}\n`);
      return;
    }

    // ── APPLICATION ─────────────────────────────────────────────────────
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('configurer-fatmat-pointage-paie'), hashtext($1))`,
      [String(societe.id)]);

    let horaireId = horaireExistant[0]?.id;
    if (!horaireId) {
      horaireId = (await client.query(
        `INSERT INTO attendance_work_schedules (company_id, code, name, active)
         VALUES ($1,$2,$3,true) RETURNING id`, [societe.id, HORAIRE.code, HORAIRE.nom])).rows[0].id;
    }
    for (let jour = 1; jour <= 7; jour += 1) {
      const travaille = JOURS_TRAVAILLES.includes(jour);
      await client.query(
        `INSERT INTO attendance_schedule_days
           (schedule_id, iso_weekday, is_working_day, start_time, end_time, break_start, break_end)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (schedule_id, iso_weekday) DO UPDATE SET
           is_working_day = EXCLUDED.is_working_day,
           start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
           break_start = EXCLUDED.break_start, break_end = EXCLUDED.break_end`,
        [horaireId, jour, travaille,
         travaille ? HORAIRE.debut : null, travaille ? HORAIRE.fin : null,
         travaille ? HORAIRE.pauseDebut : null, travaille ? HORAIRE.pauseFin : null]);
    }

    let siteId = siteExistant[0]?.id;
    if (!siteId) {
      siteId = (await client.query(
        `INSERT INTO attendance_work_sites (company_id, code, name, city, site_type, active)
         VALUES ($1,'FATMAT-SITE','Site principal FAT & MAT','',  'WAREHOUSE', true) RETURNING id`,
        [societe.id])).rows[0].id;
    }

    if (!configExistante[0]) {
      await client.query(
        `INSERT INTO attendance_company_configuration (company_id, official_start_at, timezone)
         VALUES ($1, now(), 'Africa/Bamako')
         ON CONFLICT (company_id) DO NOTHING`, [societe.id]);
    }

    const resultatEmployes = [];
    for (const { personne, existant, netAttendu } of plan) {
      let employeId;
      if (existant) {
        employeId = existant.id;
        await client.query(
          `UPDATE attendance_employees
              SET job_title = $1, phone = COALESCE(NULLIF($2,''), phone),
                  site_id = COALESCE(site_id, $3), schedule_id = COALESCE(schedule_id, $4),
                  user_id = COALESCE(user_id, $5), updated_at = CURRENT_TIMESTAMP
            WHERE id = $6 AND company_id = $7`,
          [personne.poste, personne.telephone || "", siteId, horaireId,
           personne.estIssa ? issaUserId : null, employeId, societe.id]);
      } else {
        const { rows: num } = await client.query(
          `SELECT COALESCE(MAX(employee_number), 0) + 1 AS n FROM attendance_employees WHERE company_id = $1`,
          [societe.id]);
        employeId = (await client.query(
          `INSERT INTO attendance_employees
             (company_id, employee_number, full_name, user_id, site_id, schedule_id, job_title, phone, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING id`,
          [societe.id, num[0].n, personne.nom, personne.estIssa ? issaUserId : null,
           siteId, horaireId, personne.poste, personne.telephone || ""])).rows[0].id;
      }

      /* Une nouvelle ligne de salaire seulement si le net change réellement —
         effective_from = aujourd'hui, la précédente reste lisible telle
         quelle : c'est l'historique, pas une correction rétroactive. */
      const { rows: salaireActuel } = await client.query(
        `SELECT monthly_salary FROM attendance_salary_settings_v2
          WHERE employee_id = $1 ORDER BY effective_from DESC LIMIT 1`, [employeId]);
      if (!salaireActuel[0] || Number(salaireActuel[0].monthly_salary) !== netAttendu) {
        await client.query(
          `INSERT INTO attendance_salary_settings_v2
             (company_id, employee_id, monthly_salary, daily_rate, basis_days, effective_from, set_by)
           VALUES ($1,$2,$3,$4,30,CURRENT_DATE,NULL)
           ON CONFLICT (employee_id, effective_from) DO UPDATE SET
             monthly_salary = EXCLUDED.monthly_salary, daily_rate = EXCLUDED.daily_rate`,
          /* Salaire journalier = salaire mensuel de base ÷ 30, arrondi à
             l'entier le plus proche — la base seule, jamais l'indemnité, qui
             n'est pas due au prorata d'une journée d'absence. */
          [societe.id, employeId, netAttendu, Math.round(personne.base / 30)]);
      }
      resultatEmployes.push({ nom: personne.nom, employeId, net: netAttendu, cree: !existant });
    }

    if (issaUserId) {
      await client.query(
        `INSERT INTO attendance_operator_scopes (company_id, operator_user_id, site_id, can_punch)
         VALUES ($1,$2,$3,true)
         ON CONFLICT (company_id, operator_user_id, site_id) DO UPDATE SET can_punch = true`,
        [societe.id, issaUserId, siteId]);
    }

    /* Contrôle final : rien n'a été écrit hors du périmètre de cette
       société — la garantie la plus simple à vérifier est qu'aucune ligne
       créée ne porte un company_id différent, ce que les requêtes
       ci-dessus rendent structurellement impossible ; on le revérifie
       explicitement plutôt que de se fier au seul texte du code. */
    const { rows: horsPerimetre } = await client.query(
      `SELECT count(*) n FROM attendance_employees
        WHERE full_name = ANY($1::text[]) AND company_id <> $2`,
      [EMPLOYES_CERTIFIES.map((e) => e.nom), societe.id]);
    if (Number(horsPerimetre[0].n) > 0) {
      throw new Error("Une écriture hors du périmètre de FAT & MAT a été détectée. Tout est annulé.");
    }

    await client.query("COMMIT");
    console.log(`\n${V}CONFIGURATION TERMINÉE${Z}`);
    for (const r of resultatEmployes) {
      console.log(`  ${r.cree ? "créé  " : "à jour"} — ${r.nom.padEnd(22)} net ${r.net} (#${r.employeId})`);
    }
    console.log(`  ${V}total net : ${totalNet} FCFA${Z}\n`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\n${R}ÉCHEC : ${e.message}${Z}`);
    console.error("Aucune écriture n'a survécu.\n");
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(async (e) => {
  console.error(`${R}ÉCHEC : ${e.message}${Z}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
