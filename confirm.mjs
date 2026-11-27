/**
 * Asking the person before a tool does something they should agree to, through an MCP form.
 *
 * A handler calls confirmations() before it writes anything, because it runs again with the
 * answers and a write made before the question would happen twice. Every question goes into
 * one round. A key ends with a fingerprint of what it is about, so when that changes between
 * the question and the answer the old answer sits under a key nobody reads and the person is
 * asked again.
 */
import { inputRequired, inputResponse, CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';

export { fingerprint } from './fingerprint.mjs';

const YES_NO = { type: 'object', properties: { confirm: { type: 'boolean', title: 'Yes' } }, required: ['confirm'] };

/* A form sent to a client that never declared one is a -32021 protocol error. A bare
   elicitation: {} is how a 2025-era client declares forms; one naming only url has none. */
export function hasForms(server, ctx) {
  const capabilities = ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? server.getClientCapabilities();
  const elicitation = capabilities?.elicitation;
  return elicitation !== null && typeof elicitation === 'object' && (elicitation.form !== undefined || elicitation.url === undefined);
}

/**
 * asks: [{ key, message }]. Returns { ask } for the handler to return when the client has forms
 * and any key is unanswered, or { answers } mapping each key to 'yes', 'no' or 'unasked' (the
 * client has no forms). Only confirm === true in an accepted form is a yes.
 */
export function confirmations(server, ctx, asks) {
  if (!hasForms(server, ctx)) return { answers: Object.fromEntries(asks.map(({ key }) => [key, 'unasked'])) };
  const responses = asks.map(({ key }) => inputResponse(ctx.mcpReq.inputResponses, key));
  if (responses.some(r => r.kind === 'missing')) {
    // The 2025-era shim hands back only the latest round's answers, so every key is asked again.
    return { ask: inputRequired({ inputRequests: Object.fromEntries(asks.map(({ key, message }) => [key, inputRequired.elicit({ message, requestedSchema: YES_NO })])) }) };
  }
  return { answers: Object.fromEntries(asks.map(({ key }, i) => {
    const r = responses[i];
    return [key, r.kind === 'elicit' && r.action === 'accept' && r.content?.confirm === true ? 'yes' : 'no'];
  })) };
}
