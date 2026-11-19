<script setup lang="ts">
/** Piwi Runner's mark: the app's own icon (`app-icon.svg`), the Piwi bird on a teal tile with a play sign. */
import icon from '../../app-icon.svg';
</script>

<template>
  <img :src="icon" alt="" draggable="false" class="select-none" />
</template>
