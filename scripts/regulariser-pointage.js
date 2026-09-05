"use strict";

/**
 * RÉGULARISER DES JOURNÉES NON POINTÉES.
 *
 *   node scripts/regulariser-pointage.js --preview --company-id=1 \
 *        --date-from=2026-08-25 --date-to=2026-09-03
 *
 *   node scripts/regulariser-pointage.js --apply --company-id=1 \
 *        --date-from=2026-08-25 --date-to=2026-09-03 \
 *        --motif="Mise en service du pointage" \
 *        --confirmer="OUI JE REGULARISE 1 DU 2026-08-25 AU 2026-09-03"
 *
 * Options :
 *   --preview | --apply        obligatoire, l'un ou l'autre
 *   --company-id=<n>           société ciblée
 *   --date-from / --date-to    bornes INCLUSES, toutes deux obligatoires
 *   --motif="…"                obligatoire pour --apply
 *   --confirmer="…"            phrase exacte, obligatoire pour --apply
 *   --samedi=NORMAL|NON_TRAVAILLE|FACULTATIF|EXCEPTIONNEL
 *   --feries=2026-09-22,2026-01-01
 *   --arrivee=08:00  --depart=17:00
 *   --employes=12,15           restreindre à certains employés
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QUE CE SCRIPT NE FAIT PAS
 *
 *   • il n'écrit JAMAIS dans `attendance_day_records_v2`. Les pointages bruts
 *     restent tels quels — souvent vides, ce qui est l'information : personne
 *     n'a pointé ce jour-là. La valeur retenue vit à côté, dans
 *     `attendance_regularizations`, avec son motif et son auteur ;
 *
 *   • il n'utilise jamais « aujourd'hui » comme date de fin. Une exécution
 *     dans six mois régulariserait sinon six mois de journées que personne
 *     n'a demandées. `--date-to` est obligatoire, toujours ;
 *
 *   • il ne touche pas au dimanche, ni aux jours fériés fournis, ni au samedi
 *     si le mode le dit non travaillé : un jour non dû ne devient pas un jour
 *     travaillé parce qu'un script est passé.
 *
 * Idempotence : chaque exécution porte une clé déduite de ses paramètres. Un
 * second passage aux mêmes paramètres ne crée rien. Un verrou consultatif par
 * société empêche deux exécutions simultanées de se croiser.
 */

