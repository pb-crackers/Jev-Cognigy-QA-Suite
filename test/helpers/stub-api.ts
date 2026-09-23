/**
 * A local stand-in for the TypeSafe API.
 *
 * Pointing the SDK at this via TYPESAFE_BASE_URL exercises the real client, the
 * real request shape and the real answer parsing, while counting round trips and
 * spending nothing. Answers are synthesized from the question types in the
 * request, with per-question overrides for the case under test.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubRequest {
  questions: Record<string, { type: string; criteria?: Record<string, unknown> | unknown[] }>;
  state: unknown;
  model: string;
}

export interface StubApi {
  baseURL: string;
  /** One entry per HTTP round trip, in order. */
  requests: StubRequest[];
  /**
   * Replace the canned answers for subsequent requests. The server stays on one
   * port for the whole suite because the SDK client resolves its base URL once,
   * on construction, and would keep pointing at a replaced server.
   */
  setOverrides(overrides: Overrides): void;
  close(): Promise<void>;
}

export type Overrides = Record<string, unknown>;

export async function startStubApi(initial: Overrides = {}): Promise<StubApi> {
  const requests: StubRequest[] = [];
  let overrides = initial;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as StubRequest;
      requests.push(body);

      // An override of { fail: true } for any question makes the whole request fail, as an outage would.
      if (Object.keys(body.questions).some((name) => (overrides[name] as { fail?: boolean } | undefined)?.fail)) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'stub outage' }));
        return;
      }
      const answers: Record<string, unknown> = {};
      for (const [name, question] of Object.entries(body.questions)) {
        if (name in overrides) {
          answers[name] = overrides[name];
          continue;
        }
        if (question.type === 'noul') {
          answers[name] = { type: 'noul', noul: 0.9 };
        } else if (question.type === 'score') {
          // A score's criteria is an ordered array, and its answer carries a
          // numeric `score` plus a legend keyed by level index — a different
          // shape from a choice, which an earlier version of this stub missed.
          const levels = (question.criteria ?? []) as unknown[];
          const middle = Math.floor((levels.length - 1) / 2);
          answers[name] = {
            type: 'score',
            score: middle,
            confidence: 1,
            legend: Object.fromEntries(levels.map((level, index) => [index, level])),
            probabilities: Object.fromEntries(levels.map((_, index) => [index, index === middle ? 1 : 0])),
          };
        } else {
          const labels = Object.keys(question.criteria ?? {});
          answers[name] = {
            type: 'choice',
            choice: labels[0],
            confidence: 1,
            probabilities: Object.fromEntries(labels.map((l, i) => [l, i === 0 ? 1 : 0])),
          };
        }
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers,
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    setOverrides(next: Overrides) {
      overrides = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
