import { createAppServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { ApolloProvider } from '../src/providers/apollo.js';
import { state, decision } from '../test/helpers.js';
import { plan, responses, fakeApollo } from '../test/prospecting-fixtures.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try {
 for (const scenario of ['cohort-review','provider-failure','strategy-failure','no-enrichment']) {
  const directory=await mkdtemp(join(tmpdir(),'m3-browser-'));await writeFile(join(directory,'state.json'),JSON.stringify(state));
  const store=new Store(directory), calls=[], contexts=[],errors=[];
  const request=scenario==='no-enrichment'?{...plan,fields:plan.fields.filter(f=>f.field!=='businessEmail')}:plan;
  const queue=scenario==='provider-failure'?[{httpStatus:403,payload:{error:'Synthetic source restriction'}}]:responses();
  const server=createAppServer({store,model:{name:'mock',decide:async c=>{contexts.push(c);return {model:'mock',decision:{...decision,ownerInputRequired:false,ownerApprovalRequired:true},prospectRequest:request};}},
   prospectProvider:new ApolloProvider({apiKey:'fake',fetchImpl:fakeApollo(queue,calls)}),makeDecision:()=>({decide:async c=>{
    if(scenario==='strategy-failure')throw Error('Synthetic strategy failure');
    return {model:'mock',decision:{...decision,recommendedNextStep:'Review the prepared cohort.',evidenceUsed:c.evidenceUsedOptions,ownerInputRequired:false}};
   }})});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));await server.initialize();
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
  try {
   await page.goto('http://127.0.0.1:'+server.address().port);
   await page.waitForFunction(()=>!document.querySelector('#run').disabled);
   await page.locator('#run').click();await page.waitForFunction(()=>!document.querySelector('#run').disabled);
   assert.equal(calls.length,0);
   await page.getByRole('button',{name:'Approve & build cohort',exact:true}).click();
   await page.waitForFunction(()=>!document.querySelector('#run').disabled);
   const content=await page.locator('#decisions').innerText();
   if(scenario==='provider-failure') {
    assert.match(content,/Synthetic source restriction/);assert.match(content,/could not finish/);assert.equal(calls.length,1);
   } else {
    assert.equal(await page.locator('.prospect').count(),2);
    assert.equal(calls.length,scenario==='no-enrichment'?2:3);
    if(scenario==='strategy-failure')assert.match(content,/could not finish/);
    assert.match(content,/not independent verification/);
    await page.getByLabel('Review apollo:p1',{exact:true}).selectOption('approve');
    await page.getByLabel('Review apollo:p2',{exact:true}).selectOption('reject');
    await page.getByLabel('Reason apollo:p2',{exact:true}).fill('  Not my audience\nPlease keep my wording.  ');
    await page.getByLabel('Correction apollo:p2',{exact:true}).fill('Different role');
    await page.getByLabel('Minutes spent reviewing this cohort',{exact:true}).fill('8');
    await page.getByLabel('Did you need additional manual research? Describe briefly, or say no.',{exact:true}).fill('No');
    await page.getByLabel('Roughly how many minutes would equivalent prospecting normally take you?',{exact:true}).fill('40');
    await page.getByRole('button',{name:'Save cohort review',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Review recorded'));
    assert.match(await page.locator('#decisions').innerText(),/1 of 2 worth contacting; 1 rejected/);
    const snapshot=await store.read();const review=snapshot.history[1].cohortReview;
    assert.equal(review.reviews[1].reason,'  Not my audience\nPlease keep my wording.  ');
    assert.equal(review.metrics.normalMinutes,40);
    await page.locator('#run').click();await page.waitForFunction(()=>!document.querySelector('#run').disabled);
    assert.equal(contexts[1].decisionHistory[1].outcomes[0].cohortReview.reviews[1].correction,'Different role');
    assert.equal(await page.getByLabel('Minutes spent reviewing this cohort',{exact:true}).count(),0);
   }
   assert.deepEqual(errors,[]);console.log('PASS M3 browser '+scenario);
  } finally {await page.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});await rm(directory,{recursive:true,force:true});}
 }
} finally {await browser.close();}
