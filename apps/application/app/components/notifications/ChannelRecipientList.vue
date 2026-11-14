<script setup lang="ts">
/**
 * The channels a delivery goes to, one per line: the channel's name, what it
 * sends and who receives it, and whose channel it is. Shown under a report
 * schedule's *Send to* and on each schedule of the Quality reports page.
 */
import { channelOwnerLabel, type ChannelOwner } from '#shared/notifications/channel-recipients';

withDefaults(
  defineProps<{
    channels: Array<{ id: number; name: string; recipient: string; owner: ChannelOwner | null }>;
    /** Whose each channel is; off with authentication disabled, where every channel is global. */
    showOwner?: boolean;
  }>(),
  { showOwner: true },
);
</script>

<template>
  <ul class="space-y-0.5">
    <li v-for="c in channels" :key="c.id" class="text-xs text-muted break-words" :data-testid="`recipient-${c.id}`">
      <span class="font-medium text-default">{{ c.name }}</span
      >: {{ c.recipient }}<template v-if="showOwner && c.owner"> · {{ channelOwnerLabel(c.owner) }}</template>
    </li>
  </ul>
</template>
