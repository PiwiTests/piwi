import { computed, ref } from 'vue';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { RunRequestPromptView } from '@piwitests/editor/run-target-view';

const states = new Map<string, ReturnType<typeof ref>>();
vi.stubGlobal('useState', (key: string, init: () => unknown) => {
  if (!states.has(key)) states.set(key, ref(init()));
  return states.get(key)!;
});
vi.stubGlobal('computed', computed);

const { useDesktopTeamRequests } = await import('../app/composables/useDesktopTeamRequests');

function request(id: string, command = 'npx playwright test'): RunRequestPromptView {
  return { id, command } as RunRequestPromptView;
}

describe('useDesktopTeamRequests', () => {
  beforeEach(() => states.clear());

  test('starts with no connection and no request', () => {
    const { connection, queue, current } = useDesktopTeamRequests();
    expect(connection.value.state).toBe('none');
    expect(queue.value).toEqual([]);
    expect(current.value).toBeNull();
  });

  test('shows the oldest request first', () => {
    const { add, current } = useDesktopTeamRequests();
    add(request('a'));
    add(request('b'));
    expect(current.value?.id).toBe('a');
  });

  test('a request sent again takes its place in the queue', () => {
    const { add, queue } = useDesktopTeamRequests();
    add(request('a'));
    add(request('b'));
    add(request('a', 'a new command'));
    expect(queue.value.map((r) => r.id)).toEqual(['a', 'b']);
    expect(queue.value[0]!.command).toBe('a new command');
  });

  test('an answered request leaves the queue', () => {
    const { add, remove, current } = useDesktopTeamRequests();
    add(request('a'));
    add(request('b'));
    remove('a');
    expect(current.value?.id).toBe('b');
  });

  test('is shared by every caller', () => {
    useDesktopTeamRequests().add(request('a'));
    expect(useDesktopTeamRequests().current.value?.id).toBe('a');
  });
});
