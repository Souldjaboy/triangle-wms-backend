"use strict";
const { error } = require('./model');
async function read(db, userId, companyId) {
  const owner=(await db.query('SELECT user_id FROM dt_module_owner WHERE singleton=TRUE')).rows[0];
  if(!owner) throw error('Accès privé non configuré.',503);
  const isOwner=Number(owner.user_id)===Number(userId);
  const grant=isOwner ? true : (await db.query('SELECT allowed FROM dt_module_access WHERE company_id=$1 AND user_id=$2',[companyId,userId])).rows[0]?.allowed === true;
  return {isOwner,canView:grant};
}
function requireOwner(ctx) {
  if(!ctx.canManageAccess) throw error('Gestion des accès réservée au propriétaire.',403);
}
async function list(db,ctx,query='') {
  requireOwner(ctx);
  const q=String(query||'').trim().slice(0,160);
  return (await db.query(`SELECT u.id,u.fullname,u.email,u.role,u.is_active,
    COALESCE(a.allowed,FALSE) AS allowed,(u.id=o.user_id) AS is_owner
    FROM users u CROSS JOIN dt_module_owner o
    LEFT JOIN dt_module_access a ON a.user_id=u.id AND a.company_id=$1
    WHERE (u.company_id=$1 OR EXISTS(SELECT 1 FROM user_company_access c WHERE c.user_id=u.id AND c.company_id=$1 AND c.is_active=TRUE))
    AND ($2='' OR strpos(lower(COALESCE(u.email,'') || ' ' || COALESCE(u.fullname,'')),lower($2))>0)
    ORDER BY (u.id=o.user_id) DESC,lower(COALESCE(u.fullname,'')),u.id LIMIT 100`,[ctx.companyId,q])).rows;
}
async function set(db,ctx,req,id,allowed) {
  requireOwner(ctx);
  if(typeof allowed!=='boolean') throw error('La valeur Autoriser doit être un booléen.');
  if(!Number.isSafeInteger(id)||id<=0) throw error('Compte invalide.');
  // Serialize grant changes and preserve a coherent before/after audit.
  await db.query('SELECT pg_advisory_xact_lock($1,$2)',[ctx.companyId,id]);
  const owner=(await db.query('SELECT user_id FROM dt_module_owner WHERE singleton=TRUE')).rows[0];
  if(Number(owner?.user_id)!==Number(ctx.user.id)) throw error('Gestion des accès réservée au propriétaire.',403);
  if(Number(owner.user_id)===id) throw error('L’accès du propriétaire est permanent.');
  const target=(await db.query(`SELECT u.id,u.is_active FROM users u WHERE u.id=$1 AND
    (u.company_id=$2 OR EXISTS(SELECT 1 FROM user_company_access c WHERE c.user_id=u.id AND c.company_id=$2 AND c.is_active=TRUE)) FOR UPDATE OF u`,[id,ctx.companyId])).rows[0];
  if(!target) throw error('Compte introuvable dans cette entreprise.',404);
  if(allowed && target.is_active!==true) throw error('Ce compte est désactivé.');
  const before=(await db.query('SELECT allowed FROM dt_module_access WHERE company_id=$1 AND user_id=$2',[ctx.companyId,id])).rows[0]?.allowed === true;
  await db.query(`INSERT INTO dt_module_access(company_id,user_id,allowed,updated_by) VALUES($1,$2,$3,$4)
    ON CONFLICT(company_id,user_id) DO UPDATE SET allowed=EXCLUDED.allowed,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,[ctx.companyId,id,allowed,ctx.user.id]);
  await db.query(`INSERT INTO audit_logs(user_id,user_email,user_role,company_id,action,entity_type,entity_id,ip_address,user_agent,details)
    VALUES($1,$2,$3,$4,$5,'digital_twin_access',$6,$7,$8,$9)`,[ctx.user.id,ctx.user.email,ctx.user.role,ctx.companyId,
    allowed?'digital_twin.access.grant':'digital_twin.access.revoke',id,req.ip||'',req.get('user-agent')||'',JSON.stringify({before,after:allowed})]);
  return {user_id:id,allowed};
}
module.exports={read,list,set,requireOwner};
