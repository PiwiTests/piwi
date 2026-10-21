import type { InjectionKey, MaybeRefOrGetter, Ref } from 'vue';

const EXTERNAL_ID_URL: InjectionKey<Readonly<Ref<string | null>>> = Symbol('externalIdUrl');

/**
 * Give the test ID chips below this component the project's link template (`externalIdUrl`), so each chip links to
 * its test in the team's test management tool. A page showing one project's tests provides it once.
 */
export function provideExternalIdUrl(template: MaybeRefOrGetter<string | null | undefined>): void {
  provide(
    EXTERNAL_ID_URL,
    computed(() => toValue(template) ?? null),
  );
}

/** The link template a parent provided, or `null`. */
export function useExternalIdUrl(): Readonly<Ref<string | null>> {
  return inject(EXTERNAL_ID_URL, ref(null));
}
