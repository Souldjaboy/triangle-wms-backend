const {test}=require('node:test');const assert=require('node:assert/strict');
const ts=require('../../../frontend/node_modules/typescript');
const {addStockEntry,envForDump}=require('../../scripts/update-digital-twin-private-vps.cjs');
const fs=require('fs'),os=require('os'),path=require('path');
test('public links become checked entry components without changing stock permission guards',()=>{
 for(const link of ['', '<Link href="/stocks/digital-twin">3D</Link>', '<a href="/stocks/digital-twin">Voir</a>']){
  const source='"use client"; export default function Page(){if(!canView)return <p>Refusé</p>;return <main><h1>Stocks</h1>'+link+'<p>Opérations inchangées</p></main>}';
  const result=addStockEntry(source,ts);
  assert.ok(result.includes('<DigitalTwinEntry />'));assert.ok(!result.includes('href="/stocks/digital-twin"'));assert.ok(result.includes('if(!canView)return <p>Refusé</p>'));assert.ok(result.includes('<p>Opérations inchangées</p>'));
  assert.equal(addStockEntry(result,ts),result);
 }
 assert.throws(()=>addStockEntry('"use client";export default ()=> <div/>',ts),/unique/);
});
test('database backup keeps password only in a private file',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'twin-private-'));
 try{const {env,pass}=envForDump('postgres://user:fake%3Asecret@localhost:5432/test',d);assert.ok(!JSON.stringify(env).includes('fake'));assert.equal(fs.statSync(pass).mode&0o777,0o600);assert.match(fs.readFileSync(pass,'utf8'),/fake\\:secret/);}finally{fs.rmSync(d,{recursive:true,force:true});}
});
