/**
 * Simulated customers for demos: where they talk, who talks, and that each
 * conversation holds one session against a REST endpoint. A local server
 * plays the endpoint; nothing leaves the machine.
 */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { cast, endpointBase, PERSONAS, restEndpoint, simulate, type TurnEvent } from '../src/demo/simulate.ts';
import type { Agent } from '../src/agents/model.ts';

describe('where a simulated customer talks', () => {
  it('finds the endpoint host from the API host', () => {
    assert.equal(endpointBase('https://api-trial-us.cognigy.ai'), 'https://endpoint-trial-us.cognigy.ai');
    assert.equal(endpointBase('https://api-trial-us.cognigy.ai/new/'), 'https://endpoint-trial-us.cognigy.ai');
  });

  it('prefers an explicit override, and gives up rather than guess', () => {
    assert.equal(endpointBase('https://api-x.cognigy.ai', 'https://ep.example.com/'), 'https://ep.example.com');
    assert.equal(endpointBase('https://cognigy.acme.internal'), undefined);
    assert.equal(endpointBase(undefined), undefined);
    assert.equal(endpointBase('not a url'), undefined);
  });

  it('uses only a REST endpoint that has a token', () => {
    const agent = { endpoints: [
      { id: 'w', name: 'Webchat', channel: 'webchat3', urlToken: 'w-token' },
      { id: 'r0', name: 'REST, no token', channel: 'rest' },
      { id: 'r', name: 'REST', channel: 'rest', urlToken: 'r-token' },
    ] } as unknown as Agent;
    assert.equal(restEndpoint(agent)?.id, 'r');
    assert.equal(restEndpoint({ endpoints: [] } as unknown as Agent), undefined);
  });
});

describe('who talks', () => {
  it('cycles through every persona before repeating one', () => {
    const six = cast(PERSONAS.length).map((persona) => persona.id);
    assert.equal(new Set(six).size, PERSONAS.length);
    assert.equal(cast(PERSONAS.length + 1).at(-1)?.id, PERSONAS[0].id);
  });

  it('narrows to the personas asked for, and caps the crowd', () => {
    assert.deepEqual(cast(3, ['jailbreaker']).map((persona) => persona.id), ['jailbreaker', 'jailbreaker', 'jailbreaker']);
    assert.deepEqual(cast(3, ['nobody']), []);
    assert.equal(cast(500).length, 30);
    assert.equal(cast(0).length, 1);
  });
});

describe('holding the conversations', () => {
  it('keeps each conversation in its own session and reports every turn', async () => {
    const seen: { sessionId: string; text: string; userId: string }[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const message = JSON.parse(body);
        seen.push(message);
        if (message.text.includes('LLC')) {
          response.writeHead(500).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ outputStack: [{ text: `echo: ${message.text}` }, { data: {} }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;

    const personas = cast(2, ['rate-pusher', 'off-topic']);
    const turns: TurnEvent[] = [];
    const result = await simulate({ url, personas, onTurn: (turn) => turns.push(turn), stagger: 0, thinking: [0, 0] });
    server.close();

    const sessions = new Set(seen.map((message) => message.sessionId));
    assert.equal(sessions.size, 2, 'one session per conversation');
    assert.ok(seen.every((message) => message.userId === 'agent-watch-demo'));
    assert.equal(turns.length, PERSONAS.find((p) => p.id === 'rate-pusher')!.lines.length + 2, 'a failed turn ends that conversation');

    const pusher = turns.find((turn) => turn.persona === 'rate-pusher');
    assert.deepEqual(pusher?.replies, [`echo: ${PERSONAS.find((p) => p.id === 'rate-pusher')!.lines[0]}`], 'text outputs only');
    const failed = turns.find((turn) => turn.error);
    assert.match(failed?.error ?? '', /500/);
    assert.equal(result.sessions.find((session) => session.persona === 'off-topic')?.failed, true);
    assert.equal(result.sessions.find((session) => session.persona === 'rate-pusher')?.failed, false);
  });
});
