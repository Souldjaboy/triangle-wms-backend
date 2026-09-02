"use strict";

const crypto = require("crypto");

const directionDe = (sens) => ({ "Entrée": "IN", "Sortie": "OUT" }[sens] || sens);
const sensDe = (direction) => ({ IN: "Entrée", OUT: "Sortie" }[direction] || direction);
const cleEvenement = ({ sha, feuille, ligne, direction, date, sequence }) =>
  crypto.createHash("sha256").update([sha, feuille, ligne, direction, date, sequence].join("\u001f")).digest("hex");

function erreur(message, code, httpStatus = 400) {
  const e = new Error(message); e.code = code; e.httpStatus = httpStatus; return e;
}

function verifierAllocation(allocation, bins, attendu) {
  if (!allocation || typeof allocation !== "object" || Array.isArray(allocation))
    throw erreur("Indiquez une quantité par bin.", "BINS_REQUIRED");
  const autorises = new Set(bins || []);
  const inconnus = Object.keys(allocation).filter((b) => !autorises.has(b));
  if (inconnus.length) throw erreur(`Bin hors de cet événement : ${inconnus.join(", ")}.`, "BIN_UNKNOWN");
  const valeurs = Object.values(allocation).map(Number);
  if (valeurs.some((q) => !Number.isFinite(q) || q < 0))
    throw erreur("Les quantités doivent être des nombres positifs ou nuls.", "INVALID_QUANTITY");
  const somme = valeurs.reduce((s, q) => s + q, 0);
  if (somme !== Number(attendu))
    throw erreur(`La répartition totalise ${somme} au lieu de ${attendu}.`, "ALLOCATION_MISMATCH");
  return somme;
}

async function auditer(client, { companyId, type, id, action, avant, apres, motif, userId }) {
  await client.query(
    `INSERT INTO stock_import_allocation_audit
       (company_id, entity_type, entity_id, action, before_value, after_value, reason, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [companyId, type, id, action, avant ? JSON.stringify(avant) : null,
     apres ? JSON.stringify(apres) : null, motif || null, userId || null]);
}

async function creerEvenement(client, { companyId, batchId, sha, mouvement, date, sequence = 1 }) {
  const direction = directionDe(mouvement.sens);
  const key = cleEvenement({ sha, feuille: mouvement.provenance.feuille,
    ligne: mouvement.provenance.ligne, direction, date, sequence });
  const { rows } = await client.query(
    `INSERT INTO stock_import_movement_events
       (company_id,batch_id,file_sha256,excel_sheet,excel_row,excel_cell,event_key,
        direction,effective_date,event_sequence,quantity,allowed_bins,source_context)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (company_id,event_key) DO UPDATE SET batch_id=EXCLUDED.batch_id
     RETURNING *`,
    [companyId,batchId,sha,mouvement.provenance.feuille,mouvement.provenance.ligne,
     mouvement.provenance.cellule,key,direction,date,sequence,mouvement.quantite,
     JSON.stringify(mouvement.bins||[]),JSON.stringify({description:mouvement.description,
       rayon:mouvement.rayon,location:mouvement.location,niveau:mouvement.niveau,
       zoneSansRack:mouvement.zoneSansRack})]);
  const event = rows[0];
  await client.query(
    `INSERT INTO stock_import_movement_allocations
       (company_id,movement_event_id,expected_quantity)
     VALUES ($1,$2,$3) ON CONFLICT (movement_event_id) DO NOTHING`,
    [companyId,event.id,event.quantity]);
  if((mouvement.bins||[]).length===0){
    await client.query(`UPDATE stock_import_movement_allocations SET allocation=$1,
      status='VALIDATED',validated_at=now() WHERE movement_event_id=$2`,
      [JSON.stringify({__LOCATION__:Number(event.quantity)}),event.id]);
    await client.query(`UPDATE stock_import_movement_events SET status='READY' WHERE id=$1`,[event.id]);
  }
  return event;
}

async function synchroniser(client, { companyId, batchId, sha, apercu }) {
  let crees = 0, enAttenteDates = 0;
  for (const m of apercu.mouvements.liste) {
    if ((m.datesProposees || []).length > 1) { enAttenteDates += 1; continue; }
    if (!m.date) { enAttenteDates += 1; continue; }
    const avant = await client.query(`SELECT count(*)::int n FROM stock_import_movement_events
      WHERE company_id=$1 AND event_key=$2`, [companyId, cleEvenement({ sha,
      feuille:m.provenance.feuille, ligne:m.provenance.ligne, direction:directionDe(m.sens),
      date:m.date, sequence:1 })]);
    await creerEvenement(client, { companyId,batchId,sha,mouvement:m,date:m.date });
    if (avant.rows[0].n === 0) crees += 1;
  }
  return { crees, enAttenteDates };
}

async function validerStock(client,{companyId,batchId,sha,feuille,ligne,attendu,allocation,bins,userId}) {
  verifierAllocation(allocation,bins,attendu);
  const {rows}=await client.query(
    `INSERT INTO stock_import_stock_allocations
       (company_id,batch_id,file_sha256,excel_sheet,excel_row,expected_quantity,
        allocation,status,validated_by,validated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'VALIDATED',$8,now())
     ON CONFLICT (company_id,file_sha256,excel_sheet,excel_row) DO UPDATE
       SET allocation=EXCLUDED.allocation,status='VALIDATED',version=stock_import_stock_allocations.version+1,
           validated_by=EXCLUDED.validated_by,validated_at=now(),updated_at=now()
       WHERE stock_import_stock_allocations.status IN ('OPEN','REOPENED')
     RETURNING *`,[companyId,batchId||null,sha,feuille,ligne,attendu,
      JSON.stringify(allocation),userId||null]);
  if(!rows[0]) throw erreur("Cette répartition du stock est déjà validée.","ALREADY_VALIDATED",409);
  await auditer(client,{companyId,type:"STOCK_ALLOCATION",id:rows[0].id,action:"VALIDATE",
    apres:rows[0],userId});
  return rows[0];
}

async function reouvrirStock(client,{companyId,id,motif,userId}) {
  if(!String(motif||"").trim()) throw erreur("Un motif est obligatoire.","REASON_REQUIRED");
  const {rows}=await client.query(`SELECT * FROM stock_import_stock_allocations
    WHERE id=$1 AND company_id=$2 FOR UPDATE`,[id,companyId]);
  const a=rows[0];
  if(!a) throw erreur("Répartition introuvable.","NOT_FOUND",404);
  if(a.status!=="VALIDATED") throw erreur("Seule une répartition validée peut être rouverte.","NOT_VALIDATED",409);
  const {rows:maj}=await client.query(`UPDATE stock_import_stock_allocations
    SET status='REOPENED',version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[id]);
  await auditer(client,{companyId,type:"STOCK_ALLOCATION",id,action:"REOPEN",avant:a,
    apres:maj[0],motif,userId});
  return maj[0];
}

