import { describe, expect, it } from 'vitest';
import {
  askTextMessage,
  eventChoiceCallback,
  nextStep,
  parseEventChoiceCallback,
  parseFullName,
  parsePhone,
  parseRequestText,
} from './request-flow';

const eventId = '3f0e8f6a-1c2b-4d3e-8f90-abcdef123456';

describe('parseEventChoiceCallback', () => {
  it('reads the event chosen with a button', () => {
    expect(parseEventChoiceCallback(eventChoiceCallback(eventId))).toBe(eventId);
  });

  it('keeps the callback inside the 64 bytes Telegram allows', () => {
    expect(Buffer.byteLength(eventChoiceCallback(eventId))).toBeLessThanOrEqual(64);
  });

  it('ignores foreign and malformed callbacks', () => {
    expect(parseEventChoiceCallback('cmp:3f0e8f6a:INTERESTED')).toBeNull();
    expect(parseEventChoiceCallback('req:ev:not-a-uuid')).toBeNull();
    expect(parseEventChoiceCallback(undefined)).toBeNull();
  });
});

describe('nextStep', () => {
  it('asks for the full name first: without it CRM rejects the person', () => {
    expect(nextStep({ fullName: null, phone: '+79130000000' })).toBe('fullName');
  });

  it('asks for a phone when only the name is known', () => {
    expect(nextStep({ fullName: 'Иванов Иван Иванович', phone: null })).toBe('phone');
  });

  it('asks nothing when the profile is already filled', () => {
    expect(nextStep({ fullName: 'Иванов Иван Иванович', phone: '+79130000000' })).toBeNull();
  });

  it('treats blank values as missing', () => {
    expect(nextStep({ fullName: '   ', phone: '  ' })).toBe('fullName');
  });
});

describe('parseRequestText', () => {
  it('accepts a short but meaningful request', () => {
    expect(parseRequestText('нужна помощь с заявкой')).toEqual({
      text: 'нужна помощь с заявкой',
    });
  });

  it('rejects an empty message with a readable reason', () => {
    const result = parseRequestText('  ');
    expect(result).toHaveProperty('error');
  });
});

describe('parseFullName', () => {
  it('accepts a Russian full name and collapses spacing', () => {
    expect(parseFullName('  Иванов   Иван Иванович ')).toEqual({
      fullName: 'Иванов Иван Иванович',
    });
  });

  it('accepts a hyphenated surname', () => {
    expect(parseFullName('Петрова-Водкина Анна Сергеевна')).toEqual({
      fullName: 'Петрова-Водкина Анна Сергеевна',
    });
  });

  // Именно эти варианты CRM отклоняла, оставляя человека вне рассылки.
  it('rejects a latin or incomplete name', () => {
    expect(parseFullName('Kirill')).toHaveProperty('error');
    expect(parseFullName('Иван Иванов')).toHaveProperty('error');
    expect(parseFullName('катюшк')).toHaveProperty('error');
  });
});

describe('parsePhone', () => {
  it('normalises a typed number to digits with a plus', () => {
    expect(parsePhone('+7 (913) 000-00-00')).toEqual({ phone: '+79130000000' });
  });

  it('rejects something that is not a number', () => {
    expect(parsePhone('позвоните мне')).toHaveProperty('error');
    expect(parsePhone('12345')).toHaveProperty('error');
  });
});

describe('askTextMessage', () => {
  it('names the event and the team that will answer', () => {
    const message = askTextMessage({
      title: 'ТОП-1000 университетских проектов',
      organizer: 'Стартап-студия НГУ',
    });
    expect(message).toContain('«ТОП-1000 университетских проектов»');
    expect(message).toContain('Стартап-студия НГУ посмотрит запрос');
  });
});
