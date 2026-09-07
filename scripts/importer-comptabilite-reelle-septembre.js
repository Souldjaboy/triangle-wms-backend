"use strict";

/* Import strict des deux classeurs certifiés reçus le 3 septembre 2026.
 * Preview par défaut, transaction unique en apply, empreintes et totaux figés.
 * Les lignes sans montant restent archivées mais n'affectent aucun solde. */
const fs = require("fs");
const crypto = require("crypto");
const XLSX = require("xlsx");
require("dotenv").config();
const { Pool } = require("pg");

const HASH_TABLEAUX = "86e9ab8d333da9d01d87bdffd4a93ca62581bb28c0a2eff263149e11f5b634f3";
const HASH_BANQUES = "333d5ba6288b5ac192c1c7e811efa0cdfa44f38a78255daab63f46f85be2b075";
const CONFIRMATION = "OUI-JE-SEPARE-TRIANGLE-ET-FATMAT";
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.length ? rest.join("=") : true];
}));
const APPLY = args.apply === true;

const sha = (path) => crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
const norm = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toUpperCase();
const money = (value) => Number(value || 0);
const isoDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : XLSX.SSF.parse_date_code(Number(value));
  if (date instanceof Date) return date.toISOString().slice(0, 10);
  if (!date?.y) return null;
  return `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
};
const fp = (line) => crypto.createHash("sha256").update(JSON.stringify(line)).digest("hex");
const rows = (workbook, sheet) => XLSX.utils.sheet_to_json(workbook.Sheets[sheet], { header: 1, raw: true, defval: null });

function readFiles(tableauxPath, banquesPath) {
  const hashes = { tableaux: sha(tableauxPath), banques: sha(banquesPath) };
  if (hashes.tableaux !== HASH_TABLEAUX || hashes.banques !== HASH_BANQUES) {
    throw new Error(`Empreinte refusée. TABLEAUX=${hashes.tableaux}, BANQUES=${hashes.banques}`);
  }
  const tableaux = XLSX.readFile(tableauxPath, { cellDates: false });
  const banques = XLSX.readFile(banquesPath, { cellDates: false });
  return { tableaux, banques, hashes };
}

function buildPlan(files) {
  const plan = { banks: [], triangleExpenses: [], fatmatExpenses: [], archive: [], monthly: [] };
  const bankSpecs = [
    ["ORABANK TRIANGLE", "triangle", 95996235, 20396235],
    ["BDM TRIANGLE", "triangle", 91428750, 11248750],
    ["BNDA ALLIANCE", "fatmat", 22120150, 5108450],
  ];
  for (const [sheet, company, opening, closing] of bankSpecs) {
    const data = rows(files.banques, sheet);
    const operations = [];
    for (let i = 1; i < data.length - 1; i++) {
      const [date, reference, label, income, expense, sourceBalance, observation] = data[i];
      if (!date && !reference && !label && !income && !expense) continue;
      const line = { company, sheet, row: i + 1, date: isoDate(date), reference, label, income: money(income), expense: money(expense), sourceBalance, observation };
      if (i === 1 && norm(reference) === "SOLDE INITIAL") continue;
      if (line.income > 0 || line.expense > 0) operations.push(line);
      else if ([reference, label, observation].some(Boolean)) {
        plan.archive.push({ ...line, status: "INCOMPLETE", reviewReason: "Opération bancaire sans montant" });
      }
    }
    const calc = opening + operations.reduce((sum, line) => sum + line.income - line.expense, 0);
    if (calc !== closing) throw new Error(`${sheet}: solde calculé ${calc}, attendu ${closing}.`);
    plan.banks.push({ sheet, company, opening, closing, operations });
  }

  const followTriangle = rows(files.tableaux, "Suivi Triangle");
  for (let i = 6; i < followTriangle.length - 1; i++) {
    const [date, label, reference, income, expense, , observation] = followTriangle[i];
    const line = { company: "triangle", sheet: "Suivi Triangle", row: i + 1, date: isoDate(date), label, reference, income: money(income), expense: money(expense), observation };
    if (line.date && (line.income > 0 || line.expense > 0)) {
      if (line.income === 7500000 && norm(reference) === "FN-T00408") continue; // traité une seule fois ci-dessous
      if (line.expense > 0) plan.triangleExpenses.push(line);
    } else if ([label, reference, observation].some(Boolean)) plan.archive.push({ ...line, status: "INCOMPLETE" });
  }

  const followFatmat = rows(files.tableaux, "Suivi Fat & Mat");
  for (let i = 5; i < followFatmat.length - 7; i++) {
    const [date, label, truck, reference, income, expense, , observation] = followFatmat[i];
    const line = { company: "fatmat", sheet: "Suivi Fat & Mat", row: i + 1, date: isoDate(date), label, truck, reference, income: money(income), expense: money(expense), observation };
    if (line.date && (line.income > 0 || line.expense > 0)) plan.fatmatExpenses.push(line);
    else if ([label, truck, reference, observation].some(Boolean)) plan.archive.push({ ...line, status: "INCOMPLETE" });
  }

  const evolution = [
    ["Evolution Triangle", "triangle", [["2026-05", 0,3153450],["2026-06",75240000,40604000],["2026-07",159700000,132993173],["2026-08",71232500,23884942]]],
    ["Evolution  Fat et Mat", "fatmat", [["2026-05",3840000,2307300],["2026-06",27040000,21354700],["2026-07",26630000,22382900],["2026-08",13209000,29302000]]],
  ];
  for (const [sheet, company, periods] of evolution) {
    for (const [period, income, expense] of periods) plan.monthly.push({ company, sheet, row: 0, period, income, expense, status: "SUMMARY_ONLY" });
  }

  const triangleExpense = plan.triangleExpenses.reduce((s, x) => s + x.expense, 0);
  const fatmatExpense = plan.fatmatExpenses.reduce((s, x) => s + x.expense, 0);
  if (triangleExpense !== 1680400 || fatmatExpense !== 6038000) {
    throw new Error(`Dépenses non réconciliées : Triangle=${triangleExpense}, FATMAT=${fatmatExpense}.`);
  }
  plan.confirmed = {
    triangleOpeningReview: 2413858,
    cementSale: { amount: 7500000, businessDate: "2026-09-01", cashDate: "2026-09-02", recordedDate: "2026-09-03", reference: "FN-T00408" },
    triangleExpense,
    fatmatExpense,
    triangleCashClosing: 2195458,
    intercompanyAdvance: 6038000,
  };
  const closing = 2413858 + 7500000 - triangleExpense - fatmatExpense;
  if (closing !== plan.confirmed.triangleCashClosing) throw new Error("Solde de trésorerie final non réconcilié.");
  return plan;
}

async function exactCompany(client, id, expected) {
  const row = (await client.query("SELECT id,name FROM companies WHERE id=$1", [id])).rows[0];
  if (!row || !norm(row.name).includes(expected)) throw new Error(`Entreprise #${id} incompatible (${row?.name || "absente"}).`);
  return row;
}

