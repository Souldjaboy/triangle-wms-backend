#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const A = require("../services/attendance-workforce");

let passed=0, failed=0;
function check(name, condition) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const root=path.join(__dirname,"..");
const sql=fs.readFileSync(path.join(root,"sql/071_pointage_effectif_sites_paie.sql"),"utf8");
const payrollSql=fs.readFileSync(path.join(root,"sql/072_paie_mensuelle_pointage.sql"),"utf8");
const setup=fs.readFileSync(path.join(root,"scripts/configure-pointage-triangle-20260903.js"),"utf8");
const server=fs.readFileSync(path.join(root,"server.js"),"utf8");

console.log("\nRÈGLES DE POINTAGE V2");
check("les accents et variantes de rôle sont normalisés",A.normalizeRole("Super Administrateur")==="super_administrateur");
check("le super administrateur voit la paie",A.roleCanViewSalary({role:"super_admin"}));
check("le comptable voit la paie",A.roleCanViewSalary({role:"comptable"}));
check("un opérateur d'entrepôt ne voit pas la paie",!A.roleCanViewSalary({role:"responsable_entrepot"}));
check("un rôle direction générique ne voit pas la paie",!A.roleCanViewSalary({role:"direction"}));
check("08:10 produit exactement 10 minutes de retard",A.minutesLate("2026-09-03T08:10:00Z","2026-09-03","08:00")==10);
check("une arrivée avant 08:00 ne produit aucun retard",A.minutesLate("2026-09-03T07:55:00Z","2026-09-03","08:00")===0);
check("les quatre actions officielles existent",Object.keys(A.ACTION_COLUMNS).join(",")==="CHECK_IN,BREAK_OUT,BREAK_IN,CHECK_OUT");
let rejected=false;try{A.assertAction("DELETE");}catch(error){rejected=error.code==="ATTENDANCE_ACTION_INVALID";}check("une action inconnue est refusée",rejected);

console.log("\nSTRUCTURE ET REMISE À ZÉRO");
check("les employés sont séparés des comptes",/CREATE TABLE IF NOT EXISTS attendance_employees/.test(sql)&&/user_id INTEGER REFERENCES users\(id\) ON DELETE SET NULL/.test(sql));
check("un seul pointage journalier par employé",/UNIQUE \(company_id, employee_id, work_date\)/.test(sql));
check("les ajustements exigent un motif",/length\(trim\(reason\)\) >= 3/.test(sql));
check("la remise à zéro archive avant de supprimer",setup.indexOf("archiveRows(client")<setup.indexOf("DELETE FROM attendance_history"));
check("la remise à zéro ne supprime jamais les utilisateurs",!setup.includes("DELETE FROM users"));
check("l'application exige une confirmation explicite",setup.includes("RESET_POINTAGE_2026_09_03"));
check("les 27 employés sont déclarés",(setup.match(/^\s*\[\d+,/gm)||[]).length===27);
const salaryRows=[...setup.matchAll(/\[\"\d+\",\"[^\"]+\",(\d+),(\d+)\]/g)].map((match)=>Number(match[1]));
check("les 26 salaires individuels sont déclarés",salaryRows.length===26);
check("la somme des lignes mensuelles est 1 785 000 FCFA",salaryRows.reduce((sum,value)=>sum+value,0)===1785000);
check("la paie conserve le mode, la référence et l'auteur du paiement",/payment_method TEXT/.test(payrollSql)&&/payment_reference TEXT/.test(payrollSql)&&/paid_by INTEGER/.test(payrollSql));
check("les trois sites sont codifiés",["OFFICE","MAGNAMB","BOUGOUBA"].every(code=>setup.includes(`[\"${code}\"`)));
check("le samedi est prévu uniquement pour l'entrepôt",setup.includes("const working = day<=6")&&setup.includes("day<=5?\"17:00\":day===6?\"12:00\""));
check("l'ancien pointage direct n'est plus sur l'URL publique",!server.includes('app.post("/attendance/check"')&&!server.includes('app.post("/attendance/scan"'));

console.log(`\nPointage v2 : ${passed} réussis, ${failed} échecs.`);
if(failed)process.exitCode=1;
