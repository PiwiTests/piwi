import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import ConfigModeSwitch from './components/ConfigModeSwitch.vue'
import DemoExamples from './components/DemoExamples.vue'
import EnvWizard from './components/EnvWizard.vue'
import HeroVisual from './components/HeroVisual.vue'
import Needs from './components/Needs.vue'
import { installImageZoom } from './image-zoom'
import './custom.css'

// Extends the default VitePress theme with a small amount of custom CSS (see
// custom.css) — used to style inline screenshot figures on content pages — the
// configuration reference/generator components used on /configuration and
// /configuration/generator, the <Needs> prerequisite row on feature pages, the
// <DemoExamples> list under a feature page's "Try it in the demo" heading,
// the home hero's illustration (<HeroVisual>, in the slot the default theme
// keeps for the hero image), and click-to-zoom on the content's images
// (image-zoom.ts).
export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { 'home-hero-image': () => h(HeroVisual) }),
  enhanceApp({ app }) {
    app.component('ConfigModeSwitch', ConfigModeSwitch)
    app.component('DemoExamples', DemoExamples)
    app.component('EnvWizard', EnvWizard)
    app.component('Needs', Needs)
    if (typeof document !== 'undefined') installImageZoom()
  },
} satisfies Theme
