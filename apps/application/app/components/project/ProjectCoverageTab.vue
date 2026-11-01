<script setup lang="ts">
/**
 * The project page's Coverage tab: what the suite does not test, in three
 * views behind one switch. **Gaps** ranks the tests to write, **Map** draws the
 * project graph per feature, **Code** combines the suites' coverage of a commit.
 * Gaps and Map follow the `test-map` capability, Code the `coverage` one.
 *
 * The view is the address's `?view=`. Without one, a `?node=` opens Map, a
 * `?commit=`, `?folder=` or `?area=` opens Code, and anything else the first
 * view the project has. A view's own keys leave the address when another opens.
 */
import { COVERAGE_VIEW_KEYS, COVERAGE_VIEWS, type CoverageView } from '~/utils/coverage-tab';

const props = defineProps<{ projectId: number }>();
const route = useRoute();
const router = useRouter();
const { isHidden } = await useProjectCapabilities(props.projectId);

const LABELS: Record<CoverageView, string> = { gaps: 'Gaps', map: 'Map', code: 'Code' };

const views = computed(() =>
  COVERAGE_VIEWS.filter((view) => !isHidden(view === 'code' ? 'coverage' : 'test-map')).map((view) => ({
    key: view,
    label: LABELS[view],
  })),
);

/** The view a link without `?view=` means, from the keys it carries. */
function impliedView(): CoverageView {
  if (route.query.node) return 'map';
  if (route.query.commit || route.query.folder || route.query.area) return 'code';
  return 'gaps';
}

const view = computed<CoverageView>({
  get() {
    const available = views.value.map((v) => v.key);
    const asked = COVERAGE_VIEWS.find((v) => v === route.query.view) ?? impliedView();
    return available.includes(asked) ? asked : (available[0] ?? 'gaps');
  },
  set(next) {
    const patch: Record<string, string | undefined> = { view: next };
    for (const [owner, keys] of Object.entries(COVERAGE_VIEW_KEYS)) {
      if (owner !== next) for (const key of keys) patch[key] = undefined;
    }
    void router.replace({ query: { ...route.query, ...patch } });
  },
});
</script>

<template>
  <div class="space-y-4">
    <SegmentedSwitch v-if="views.length > 1" v-model="view" :items="views" class="max-sm:px-4" />

    <div v-if="view === 'gaps'" data-tour="coverage-gaps-view">
      <GapsPanel :project-id="props.projectId" />
    </div>
    <div v-else-if="view === 'map'" data-tour="coverage-map-view">
      <TestMapPanel :project-id="props.projectId" />
    </div>
    <div v-else data-tour="coverage-code-view">
      <ProjectCodeCoverage :project-id="props.projectId" />
    </div>
  </div>
</template>
