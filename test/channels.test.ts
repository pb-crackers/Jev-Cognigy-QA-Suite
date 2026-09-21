/**
 * The channel label map, humaniser and filter compiler. Pure; no network.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { channelClause, humanise, labelFor, UNKNOWN_CHANNEL } from '../src/cognigy/channels.ts';

describe('channel labels', () => {
  it('maps the three strings verified against real data', () => {
    assert.equal(labelFor('adminconsole').label, 'Interaction Panel');
    assert.equal(labelFor('voiceGateway2').label, 'Voice');
    assert.equal(labelFor('rest').label, 'REST API');
  });

  it('collapses both voice gateways to one label', () => {
    assert.equal(labelFor('voiceGateway').label, labelFor('voiceGateway2').label);
    assert.equal(labelFor('voiceGateway').kind, 'voice');
  });

  it('keeps the raw value alongside the label, since the raw is the fact', () => {
    assert.equal(labelFor('voiceGateway2').raw, 'voiceGateway2');
  });

  it('marks a derived label as not known, so the UI can say so', () => {
    assert.equal(labelFor('adminconsole').known, true);
    assert.equal(labelFor('someNewChannel').known, false);
  });

  it('humanises an unmapped value rather than mislabelling it', () => {
    assert.equal(labelFor('someNewChannel').label, 'Some New Channel');
    assert.equal(labelFor('someNewChannel').kind, 'unknown');
  });

  it('is case-insensitive about the mapping', () => {
    assert.equal(labelFor('AdminConsole').label, 'Interaction Panel');
    assert.equal(labelFor('REST').label, 'REST API');
  });

  it('handles a session with no channel at all', () => {
    for (const empty of [null, undefined, '', '   ']) {
      const result = labelFor(empty);
      assert.equal(result.label, 'Unknown');
      assert.equal(result.raw, UNKNOWN_CHANNEL);
    }
  });
});

describe('humanise', () => {
  it('splits camelCase', () => {
    assert.equal(humanise('someNewChannel'), 'Some New Channel');
  });

  it('separates a version digit from its word', () => {
    assert.equal(humanise('voiceGateway3'), 'Voice Gateway 3');
  });

  it('treats underscores and hyphens as spaces', () => {
    assert.equal(humanise('voice_gateway-beta'), 'Voice Gateway Beta');
  });

  it('leaves an already-plain word alone but capitalised', () => {
    assert.equal(humanise('slack'), 'Slack');
  });
});

describe('the OData clause', () => {
  it('emits a bare equality for one value', () => {
    assert.equal(channelClause(['rest']), "channel eq 'rest'");
  });

  it('chains with or, because Cognigy rejects in()', () => {
    assert.equal(
      channelClause(['rest', 'voiceGateway2']),
      "(channel eq 'rest' or channel eq 'voiceGateway2')",
    );
    assert.ok(!String(channelClause(['a', 'b'])).includes(' in '));
  });

  it('returns nothing for an empty list, leaving the caller to decide', () => {
    assert.equal(channelClause([]), undefined);
  });

  it('drops duplicates and blanks rather than emitting redundant clauses', () => {
    assert.equal(channelClause(['rest', 'rest', '  ']), "channel eq 'rest'");
  });

  it('asks for a null channel when the absent-channel bucket is selected', () => {
    assert.equal(channelClause([UNKNOWN_CHANNEL]), 'channel eq null');
  });

  it('escapes a quote rather than breaking the query', () => {
    assert.equal(channelClause(["it's"]), "channel eq 'it''s'");
  });
});
