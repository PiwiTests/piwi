<script setup lang="ts">
/**
 * A test named by its title path, as Playwright's reporters print it: the spec
 * file's folders, the file and the test's line (the file opens in the IDE), the
 * describe blocks, outermost first, then the title, all joined by `›` and
 * wrapping as one line of text. A deep path folds its middle (`foldSegments`):
 * past four folders only the first two and the last show, past two describe
 * blocks only the outermost and the innermost, and an ellipsis button in place
 * of the rest unfolds the whole path. The title is the default slot, so the
 * caller sets its emphasis; the path keeps the surrounding text's style. A test
 * with no file or no describe block shows what it has.
 */
import { foldSegments, splitFilePath, TITLE_PATH_MAX_DESCRIBES, TITLE_PATH_MAX_FOLDERS } from '~/utils/title-path';

const props = defineProps<{
  filePath?: string | null;
  /** The line the test is declared on. */
  line?: number | null;
  /** The describe blocks around the test, outermost first. */
  suitePath?: readonly string[] | null;
  projectKey?: string | number | null;
  projectName?: string | null;
}>();

const expanded = ref(false);

const file = computed(() => splitFilePath(props.filePath ?? ''));
const folders = computed(() => foldSegments(file.value.folders, expanded.value ? Infinity : TITLE_PATH_MAX_FOLDERS, 2));
const describes = computed(() =>
  foldSegments(props.suitePath ?? [], expanded.value ? Infinity : TITLE_PATH_MAX_DESCRIBES, 1),
);

const ELLIPSIS_CLASS =
  'rounded cursor-pointer hover:bg-elevated hover:text-default focus-visible:outline-2 focus-visible:outline-primary';
</script>

<template>
  <span class="min-w-0 break-words" data-test-title-path>
    <template v-if="filePath"
      ><span class="font-mono wrap-anywhere"
        ><template v-for="(folder, i) in folders.head" :key="`h${i}`">{{ folder }}/</template
        ><template v-if="folders.hidden.length"
          ><button
            type="button"
            :class="ELLIPSIS_CLASS"
            :title="folders.hidden.join('/')"
            aria-label="Show the full path"
            @click="expanded = true"
          >
            <UIcon name="i-lucide-ellipsis" class="size-3.5 align-middle" /></button
          >/<template v-for="(folder, i) in folders.tail" :key="`t${i}`">{{ folder }}/</template></template
        ></span
      ><OpenInIdeLink :file-path="filePath" :line="line" :project-key="projectKey" :project-name="projectName" inline
        >{{ file.fileName }}<template v-if="line">:{{ line }}</template></OpenInIdeLink
      ><span aria-hidden="true"> › </span><span class="sr-only">, </span></template
    ><template v-for="(segment, i) in describes.head" :key="`d${i}`"
      >{{ segment }}<span aria-hidden="true"> › </span><span class="sr-only">, </span></template
    ><template v-if="describes.hidden.length"
      ><button
        type="button"
        :class="ELLIPSIS_CLASS"
        :title="describes.hidden.join(' › ')"
        aria-label="Show the full path"
        @click="expanded = true"
      >
        <UIcon name="i-lucide-ellipsis" class="size-3.5 align-middle" /></button
      ><span aria-hidden="true"> › </span
      ><template v-for="(segment, i) in describes.tail" :key="`dt${i}`"
        >{{ segment }}<span aria-hidden="true"> › </span><span class="sr-only">, </span></template
      ></template
    ><slot />
  </span>
</template>
