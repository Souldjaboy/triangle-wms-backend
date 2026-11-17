const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const A=require('../../digital-twin/access'),S=require('../../digital-twin/service');
let pg;
const req={user:{id:1},tenant_id:'triangle',headers:{},ip:'127.0.0.1',get:()=>'',body:{}};
const migration=fs.readFileSync(path.join(__dirname,'../../sql/065_digital_twin_private_access.sql'),'utf8').replace(/^\\.*$/gm,'');
const context=(id,only=false)=>S.context(pg,{...req,user:{id}},(_r,f)=>f,only);
before(async()=>{
 pg=new PGlite();await pg.exec(`
 CREATE TABLE companies(id integer primary key,tenant_id text);INSERT INTO companies VALUES(1,'triangle'),(2,'triangle'),(3,'other');
 CREATE TABLE users(id integer primary key,email text,fullname text,role text,company_id integer,is_active boolean,is_super_admin boolean,warehouse_id integer);
 INSERT INTO users VALUES(1,'Diallogcif@gmail.com','Propriétaire','super_admin',1,true,true,null),(2,'other@test','Autre super admin','super_admin',1,true,true,null),(3,'viewer@test','Lecteur','magasinier',1,true,false,1),(4,'outside@test','Autre société','admin',2,true,false,null),(5,'inactive@test','Inactif','admin',1,false,false,null);
 CREATE TABLE user_company_access(user_id integer,company_id integer,is_active boolean);
 CREATE TABLE permission_modules(module_key text,parent_key text,label text,description text,sort_order integer,is_active boolean,is_system boolean,actions text[]);
 CREATE TABLE role_permissions(company_id integer,role text,module_key text,action text,allowed boolean);
 INSERT INTO role_permissions VALUES(1,'magasinier','stock','view',true),(1,'magasinier','stock','visible',true);
 CREATE TABLE user_permission_overrides(company_id integer,user_id integer,module_key text,action text,effect text);
 CREATE TABLE user_permissions(user_id integer,module_key text,can_view boolean,can_create boolean,can_edit boolean,can_delete boolean,can_validate boolean);
 CREATE TABLE audit_logs(id serial primary key,user_id integer,user_email text,user_role text,company_id integer,action text,entity_type text,entity_id integer,ip_address text,user_agent text,details jsonb);
 CREATE TABLE products(id integer primary key,stock integer);INSERT INTO products VALUES(1,57);`);
 await pg.exec(migration);
});
after(async()=>{await pg.close();});
beforeEach(async()=>{await pg.exec("DELETE FROM dt_module_access;DELETE FROM user_permission_overrides;UPDATE users SET is_active=TRUE WHERE id=3");});
test('migration binds exactly the confirmed owner; no initial grant and no stock change',async()=>{
 assert.deepEqual((await pg.query('SELECT user_id FROM dt_module_owner')).rows,[{user_id:1}]);
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM dt_module_access')).rows[0].n,0);
 await pg.exec(migration);assert.equal((await pg.query('SELECT stock FROM products')).rows[0].stock,57);
 const ctx=await context(1);assert.equal(ctx.canManageAccess,true);assert.equal(ctx.canView,true);
});
test('other super admins and viewers are denied by default, including a fresh JWT',async()=>{
 for(const id of [2,3,4]) {await assert.rejects(()=>context(id),{status:403});assert.equal((await context(id,true)).canView,false);}
});
test('only owner grants and revokes; revocation is rechecked without logging out',async()=>{
 const owner=await context(1);await A.set(pg,owner,req,3,true);
 const viewer=await context(3);assert.equal(viewer.canView,true);assert.equal(viewer.canManageAccess,false);assert.equal(viewer.canConfigure,false);assert.equal(viewer.canPublish,false);
 await assert.rejects(()=>A.set(pg,viewer,req,2,true),{status:403});await assert.rejects(()=>A.list(pg,viewer),{status:403});
 await A.set(pg,owner,req,3,false);await assert.rejects(()=>context(3),{status:403});
 const logs=(await pg.query("SELECT action,details FROM audit_logs WHERE entity_id=3 ORDER BY id")).rows;
 assert.deepEqual(logs.map(l=>l.action),['digital_twin.access.grant','digital_twin.access.revoke']);assert.deepEqual(logs[1].details,{before:true,after:false});
});
test('generic role and permission changes cannot bypass the private gate',async()=>{
 await pg.query("INSERT INTO user_permission_overrides VALUES(1,3,'stock','view','ALLOW'),(1,3,'digital_twin','view','ALLOW')");
 await assert.rejects(()=>context(3),{status:403});
});
test('grant does not replace stock permission, active status or company membership',async()=>{
 const owner=await context(1);await A.set(pg,owner,req,3,true);
 await pg.query("INSERT INTO user_permission_overrides VALUES(1,3,'stock','view','DENY')");await assert.rejects(()=>context(3),{status:403});
 await pg.query('UPDATE users SET is_active=FALSE WHERE id=3');await assert.rejects(()=>context(3),{status:403});
 await assert.rejects(()=>A.set(pg,owner,req,4,true),{status:404});await assert.rejects(()=>A.set(pg,owner,req,5,true),{status:400});
});
test('owner cannot be revoked; strict boolean and company-scoped account listing',async()=>{
 const owner=await context(1);
 await assert.rejects(()=>A.set(pg,owner,req,1,false),{status:400});await assert.rejects(()=>A.set(pg,owner,req,3,'false'),{status:400});
 const users=await A.list(pg,owner);assert.ok(!users.some(u=>u.id===4));assert.equal((await A.list(pg,owner,'viewer@test')).length,1);
});
test('a granted super admin remains a viewer, cannot grant access or publish plans',async()=>{
 const owner=await context(1);await A.set(pg,owner,req,2,true);const other=await context(2);
 assert.equal(other.canView,true);assert.equal(other.canConfigure,false);assert.equal(other.canPublish,false);
 await assert.rejects(()=>A.set(pg,other,req,3,true),{status:403});
});
test('transaction rolls back grant if audit fails',async()=>{
 const owner=await context(1);await pg.exec('BEGIN');
 try{await pg.exec('ALTER TABLE audit_logs RENAME TO audit_logs_test');await assert.rejects(()=>A.set(pg,owner,req,3,true));}finally{await pg.exec('ROLLBACK');}
 assert.equal((await A.read(pg,3,1)).canView,false);
});
test('owner follows immutable user ID rather than a subsequently edited email',async()=>{
 await pg.query("UPDATE users SET email='changed@test' WHERE id=1");
 try{assert.equal((await context(1)).canManageAccess,true);await assert.rejects(()=>context(2),{status:403});}finally{await pg.query("UPDATE users SET email='Diallogcif@gmail.com' WHERE id=1");}
});

