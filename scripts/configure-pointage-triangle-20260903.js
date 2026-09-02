#!/usr/bin/env node
"use strict";

/*
 * Prépare le nouveau pointage Triangle sans jamais créer de mot de passe.
 * Par défaut : aperçu en lecture seule.
 * Application :
 *   ATTENDANCE_COMPANY_ID=1 \
 *   ATTENDANCE_RESET_CONFIRM=RESET_POINTAGE_2026_09_03 \
 *   node scripts/configure-pointage-triangle-20260903.js --apply
 *
 * Les anciennes données de pointage sont copiées dans
 * attendance_reset_archives avant suppression. Les users et permissions ne
 * sont jamais supprimés.
 */

const { Pool } = require("pg");
const { normalizeRole } = require("../services/attendance-workforce");

const COMPANY_ID = Number(process.env.ATTENDANCE_COMPANY_ID || 0);
const APPLY = process.argv.includes("--apply");
const CONFIRM = process.env.ATTENDANCE_RESET_CONFIRM || "";
const RESET_KEY = "POINTAGE-TRIANGLE-2026-09-03";

const staff = [
  [1,"Souleymane Diallo","OFFICE",["souleymane diallo","souleman diallo"]],
  [2,"Amary Zerbo","MAGNAMB",["amary zerbo","amari zerbo"]],
  [3,"Souleymane Yaya Fofana","OFFICE",["souleymane yaya fofana","souleman fofana","souleymane fofana"]],
  [4,"Hawa Diarra","OFFICE",["hawa diarra","awa jara","awa diarra"]],
  [5,"Bahini Baillo","OFFICE",["bahini baillo","baini ballo","baini baillo"]],
  [6,"Awa Ouleguem","OFFICE",["awa ouleguem","awa weregam","awa oulegem"]],
  [7,"Sekou Traoré","MAGNAMB",["sekou traore"]],
  [8,"Malamine N’Diaye","MAGNAMB",["malamine n'diaye","malamine ndiaye"]],
  [9,"Drissa Traoré","BOUGOUBA",["drissa traore"]],
  [10,"Mamadou Traoré","MAGNAMB",["mamadou traore"]],
  [11,"Mohamed Sanogo","MAGNAMB",["mohamed sanogo"]],
  [12,"Moustapha Diarra","MAGNAMB",["moustapha diarra"]],
  [13,"Moussa Camara","MAGNAMB",["moussa camara"]],
  [14,"Madeleine Traoré","MAGNAMB",["madeleine traore"]],
  [15,"Kadiatou Guindo","MAGNAMB",["kadiatou guindo"]],
  [16,"Coumba Sissoko","BOUGOUBA",["coumba sissoko","kumba sissoko"]],
  [17,"Oumar Sangaré","MAGNAMB",["oumar sangare"]],
  [18,"Abdoulaye Fofana","MAGNAMB",["abdoulaye fofana"]],
  [19,"Philippe Sanogo","MAGNAMB",["philippe sanogo"]],
  [20,"Massitan Sampana","MAGNAMB",["massitan sampana"]],
  [21,"Ibrahima Traoré","MAGNAMB",["ibrahima traore"]],
  [22,"Mohamed Sangaré","MAGNAMB",["mohamed sangare"]],
  [23,"Rachel Pagnon Baillo","MAGNAMB",["rachel pagnon baillo","rachel pagnon ballo"]],
  [24,"Falaye Dembele","MAGNAMB",["falaye dembele"]],
  [25,"Modibo Zerbo","MAGNAMB",["modibo zerbo"]],
  [26,"Mohamed Fofana","MAGNAMB",["mohamed fofana"]],
  [27,"Mohamedou Diallo","OFFICE",["mohamedou diallo","mohamadou diallo"]],
];

