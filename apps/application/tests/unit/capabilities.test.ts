import { describe, test, expect } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_BY_ID,
  CAPABILITY_MODULES,
  CAPABILITY_PRESETS,
  capabilitiesForModule,
  capabilityHidden,
  DESKTOP_HIDDEN_CAPABILITIES,
  resolveCapability,
  resolveCapabilities,
  parseInstanceDecisions,
  parseProjectDecisions,
  applyDecisionPatch,
  type CapabilityId,
  type CapabilityInput,
  type CapabilityState,
} from '../../shared/capabilities';
import { SETUP_CAPABILITIES } from '../../app/utils/setup-capabilities';
import type { SetupCapabilityId } from '../../shared/handlers/setup-status';

const def = CAPABILITY_BY_ID.fixtures;

describe('resolveCapability precedence', () => {
  // One row per step of the resolver's ordered precedence. The resolver ignores `def`, so
  // a single representative capability drives every case.
  const cases: { name: string; input: CapabilityInput; expected: CapabilityState }[] = [
    {
      name: 'evidence wins over every decision',
      input: {
        evidence: true,
        projectDecision: 'declined',
        instanceDecision: 'declined',
        followedState: 'declined',
      },
      expected: 'active',
    },
    { name: 'project decline', input: { evidence: false, projectDecision: 'declined' }, expected: 'declined' },
    {
      name: 'project enable skips the instance decline',
      input: { evidence: false, projectDecision: 'enabled', instanceDecision: 'declined' },
      expected: 'undecided',
    },
    {
      name: 'project enable skips a declined followed capability',
      input: { evidence: false, projectDecision: 'enabled', followedState: 'declined' },
      expected: 'undecided',
    },
    {
      name: 'project enable continues past applicability to available when configured',
      input: { evidence: false, projectDecision: 'enabled', applicable: false, configured: true },
      expected: 'available',
    },
    { name: 'instance decline', input: { evidence: false, instanceDecision: 'declined' }, expected: 'declined' },
    {
      name: 'a declined followed capability declines this one',
      input: { evidence: false, followedState: 'declined' },
      expected: 'declined',
    },
    { name: 'not applicable', input: { evidence: false, applicable: false }, expected: 'not-applicable' },
    { name: 'configured but empty is available', input: { evidence: false, configured: true }, expected: 'available' },
    { name: 'nothing stored is undecided', input: { evidence: false }, expected: 'undecided' },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(resolveCapability(def, c.input)).toBe(c.expected);
    });
  }
});

describe('resolveCapability with passive-data evidence', () => {
  // The Test Map's graph nodes are written on every run, so its evidence is
  // passive: a decline must hold over that data, or declining it does nothing on
  // any project with history. Every other capability keeps "data always wins".
  const testMap = CAPABILITY_BY_ID['test-map'];

  test('the flag is on for test-map and off for a turned-on capability', () => {
    expect(testMap.passiveData).toBe(true);
    expect(CAPABILITY_BY_ID.fixtures.passiveData).toBeFalsy();
  });

  test('an instance decline holds over passive data', () => {
    expect(resolveCapability(testMap, { evidence: true, instanceDecision: 'declined' })).toBe('declined');
  });

  test('a project decline holds over passive data', () => {
    expect(resolveCapability(testMap, { evidence: true, projectDecision: 'declined' })).toBe('declined');
  });

  test('a project enable over an instance decline lets passive data read active', () => {
    expect(
      resolveCapability(testMap, { evidence: true, projectDecision: 'enabled', instanceDecision: 'declined' }),
    ).toBe('active');
  });

  test('passive data with no decline still reads active', () => {
    expect(resolveCapability(testMap, { evidence: true })).toBe('active');
  });

  test('a non-passive capability keeps data-wins even when declined', () => {
    expect(resolveCapability(def, { evidence: true, instanceDecision: 'declined' })).toBe('active');
  });
});

describe('resolveCapabilities', () => {
  test('a follower reads its target’s resolved state', () => {
    const states = resolveCapabilities({
      fixtures: { evidence: false, instanceDecision: 'declined' },
      'locator-healing': { evidence: false },
    });
    expect(states.fixtures).toBe('declined');
    // locator-healing follows fixtures, so a fixtures decline cascades.
    expect(states['locator-healing']).toBe('declined');
  });

  test('a follower with its own evidence stays active despite a declined target', () => {
    const states = resolveCapabilities({
      fixtures: { evidence: false, instanceDecision: 'declined' },
      'locator-healing': { evidence: true },
    });
    expect(states.fixtures).toBe('declined');
    expect(states['locator-healing']).toBe('active');
  });

  test('resolves every registry capability', () => {
    const states = resolveCapabilities({});
    for (const capability of CAPABILITIES) expect(states[capability.id]).toBe('undecided');
  });

  test('server-probes follows test-map: a test-map decline cascades', () => {
    const states = resolveCapabilities({
      'test-map': { evidence: false, instanceDecision: 'declined' },
      'server-probes': { evidence: false },
    });
    expect(states['test-map']).toBe('declined');
    expect(states['server-probes']).toBe('declined');
  });

  test('server-probes is not-applicable without a server trace, even when configured', () => {
    const states = resolveCapabilities({
      'test-map': { evidence: false },
      'server-probes': { evidence: false, configured: true, applicable: false },
    });
    // test-map is undecided (no decline to cascade), so server-probes reaches the
    // applicability check and reads not-applicable rather than declined.
    expect(states['test-map']).toBe('undecided');
    expect(states['server-probes']).toBe('not-applicable');
  });
});