async function ventilerDates(client, { companyId, batchId, sha, mouvement, fractions, userId }) {
  if (!Array.isArray(fractions) || fractions.length === 0)
    throw erreur("Renseignez les quantités par date.", "DATE_SPLIT_REQUIRED");
  const datesPermises = new Set(mouvement.datesProposees || []);
  const normalisees = fractions.map((f, i) => ({
    date: String(f.date || ""), quantity: Number(f.quantity), sequence: Number(f.sequence || i + 1),
  }));
  if (normalisees.some((f) => !datesPermises.has(f.date)))
    throw erreur("Une date ne figure pas dans la cellule Excel.", "DATE_UNKNOWN");
  if (normalisees.some((f) => !Number.isFinite(f.quantity) || f.quantity <= 0))
    throw erreur("Chaque fraction doit porter une quantité strictement positive.", "INVALID_QUANTITY");
  if (normalisees.reduce((s,f)=>s+f.quantity,0) !== Number(mouvement.quantite))
    throw erreur("La somme des fractions doit égaler la quantité totale du mouvement.", "DATE_SPLIT_MISMATCH");
  const uniques = new Set(normalisees.map((f)=>`${f.date}:${f.sequence}`));
  if (uniques.size !== normalisees.length) throw erreur("Deux fractions ont la même date et séquence.", "DUPLICATE_FRACTION");

  const existants = await client.query(
    `SELECT * FROM stock_import_movement_events WHERE company_id=$1 AND file_sha256=$2
      AND excel_sheet=$3 AND excel_row=$4 AND direction=$5 FOR UPDATE`,
    [companyId,sha,mouvement.provenance.feuille,mouvement.provenance.ligne,directionDe(mouvement.sens)]);
  if (existants.rows.some((e) => e.status === "IMPORTED"))
    throw erreur("Une fraction déjà importée ne peut pas être remplacée.", "ALREADY_IMPORTED", 409);
  if (existants.rows.length) throw erreur("Cette ventilation existe déjà.", "ALREADY_SPLIT", 409);

  const events = [];
  for (const f of normalisees) {
    const event = await creerEvenement(client, { companyId,batchId,sha,
      mouvement:{...mouvement,quantite:f.quantity},date:f.date,sequence:f.sequence });
    events.push(event);
    await auditer(client,{companyId,type:"MOVEMENT_EVENT",id:event.id,action:"CREATE",
      apres:event,userId});
  }
  return events;
}

