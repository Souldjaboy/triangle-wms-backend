"use strict";

const assert = require("assert");
const fixture = require("./fixture-em2s");
const P = require("../services/import-em2s");
const R = require("../services/import-em2s-repartitions");

let ok=0;
const test=(nom,fn)=>{try{fn();ok+=1;console.log(`  ✓ ${nom}`);}catch(e){console.error(`  ✗ ${nom} — ${e.message}`);process.exitCode=1;}};
const lecture=P.lireClasseur(fixture.construire(),{nomFichier:"fixture-em2s.xlsx"});
const mouvements=lecture.stock.lignes.flatMap((l)=>l.mouvements.filter((m)=>m.nouveau)
  .map((m)=>({...m,ligne:l}))) ;

console.log("\n▸ MODÈLE IN/OUT PAR ÉVÉNEMENT");
test("une ligne avec seulement une entrée reste un seul événement IN",()=>{
  const x=lecture.stock.lignes.find((l)=>l.mouvements.filter((m)=>m.nouveau).length===1
    && l.mouvements.some((m)=>m.nouveau&&m.sens==="Entrée"));
  assert(x); assert.deepStrictEqual(x.mouvements.filter((m)=>m.nouveau).map((m)=>R.directionDe(m.sens)),["IN"]);
});
test("une ligne avec seulement une sortie reste un seul événement OUT",()=>{
  const x=lecture.stock.lignes.find((l)=>l.mouvements.filter((m)=>m.nouveau).length===1
    && l.mouvements.some((m)=>m.nouveau&&m.sens==="Sortie"));
  assert(x); assert.deepStrictEqual(x.mouvements.filter((m)=>m.nouveau).map((m)=>R.directionDe(m.sens)),["OUT"]);
});
test("la ligne 167 porte IN +4 et OUT -2",()=>{
  const x=lecture.stock.lignes.find((l)=>l.provenance.ligne===167);
  assert.deepStrictEqual(x.mouvements.filter((m)=>m.nouveau).map((m)=>[R.directionDe(m.sens),m.quantite]),[["IN",4],["OUT",2]]);
});
test("IN et OUT ont des identifiants stables différents",()=>{
  const base={sha:lecture.fichier.sha256,feuille:"LISTE DES STOCK",ligne:167,date:"2026-07-29",sequence:1};
  assert.notStrictEqual(R.cleEvenement({...base,direction:"IN"}),R.cleEvenement({...base,direction:"OUT"}));
});
test("le rejeu redonne exactement la même clé",()=>{
  const e={sha:lecture.fichier.sha256,feuille:"LISTE DES STOCK",ligne:167,direction:"IN",date:"2026-07-29",sequence:1};
  assert.strictEqual(R.cleEvenement(e),R.cleEvenement({...e}));
});
test("des bins différents sont valides pour les deux sens",()=>{
  assert.strictEqual(R.verifierAllocation({BIN1:4,BIN2:0},["BIN1","BIN2"],4),4);
  assert.strictEqual(R.verifierAllocation({BIN1:0,BIN2:2},["BIN1","BIN2"],2),2);
});
test("une somme de bins fausse est refusée",()=>{
  assert.throws(()=>R.verifierAllocation({BIN1:1,BIN2:1},["BIN1","BIN2"],4),/au lieu de 4/);
});
test("trois dates et séquences donnent trois clés indépendantes",()=>{
  const base={sha:"a".repeat(64),feuille:"LISTE DES STOCK",ligne:248,direction:"OUT"};
  const keys=["2026-08-19","2026-08-21","2026-08-25"].map((date,i)=>R.cleEvenement({...base,date,sequence:i+1}));
  assert.strictEqual(new Set(keys).size,3);
});
test("la quantité de la ligne 167 n'est jamais fusionnée en 6",()=>{
  const x=mouvements.filter((m)=>m.ligne.provenance.ligne===167);
  assert.deepStrictEqual(x.map((m)=>m.quantite),[4,2]);
});
test("la migration impose l'unicité de l'événement métier",()=>{
  const sql=require("fs").readFileSync(require("path").join(__dirname,"../sql/070_repartitions_separees.sql"),"utf8");
  assert.match(sql,/UNIQUE \(company_id, file_sha256, excel_sheet, excel_row, direction, effective_date, event_sequence\)/);
});

console.log(`\n${ok} réussis, ${process.exitCode?1:0} échoué(s)`);