function historicalProjection(line, bankId = null) {
  const summaryOnly = line.status === "SUMMARY_ONLY";
  const income = summaryOnly ? 0 : money(line.income);
  const expense = summaryOnly ? 0 : money(line.expense);
  if (!summaryOnly && income > 0 && expense > 0) {
    throw new Error(
      `${line.sheet || "Source"} ligne ${line.row || "?"}: une opération ne peut pas être simultanément une entrée et une dépense.`
    );
  }
  return {
    lineType: summaryOnly ? "MONTHLY_SUMMARY" : "OPERATION",
    accountKind: summaryOnly ? "INFORMATION" : (bankId ? "BANK" : "TREASURY"),
    income,
    expense,
  };
}

async function insertHistorical(client, imp, companyId, line, transactionId = null, bankId = null) {
  const projection = historicalProjection(line, bankId);
  const fingerprint = fp({ companyId, sheet: line.sheet, row: line.row, date: line.date || line.period, reference: line.reference, income: line.income || 0, expense: line.expense || 0, label: line.label || "" });
  return (await client.query(
    `INSERT INTO accounting_historical_lines
       (import_id,company_id,source_sheet,source_row,operation_date,line_type,account_kind,bank_id,reference,description,income,expense,status,review_reason,accounting_transaction_id,fingerprint,source_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (company_id,fingerprint) DO NOTHING RETURNING id`,
    [imp,companyId,line.sheet,line.row,line.date || null,projection.lineType,
      projection.accountKind,bankId,line.reference || null,line.label || line.period || null,projection.income,projection.expense,
      line.status || "IMPORTED",line.status === "INCOMPLETE" ? (line.reviewReason || "Montant ou date absent dans le classeur") : null,transactionId,fingerprint,JSON.stringify(line)]
  )).rows[0] || null;
}