async function validerMouvement(client, { companyId, eventId, allocation, bins, userId, version }) {
  const { rows } = await client.query(
    `SELECT e.*,a.id allocation_id,a.allocation,a.status allocation_status,a.version
       FROM stock_import_movement_events e JOIN stock_import_movement_allocations a
         ON a.movement_event_id=e.id
      WHERE e.id=$1 AND e.company_id=$2 FOR UPDATE OF e,a`, [eventId,companyId]);
  const e = rows[0];
  if (!e) throw erreur("Événement introuvable.", "NOT_FOUND", 404);
  if (version != null && Number(version) !== e.version) throw erreur("Cette fiche a changé. Rechargez-la.", "STALE_VERSION", 409);
  if (e.allocation_status === "VALIDATED") throw erreur("Cette répartition est déjà validée.", "ALREADY_VALIDATED", 409);
  verifierAllocation(allocation,bins,e.quantity);
  const avant={allocation:e.allocation,status:e.allocation_status,version:e.version};
  const { rows: maj } = await client.query(
    `UPDATE stock_import_movement_allocations SET allocation=$1,status='VALIDATED',
       version=version+1,validated_by=$2,validated_at=now(),updated_at=now()
     WHERE id=$3 RETURNING *`,[JSON.stringify(allocation),userId||null,e.allocation_id]);
  await client.query(`UPDATE stock_import_movement_events SET status='READY',updated_at=now() WHERE id=$1`,[e.id]);
  await auditer(client,{companyId,type:"MOVEMENT_ALLOCATION",id:e.allocation_id,
    action:e.allocation_status==="REOPENED"?"CORRECT":"VALIDATE",avant,apres:maj[0],userId});
  return {...e,allocation:maj[0]};
}

async function reouvrirMouvement(client,{companyId,eventId,motif,userId}) {
  if (!String(motif||"").trim()) throw erreur("Un motif est obligatoire.","REASON_REQUIRED");
  const { rows }=await client.query(`SELECT e.status event_status,a.* FROM stock_import_movement_events e
    JOIN stock_import_movement_allocations a ON a.movement_event_id=e.id
    WHERE e.id=$1 AND e.company_id=$2 FOR UPDATE OF e,a`,[eventId,companyId]);
  const a=rows[0];
  if(!a) throw erreur("Événement introuvable.","NOT_FOUND",404);
  if(a.event_status==="IMPORTED") throw erreur("Un mouvement importé ne peut pas être rouvert.","ALREADY_IMPORTED",409);
  if(a.status!=="VALIDATED") throw erreur("Seule une répartition validée peut être rouverte.","NOT_VALIDATED",409);
  const {rows:maj}=await client.query(`UPDATE stock_import_movement_allocations SET status='REOPENED',
    version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[a.id]);
  await client.query(`UPDATE stock_import_movement_events SET status='PENDING_ALLOCATION',updated_at=now() WHERE id=$1`,[eventId]);
  await auditer(client,{companyId,type:"MOVEMENT_ALLOCATION",id:a.id,action:"REOPEN",avant:a,
    apres:maj[0],motif,userId});
  return maj[0];
}

async function lister(client,{companyId,sha}) {
  const {rows}=await client.query(`SELECT e.*,a.allocation,a.status allocation_status,a.version
    FROM stock_import_movement_events e JOIN stock_import_movement_allocations a ON a.movement_event_id=e.id
    WHERE e.company_id=$1 AND ($2::text IS NULL OR e.file_sha256=$2)
    ORDER BY e.excel_sheet,e.excel_row,e.direction,e.effective_date,e.event_sequence`,[companyId,sha||null]);
  return rows;
}

module.exports={directionDe,sensDe,cleEvenement,verifierAllocation,synchroniser,
  validerStock,reouvrirStock,ventilerDates,validerMouvement,reouvrirMouvement,lister};