describe('registry consistency', () => {
  test('every id belongs to exactly one known module', () => {
    for (const capability of CAPABILITIES) {
      expect(CAPABILITY_MODULES).toContain(capability.module);
    }
  });

  test('every follows target exists and is not itself a follower', () => {
    for (const capability of CAPABILITIES) {
      if (!capability.follows) continue;
      const target = CAPABILITY_BY_ID[capability.follows];
      expect(target, `${capability.id} follows unknown ${capability.follows}`).toBeTruthy();
      expect(target.follows, `${capability.follows} is itself a follower`).toBeUndefined();
    }
  });

  test('every non-core SetupCapabilityId has a registry entry', () => {
    const registryIds = new Set<string>(CAPABILITIES.map((c) => c.id));
    const coreLadderIds: SetupCapabilityId[] = ['reporter', 'clustering'];
    for (const copy of SETUP_CAPABILITIES) {
      if (coreLadderIds.includes(copy.id)) continue;
      expect(registryIds.has(copy.id), `${copy.id} has ladder copy but no registry entry`).toBe(true);
    }
  });

  test('every detection maps to a capability with ladder copy', () => {
    const copyIds = new Set<string>(SETUP_CAPABILITIES.map((c) => c.id));
    for (const capability of CAPABILITIES) {
      if (capability.detection === null) continue;
      expect(copyIds.has(capability.detection), `detection ${capability.detection} has no ladder copy`).toBe(true);
    }
  });

  test('since is a semantic version', () => {
    for (const capability of CAPABILITIES) {
      expect(capability.since, `${capability.id}.since`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  test('presets cover every module, core included', () => {
    expect(CAPABILITY_PRESETS.map((p) => p.module).sort()).toEqual([...CAPABILITY_MODULES].sort());
    for (const module of CAPABILITY_MODULES) {
      expect(capabilitiesForModule(module).length, `module ${module} has capabilities`).toBeGreaterThan(0);
    }
  });
});

describe('decision parsing and patching', () => {
  test('parseInstanceDecisions keeps only known ids mapped to declined', () => {
    const parsed = parseInstanceDecisions({
      decisions: { notifications: 'declined', ai: 'enabled', bogus: 'declined', fixtures: 'nope' },
    });
    expect(parsed).toEqual({ notifications: 'declined' });
  });

  test('parseProjectDecisions keeps declined and enabled', () => {
    const parsed = parseProjectDecisions({ fixtures: 'enabled', quarantine: 'declined', bogus: 'enabled' });
    expect(parsed).toEqual({ fixtures: 'enabled', quarantine: 'declined' });
  });

  test('applyDecisionPatch clears on null, replaces on a value, ignores unknowns', () => {
    const current: Partial<Record<CapabilityId, 'declined' | 'enabled'>> = {
      fixtures: 'declined',
      quarantine: 'enabled',
    };
    const next = applyDecisionPatch(current, { fixtures: null, markers: 'declined', bogus: 'declined' }, true);
    expect(next).toEqual({ quarantine: 'enabled', markers: 'declined' });
  });

  test('applyDecisionPatch drops enabled when it is not allowed', () => {
    const next = applyDecisionPatch({}, { fixtures: 'enabled', notifications: 'declined' }, false);
    expect(next).toEqual({ notifications: 'declined' });
  });
});

describe('capabilityHidden', () => {
  test('a declined or not-applicable capability is hidden on every build', () => {
    for (const desktop of [false, true]) {
      expect(capabilityHidden('notifications', 'declined', desktop)).toBe(true);
      expect(capabilityHidden('backend-logs', 'not-applicable', desktop)).toBe(true);
      expect(capabilityHidden('notifications', 'active', desktop)).toBe(false);
    }
  });

  test('the desktop build hides pull-request feedback and auto-heal, whatever their state', () => {
    expect([...DESKTOP_HIDDEN_CAPABILITIES].sort()).toEqual(['auto-heal', 'pr-feedback']);
    for (const id of ['pr-feedback', 'auto-heal'] as const) {
      expect(capabilityHidden(id, 'active', true)).toBe(true);
      expect(capabilityHidden(id, 'active', false)).toBe(false);
    }
  });
});