test('Express routes enforce private access, reject self-grants and require authentication without network sockets',async()=>{
 const express=require('express'),http=require('node:http'),{PassThrough}=require('node:stream');
 const app=express();
 const pool={query:(...args)=>pg.query(...args),connect:async()=>({query:(...args)=>pg.query(...args),release(){}})};
 const router=require('../../routes/digital-twin')({pool,getEffectiveCompanyId:(_r,f)=>f,authenticateToken:(r,res,next)=>{
   if(!r.headers.authorization)return res.status(401).json({error:'Non connecté'});
   r.user={id:Number(r.headers.authorization)};r.tenant_id='triangle';next();
 }});
 app.use('/digital-twin',router);
 async function call(url,id,method='GET',body={}){
   return new Promise((resolve,reject)=>{
     const req=new http.IncomingMessage(new PassThrough());Object.assign(req,{url:'/digital-twin'+url,method,headers:id?{authorization:String(id)}:{},body});
     const res=new http.ServerResponse(req);res.json=function(data){resolve({status:this.statusCode,data});return this;};
     app.handle(req,res,reject);
   });
 }
 assert.equal((await call('/access',null)).status,401);
 assert.equal((await call('/warehouses',2)).status,403);
 assert.deepEqual((await call('/access',2)).data,{canView:false,canManage:false});
 assert.equal((await call('/access/users/2',2,'PUT',{allowed:true})).status,403);
 assert.equal((await call('/access/users/3',1,'PUT',{allowed:true})).status,200);
 assert.deepEqual((await call('/access',3)).data,{canView:true,canManage:false});
 assert.equal((await call('/access/users',3)).status,403);
 assert.equal((await call('/access/users/3',1,'PUT',{allowed:false})).status,200);
 assert.equal((await call('/warehouses/1',3)).status,403);
});
