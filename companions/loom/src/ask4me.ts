import { setTimeout as sleep } from 'node:timers/promises';
import type { Question, QuestionSpec } from './store.js';

export interface AskConfig { endpoint: string; key: string; publicUrl: string }
export interface Answer { answer: Record<string, string>; error: string }

export function formFor(spec: QuestionSpec) {
  const properties: Record<string, unknown> = {
    details: { type: 'string', title: 'Requested operation', readOnly: true },
  };
  const data: Record<string, string> = { details: spec.detail };
  const elements: unknown[] = [{ type: 'Control', scope: '#/properties/details', options: { multi: true, readonly: true } }];
  const required: string[] = [];
  if (spec.kind === 'approval') {
    properties.decision = { type: 'string', title: 'Decision', enum: ['decline', 'accept'] };
    data.decision = 'decline';
    elements.push({ type: 'Control', scope: '#/properties/decision' });
    required.push('decision');
  } else {
    for (const [index, field] of (spec.fields ?? []).entries()) {
      const key = `field_${index}`;
      properties[key] = { type: 'string', title: field.question, minLength: 1, maxLength: 8000,
        ...(field.options?.length ? { description: `Suggested answers: ${field.options.join('; ')}` } : {}) };
      data[key] = '';
      elements.push({ type: 'Control', scope: `#/properties/${key}`, options: { multi: true } });
      required.push(key);
    }
  }
  return {
    title: spec.kind === 'approval' ? 'Loom: approval needed' : 'Loom: reply needed',
    // Details live in the form, not in the text delivered to the push provider.
    body: 'A local task needs your attention. Open the interaction page to review and respond.',
    expires_in_seconds: 3600,
    jsonforms: { schema: { type: 'object', properties, required }, data,
      uischema: { type: 'VerticalLayout', elements }, submit_label: spec.kind === 'approval' ? 'Confirm decision' : 'Send reply' },
  };
}

export function validateAnswer(spec: QuestionSpec, payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid answer.');
  const value = payload as Record<string, unknown>;
  if (spec.kind === 'approval') {
    if (value.decision !== 'accept' && value.decision !== 'decline') throw new Error('Invalid approval decision.');
    return { decision: value.decision };
  }
  const answer: Record<string, string> = {};
  for (const [index] of (spec.fields ?? []).entries()) {
    const key = `field_${index}`;
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 8000) throw new Error('Invalid reply.');
    answer[key] = value[key];
  }
  return answer;
}

export async function waitForAnswer(question: Question, config: AskConfig, onUrl: (url: string) => void, signal: AbortSignal): Promise<Answer> {
  const spec: QuestionSpec = JSON.parse(question.spec);
  const url = new URL('/v1/ask', config.endpoint);
  url.searchParams.set('stream', 'true');
  url.searchParams.set('request_id', question.request_id);
  const deadline = question.created + 3_600_000;
  while (!signal.aborted && Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        // The Go endpoint flushes headers before reading the body; prevent its keep-alive body drain.
        method: 'POST', headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify(formFor(spec)), signal: AbortSignal.any([signal, AbortSignal.timeout(70_000)]),
      });
      if (!response.ok || !response.body) return { answer: {}, error: `Notification service returned HTTP ${response.status}.` };
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.length > 1_000_000) return { answer: {}, error: 'Notification response exceeded its size limit.' };
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trimEnd(); buffer = buffer.slice(end + 1);
          if (!line.startsWith('data:')) continue;
          const content = line.slice(5).trim();
          if (!content || content === '[DONE]') continue;
          const event = JSON.parse(content) as { type: string; data?: Record<string, unknown> };
          if (event.type === 'request.created' && typeof event.data?.interaction_url === 'string') {
            const link = new URL(event.data.interaction_url);
            if (link.origin !== new URL(config.publicUrl).origin || !link.pathname.startsWith('/r/')) {
              return { answer: {}, error: 'Notification link does not match the configured public address.' };
            }
            onUrl(link.href);
          }
          if (event.type === 'notify.failed') return { answer: {}, error: 'Notification delivery failed. No approval was granted.' };
          if (event.type === 'request.expired') return { answer: {}, error: 'The request expired. No approval was granted.' };
          if (event.type === 'user.submitted') {
            try { return { answer: validateAnswer(spec, event.data?.payload), error: '' }; }
            catch { return { answer: {}, error: 'The submitted response was invalid. No approval was granted.' }; }
          }
        }
      }
    } catch {
      // Reusing the persisted request ID reconnects without sending a second notification.
    }
    await sleep(2000, undefined, { signal }).catch(() => undefined);
  }
  return { answer: {}, error: signal.aborted ? 'Request cancelled.' : 'The request expired. No approval was granted.' };
}
