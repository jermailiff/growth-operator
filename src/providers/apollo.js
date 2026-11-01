// Adapted from the old ApolloContactProvider: endpoint/auth/error handling only.
export class ProviderError extends Error {
  constructor(message, code = 'provider_error') { super(message); this.code = code; }
}
export class ApolloProvider {
  constructor({ apiKey, fetchImpl = fetch } = {}) { this.apiKey = apiKey; this.fetchImpl = fetchImpl; }
  async request(path, body, { signal, record }) {
    if (!this.apiKey?.trim()) throw new ProviderError('Set APOLLO_API_KEY before acquiring a cohort.', 'missing_credential');
    const url = new URL('https://api.apollo.io/api/v1' + path);
    if (path === '/people/bulk_match') {
      for (const key of ['reveal_phone_number', 'reveal_personal_emails', 'run_waterfall_email', 'run_waterfall_phone']) url.searchParams.set(key, 'false');
    }
    // Persist intent before dispatch. No automatic retry after ambiguous transport failure.
    const audit = { endpoint: path, url: url.toString(), body, startedAt: new Date().toISOString() };
    await record({ ...audit, phase: 'requested' });
    let response, raw;
    try {
      response = await this.fetchImpl(url, { method: 'POST', signal, headers: {
        accept: 'application/json', 'content-type': 'application/json', 'cache-control': 'no-cache', 'x-api-key': this.apiKey
      }, body: JSON.stringify(body) });
      raw = await response.text();
    } catch {
      await record({ ...audit, phase: 'failed', error: 'Transport interrupted; provider completion/charges unknown.' });
      throw new ProviderError('Provider connection interrupted; no retry was made. Charges may be unknown.', 'transport_unknown');
    }
    const headers = Object.fromEntries([...response.headers].filter(([key]) =>
      /^(x-request-id|request-id|retry-after|x-rate-limit.*|x-.*usage|x-.*requests-left)$/.test(key)));
    await record({ ...audit, phase: 'returned', httpStatus: response.status, headers, rawResponse: raw, receivedAt: new Date().toISOString() });
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new ProviderError('Provider returned unreadable data.', 'invalid_response'); }
    if (!response.ok) {
      const code = response.status === 429 ? 'rate_limit' : [401,403].includes(response.status) ? 'permission_error' : 'provider_error';
      const detail = typeof payload.error === 'string' ? payload.error : typeof payload.message === 'string' ? payload.message : 'See saved provider response.';
      throw new ProviderError('Apollo rejected the request (HTTP ' + response.status + '): ' + detail.replaceAll(this.apiKey, '[redacted]') + ' Execution stopped.', code);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ProviderError('Invalid provider response.', 'invalid_response');
    return payload;
  }
  organizations(company, options) { return this.request('/mixed_companies/search', { q_organization_name: company, per_page: 10, page: 1 }, options); }
  people(plan, organizationIds, options) {
    return this.request('/mixed_people/api_search', {
      organization_ids: organizationIds, person_locations: plan.locations, person_titles: plan.titles,
      include_similar_titles: false, per_page: plan.poolSize, page: 1
    }, options);
  }
  enrich(ids, options) {
    return this.request('/people/bulk_match', { details: ids.map(id => ({ id })) }, options);
  }
}
