import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvidence, canApproveClaim } from '../packages/core/src/evidence.ts';
import { transition } from '../packages/core/src/contracts.ts';
const e = { workspaceId:'a', sourceVersionId:'v1', metadataVerified:true,
  availability:'fulltext', sourceText:'نص موثق', quote:'نص', start:0, end:2,
  locator:{kind:'pdf_page',index:1}, review:'supported', reviewerId:'human-1' };
test('exact Arabic excerpt with human review can pass structural gate',()=>assert.equal(canApproveClaim('a','fact',[e]),true));
test('cross-tenant evidence denied',()=>assert.ok(validateEvidence('b',e).includes('TENANT_MISMATCH')));
test('fabricated quotation denied',()=>assert.equal(canApproveClaim('a','fact',[{...e,quote:'مختلق'}]),false));
test('metadata does not establish a claim',()=>assert.equal(canApproveClaim('a','fact',[{...e,availability:'metadata_only'}]),false));
test('abstract-only evidence cannot approve fulltext finding',()=>assert.equal(canApproveClaim('a','fact',[{...e,availability:'abstract'}]),false));
test('missing and invalid page locators rejected',()=>assert.ok(validateEvidence('a',{...e,locator:{kind:'pdf_page',index:0}}).length));
test('human review required',()=>assert.equal(canApproveClaim('a','fact',[{...e,review:'pending'}]),false));
test('hypothesis is not an established result',()=>assert.equal(canApproveClaim('a','hypothesis',[e]),false));
test('empty evidence denied',()=>assert.equal(canApproveClaim('a','fact',[]),false));
test('contradicting evidence blocks approval',()=>assert.equal(canApproveClaim('a','inference',[e,{...e,review:'contradicted'}]),false));
test('terminal job cannot silently restart',()=>assert.throws(()=>transition('succeeded','running')));
test('job can pause for human review',()=>assert.equal(transition('running','awaiting_review'),'awaiting_review'));