async function nextNumber(client, companyId, prefix) {
  const key = `accounting_transactions.transaction_number.${prefix}.2026`;
  const n = (await client.query(
    `INSERT INTO number_counters(company_id,counter_key,last_value) VALUES($1,$2,1)
     ON CONFLICT(company_id,counter_key) DO UPDATE SET last_value=number_counters.last_value+1,updated_at=now()
     RETURNING last_value`, [companyId,key])).rows[0].last_value;
  return `${prefix}-2026-${String(n).padStart(6,"0")}`;
}

async function transaction(client, companyId, data) {
  const number = await nextNumber(client, companyId, data.prefix || "HIS");
  return (await client.query(
    `INSERT INTO accounting_transactions(company_id,transaction_number,transaction_type,source_type,amount,currency,direction,category,description,status,bank_id,source_label,destination_label,created_by,validated_by,validated_at,operation_date,created_at,updated_at)
     VALUES($1,$2,$3,'historical_excel_20260903',$4,'FCFA',$5,$6,$7,'validé',$8,$9,$10,$11,$11,now(),$12::date,$12::date,now()) RETURNING id`,
    [companyId,number,data.type,data.amount,data.direction,data.category,data.description,data.bankId || null,data.source || "",data.destination || "",data.userId,data.date]
  )).rows[0];
}

async function journal(client, companyId, sourceId, date, label, debit, credit, userId) {
  const number = `HIS-${companyId}-${sourceId}`;
  const entry = (await client.query(
    `INSERT INTO journal_entries(company_id,entry_number,entry_date,label,module_source,source_id,status,created_by)
     VALUES($1,$2,$3,$4,'historical_excel_20260903',$5,'validé',$6) RETURNING id`,
    [companyId,number,date,label,sourceId,userId])).rows[0];
  for (const line of [debit, credit]) await client.query(
    `INSERT INTO journal_entry_lines(entry_id,company_id,account_code,account_name,debit,credit,bank_id)
     VALUES($1,$2,$3,$4,$5,$6,$7)`, [entry.id,companyId,line.code,line.name,line.debit || 0,line.credit || 0,line.bankId || null]);
}

