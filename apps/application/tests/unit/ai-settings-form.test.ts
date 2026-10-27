import { describe, expect, it } from 'vitest';
import { buildAiSaveBody, isRoleConfigured, roleSaveBody, type RoleForms } from '~/utils/ai-settings-form';

function blankRole() {
  return { enabled: false, reuse: null, provider: '', model: '', baseUrl: '', apiKey: '', temperature: '' };
}

function forms(overrides: Partial<Record<keyof RoleForms, Partial<RoleForms['diagnosis']>>> = {}): RoleForms {
  return {
    diagnosis: { ...blankRole(), ...overrides.diagnosis },
    research: { ...blankRole(), ...overrides.research },
    embedding: { ...blankRole(), ...overrides.embedding },
    assistant: { ...blankRole(), ...overrides.assistant },
  };
}

describe('ai-settings-form', () => {
  describe('isRoleConfigured', () => {
    it('treats diagnosis as configured when a provider is chosen, ignoring its (toggle-less) enabled flag', () => {
      // The required diagnosis role has no enable switch, so `enabled` is never
      // flipped true for a first-time config — provider presence is the signal.
      expect(isRoleConfigured(forms({ diagnosis: { provider: 'claude-cli', enabled: false } }), 'diagnosis')).toBe(
        true,
      );
      expect(isRoleConfigured(forms({ diagnosis: { provider: '', enabled: true } }), 'diagnosis')).toBe(false);
    });

    it('treats optional roles as configured only when their enable switch is on', () => {
      expect(isRoleConfigured(forms({ research: { provider: 'openai', enabled: false } }), 'research')).toBe(false);
      expect(isRoleConfigured(forms({ research: { provider: 'openai', enabled: true } }), 'research')).toBe(true);
    });
  });

  describe('buildAiSaveBody', () => {
    it('saves a first-time claude-cli diagnosis instead of silently clearing it (the reported bug)', () => {
      // Provider picked, phantom enabled flag still false, not env-managed.
      const body = buildAiSaveBody(forms({ diagnosis: { provider: 'claude-cli', enabled: false } }), {
        envManaged: false,
        autoDiagnose: false,
      });
      expect(body.roles).not.toBeNull();
      expect(body.roles!.diagnosis).toEqual({
        provider: 'claude-cli',
        model: undefined,
        baseUrl: undefined,
        temperature: undefined,
      });
      // Optional roles left off stay null (removed) — not a spurious rejection.
      expect(body.roles!.research).toBeNull();
      expect(body.roles!.embedding).toBeNull();
    });

    it('clears the whole config when diagnosis has no provider (non-env)', () => {
      const body = buildAiSaveBody(forms(), { envManaged: false, autoDiagnose: true });
      expect(body.roles).toBeNull();
      expect(body.autoDiagnose).toBe(true);
    });

    it('keeps sending roles when env-managed even with no provider chosen (preserves model overrides)', () => {
      const body = buildAiSaveBody(forms({ diagnosis: { model: 'claude-opus-4-8' } }), {
        envManaged: true,
        autoDiagnose: false,
      });
      expect(body.roles).not.toBeNull();
    });

    it('includes an enabled optional role that reuses another role', () => {
      const body = buildAiSaveBody(
        forms({
          diagnosis: { provider: 'anthropic' },
          research: { enabled: true, reuse: 'diagnosis', model: 'claude-haiku-4-5' },
        }),
        { envManaged: false, autoDiagnose: false },
      );
      expect(body.roles!.research).toEqual({ reuse: 'diagnosis', model: 'claude-haiku-4-5', temperature: undefined });
    });

    it('sends the assistant role only when its switch is on', () => {
      const off = buildAiSaveBody(forms({ diagnosis: { provider: 'anthropic' } }), {
        envManaged: false,
        autoDiagnose: false,
      });
      expect(off.roles!.assistant).toBeNull();
      const on = buildAiSaveBody(
        forms({
          diagnosis: { provider: 'anthropic' },
          assistant: { enabled: true, reuse: 'diagnosis', model: 'claude-haiku-4-5' },
        }),
        { envManaged: false, autoDiagnose: false },
      );
      expect(on.roles!.assistant).toEqual({ reuse: 'diagnosis', model: 'claude-haiku-4-5', temperature: undefined });
    });

    it('carries an OpenAI role fully, and only sends apiKey when the field is non-empty', () => {
      const withKey = buildAiSaveBody(
        forms({
          diagnosis: { provider: 'openai', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' },
        }),
        { envManaged: false, autoDiagnose: false },
      );
      expect(withKey.roles!.diagnosis).toMatchObject({
        provider: 'openai',
        model: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-x',
      });

      const noKey = buildAiSaveBody(
        forms({ diagnosis: { provider: 'openai', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' } }),
        { envManaged: false, autoDiagnose: false },
      );
      expect(noKey.roles!.diagnosis).not.toHaveProperty('apiKey');
    });

    it('throws on an out-of-range temperature so the caller can surface a save failure', () => {
      expect(() =>
        buildAiSaveBody(forms({ diagnosis: { provider: 'openai', model: 'm', baseUrl: 'u', temperature: '5' } }), {
          envManaged: false,
          autoDiagnose: false,
        }),
      ).toThrow(/temperature/);
    });
  });

  describe('roleSaveBody', () => {
    it('returns null for an unconfigured role', () => {
      expect(roleSaveBody(forms(), 'embedding')).toBeNull();
    });
  });
});