// Montants individuels lus sur la fiche de salaire d'août 2026. Les retenues
// d'août ne sont pas reconduites : à partir de septembre, les absences et les
// ajustements justifiés alimentent le calcul mensuel.
const salaryRows = {
  1:["74329225","Responsable administrative et informatique",150000,5000],
  2:["72717014","Responsable logistique",150000,5000],
  3:["92995011","Comptable",100000,3333],
  4:["76489323","Assistante directeur",75000,2500],
  5:["93311815","Stagiaire",50000,1667],
  6:["89902819","Ménagère",30000,1000],
  7:["76452019","Agent de terrain",50000,1667],
  8:["76161347","Coursier",30000,1000],
  9:["76327799","Magasinier",100000,3333],
  10:["74711611","Magasinier",100000,3333],
  11:["62892701","Aide magasinier",100000,3333],
  12:["62674444","Magasinier",100000,3333],
  13:["78800121","Aide magasinier",100000,3333],
  14:["707144149","Aide magasinier",50000,1667],
  15:["79608644","Aide magasinier",50000,1667],
  16:["71777577","Aide magasinier",50000,1667],
  17:["79218819","Aide magasinier",100000,3333],
  18:["73583702","Aide magasinier",50000,1667],
  19:["91855943","Stagiaire",50000,1667],
  20:["78149103","Aide magasinier",50000,1667],
  21:["83328186","Stagiaire",50000,1667],
  22:["82274122","Aide magasinier",100000,3333],
  23:["98346440","Stagiaire",25000,833],
  24:["97291589","Stagiaire",25000,833],
  25:["72717014","Stagiaire",25000,833],
  26:["82388894","Stagiaire",25000,833],
};

