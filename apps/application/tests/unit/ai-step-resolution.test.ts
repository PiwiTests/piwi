import { describe, it, expect } from 'vitest';
import {
  RESOLUTION_ACTIONS,
  STEP_RESOLUTION_SCHEMA,
  buildStepResolutionPrompt,
  validateStepResolution,
  type StepResolutionRequest,
} from '#shared/ai-step-resolution';

const baseRequest: StepResolutionRequest = {
  kind: 'run',
  template: 'log in as {email}',
  paramNames: ['email'],
  ariaSnapshot: '- textbox "Email"\n- button "Sign in"',
  history: [{ action: 'fill', element: { role: 'textbox', name: 'Email' }, value: '{{email}}' }],
};

describe('buildStepResolutionPrompt', () => {
  it('puts the stable context before the volatile snapshot for cache reuse', () => {
    const { user, stablePrefixChars } = buildStepResolutionPrompt(baseRequest);
    expect(user.slice(0, stablePrefixChars)).toContain('TEMPLATE: log in as {email}');
    expect(user.slice(0, stablePrefixChars)).not.toContain('textbox "Email"\n- button');
    expect(user.slice(stablePrefixChars)).toBe(baseRequest.ariaSnapshot);
  });

  it('lists placeholders as markers and renders history', () => {
    const { user } = buildStepResolutionPrompt(baseRequest);
    expect(user).toContain('PLACEHOLDERS: {{email}}');
    expect(user).toContain('1. fill textbox "Email" = {{email}}');
  });
});

describe('validateStepResolution', () => {
  it('accepts a single-element locator decision', () => {
    const res = validateStepResolution(JSON.stringify({ element: { role: 'button', name: 'Sign in' } }));
    expect(res.element).toEqual({ role: 'button', name: 'Sign in' });
  });

  it('accepts a done decision with a postcondition', () => {
    const res = validateStepResolution(
      JSON.stringify({ done: true, postcondition: { assert: 'visible', element: { role: 'heading', name: 'Home' } } }),
    );
    expect(res.done).toBe(true);
    expect(res.postcondition).toMatchObject({ assert: 'visible' });
  });

  it('rejects an action outside the closed vocabulary', () => {
    expect(() => validateStepResolution(JSON.stringify({ element: { role: 'link' }, action: 'navigate' }))).toThrow(
      /not in the allowed set/,
    );
  });

  it('rejects a postcondition with an unsupported assert', () => {
    expect(() => validateStepResolution(JSON.stringify({ done: true, postcondition: { assert: 'exists' } }))).toThrow(
      /assert/,
    );
  });

  it('rejects an element without a role and non-JSON', () => {
    expect(() => validateStepResolution(JSON.stringify({ element: { name: 'x' } }))).toThrow(/role is required/);
    expect(() => validateStepResolution('not json')).toThrow(/not valid JSON/);
  });

  it('accepts a wait decision carrying a response glob (and an empty one for no wait)', () => {
    expect(validateStepResolution(JSON.stringify({ waitForResponse: '**/api/login' })).waitForResponse).toBe(
      '**/api/login',
    );
    expect(validateStepResolution(JSON.stringify({})).waitForResponse).toBeUndefined();
  });
});

describe('buildStepResolutionPrompt — wait kind', () => {
  it('lists the observed responses and the step that produced them', () => {
    const { user } = buildStepResolutionPrompt({
      kind: 'wait',
      template: 'log in as {email}',
      paramNames: ['email'],
      ariaSnapshot: '',
      history: [{ action: 'click', element: { role: 'button', name: 'Sign in' } }],
      observedResponses: ['**/api/login', '**/analytics/collect'],
    });
    expect(user).toContain('KIND: wait');
    expect(user).toContain('LAST STEP: click button "Sign in"');
    expect(user).toContain('OBSERVED RESPONSES:');
    expect(user).toContain('**/api/login');
    // No page snapshot section for a wait pick.
    expect(user).not.toContain('PAGE SNAPSHOT');
  });
});

describe('STEP_RESOLUTION_SCHEMA', () => {
  it('constrains action to the resolution vocabulary', () => {
    const actionEnum = STEP_RESOLUTION_SCHEMA.properties.action.enum;
    expect(actionEnum).toEqual([...RESOLUTION_ACTIONS]);
  });
});
