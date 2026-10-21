<script setup lang="ts">
// The home page's hero illustration, in the slot the default theme keeps for an image: the Piwi mark above a small
// run panel that tells one run's story in a CSS loop. Six tests land one by one, the two failures are grouped into one
// root cause, and the replacement locator is offered as the fix; the mark's check swells at that moment. Everything
// is markup and keyframes on one shared clock (`--loop`), so the scenes stay in step; a visitor who prefers reduced
// motion gets the final state, still.
const tests = [
  { name: 'applies a coupon', took: '1.2 s', failed: false },
  { name: 'pays by card', took: '5.0 s', failed: true },
  { name: 'removes a row', took: '0.9 s', failed: false },
  { name: 'search finds mugs', took: '0.8 s', failed: false },
  { name: 'pays by gift card', took: '5.0 s', failed: true },
  { name: 'privacy page', took: '0.6 s', failed: false },
]
</script>

<template>
  <div
    class="hero-visual"
    role="img"
    aria-label="A run streaming into Piwi: six tests land, the two failures are grouped into one root cause, and the replacement locator is offered as the fix."
  >
    <div class="mark" aria-hidden="true">
      <svg viewBox="0 0 512 512" width="88" height="88">
        <rect width="512" height="512" rx="118" fill="#7c3aed" />
        <g transform="translate(256 256) scale(1.1666) translate(-127 -154)">
          <circle cx="137.3" cy="118" r="57" fill="#0d1d47" />
          <path
            d="M27.11 225.74 L27.11 113.13 C27.387 70.881 52.369 32.669 91.958 13.939 C134.443 -6.161 190.2 -2.218 234.141 42.928 L256.46 65.86 C257.993 67.44 257.83 68.817 255.97 69.99 L231.52 85.4 C246.493 125.196 232.85 170.793 198.262 196.55 C163.675 222.307 116.776 221.794 83.94 195.3 L31.96 228.4 C28.727 230.46 27.11 229.573 27.11 225.74 Z M162.57 165.22 C190.8 149.461 198.999 116.772 184.523 90.842 C170.048 64.912 138.38 55.561 110.15 71.32 C81.92 87.079 75.566 119.03 90.042 144.96 C104.517 170.89 134.34 180.979 162.57 165.22 Z M189.62 52.7 A16 16 0 1 0 221.62 52.7 A16 16 0 1 0 189.62 52.7 Z"
            fill="#ffffff"
            fill-rule="evenodd"
          />
          <circle class="mark-lid" cx="205.62" cy="52.7" r="17" fill="#ffffff" />
          <path
            class="mark-check"
            d="M101.78 123.89 L126.25 148.22 L170.85 98.47 L165.31 93.49 L125.94 137.4 L107.04 118.6 Z"
            fill="#2fd9ae"
            stroke="#2fd9ae"
            stroke-width="22"
            stroke-linejoin="round"
          />
          <path
            d="M28.2 276.73 L83.43 241.904 L154.16 276.68"
            fill="none"
            stroke="#ffffff"
            stroke-width="28"
            stroke-linejoin="round"
          />
          <circle cx="28.2" cy="276.73" r="32" fill="#ffffff" />
          <circle cx="154.16" cy="276.68" r="32" fill="#ffffff" />
        </g>
      </svg>
    </div>

    <div class="panel" aria-hidden="true">
      <div class="head">
        <span class="run">Run #124 <span class="branch">main</span></span>
        <span class="state state-live"><i class="dot"></i>streaming</span>
        <span class="state state-done">4 passed · 2 failing</span>
      </div>

      <ul class="rows">
        <li v-for="(test, i) in tests" :key="test.name" :class="['row', `row-${i}`, { failed: test.failed }]">
          <svg v-if="test.failed" class="icon" viewBox="0 0 16 16" width="16" height="16">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
          <svg v-else class="icon" viewBox="0 0 16 16" width="16" height="16">
            <path d="M3 8.5l3 3 7-7" />
          </svg>
          <span class="name">{{ test.name }}</span>
          <span class="took">{{ test.took }}</span>
        </li>
      </ul>

      <div class="cluster">
        <span class="cluster-title">1 root cause · 2 tests</span>
        <code class="cluster-why">locator('.btn-primary').nth(1) not found</code>
      </div>

      <div class="heal">
        <span class="heal-label">Heal</span>
        <code class="heal-locator">getByRole('button', { name: 'Place order' })</code>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* One clock for every scene: the percentages below are moments of this loop. */
.hero-visual {
  --loop: 14s;
  --teal: #0d9488;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  width: 100%;
  max-width: 400px;
  margin: 0 auto;
  font-family: var(--vp-font-family-base);
}

.dark .hero-visual {
  --teal: #2fd9ae;
}

/* ── The mark ─────────────────────────────────────────────────────────── */

.mark {
  position: relative;
  z-index: 1;
  filter: drop-shadow(0 10px 24px rgb(124 58 237 / 0.35));
}

.mark svg {
  display: block;
}

/* The eye is a hole in the head; the lid closes over it for a blink every few seconds. */
.mark-lid {
  transform-box: fill-box;
  transform-origin: center;
  transform: scaleY(0);
  animation: blink 5s linear infinite;
}

/* The check swells for a moment when the fix lands. */
.mark-check {
  transform-box: fill-box;
  transform-origin: center;
  animation: swell var(--loop) ease-in-out infinite both;
}

/* ── The run panel ───────────────────────────────────────────────────── */

