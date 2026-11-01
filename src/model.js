import { PROSPECT_INSTRUCTIONS, prospectEnvelopeSchema, unwrapProspectResponse } from './prospecting.js';
import { INSTRUCTIONS, DECISION_SCHEMA } from './operator.js';

export function createModel({ apiKey, model, fetchImpl = fetch, decisionSchema = DECISION_SCHEMA, prospecting = false }) {
  return {
    name: model,
    async decide(context) {
      if (!apiKey?.trim()) throw new Error('Set OPENAI_API_KEY in growth-operator-v0/.env, enable API billing, and restart the server.');
      if (!model?.trim()) throw new Error('Set OPERATOR_MODEL in growth-operator-v0/.env and restart the server.');
      let response;
      try {
        response = await fetchImpl('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(180_000),
          body: JSON.stringify({
            model, store: false, instructions: INSTRUCTIONS + (prospecting ? PROSPECT_INSTRUCTIONS : ''),
            input: JSON.stringify(context),
            text: { format: { type: 'json_schema', name: 'operator_decision', strict: true, schema: prospecting ? prospectEnvelopeSchema(decisionSchema) : decisionSchema } }
          })
        });
      } catch {
        throw new Error('The model connection failed or exceeded 180 seconds. No decision was received. The provider may have processed the request; no automatic retry was made.');
      }
      if (!response.ok) {
        const detail = {
          401: 'Check OPENAI_API_KEY.',
          403: 'Check project permissions and model access.',
          404: 'Check OPERATOR_MODEL and your account’s model access.',
          429: 'Check API billing, quota, and rate limits.',
          400: 'Check that OPERATOR_MODEL supports Responses and structured outputs; the complete history may also exceed its context limit.'
        }[response.status] || 'The provider is unavailable. Try again manually later.';
        throw new Error(`Model request failed (HTTP ${response.status}). ${detail} No automatic retry was made.`);
      }
      let payload;
      try { payload = await response.json(); } catch { throw new Error('The model provider returned unreadable JSON.'); }
      if (payload.status !== 'completed') throw new Error('The model response did not complete. No decision was accepted.');
      const content = (payload.output || []).flatMap(item => item.content || []);
      if (content.some(item => item.type === 'refusal')) throw new Error('The model declined this request. No decision was accepted.');
      const raw = content.filter(item => item.type === 'output_text').map(item => item.text).join('');
      let decision;
      try { decision = JSON.parse(raw); } catch { throw new Error('The model did not return a readable structured decision.'); }
      return { ...(prospecting ? unwrapProspectResponse(decision, Boolean(decisionSchema.properties.decision)) : { decision }), model: payload.model || model };
    }
  };
}
