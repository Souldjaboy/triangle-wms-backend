#!/usr/bin/env node
"use strict";

const assert = require("assert");
const P = require("../services/attendance-payroll");

let passed=0;
function test(name,fn){try{fn();passed++;console.log(`✓ ${name}`);}catch(error){console.error(`✗ ${name}: ${error.message}`);process.exitCode=1;}}

test("le salaire complet est conservé sans absence",()=>{
  const x=P.calculatePayrollLine({monthly_salary:150000,daily_rate:5000,absence_days:0,adjustments:0});
  assert.equal(x.net_salary,150000); assert.equal(x.status,"TO_PAY");
});
test("une absence retire exactement le tarif journalier",()=>{
  const x=P.calculatePayrollLine({monthly_salary:150000,daily_rate:5000,absence_days:1,adjustments:0});
  assert.equal(x.absence_deduction,5000); assert.equal(x.net_salary,145000);
});
test("une retenue justifiée diminue le net",()=>assert.equal(P.calculatePayrollLine({monthly_salary:100000,daily_rate:3333,absence_days:0,adjustments:-5000}).net_salary,95000));
test("un complément justifié augmente le net",()=>assert.equal(P.calculatePayrollLine({monthly_salary:50000,daily_rate:1667,absence_days:1,adjustments:1667}).net_salary,50000));
test("un salaire manquant bloque le paiement",()=>assert.equal(P.calculatePayrollLine({monthly_salary:null,daily_rate:null,absence_days:0}).status,"BLOCKED"));
test("le net ne devient jamais négatif",()=>assert.equal(P.calculatePayrollLine({monthly_salary:25000,daily_rate:833,absence_days:40}).net_salary,0));
test("espèces, banque et mobile money sont acceptés",()=>{
  assert.equal(P.assertPaymentMethod("cash"),"CASH"); assert.equal(P.assertPaymentMethod("BANK"),"BANK"); assert.equal(P.assertPaymentMethod("mobile_money"),"MOBILE_MONEY");
});
test("un mode inconnu est refusé",()=>assert.throws(()=>P.assertPaymentMethod("autre"),/invalide/));

console.log(`\nPaie v2 : ${passed}/8 réussis.`);
if(passed!==8) process.exitCode=1;
