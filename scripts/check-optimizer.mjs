import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { default_w } from 'ts-fsrs';
const samples=[], logs=[];
for(let cid=1;cid<=80;cid++) {
 const reviews=[]; let time=Date.UTC(2026,0,1), previous=0;
 for(let j=0;j<6;j++) {
  const delta=j ? (cid+j)%6+1 : 0, rating=j&&((cid+j)%7===0)?1:((cid+j)%5===0?4:3);
  reviews.push({rating,delta_t:delta}); samples.push({cid,reviews:structuredClone(reviews)}); time+=delta*86400000;
  logs.push({cid,id:time,rating,interval:delta||1,last_interval:previous,duration:7000+(cid%10)*1000,kind:j?1:0}); previous=delta||1;
 }
}
const base={samples,logs,weights:[...default_w],health:true,relearning_steps:1,learning_steps:2,new_limit:10,review_limit:100,maximum_interval:36500,new_ignore_review:true,deck_size:80,cutoff:Math.round(Date.now()/1000)};
for(const action of ['optimize','retention']) {
 const start=Date.now();
 const result=await new Promise((resolve,reject)=>{
  const worker=new Worker(fs.readFileSync('optimizer/worker.cjs','utf8'),{eval:true,workerData:{wasm:fs.readFileSync('assets/optimizer.wasm').toString('base64'),input:{...base,action}}});
  let received=false;
  worker.on('message',m=>{ if(m.message) console.log(m.message); if(m.diagnostic) console.error(m.diagnostic); if(m.error) {reject(new Error(m.error));worker.terminate();} else if(m.result) {received=true;resolve(m.result);worker.terminate();} });
  worker.on('error',reject);worker.on('exit',c=>{if(!received&&c!==1) reject(new Error('No result '+c));});
 });
 if(action==='optimize') {assert.equal(result.weights.length,21);assert(result.weights.every(Number.isFinite));assert(Number.isFinite(result.after.logLoss));}
 else {assert.equal(result.rows.length,7);assert(result.recommended>=.7&&result.recommended<=.95);assert(result.rows.every(r=>Number.isFinite(r.minutesPerDay)));}
 console.log(action,JSON.stringify(result),Date.now()-start+'ms');
}
