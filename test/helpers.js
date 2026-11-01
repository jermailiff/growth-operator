import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

export const state = {
  businessContext: 'A wedding photographer with two available weekends this quarter.',
  objective: 'Book two additional weddings this quarter.',
  initiatives: [{ description: 'Test a referral partnership with local venues.', origin: 'owner', status: 'proposed' }],
  state: 'No partnership results have been observed yet.'
};
export const decision = {
  assessment: 'The partnership hypothesis has no observed results.',
  recommendedNextStep: 'Clarify whether partner venues have upcoming unfilled referrals.',
  reasoningSummary: 'The business has limited capacity and needs evidence of relevant demand.',
  evidenceUsed: ['businessContext: two available weekends this quarter.'],
  assumptions: ['Partners may receive relevant inquiries.'],
  importantUnknowns: ['Whether inquiries match the available dates.'],
  proposedAction: 'Prepare one question for the owner about existing venue relationships.',
  ownerApprovalRequired: false,
  ownerInputRequired: true,
  ownerRequirementDetails: 'Which venues have referred clients before?',
  intendedOutcomeOrEvidence: 'Identify an existing relationship worth investigating.',
  learnings: []
};
export async function temporaryStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'growth-v0-'));
  await writeFile(join(directory, 'state.json'), JSON.stringify(state));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new Store(directory);
}
