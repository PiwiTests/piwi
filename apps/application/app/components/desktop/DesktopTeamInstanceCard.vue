<script setup lang="ts">
/**
 * Settings → Desktop app: the connection to a team instance (Run on my machine), which also compares a test that fails
 * here with the instance's CI (Compare with team instance), and a note when its key was made before it could:
 * connecting again gives one that can.
 */
const { connection } = useDesktopTeamRequests();
</script>

<template>
  <SectionCard icon="i-lucide-monitor-play" title="Run on my machine" data-shot="desktop-team-instance-card">
    <template #subtitle>{{ connectionIntro() }}</template>
    <div class="space-y-4">
      <DesktopTeamInstance app-name="Piwi Desktop" />
      <p
        v-if="connection.compares === true && connection.state !== 'none'"
        class="text-xs text-muted"
        data-testid="team-instance-compares"
      >
        This connection also compares a test that fails here with the team instance's CI.
      </p>
      <p
        v-else-if="connection.compares === false && connection.state !== 'none'"
        class="text-xs text-muted"
        data-testid="team-instance-reconnect-to-compare"
      >
        This connection was made before the app could compare a test with the team instance's CI. Disconnect, then
        connect again to compare.
      </p>
    </div>
  </SectionCard>
</template>
