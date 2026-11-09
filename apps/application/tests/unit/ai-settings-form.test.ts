import { describe, expect, it } from 'vitest';
import type { AiRoleSettings } from '~~/types/api';
import { providerTile } from '~/utils/ai-provider-catalog';
import {
  applyTile,
  blankRoleDraft,
  buildAiSaveBody,
  connectionProblem,
  isRoleConfigured,
  roleDraftFromSettings,
  roleSaveBody,
  storedKeyApplies,
  type RoleForms,
} from '~/utils/ai-settings-form';

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

    it('reads a temperature a number input handed over as a number', () => {
      const body = roleSaveBody(
        forms({ diagnosis: { provider: 'openai', model: 'm', baseUrl: 'u', temperature: 0.2 } }),
        'diagnosis',
      );
      expect(body?.temperature).toBe(0.2);
    });

    it('removes the stored key of a role moved to another provider with no key typed', () => {
      const moved = forms({
        diagnosis: { provider: 'openai', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1' },
      });
      expect(roleSaveBody(moved, 'diagnosis', true)).toMatchObject({ apiKey: null });
      expect(roleSaveBody(moved, 'diagnosis')).not.toHaveProperty('apiKey');
      const typed = forms({ diagnosis: { provider: 'openai', model: 'm', baseUrl: 'u', apiKey: 'sk-new' } });
      expect(roleSaveBody(typed, 'diagnosis', true)).toMatchObject({ apiKey: 'sk-new' });
      const body = buildAiSaveBody(moved, { envManaged: false, autoDiagnose: false, dropStoredKeys: ['diagnosis'] });
      expect(body.roles!.diagnosis).toMatchObject({ apiKey: null });
    });
  });

  describe('tiles', () => {
    const storedOllama: AiRoleSettings = {
      provider: 'openai',
      model: 'qwen2.5-coder:14b',
      baseUrl: 'http://localhost:11434/v1',
      reuse: null,
      hasApiKey: false,
      temperature: 0.2,
    };

    it('reads a stored role back into its tile', () => {
      expect(roleDraftFromSettings(storedOllama)).toMatchObject({ tile: 'ollama', enabled: true, temperature: '0.2' });
      expect(roleDraftFromSettings({ ...storedOllama, reuse: 'diagnosis' }).tile).toBeNull();
      expect(roleDraftFromSettings(null)).toEqual(blankRoleDraft());
    });

    it("fills a new tile's address and suggested model, and drops a typed key", () => {
      const form = { ...blankRoleDraft(), apiKey: 'typed' };
      applyTile(form, providerTile('openai')!, 'main', null);
      expect(form).toMatchObject({
        tile: 'openai',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        apiKey: '',
      });
      applyTile(form, providerTile('openai')!, 'embed', null);
      expect(form.model).toBe('text-embedding-3-small');
      applyTile(form, providerTile('ollama')!, 'embed', null);
      expect(form.model).toBe('nomic-embed-text');
    });

    it('brings the stored address, model and temperature back on the stored tile', () => {
      const form = blankRoleDraft();
      applyTile(form, providerTile('anthropic')!, 'main', storedOllama);
      applyTile(form, providerTile('ollama')!, 'main', storedOllama);
      expect(form).toMatchObject({
        baseUrl: 'http://localhost:11434/v1',
        model: 'qwen2.5-coder:14b',
        temperature: '0.2',
      });
    });

    it('keeps a stored key only for the provider and address it was saved for', () => {
      const stored: AiRoleSettings = {
        ...storedOllama,
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        hasApiKey: true,
      };
      const form = roleDraftFromSettings(stored);
      expect(storedKeyApplies(form, stored)).toBe(true);
      expect(storedKeyApplies({ ...form, baseUrl: 'https://api.openai.com/v1/' }, stored)).toBe(true);
      expect(storedKeyApplies({ ...form, baseUrl: 'https://gateway.example.com/v1' }, stored)).toBe(false);
      expect(storedKeyApplies({ ...form, provider: 'anthropic' }, stored)).toBe(false);
    });

    it('names what a connection lacks', () => {
      const anthropic = { ...blankRoleDraft(), tile: 'anthropic' as const, provider: 'anthropic' };
      expect(connectionProblem(blankRoleDraft(), false)).toBe('Choose a provider.');
      expect(connectionProblem(anthropic, false)).toBe('Anthropic needs an API key.');
      expect(connectionProblem(anthropic, true)).toBeNull();
      expect(connectionProblem({ ...anthropic, apiKey: 'sk-ant-x' }, false)).toBeNull();
      const custom = { ...blankRoleDraft(), tile: 'openai-compatible' as const, provider: 'openai' };
      expect(connectionProblem(custom, false)).toBe('Enter the server address.');
      expect(connectionProblem({ ...custom, baseUrl: 'http://vllm:8000/v1' }, false)).toBe('Enter a model.');
      expect(connectionProblem({ ...blankRoleDraft(), tile: 'claude-cli', provider: 'claude-cli' }, false)).toBeNull();
    });
  });
});
