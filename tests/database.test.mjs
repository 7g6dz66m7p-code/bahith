import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const ids = {a:'00000000-0000-0000-0000-000000000001',b:'00000000-0000-0000-0000-000000000002',u:'00000000-0000-0000-0000-000000000003',v:'00000000-0000-0000-0000-000000000004',pa:'00000000-0000-0000-0000-000000000005',pb:'00000000-0000-0000-0000-000000000006'};
test('PostgreSQL migration and tenant authorization integration',async t=>{
 const db=new PGlite();
 try {
 await db.exec(await readFile(new URL('../db/migrations/001_foundation.sql',import.meta.url),'utf8'));
 await db.exec(`INSERT INTO bahith.users(id,subject) VALUES ('${ids.u}','test-owner'),('${ids.v}','test-viewer');
 INSERT INTO bahith.workspaces(id,name) VALUES ('${ids.a}','A'),('${ids.b}','B');
 INSERT INTO bahith.memberships VALUES ('${ids.a}','${ids.u}','owner'),('${ids.b}','${ids.v}','viewer');
 INSERT INTO bahith.projects(id,workspace_id,title) VALUES ('${ids.pa}','${ids.a}','A project'),('${ids.pb}','${ids.b}','B project');
 SET ROLE bahith_app;`);
 const ctx=async(u,w)=>{ await db.query("SELECT set_config('app.user_id',$1,false),set_config('app.workspace_id',$2,false)",[u,w]); };
 await t.test('missing context returns no records',async()=>assert.equal((await db.query('SELECT * FROM bahith.projects')).rows.length,0));
 await ctx(ids.u,ids.a);
 await t.test('member sees only own workspace',async()=>assert.deepEqual((await db.query('SELECT title FROM bahith.projects')).rows,[{title:'A project'}]));
 await t.test('cross-tenant reads return empty',async()=>assert.equal((await db.query('SELECT * FROM bahith.projects WHERE id=$1',[ids.pb])).rows.length,0));
 await t.test('cross-tenant insert rejected',async()=>assert.rejects(db.query('INSERT INTO bahith.projects(workspace_id,title) VALUES ($1,$2)',[ids.b,'bad'])));
 await t.test('cross-tenant foreign key rejected',async()=>assert.rejects(db.query('INSERT INTO bahith.sources(workspace_id,project_id,title) VALUES ($1,$2,$3)',[ids.a,ids.pb,'bad link'])));
 await ctx(ids.u,ids.b);
 await t.test('forged workspace context without membership fails',async()=>assert.equal((await db.query('SELECT * FROM bahith.projects')).rows.length,0));
 await ctx(ids.v,ids.b);
 await t.test('viewer may read',async()=>assert.equal((await db.query('SELECT * FROM bahith.projects')).rows.length,1));
 await t.test('viewer cannot insert',async()=>assert.rejects(db.query('INSERT INTO bahith.projects(workspace_id,title) VALUES ($1,$2)',[ids.b,'bad'])));
 await t.test('viewer cannot update',async()=>assert.equal((await db.query("UPDATE bahith.projects SET title='bad' RETURNING id")).rows.length,0));
 await t.test('cannot self-upgrade role',async()=>assert.rejects(db.exec("UPDATE bahith.memberships SET role='owner'")));
 await t.test('cannot overwrite human review',async()=>assert.rejects(db.exec("UPDATE bahith.reviews SET verdict='supported'")));
 await t.test('reviewed evidence cannot be rewritten',async()=>assert.rejects(db.exec("UPDATE bahith.evidence SET quote='forged'")));
 await t.test('source versions cannot be rewritten',async()=>assert.rejects(db.exec("UPDATE bahith.source_versions SET parser_version='forged'")));
 await t.test('application role cannot bypass RLS',async()=>{const r=await db.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");assert.deepEqual(r.rows,[{rolsuper:false,rolbypassrls:false}]);});
 } finally {await db.close();}
});
