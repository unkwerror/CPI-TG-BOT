import { describe, expect, it } from 'vitest';
import {
  parseCampaignCallbackData,
  parseCampaignStartPayload,
  parseEventStartPayload,
} from './campaign-payload';

const recipient = '3f4a1c2e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';

describe('parseCampaignStartPayload', () => {
  it('reads an action that contains an underscore', () => {
    expect(parseCampaignStartPayload(`cmp_${recipient}_MORE_INFO`)).toEqual({
      recipientId: recipient,
      action: 'MORE_INFO',
    });
  });

  it('reads the remaining actions', () => {
    expect(parseCampaignStartPayload(`cmp_${recipient}_INTERESTED`)?.action).toBe('INTERESTED');
    expect(parseCampaignStartPayload(`cmp_${recipient}_UNSUBSCRIBED`)?.action).toBe('UNSUBSCRIBED');
  });

  it('accepts an upper case identifier and normalizes it', () => {
    expect(parseCampaignStartPayload(`cmp_${recipient.toUpperCase()}_INTERESTED`)).toEqual({
      recipientId: recipient,
      action: 'INTERESTED',
    });
  });

  it('rejects payloads that are not campaign replies', () => {
    expect(parseCampaignStartPayload('event_HACK2026')).toBeNull();
    expect(parseCampaignStartPayload(undefined)).toBeNull();
    expect(parseCampaignStartPayload('')).toBeNull();
    expect(parseCampaignStartPayload('cmp_')).toBeNull();
  });

  it('rejects an unknown action and a malformed identifier', () => {
    expect(parseCampaignStartPayload(`cmp_${recipient}_DROP_TABLE`)).toBeNull();
    expect(parseCampaignStartPayload('cmp_not-a-uuid_INTERESTED')).toBeNull();
  });
});

describe('parseCampaignCallbackData', () => {
  it('reads the inline keyboard payload', () => {
    expect(parseCampaignCallbackData(`cmp:${recipient}:MORE_INFO`)).toEqual({
      recipientId: recipient,
      action: 'MORE_INFO',
    });
  });

  it('rejects foreign or malformed callback data', () => {
    expect(parseCampaignCallbackData('other:payload')).toBeNull();
    expect(parseCampaignCallbackData(`cmp:${recipient}`)).toBeNull();
    expect(parseCampaignCallbackData(`cmp::INTERESTED`)).toBeNull();
    expect(parseCampaignCallbackData(null)).toBeNull();
  });
});

describe('parseEventStartPayload', () => {
  it('strips the event prefix and keeps a bare code', () => {
    expect(parseEventStartPayload('event_HACK2026')).toBe('HACK2026');
    expect(parseEventStartPayload('HACK2026')).toBe('HACK2026');
  });

  it('ignores campaign payloads and empty input', () => {
    expect(parseEventStartPayload(`cmp_${recipient}_INTERESTED`)).toBeNull();
    expect(parseEventStartPayload('   ')).toBeNull();
    expect(parseEventStartPayload(undefined)).toBeNull();
  });
});