.panel {
  position: relative;
  z-index: 1;
  width: 100%;
  padding: 12px 14px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-elv);
  box-shadow: var(--vp-shadow-3);
  font-size: 13px;
  line-height: 1.4;
  text-align: left;
  color: var(--vp-c-text-1);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px 10px;
  border-bottom: 1px solid var(--vp-c-divider);
  font-weight: 600;
}

.branch {
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--vp-c-default-soft);
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  font-weight: 500;
  color: var(--vp-c-text-2);
}

.state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--vp-c-text-2);
}

.state-live {
  position: absolute;
  right: 16px;
  opacity: 0;
  animation: live var(--loop) linear infinite both;
}

.state-done {
  animation: done var(--loop) linear infinite both;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--vp-c-green-1);
  animation: pulse 1.2s ease-in-out infinite;
}

.rows {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 -6px;
  padding: 5px 8px;
  border-radius: 8px;
  animation-duration: var(--loop);
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  animation-fill-mode: both;
}

.row-0 {
  animation-name: row-0;
}
.row-1 {
  animation-name: row-1, clustered;
}
.row-2 {
  animation-name: row-2;
}
.row-3 {
  animation-name: row-3;
}
.row-4 {
  animation-name: row-4, clustered;
}
.row-5 {
  animation-name: row-5;
}

/* The two failures, once grouped: the final state, which the loop reaches a third of the way in. */
.row.failed {
  background: var(--vp-c-brand-soft);
}

.icon {
  flex: none;
  fill: none;
  stroke: var(--vp-c-green-1);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.failed .icon {
  stroke: var(--vp-c-red-1);
}

.name {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.took {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--vp-c-text-3);
}

.cluster {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 10px;
  padding: 8px 10px;
  border-left: 3px solid var(--vp-c-brand-1);
  border-radius: 6px;
  background: var(--vp-c-brand-soft);
  animation: cluster var(--loop) linear infinite both;
}

.cluster-title {
  font-weight: 600;
  color: var(--vp-c-brand-1);
}

.cluster-why,
.heal-locator {
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  color: var(--vp-c-text-2);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.heal {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 0 2px;
  animation: heal var(--loop) linear infinite both;
}

.heal-label {
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--teal) 16%, transparent);
  font-size: 11px;
  font-weight: 600;
  color: var(--teal);
}

.heal-locator {
  color: var(--teal);
  animation: reveal var(--loop) linear infinite both;
}

/* ── The clock ───────────────────────────────────────────────────────── */

@keyframes blink {
  0%,
  90%,
  100% {
    transform: scaleY(0);
  }
  93%,
  96% {
    transform: scaleY(1);
  }
}

@keyframes pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.5);
    opacity: 0.6;
  }
}

/* The tests land one by one over the first four seconds and leave together at the end. */
@keyframes row-0 {
  0%,
  4.3% {
    opacity: 0;
    transform: translateY(6px);
  }
  6.8%,
  94% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
    transform: none;
  }
}
@keyframes row-1 {
  0%,
  8.2% {
    opacity: 0;
    transform: translateY(6px);
  }
  10.7%,
  94% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
    transform: none;
  }
}
@keyframes row-2 {
  0%,
  12.1% {
    opacity: 0;
    transform: translateY(6px);
  }
  14.6%,
  94% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
    transform: none;
  }
}
@keyframes row-3 {
  0%,
  16.1% {
    opacity: 0;
    transform: translateY(6px);
  }
  18.6%,
  94% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
    transform: none;
  }
}
@keyframes row-4 {
  0%,
  20% {
    opacity: 0;
    transform: translateY(6px);
  }
  22.5%,
  94% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
    transform: none;
  }
}
@keyframes row-5 {
  0%,
  23.9% {
    opacity: 0;
    transform: translateY(6px);
  }
  26.4%,
  94% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
    transform: none;
  }
}

/* The streaming badge, while the tests land; the counts once they have. */
@keyframes live {
  0%,
  3% {
    opacity: 0;
  }
  5%,
  27% {
    opacity: 1;
  }
  30%,
  100% {
    opacity: 0;
  }
}
@keyframes done {
  0%,
  30% {
    opacity: 0;
  }
  33%,
  94% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

/* Five seconds in, the failures are grouped: the group appears and its tests take its tint. */
@keyframes clustered {
  0%,
  35% {
    background-color: transparent;
  }
  38%,
  94% {
    background-color: var(--vp-c-brand-soft);
  }
  100% {
    background-color: transparent;
  }
}
@keyframes cluster {
  0%,
  35% {
    opacity: 0;
    transform: translateY(8px);
  }
  38.5%,
  94% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
    transform: none;
  }
}

/* Seven seconds in, the fix: the heal line, its locator written out, and the check swelling on the mark. */
@keyframes heal {
  0%,
  52% {
    opacity: 0;
    transform: translateY(6px);
  }
  55%,
  94% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
    transform: none;
  }
}
@keyframes reveal {
  0%,
  55% {
    clip-path: inset(0 100% 0 0);
  }
  64%,
  100% {
    clip-path: inset(0 0 0 0);
  }
}
@keyframes swell {
  0%,
  53%,
  60%,
  100% {
    transform: scale(1);
  }
  56.5% {
    transform: scale(1.25);
  }
}

/* No motion: the final state, as the base styles draw it. */
@media (prefers-reduced-motion: reduce) {
  .hero-visual *,
  .hero-visual {
    animation: none !important;
  }
  .state-live {
    display: none;
  }
}
</style>
