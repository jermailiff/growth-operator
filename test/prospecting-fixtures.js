export const plan = {
  provider: 'apollo', audienceHypothesis: 'Local facilities managers may need workshop maintenance.',
  companies: ['Example Manufacturing'], locations: ['Oakland'], titles: ['Facilities'],
  cohortSize: 2, poolSize: 4, maxEnrichments: 2, maxCalls: 3, maxCredits: 3, deadlineSeconds: 60,
  fields: [{field:'name',purpose:'Owner identification'}, {field:'company',purpose:'Audience fit'},
    {field:'title',purpose:'Role fit'}, {field:'location',purpose:'Service area'}, {field:'businessEmail',purpose:'Contact route for review only'}],
  segmentHypothesis: 'Test whether facilities teams want preventive maintenance.'
};
export const person = (id, extra = {}) => ({
  id, first_name: 'Synthetic', last_name: id, title: 'Facilities Manager', city: 'Oakland', state: 'California',
  organization: { id: 'org', name: 'Example Manufacturing' }, ...extra
});
export function fakeApollo(responses, calls = []) {
  return async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body), signal: options.signal });
    if (!responses.length) throw Error('Unexpected extra provider call.');
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.payload ?? next), { status: next.httpStatus || 200,
      headers: { 'x-request-id': 'synthetic', 'x-rate-limit-minute':'50' } });
  };
}
export const responses = () => [
  { organizations: [{ id: 'org', name: 'Example Manufacturing' }], credits_consumed: 1 },
  { people: ['p1','p2','p3','p4'].map(id => person(id)) },
  { matches: ['p1','p2'].map(id => person(id, {email: id + '@example.test', email_status:'verified',match_confidence:'high'})), credits_consumed:2 }
];
