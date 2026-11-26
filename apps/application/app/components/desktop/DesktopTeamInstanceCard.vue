<script setup lang="ts">
/**
 * Settings → Team instance: the connection to a team instance, which takes run requests (Run on my machine) and
 * compares a test that fails here with the instance's CI (Compare with team instance), and a note when its key was made
 * before it could compare: connecting again gives one that can.
 */
const { connection } = useDesktopTeamRequests();
</script>

<template>
  <SectionCard icon="i-lucide-server" title="Connection" data-shot="desktop-team-instance-card">
    <template #subtitle>
      Connect this app to your team's Piwi instance: it takes the runs you ask for there (Run on my machine), and shows
      how a test that fails here does in the team's CI (Compare with team instance).
    </template>
    <div class="space-y-4">
      <DesktopTeamInstance app-name="Piwi Desktop" :folders="false" />
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
