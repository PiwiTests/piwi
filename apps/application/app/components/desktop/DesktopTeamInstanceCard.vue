<template>
  <SectionCard icon="i-lucide-monitor-play" title="Run on my machine" data-shot="desktop-team-instance-card">
    <template #subtitle>{{ connectionIntro() }}</template>
    <DesktopTeamInstance app-name="Piwi Desktop" />
  </SectionCard>
</template>