async function main() {
  if (APPLY === (args.preview === true)) throw new Error("Indiquez exactement --preview ou --apply.");
  if (APPLY && args.confirmer !== CONFIRMATION) throw new Error(`Confirmation requise : --confirmer=${CONFIRMATION}`);
  const tableauxPath = args.tableaux;
  const banquesPath = args.banques;
  const triangleId = Number(args["triangle-company-id"]);
  const fatmatId = Number(args["fatmat-company-id"]);
  const requestedUserId = Number(args["user-id"]);
  if (!tableauxPath || !banquesPath || !triangleId || !fatmatId || triangleId === fatmatId) throw new Error("Fichiers et deux company_id distincts obligatoires.");
  if (!requestedUserId) throw new Error("--user-id est obligatoire pour tracer l’auteur de l’import.");
  const files = readFiles(tableauxPath, banquesPath);
  const plan = buildPlan(files);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const triangle = await exactCompany(client, triangleId, "TRIANGLE");
    const fatmat = await exactCompany(client, fatmatId, "FAT");
    const operator = (await client.query("SELECT id, fullname, email FROM users WHERE id=$1", [requestedUserId])).rows[0];
    if (!operator) throw new Error(`Utilisateur auteur #${requestedUserId} introuvable.`);
    console.log(`Mode ${APPLY ? "APPLICATION" : "PREVIEW — aucune écriture"}`);
    console.log(`Triangle #${triangle.id} ${triangle.name}; FAT & MAT #${fatmat.id} ${fatmat.name}`);
    console.log(`Auteur de l’import : #${operator.id} ${operator.fullname || operator.email || "(sans nom)"}`);
    console.log(JSON.stringify({ banques: plan.banks.map(b => ({nom:b.sheet,societe:b.company,initial:b.opening,final:b.closing,operations:b.operations.length})), confirme: plan.confirmed, syntheses_mensuelles: plan.monthly.length, lignes_incompletes_archivees: plan.archive.length }, null, 2));
    const etatBanques = [];
    for (const bankPlan of plan.banks) {
      const companyId = bankPlan.company === "triangle" ? triangleId : fatmatId;
      const found = (await client.query(
        "SELECT id, bank_name, current_balance FROM accounting_banks WHERE company_id=$1 AND UPPER(TRIM(bank_name))=$2 ORDER BY id",
        [companyId, norm(bankPlan.sheet)])).rows;
      etatBanques.push({ societe: bankPlan.company, banque: bankPlan.sheet, comptes_existants: found });
    }
    const etatTresorerie = (await client.query(
      "SELECT company_id,current_balance FROM treasury_accounts WHERE company_id=ANY($1::int[]) ORDER BY company_id",
      [[triangleId, fatmatId]])).rows;
    console.log("ÉTAT ACTUEL (lecture seule)");
    console.log(JSON.stringify({ banques: etatBanques, tresoreries: etatTresorerie }, null, 2));
    if (!APPLY) return;
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('import-comptabilite-reelle-20260903'))");
    const companyIds = { triangle: triangleId, fatmat: fatmatId };
    const dejaAppliques = (await client.query(
      `SELECT company_id, status, file_sha256, file_manifest
         FROM accounting_historical_imports
        WHERE import_key='COMPTA-REELLE-2026-09-03'
          AND company_id = ANY($1::int[])
        FOR UPDATE`, [[triangleId, fatmatId]])).rows;
    if (dejaAppliques.length) {
      if (dejaAppliques.length !== 2 || dejaAppliques.some((i) => i.status !== "APPLIED"
          || i.file_sha256 !== files.hashes.tableaux
          || i.file_manifest?.banques !== files.hashes.banques)) {
        throw new Error("Import antérieur incomplet ou d’empreinte différente : intervention manuelle requise.");
      }
      await client.query("COMMIT");
      console.log("DÉJÀ APPLIQUÉ : aucune écriture, aucun solde recalculé.");
      return;
    }
    const treasuryBeforeRow = (await client.query(
      "SELECT current_balance FROM treasury_accounts WHERE company_id=$1 FOR UPDATE", [triangleId])).rows[0];
    const treasuryBefore = Number(treasuryBeforeRow?.current_balance || 0);

    const duplicateCandidates = [
      plan.confirmed.cementSale,
      ...plan.triangleExpenses.map((l) => ({ amount: l.expense, businessDate: l.date, label: l.label })),
      ...plan.fatmatExpenses.map((l) => ({ amount: l.expense, businessDate: l.date, label: l.label, company: "fatmat" })),
    ];
    for (const candidate of duplicateCandidates) {
      const candidateCompany = candidate.company === "fatmat" ? fatmatId : triangleId;
      const possible = await client.query(
        `SELECT transaction_number FROM accounting_transactions
          WHERE company_id=$1 AND amount=$2
            AND COALESCE(operation_date, created_at::date)=$3::date
            AND source_type <> 'historical_excel_20260903'
            AND ($4::text IS NULL OR description=$4)
          LIMIT 1`,
        [candidateCompany, candidate.amount, candidate.businessDate, candidate.label || null]);
      if (possible.rows[0]) {
        throw new Error(`Doublon possible ${possible.rows[0].transaction_number} pour ${candidate.label || candidate.reference}; vérification comptable requise.`);
      }
    }
    const imports = {};
    for (const key of ["triangle","fatmat"]) {
      imports[key] = (await client.query(
        `INSERT INTO accounting_historical_imports(company_id,import_key,file_name,file_sha256,file_manifest,status,summary,created_by,applied_at)
         VALUES($1,'COMPTA-REELLE-2026-09-03',$2,$3,$4,'APPLIED',$5,$6,now())
         ON CONFLICT(company_id,import_key) DO UPDATE SET import_key=EXCLUDED.import_key RETURNING id`,
        [companyIds[key],"TABLEAUX.xlsx + BANQUES.xlsx",files.hashes.tableaux,JSON.stringify(files.hashes),JSON.stringify(plan.confirmed),requestedUserId])).rows[0].id;
    }
    const userId = requestedUserId;
    for (const bankPlan of plan.banks) {
      const companyId = companyIds[bankPlan.company];
      const matches = (await client.query("SELECT * FROM accounting_banks WHERE company_id=$1 AND UPPER(TRIM(bank_name))=$2 FOR UPDATE", [companyId,norm(bankPlan.sheet)])).rows;
      if (matches.length > 1) throw new Error(`${bankPlan.sheet}: ${matches.length} comptes homonymes existent dans la même société.`);
      let bank = matches[0];
      if (!bank) bank = (await client.query(
        `INSERT INTO accounting_banks(company_id,bank_name,currency,initial_balance,current_balance,is_active,created_by) VALUES($1,$2,'FCFA',$3,$3,true,$4) RETURNING *`,
        [companyId,bankPlan.sheet,bankPlan.opening,userId])).rows[0];
      else if (Number(bank.current_balance) === 0) {
        const uses = Number((await client.query("SELECT count(*)::int AS n FROM accounting_transactions WHERE company_id=$1 AND bank_id=$2", [companyId, bank.id])).rows[0].n);
        if (uses) throw new Error(`${bankPlan.sheet}: solde nul mais ${uses} mouvement(s) existent ; rapprochement requis.`);
        bank = (await client.query("UPDATE accounting_banks SET initial_balance=$1,current_balance=$1,updated_at=now() WHERE id=$2 RETURNING *", [bankPlan.opening, bank.id])).rows[0];
      }
      else if (Number(bank.current_balance) === bankPlan.closing) throw new Error(`${bankPlan.sheet}: le solde final existe déjà sans registre d’import complet ; refus de deviner s’il a déjà été importé.`);
      else if (Number(bank.current_balance) !== bankPlan.opening) throw new Error(`${bankPlan.sheet}: banque existante avec solde incompatible ${bank.current_balance}; attendu avant import ${bankPlan.opening}.`);
      for (const line of bankPlan.operations) {
        const already = await insertHistorical(client, imports[bankPlan.company], companyId, line, null, bank.id);
        if (!already) continue;
        const amount = line.income || line.expense;
        const tx = await transaction(client, companyId, { prefix:"HIS-BQ",type:line.income ? "depot_historique" : "retrait_historique",amount,direction:line.income ? "entrée":"sortie",category:"Banque historique à rapprocher",description:line.label || line.reference || "Opération bancaire",bankId:bank.id,source:"Compte 47 - à identifier",destination:bank.bank_name,userId,date:line.date });
        await client.query("UPDATE accounting_historical_lines SET accounting_transaction_id=$1 WHERE id=$2",[tx.id,already.id]);
        await client.query("UPDATE accounting_banks SET current_balance=current_balance+$1,updated_at=now() WHERE id=$2",[line.income-line.expense,bank.id]);
        await journal(client,companyId,tx.id,line.date,line.label || "Opération bancaire historique",
          line.income ? {code:"52",name:"Banque",debit:amount,bankId:bank.id}:{code:"47",name:"Compte d'attente",debit:amount},
          line.income ? {code:"47",name:"Compte d'attente",credit:amount}:{code:"52",name:"Banque",credit:amount,bankId:bank.id},userId);
      }
      const final = Number((await client.query("SELECT current_balance FROM accounting_banks WHERE id=$1",[bank.id])).rows[0].current_balance);
      if (final !== bankPlan.closing) throw new Error(`${bankPlan.sheet}: solde final ${final}, attendu ${bankPlan.closing}.`);
    }
    await client.query(`INSERT INTO treasury_accounts(company_id,currency,initial_balance,current_balance,updated_by) VALUES($1,'FCFA',0,0,$2) ON CONFLICT(company_id) DO NOTHING`,[triangleId,userId]);
    const openingLine = {sheet:"Tresorerie",row:3,date:"2026-09-01",label:"Solde restant du mois d'AOUT — À VÉRIFIER",income:2413858,expense:0,status:"TO_REVIEW"};
    const opening = await insertHistorical(client,imports.triangle,triangleId,openingLine);
    if (opening) {
      const tx=await transaction(client,triangleId,{prefix:"HIS-OUV",type:"solde_ouverture_a_verifier",amount:2413858,direction:"entrée",category:"Report antérieur à vérifier",description:openingLine.label,source:"Origine à vérifier",destination:"Trésorerie Triangle",userId,date:openingLine.date});
      await client.query("UPDATE accounting_historical_lines SET accounting_transaction_id=$1 WHERE id=$2",[tx.id,opening.id]);
      await client.query("UPDATE treasury_accounts SET current_balance=current_balance+2413858,updated_by=$2,updated_at=now() WHERE company_id=$1",[triangleId,userId]);
      await journal(client,triangleId,tx.id,openingLine.date,openingLine.label,{code:"57",name:"Trésorerie",debit:2413858},{code:"47",name:"Compte d'attente — origine à vérifier",credit:2413858},userId);
    }
    const saleLine = {sheet:"Suivi Triangle",row:19,date:"2026-09-01",recordedDate:"2026-09-03",reference:"FN-T00408",label:"Vente de ciment payée par chèque, encaissée le 2 septembre",income:7500000,expense:0};
    const saleHist = await insertHistorical(client,imports.triangle,triangleId,saleLine);
    if (saleHist) {
      const tx=await transaction(client,triangleId,{prefix:"HIS-CIM",type:"encaissement_ciment_historique",amount:7500000,direction:"entrée",category:"Vente ciment",description:saleLine.label,source:"Client - chèque FN-T00408",destination:"Trésorerie Triangle",userId,date:"2026-09-02"});
      await client.query("UPDATE accounting_historical_lines SET accounting_transaction_id=$1,recorded_date='2026-09-03' WHERE id=$2",[tx.id,saleHist.id]);
      await client.query("UPDATE treasury_accounts SET current_balance=current_balance+7500000,updated_at=now() WHERE company_id=$1",[triangleId]);
      await journal(client,triangleId,tx.id,"2026-09-01",saleLine.label,{code:"57",name:"Trésorerie",debit:7500000},{code:"70",name:"Ventes ciment",credit:7500000},userId);
    }
    for (const line of plan.triangleExpenses) {
      const hist=await insertHistorical(client,imports.triangle,triangleId,line); if(!hist) continue;
      const tx=await transaction(client,triangleId,{prefix:"HIS-DEP",type:"depense_historique",amount:line.expense,direction:"sortie",category:"Dépense Triangle",description:line.label,source:"Trésorerie Triangle",destination:line.reference||"Dépense",userId,date:line.date});
      await client.query("UPDATE accounting_historical_lines SET accounting_transaction_id=$1 WHERE id=$2",[tx.id,hist.id]);
      await client.query("UPDATE treasury_accounts SET current_balance=current_balance-$1,updated_at=now() WHERE company_id=$2",[line.expense,triangleId]);
      await journal(client,triangleId,tx.id,line.date,line.label,{code:"65",name:"Charges Triangle",debit:line.expense},{code:"57",name:"Trésorerie",credit:line.expense},userId);
    }
    const transferNumber="INT-TRI-FAT-202609-001";
    const existingTransfer=(await client.query("SELECT id FROM intercompany_transfers WHERE from_company_id=$1 AND transfer_number=$2",[triangleId,transferNumber])).rows[0];
    if(!existingTransfer){
      const fromTx=await transaction(client,triangleId,{prefix:"HIS-INT",type:"avance_inter_societes",amount:6038000,direction:"sortie",category:"Créance FAT & MAT",description:"Dépenses FAT & MAT payées par Triangle du 1er au 3 septembre",source:"Trésorerie Triangle",destination:"FAT & MAT",userId,date:"2026-09-03"});
      await client.query("UPDATE treasury_accounts SET current_balance=current_balance-6038000,updated_at=now() WHERE company_id=$1",[triangleId]);
      await journal(client,triangleId,fromTx.id,"2026-09-03","Avance à FAT & MAT",{code:"451",name:"Créance sur FAT & MAT",debit:6038000},{code:"57",name:"Trésorerie",credit:6038000},userId);
      const transfer=(await client.query(`INSERT INTO intercompany_transfers(transfer_number,from_company_id,to_company_id,amount,operation_date,reason,from_transaction_id,created_by) VALUES($1,$2,$3,6038000,'2026-09-03',$4,$5,$6) RETURNING id`,[transferNumber,triangleId,fatmatId,"Reclassement de la trésorerie commune : dépenses FAT & MAT financées par Triangle",fromTx.id,userId])).rows[0];
      for(const line of plan.fatmatExpenses){
        const hist=await insertHistorical(client,imports.fatmat,fatmatId,line); if(!hist) continue;
        const tx=await transaction(client,fatmatId,{prefix:"HIS-DEP",type:"depense_financee_inter_societes",amount:line.expense,direction:"sortie",category:"Dépense FAT & MAT",description:line.label,source:"Avance Triangle",destination:line.reference||"Dépense",userId,date:line.date});
        await client.query("UPDATE accounting_historical_lines SET accounting_transaction_id=$1 WHERE id=$2",[tx.id,hist.id]);
        await journal(client,fatmatId,tx.id,line.date,line.label,{code:"65",name:"Charges FAT & MAT",debit:line.expense},{code:"451",name:"Dette envers Triangle",credit:line.expense},userId);
      }
      await client.query("UPDATE intercompany_transfers SET to_transaction_id=(SELECT MIN(accounting_transaction_id) FROM accounting_historical_lines WHERE import_id=$1 AND status='IMPORTED') WHERE id=$2",[imports.fatmat,transfer.id]);
    }
    for(const line of [...plan.monthly,...plan.archive]) await insertHistorical(client,imports[line.company],companyIds[line.company],line);
    const treasury=Number((await client.query("SELECT current_balance FROM treasury_accounts WHERE company_id=$1",[triangleId])).rows[0].current_balance);
    const expectedTreasury = treasuryBefore + 2195458;
    if(treasury!==expectedTreasury) throw new Error(`Trésorerie Triangle finale ${treasury}, attendu ${expectedTreasury} (ancien solde ${treasuryBefore} conservé).`);
    await client.query("COMMIT");
    console.log("APPLICATION TERMINÉE : banques réconciliées, trésoreries séparées, avance inter-sociétés tracée.");
  } catch(error) { if(APPLY) await client.query("ROLLBACK").catch(()=>{}); throw error; }
  finally { client.release(); await pool.end(); }
}

if (require.main === module) {
  main().catch((error)=>{ console.error("ARRÊT :",error.message); process.exitCode=1; });
}

module.exports = { buildPlan, readFiles, historicalProjection, HASH_TABLEAUX, HASH_BANQUES };
