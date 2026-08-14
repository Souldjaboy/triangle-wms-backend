"use strict";

/**
 * IMPORT INVENTAIRE EXCEL — analyse et normalisation (phase PREVIEW).
 *
 * Ce module LIT et NORMALISE seulement. Il n'écrit rien en base : la phase
 * d'exécution devra passer par les services métier de stock existants, jamais
 * par un UPDATE direct de products.stock.
 *
 * Générique par construction (§20) : les colonnes sont reconnues par leurs
 * en-têtes et leurs alias, pas par leur position, afin de resservir aux
 * prochains inventaires.
 *
 * Règles métier appliquées ici :
 *  - « 1O » -> 10, « 2O » -> 20, « 100 EACH » -> 100, « 1 234 » -> 1234 ;
 *  - une cellule vide reste VIDE (jamais transformée en 0 silencieux) ;
 *  - les lignes TOTAL et les lignes sans description sont ignorées ;
 *  - plusieurs X dans BIN A/B/C décrivent l'occupation physique : la quantité
 *    de la ligne n'est JAMAIS multipliée ;
 *  - le nom d'origine est toujours conservé ; la normalisation ne sert qu'à
 *    comparer.
 */

const XLSX=require("xlsx");
const fs=require("fs");

/* Normalisation d'un libellé produit : majuscules, sans accents, ponctuation
   unifiée, espaces réduits. Sert UNIQUEMENT à comparer — le nom d'origine est
   toujours conservé pour l'affichage et l'écriture en base. */
function normName(s){
  return String(s||"").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g,"")
    .replace(/[’']/g,"'").replace(/[^A-Z0-9'\/\.\*\-\s]/g," ")
    .replace(/\s+/g," ").trim();
}
/* Quantité : gère "1O", "2O", "100 EACH", "1 234", "12,5", vide. */
function parseQty(v){
  if(v===null||v===undefined||v==="") return {n:0,empty:true,raw:v};
  if(typeof v==="number") return {n:v,empty:false,raw:v};
  const raw=String(v); let s=raw.trim();
  s=s.replace(/\b(EACH|EA|PCS?|BOX|UNIT[ES]?)\b/gi,"").trim();
  s=s.replace(/[Oo](?=\d)/g,"0").replace(/(?<=\d)[Oo]/g,"0");
  s=s.replace(/\s+/g,"").replace(/,(?=\d{3}(\D|$))/g,"").replace(",",".");
  if(s==="") return {n:0,empty:true,raw};
  const n=Number(s);
  return Number.isFinite(n)?{n,empty:false,raw,corrected:raw.trim()!==String(n)}:{n:0,empty:true,raw,bad:true};
}
/* Distance de Levenshtein bornée, pour SUGGÉRER une correspondance seulement. */
function lev(a,b){
  if(a===b) return 0;
  const m=a.length,n=b.length; if(!m||!n) return Math.max(m,n);
  let prev=Array.from({length:n+1},(_,j)=>j);
  for(let i=1;i<=m;i++){ const cur=[i];
    for(let j=1;j<=n;j++) cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
    prev=cur; }
  return prev[n];
}
const similarity=(a,b)=>{const M=Math.max(a.length,b.length);return M?1-lev(a,b)/M:1;};

function readCsv(p){
  const txt=fs.readFileSync(p,"utf8").replace(/^﻿/,"");
  const lines=txt.split(/\r?\n/).filter(l=>l.trim()!=="");
  const split=l=>{const o=[];let c="",q=false;
    for(let i=0;i<l.length;i++){const ch=l[i];
      if(ch==='"'){ if(q&&l[i+1]==='"'){c+='"';i++;} else q=!q; }
      else if(ch===","&&!q){o.push(c);c="";} else c+=ch;}
    o.push(c);return o;};
  const H=split(lines[0]);
  return lines.slice(1).map(l=>{const v=split(l);const o={};H.forEach((h,i)=>o[h.trim()]=v[i]!==undefined?v[i].trim():"");return o;});
}
/* Accepte un chemin OU un Buffer : l'upload HTTP fournit un Buffer. */
function openWorkbook(src){
  return Buffer.isBuffer(src) ? XLSX.read(src,{type:"buffer"}) : XLSX.readFile(src);
}
function readStockSheet(src){
  const wb=openWorkbook(src);
  const rows=XLSX.utils.sheet_to_json(wb.Sheets["LISTE DES STOCK"],{header:1,defval:null,raw:true});
  let h=-1; rows.forEach((r,i)=>{if(h<0&&r.some(c=>String(c||"").toUpperCase().includes("ITEM DESCRIPTION")))h=i;});
  const H=rows[h].map(c=>String(c||"").toUpperCase().trim());
  const col=(...n)=>{for(const x of n){const i=H.indexOf(x);if(i>=0)return i;}return -1;};
  const C={desc:col("ITEM DESCRIPTION","ITEMS DESCRIPTION","DESCRIPTION"),row:col("ROW","RAYON"),
    loc:col("LOCATION","EMPLACEMENT"),lvl:col("LEVEL","NIVEAU"),bin:col("BIN"),
    qty:col("QUANTITIES","QUANTITY","QTY"),unit:col("UNITE","UNIT"),
    inn:col("IN/EACH","IN","ENTREE"),out:col("OUT/EACH","OUT","SORTIE")};
  const out=[];
  for(let i=h+2;i<rows.length;i++){
    const r=rows[i]; if(!r) continue;
    const d=String(r[C.desc]||"").trim();
    if(!d||/^(TOTAL|TOTAUX|SOUS.?TOTAL)/i.test(d)) continue;
    const q=parseQty(r[C.qty]), qi=parseQty(r[C.inn]), qo=parseQty(r[C.out]);
    out.push({excelRow:i+1,desc:d,norm:normName(d),
      row:r[C.row]!=null?String(r[C.row]).trim():"",loc:r[C.loc]!=null?String(r[C.loc]).trim():"",
      level:r[C.lvl]!=null?String(r[C.lvl]).trim():"",
      bins:[0,1,2].map(k=>String(r[C.bin]+k>=0?r[C.bin+k]:"" ||"").trim().toUpperCase()==="X"),
      qty:q,in:qi,out:qo,unit:String(r[C.unit]||"EACH").trim()});
  }
  return out;
}
/* Feuille WRITE OFF : deux listes côte à côte. Seule la seconde (« LISTE DES
   WRITE OFF 2 ») contient les NOUVEAUX rebuts ; la première est l'historique
   déjà enregistré et ne doit jamais être réimportée. */
function readWriteOffSheet(src){
  const wb=openWorkbook(src);
  const ws=wb.Sheets["WRITE OFF"]; if(!ws) return [];
  const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:null,raw:true});
  const out=[];
  for(let i=2;i<rows.length;i++){
    const r=rows[i]||[];
    const d=r[7]!=null?String(r[7]).trim():"";
    if(!d||/^LISTE|^ITEM/i.test(d)) continue;
    const q=parseQty(r[10]);
    if(q.n>0) out.push({desc:d,quantity:q.n,excelRow:i+1});
  }
  return out;
}

