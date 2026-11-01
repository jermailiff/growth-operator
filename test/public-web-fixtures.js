import { WEB_SCOPE_RULES, WEB_PAGE_TYPES } from '../src/prospecting.js';
export const webPlan = { provider: 'public_web', scope: { sourceMode: 'exact_hosts', pageTypes: [...WEB_PAGE_TYPES], ...WEB_SCOPE_RULES }, audienceHypothesis: 'Find workshop staff for a repair partnership.', companies: ['Example Workshop'], locations: ['Oakland'], titles: [], sourceDomains: ['workshop.example'], cohortSize: 3, maxCalls: 5, deadlineSeconds: 180, segmentHypothesis: 'Test interest in repair referrals; no demand established.' };
export const sourceUrl = 'https://workshop.example/team';
export const fact = value => ({ value, sourceUrl, support: 'Source-attributed: ' + value });
export const candidate = () => ({ name: fact('Taylor Example'), company: fact('Example Workshop'), location: fact('Oakland'), title: fact('Manager'), contact: { type: 'published_professional_email', value: 'taylor@workshop.example', sourceUrl, support: 'Professional enquiries: taylor@workshop.example' }, employmentStatus: 'current_source_claim', unknowns: ['Interest in referrals is unknown.'] });
export const webPayload = (candidates = [candidate()]) => ({ model: 'mock-resolved', status: 'completed', usage: { output_tokens: 900 }, output: [
  { type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['site:workshop.example team'], sources: [{ url: sourceUrl }] } },
  { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ candidates, sourceDetails: [{ url: sourceUrl, pageType: 'company_biography', publishedDate: 'not stated', linkedFrom: '', linkSupport: '' }], incidents: [], limitations: ['Small bounded public sample; no outreach occurred.'], scopeCompliant: true }), annotations: [{ type: 'url_citation', url: sourceUrl, start_index: 0, end_index: 1 }] }] }
] });