const { Pool } = require("pg");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[1m", GRIS = "\x1b[90m", Z = "\x1b[0m";

function options(argv) {
  const o = { preview: false, apply: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--preview") { o.preview = true; continue; }
    if (arg === "--apply")   { o.apply = true; continue; }
    const m = /^--([a-z-]+)=(.*)$/s.exec(arg);
    if (m) o[m[1].replace(/-/g, "_")] = m[2];
  }
  return o;
}

const o = options(process.argv);

function refuser(message) {
  console.error(`${R}${message}${Z}`);
  process.exit(1);
}

if (o.preview === o.apply) refuser("Indiquez exactement --preview OU --apply.");
if (!process.env.DATABASE_URL) refuser("DATABASE_URL manquant.");

const companyId = Number(o.company_id || 0);
if (!Number.isInteger(companyId) || companyId <= 0) refuser("--company-id=<n> est obligatoire.");

const dateFrom = String(o.date_from || "");
const dateTo   = String(o.date_to || "");
const jourISO = /^\d{4}-\d{2}-\d{2}$/;
if (!jourISO.test(dateFrom)) refuser("--date-from=AAAA-MM-JJ est obligatoire.");
/* Jamais « aujourd'hui » par défaut : une exécution tardive régulariserait
   des mois que personne n'a demandés. */
if (!jourISO.test(dateTo)) {
  refuser("--date-to=AAAA-MM-JJ est obligatoire. Ce script n'utilise jamais la date du jour par défaut.");
}
if (dateTo < dateFrom) refuser("--date-to est antérieure à --date-from.");

const MODES_SAMEDI = ["NORMAL", "FACULTATIF", "EXCEPTIONNEL", "NON_TRAVAILLE"];
const modeSamedi = String(o.samedi || "NORMAL").toUpperCase();
if (!MODES_SAMEDI.includes(modeSamedi)) refuser(`--samedi doit valoir : ${MODES_SAMEDI.join(", ")}.`);

const feries = String(o.feries || "").split(",").map((f) => f.trim()).filter(Boolean);
for (const f of feries) if (!jourISO.test(f)) refuser(`Jour férié invalide : ${f}`);

const heure = /^\d{2}:\d{2}$/;
const arrivee = String(o.arrivee || "08:00");
const depart  = String(o.depart || "17:00");
if (!heure.test(arrivee) || !heure.test(depart)) refuser("--arrivee et --depart attendent HH:MM.");

const employesCibles = String(o.employes || "").split(",").map((e) => Number(e.trim())).filter(Boolean);
const motif = String(o.motif || "").trim();

const PHRASE = `OUI JE REGULARISE ${companyId} DU ${dateFrom} AU ${dateTo}`;
if (o.apply) {
  if (motif.length < 10) {
    refuser("--motif=\"…\" est obligatoire pour --apply (au moins 10 caractères) : il sera lu des mois plus tard.");
  }
  if (String(o.confirmer || "") !== PHRASE) {
    refuser(`Confirmation exacte requise :\n  --confirmer="${PHRASE}"`);
  }
}

/* Garde-fou : ce script écrit. Il refuse une URL qui ressemble à une base de
   service, à moins qu'on l'y autorise explicitement. */
if (o.apply && /5432|prod|production/i.test(process.env.DATABASE_URL) && o.autoriser_production !== "1") {
  refuser("Cette URL ressemble à une base de production. Refus. (--autoriser-production=1 pour passer outre, en connaissance de cause.)");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/* La clé d'idempotence tient à TOUT ce qui change le résultat. Changer une
   seule option produit un lot différent — sinon, corriger le mode du samedi
   et relancer ne changerait rien, en silence. */
const cleIdempotence = [
  "regul", companyId, dateFrom, dateTo, modeSamedi,
  feries.slice().sort().join("|") || "sansferie",
  arrivee, depart,
  employesCibles.slice().sort((a, b) => a - b).join("|") || "tous",
].join(":");

const fr = (n) => Number(n).toLocaleString("fr-FR");

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    /* Un verrou par société : deux exécutions simultanées se sérialisent au
       lieu de produire deux lots concurrents. */
    await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [860_000, companyId]);

    const { rows: societes } = await client.query(
      `SELECT id, name FROM companies WHERE id = $1`, [companyId]);
    if (!societes[0]) throw new Error(`Société ${companyId} introuvable.`);

    const { rows: dejaFait } = await client.query(
      `SELECT id, created_at, days_count FROM attendance_regularization_batches
        WHERE company_id = $1 AND idempotency_key = $2`,
      [companyId, cleIdempotence]);

    const { rows: employes } = await client.query(
      `SELECT e.id, e.employee_number, e.full_name, e.schedule_id, e.effective_from, e.effective_to
         FROM attendance_employees e
        WHERE e.company_id = $1 AND e.active = true
          AND e.effective_from <= $3::date
          AND (e.effective_to IS NULL OR e.effective_to >= $2::date)
          AND ($4::int[] = '{}' OR e.id = ANY($4::int[]))
        ORDER BY e.employee_number`,
      [companyId, dateFrom, dateTo, employesCibles]);

    if (!employes.length) throw new Error("Aucun employé actif dans cette période.");

    /* Les journées dues, employé par employé : l'horaire décide, le dimanche
       ne compte jamais, le samedi suit le mode, les fériés sont exclus. */
    const { rows: candidats } = await client.query(
      `WITH jours AS (
         SELECT d::date AS jour, extract(isodow FROM d)::int AS isodow
           FROM generate_series($2::date, $3::date, interval '1 day') d
       )
       /* jour::text : sans ce cast, le driver pg renvoie un objet Date, et
          String(date) donne « Mon Aug 24 2026 » — que PostgreSQL refuse
          ensuite comme date. Le piège se paie toujours au moment de réécrire
          la valeur, jamais au moment de la lire. */
       SELECT e.id AS employee_id, e.full_name, e.employee_number, j.jour::text AS jour,
              d.start_time, d.end_time,
              r.id  AS record_id,
              r.check_in, r.check_out, r.status,
              g.id  AS regularization_id
         FROM attendance_employees e
         CROSS JOIN jours j
         JOIN attendance_schedule_days d
           ON d.schedule_id = e.schedule_id AND d.iso_weekday = j.isodow AND d.is_working_day
         LEFT JOIN attendance_day_records_v2 r
           ON r.company_id = e.company_id AND r.employee_id = e.id AND r.work_date = j.jour
         LEFT JOIN attendance_regularizations g
           ON g.company_id = e.company_id AND g.employee_id = e.id AND g.work_date = j.jour
        WHERE e.company_id = $1 AND e.active = true
          AND ($4::int[] = '{}' OR e.id = ANY($4::int[]))
          AND e.effective_from <= j.jour
          AND (e.effective_to IS NULL OR e.effective_to >= j.jour)
          AND j.isodow <> 7
          AND ($5 OR j.isodow <> 6)
          AND NOT (j.jour = ANY($6::date[]))
        ORDER BY e.employee_number, j.jour`,
      [companyId, dateFrom, dateTo, employesCibles, modeSamedi === "NORMAL", feries]);

    const aCreer = candidats.filter((c) => !c.regularization_id && !c.check_in);
    const dejaPointes = candidats.filter((c) => c.check_in);
    const dejaRegularises = candidats.filter((c) => c.regularization_id);

    // ────────────────────────────────────────────────────────────────
    console.log(`\n${G}RÉGULARISATION DE POINTAGE — ${o.apply ? "APPLICATION" : "PRÉVISUALISATION"}${Z}`);
    console.log(`  Société        : ${societes[0].name} (#${companyId})`);
    console.log(`  Période        : du ${dateFrom} au ${dateTo} inclus`);
    console.log(`  Samedi         : ${modeSamedi}`);
    console.log(`  Dimanche       : jamais travaillé, jamais compté comme absence`);
    console.log(`  Jours fériés   : ${feries.length ? feries.join(", ") : "aucun fourni"}`);
    console.log(`  Journée retenue: ${arrivee} → ${depart}`);
    console.log(`  Employés       : ${employes.length}${employesCibles.length ? " (restreint)" : ""}`);
    console.log(`  Clé            : ${GRIS}${cleIdempotence}${Z}`);

    if (dejaFait[0]) {
      console.log(`\n${J}  Ce lot exact a déjà été appliqué le ${String(dejaFait[0].created_at).slice(0, 19)}`);
      console.log(`  (${fr(dejaFait[0].days_count)} journée(s)). Un nouveau passage ne créera rien.${Z}`);
    }

    console.log(`\n${G}CE QUI SERA RETENU${Z}`);
    const parEmploye = new Map();
    for (const c of aCreer) {
      if (!parEmploye.has(c.employee_id)) {
        parEmploye.set(c.employee_id, { nom: c.full_name, numero: c.employee_number, jours: [] });
      }
      parEmploye.get(c.employee_id).jours.push(c.jour);
    }
    if (!parEmploye.size) {
      console.log(`  ${GRIS}aucune journée à régulariser${Z}`);
    }
    for (const [, e] of parEmploye) {
      const j = e.jours;
      console.log(`  ${String(e.numero).padStart(5)}  ${e.nom.padEnd(28)} ${String(j.length).padStart(3)} jour(s)  ${GRIS}${j[0]} → ${j[j.length - 1]}${Z}`);
    }

    console.log(`\n${G}CE QUI EST LAISSÉ TEL QUEL${Z}`);
    console.log(`  ${String(dejaPointes.length).padStart(5)} journée(s) déjà pointées — jamais écrasées`);
    console.log(`  ${String(dejaRegularises.length).padStart(5)} journée(s) déjà régularisées — jamais doublées`);
    console.log(`  ${GRIS}dimanches, fériés fournis${modeSamedi === "NON_TRAVAILLE" ? " et samedis" : ""} : hors périmètre par construction${Z}`);

    console.log(`\n${G}TOTAUX${Z}`);
    console.log(`  employés concernés : ${fr(parEmploye.size)}`);
    console.log(`  journées à créer   : ${fr(aCreer.length)}`);

    if (!o.apply) {
      await client.query("ROLLBACK");
      console.log(`\n${J}  Prévisualisation : aucune écriture n'a eu lieu.${Z}`);
      console.log(`  Pour appliquer :`);
      console.log(`    --apply --motif="…" --confirmer="${PHRASE}"\n`);
      return;
    }

    if (!aCreer.length) {
      await client.query("COMMIT");
      console.log(`\n${V}  Rien à créer. La base est déjà dans l'état demandé.${Z}\n`);
      return;
    }

    const { rows: lots } = await client.query(
      `INSERT INTO attendance_regularization_batches
         (company_id, idempotency_key, date_from, date_to, saturday_mode, holidays,
          default_check_in, default_check_out, reason, employees_count, days_count,
          performed_by, performed_by_name)
       VALUES ($1,$2,$3::date,$4::date,$5,$6::date[],$7::time,$8::time,$9,$10,$11,NULL,$12)
       ON CONFLICT (company_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [companyId, cleIdempotence, dateFrom, dateTo, modeSamedi, feries,
       arrivee, depart, motif, parEmploye.size, aCreer.length,
       String(o.auteur || "script regulariser-pointage")]);

    const batchId = lots[0]?.id
      || (await client.query(
        `SELECT id FROM attendance_regularization_batches
          WHERE company_id = $1 AND idempotency_key = $2`, [companyId, cleIdempotence])).rows[0].id;

    let crees = 0;
    for (const c of aCreer) {
      const jour = c.jour;
      const { rowCount } = await client.query(
        `INSERT INTO attendance_regularizations
           (company_id, batch_id, employee_id, record_id, work_date,
            original_check_in, original_check_out, original_status,
            effective_check_in, effective_check_out, effective_status,
            reason, performed_by_name)
         VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,
                 ($5::date + $9::time)::timestamptz,
                 ($5::date + $10::time)::timestamptz,
                 'PRESENT',$11,$12)
         ON CONFLICT (company_id, employee_id, work_date) DO NOTHING`,
        [companyId, batchId, c.employee_id, c.record_id || null, jour,
         c.check_in || null, c.check_out || null, c.status || "",
         arrivee, depart, motif, String(o.auteur || "script regulariser-pointage")]);
      crees += rowCount;
    }

    await client.query(
      `UPDATE attendance_regularization_batches SET days_count = $1 WHERE id = $2`,
      [crees, batchId]);

    await client.query("COMMIT");
    console.log(`\n${V}  ${fr(crees)} journée(s) retenues, lot #${batchId}.${Z}`);
    console.log(`  ${GRIS}Les pointages bruts n'ont pas été modifiés. Awa ou l'administrateur`);
    console.log(`  peuvent marquer une absence réelle par-dessus, sans rien effacer.${Z}\n`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\n${R}ÉCHEC : ${e.message}${Z}`);
    console.error(`${GRIS}Rien n'a été écrit : la transaction entière est annulée.${Z}\n`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