const norm = (value) => normalizeRole(value).replace(/_/g, " ").replace(/[’']/g, "").trim();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function chooseUser(users, aliases, override) {
  if (override) return users.find((u) => Number(u.id) === Number(override)) || null;
  const wanted = new Set(aliases.map(norm));
  const matches = users.filter((u) => wanted.has(norm(u.fullname)));
  return matches.length === 1 ? matches[0] : null;
}

async function archiveRows(client, table, rows, actorId) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO attendance_reset_archives(company_id,reset_key,source_table,source_id,payload,archived_by)
       VALUES($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT(company_id,reset_key,source_table,source_id) DO NOTHING`,
      [COMPANY_ID, RESET_KEY, table, String(row.id), JSON.stringify(row), actorId]
    );
  }
}

async function main() {
  if (!COMPANY_ID) throw new Error("ATTENDANCE_COMPANY_ID est obligatoire.");
  const client = await pool.connect();
  try {
    const company = (await client.query(`SELECT id,name FROM companies WHERE id=$1`, [COMPANY_ID])).rows[0];
    if (!company) throw new Error(`Entreprise ${COMPANY_ID} introuvable.`);
    const users = (await client.query(
      `SELECT id,fullname,email,role,is_super_admin FROM users WHERE company_id=$1 ORDER BY id`, [COMPANY_ID]
    )).rows;
    const matches = staff.map((entry) => ({
      entry,
      user: chooseUser(users, entry[3], process.env[`ATTENDANCE_EMPLOYEE_${entry[0]}_USER_ID`]),
    }));
    const operators = {
      OFFICE: chooseUser(users, ["hawa diarra","awa jara","awa diarra"], process.env.ATTENDANCE_OPERATOR_OFFICE_USER_ID),
      MAGNAMB: chooseUser(users, ["amary zerbo","amari zerbo"], process.env.ATTENDANCE_OPERATOR_MAGNAMB_USER_ID),
      BOUGOUBA: chooseUser(users, ["drissa traore"], process.env.ATTENDANCE_OPERATOR_BOUGOUBA_USER_ID),
    };
    const director = chooseUser(users, ["mohamedou diallo","mohamadou diallo"], process.env.ATTENDANCE_DIRECTOR_USER_ID);
    const accountant = chooseUser(users, ["souleymane yaya fofana","souleman fofana","souleymane fofana"], process.env.ATTENDANCE_ACCOUNTANT_USER_ID);
    const legacy = {};
    legacy.attendance_records = (await client.query(`SELECT a.* FROM attendance_records a JOIN users u ON u.id=a.user_id WHERE u.company_id=$1`,[COMPANY_ID])).rows;
    legacy.attendance_history = (await client.query(`SELECT a.* FROM attendance_history a JOIN users u ON u.id=a.user_id WHERE u.company_id=$1`,[COMPANY_ID])).rows;
    legacy.attendance_settings = (await client.query(`SELECT a.* FROM attendance_settings a JOIN users u ON u.id=a.user_id WHERE u.company_id=$1`,[COMPANY_ID])).rows;
    legacy.employee_attendance_sites = (await client.query(`SELECT * FROM employee_attendance_sites WHERE company_id=$1`,[COMPANY_ID])).rows;
    legacy.attendance_sites = (await client.query(`SELECT * FROM attendance_sites WHERE company_id=$1`,[COMPANY_ID])).rows;
    legacy.schedule_groups = (await client.query(`SELECT * FROM schedule_groups WHERE company_id=$1`,[COMPANY_ID])).rows;
    console.log(`\nEntreprise : ${company.name} (${company.id})`);
    console.log(`Effectif prévu : ${staff.length}; comptes liés automatiquement : ${matches.filter((m)=>m.user).length}`);
    for (const [site, user] of Object.entries(operators)) console.log(`Opérateur ${site}: ${user ? `${user.fullname} [user ${user.id}]` : "NON TROUVÉ"}`);
    console.log(`Directeur avec accès salaires : ${director ? `${director.fullname} [user ${director.id}]` : "compte non trouvé — employé créé sans accès de connexion"}`);
    console.log(`Comptable autorisé à préparer/payer : ${accountant ? `${accountant.fullname} [user ${accountant.id}]` : "compte non trouvé — à lier avant paiement"}`);
    console.log("Salaires individuels : 26; total mensuel calculé : 1 785 000 FCFA (le total imprimé 1 710 000 est incohérent). Mohamedou Diallo : en attente.");
    console.log("Anciennes lignes à archiver/réinitialiser:", Object.fromEntries(Object.entries(legacy).map(([k,v])=>[k,v.length])));
    if (!APPLY) { console.log("\nAPERÇU UNIQUEMENT — aucune écriture. Utilisez --apply avec la confirmation requise."); return; }
    if (CONFIRM !== "RESET_POINTAGE_2026_09_03") throw new Error("Confirmation destructive absente ou incorrecte.");
    if (Object.values(operators).some((user) => !user)) throw new Error("Les trois comptes opérateurs doivent être identifiés avant application. Utilisez les variables *_USER_ID si nécessaire.");
    const actor = users.find((u) => u.is_super_admin === true || normalizeRole(u.role) === "super_admin");
    if (!actor) throw new Error("Aucun super administrateur de l’entreprise trouvé pour le journal.");

    await client.query("BEGIN");
    for (const [table, rows] of Object.entries(legacy)) await archiveRows(client, table, rows, actor.id);
    await client.query(`DELETE FROM attendance_history USING users u WHERE attendance_history.user_id=u.id AND u.company_id=$1`,[COMPANY_ID]);
    await client.query(`DELETE FROM attendance_records USING users u WHERE attendance_records.user_id=u.id AND u.company_id=$1`,[COMPANY_ID]);
    await client.query(`DELETE FROM employee_attendance_sites WHERE company_id=$1`,[COMPANY_ID]);
    await client.query(`DELETE FROM attendance_settings USING users u WHERE attendance_settings.user_id=u.id AND u.company_id=$1`,[COMPANY_ID]);
    await client.query(`DELETE FROM attendance_sites WHERE company_id=$1`,[COMPANY_ID]);
    await client.query(`DELETE FROM schedule_groups WHERE company_id=$1`,[COMPANY_ID]);

    const siteRows = {};
    for (const [code,name,city,type] of [
      ["OFFICE","Bureau Sotuba ACI","Sotuba ACI","OFFICE"],
      ["MAGNAMB","Entrepôts A/B/C — Magnambougou","Magnambougou","WAREHOUSE"],
      ["BOUGOUBA","Entrepôt D — Bougouba","Bougouba","WAREHOUSE"],
    ]) {
      siteRows[code] = (await client.query(
        `INSERT INTO attendance_work_sites(company_id,code,name,city,site_type) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(company_id,code) DO UPDATE SET name=EXCLUDED.name,city=EXCLUDED.city,site_type=EXCLUDED.site_type,active=true,updated_at=now() RETURNING *`,
        [COMPANY_ID,code,name,city,type]
      )).rows[0];
    }
    const schedules = {};
    for (const [code,name] of [["OFFICE","Bureau — lundi à vendredi"],["WAREHOUSE","Entrepôt — lundi à samedi"]]) {
      schedules[code] = (await client.query(
        `INSERT INTO attendance_work_schedules(company_id,code,name) VALUES($1,$2,$3)
         ON CONFLICT(company_id,code) DO UPDATE SET name=EXCLUDED.name,active=true,updated_at=now() RETURNING *`,
        [COMPANY_ID,code,name]
      )).rows[0];
    }
    for (const schedule of Object.values(schedules)) await client.query(`DELETE FROM attendance_schedule_days WHERE schedule_id=$1`,[schedule.id]);
    for (let day=1; day<=7; day++) {
      await client.query(`INSERT INTO attendance_schedule_days(schedule_id,iso_weekday,is_working_day,start_time,end_time,break_start,break_end) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [schedules.OFFICE.id,day,day<=5,day<=5?"08:00":null,day<=5?"17:00":null,day<=5?"13:00":null,day<=5?"14:00":null]);
      const working = day<=6;
      await client.query(`INSERT INTO attendance_schedule_days(schedule_id,iso_weekday,is_working_day,start_time,end_time,break_start,break_end) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [schedules.WAREHOUSE.id,day,working,working?"08:00":null,day<=5?"17:00":day===6?"12:00":null,day<=5?"13:00":null,day<=5?"14:00":null]);
    }
    await client.query(`UPDATE attendance_employees SET active=false,effective_to='2026-09-02',updated_at=now() WHERE company_id=$1`,[COMPANY_ID]);
    for (const { entry, user } of matches) {
      const [number,name,siteCode] = entry; const schedule = siteCode === "OFFICE" ? "OFFICE" : "WAREHOUSE";
      const salary = salaryRows[number];
      const employee = (await client.query(
        `INSERT INTO attendance_employees(company_id,employee_number,full_name,user_id,site_id,schedule_id,job_title,phone,active,effective_from,effective_to)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,'2026-09-03',null)
         ON CONFLICT(company_id,employee_number) DO UPDATE SET full_name=EXCLUDED.full_name,user_id=EXCLUDED.user_id,site_id=EXCLUDED.site_id,
           schedule_id=EXCLUDED.schedule_id,job_title=EXCLUDED.job_title,phone=EXCLUDED.phone,active=true,
           effective_from='2026-09-03',effective_to=null,updated_at=now() RETURNING id`,
        [COMPANY_ID,number,name,user?.id||null,siteRows[siteCode].id,schedules[schedule].id,
         salary?.[1] || (number===27?"Directeur":""),salary?.[0] || ""]
      )).rows[0];
      if (salary) await client.query(
        `INSERT INTO attendance_salary_settings_v2(company_id,employee_id,monthly_salary,daily_rate,basis_days,effective_from,set_by)
         VALUES($1,$2,$3,$4,30,'2026-09-03',$5)
         ON CONFLICT(employee_id,effective_from) DO UPDATE SET monthly_salary=EXCLUDED.monthly_salary,
           daily_rate=EXCLUDED.daily_rate,basis_days=30,set_by=EXCLUDED.set_by,updated_at=now()`,
        [COMPANY_ID,employee.id,salary[2],salary[3],actor.id]
      );
    }
    await client.query(`DELETE FROM attendance_operator_scopes WHERE company_id=$1`,[COMPANY_ID]);
    for (const [siteCode,user] of Object.entries(operators)) await client.query(
      `INSERT INTO attendance_operator_scopes(company_id,operator_user_id,site_id,can_punch) VALUES($1,$2,$3,true)`,
      [COMPANY_ID,user.id,siteRows[siteCode].id]
    );
    if (director) await client.query(
      `INSERT INTO attendance_salary_viewers(company_id,user_id,reason) VALUES($1,$2,'Directeur') ON CONFLICT(company_id,user_id) DO UPDATE SET reason=EXCLUDED.reason`,
      [COMPANY_ID,director.id]
    );
    if (accountant) await client.query(
      `INSERT INTO attendance_payroll_authorizations(company_id,user_id,can_prepare,can_pay,reason)
       VALUES($1,$2,true,true,'Comptable désigné')
       ON CONFLICT(company_id,user_id) DO UPDATE SET can_prepare=true,can_pay=true,reason=EXCLUDED.reason`,
      [COMPANY_ID,accountant.id]
    );
    await client.query(
      `INSERT INTO attendance_company_configuration(company_id,official_start_at,timezone,updated_by)
       VALUES($1,'2026-09-03 08:00:00+00','Africa/Bamako',$2)
       ON CONFLICT(company_id) DO UPDATE SET official_start_at=EXCLUDED.official_start_at,timezone=EXCLUDED.timezone,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [COMPANY_ID,actor.id]
    );
    await client.query("COMMIT");
    console.log("\nCONFIGURATION APPLIQUÉE — 27 employés, 3 sites, horaires et opérateurs. 26 salaires chargés; directeur en attente.");
  } catch (error) {
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  } finally { client.release(); await pool.end(); }
}

main().catch((error) => { console.error("ÉCHEC :", error.message); process.exitCode=1; });