/* Feuilles de réception W-EM2S-A / B / C. Le numéro de container et la date
   figurent sur une ligne d'en-tête et valent pour les lignes qui suivent —
   on les propage jusqu'au prochain en-tête. W-EM2S-B ne contient que des
   en-têtes répétés : elle produit donc zéro réception, ce qui est correct. */
function readReceptionSheets(src, sheetNames=["W-EM2S-A","W-EM2S-B","W-EM2S-C"]){
  const wb=openWorkbook(src); const out=[];
  for(const name of sheetNames){
    const ws=wb.Sheets[name]; if(!ws) continue;
    const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:null,raw:true});
    let container=null, date=null;
    for(let i=0;i<rows.length;i++){
      const r=rows[i]||[];
      const c0=r[0]!=null?String(r[0]).trim():"";
      const c2=r[2]!=null?String(r[2]).trim():"";
      if(/CONTAINER NUMBER/i.test(c0)||/^DATE/i.test(c2)){
        // Ligne d'en-tête : mémorise container et date pour les lignes suivantes.
        const mC=c0.match(/[A-Z]{3,4}\s*:?\s*[\d\/ ]{5,}/i); if(mC) container=mC[0].trim();
        const mD=c2.replace(/^DATE\s*:?\s*/i,"").trim(); if(mD) date=mD;
        continue;
      }
      if(/RECEIVED ITEMS/i.test(c0)) continue;
      const desc=r[4]!=null?String(r[4]).trim():"";
      if(!desc||/ITEMS? DESCRIPTION/i.test(desc)) continue;
      const q=parseQty(r[8]);
      if(!(q.n>0)) continue;
      out.push({sheet:name,warehouse:name,container,date,desc,norm:normName(desc),
                unit:r[7]!=null?String(r[7]).trim():"EA",quantity:q.n,excelRow:i+1});
    }
  }
  return out;
}

module.exports={normName,parseQty,similarity,readCsv,readStockSheet,readWriteOffSheet,readReceptionSheets,openWorkbook,XLSX};
