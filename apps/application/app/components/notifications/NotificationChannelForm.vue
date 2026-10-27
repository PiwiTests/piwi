<script setup lang="ts">
/**
 * The new-channel form. Each type shows how to get its destination — a Slack
 * app pre-filled for Piwi (for an incoming webhook or a bot token), the Teams
 * Workflows template, a generated webhook secret — checks a pasted URL against
 * the type (offering the right type when it belongs to another), and sends a
 * test before saving: a channel whose test went through is saved verified.
 */
import {
  SLACK_INCOMING_WEBHOOKS_GUIDE_URL,
  SLACK_POST_MESSAGE_GUIDE_URL,
  TEAMS_WORKFLOWS_GUIDE_URL,
  channelConfigProblem,
  generateWebhookSecret,
  inspectChannelUrl,
  slackCreateAppUrl,
  suggestChannelName,
  type ChannelType,
  type SlackDelivery,
} from '#shared/notifications/channel-setup';

const props = defineProps<{
  authEnabled: boolean;
  /** Administrators can make a channel global. */
  canSeeAdmin: boolean;
  /** Whether SMTP is set up, so an email channel can send. */
  smtpConfigured: boolean;
  /** False when the server has no `PIWI_SECRET_KEY`, so a webhook secret or a Slack bot token cannot be stored. */
  canStoreSecrets: boolean;
}>();
const emit = defineEmits<{ saved: []; cancel: [] }>();

const toast = useToast();
const { copy, copied } = useCopy();

const form = reactive({
  type: 'email' as ChannelType,
  name: '',
  address: '',
  webhookUrl: '',
  slackDelivery: 'webhook' as SlackDelivery,
  token: '',
  channelId: '',
  url: '',
  secret: '',
  global: false,
});

// Browser channels pair with per-user subscriptions; without auth the project
// bell's per-browser preferences cover that role instead.
const typeItems = computed(() => [
  { label: 'Email', value: 'email' },
  { label: 'Slack', value: 'slack' },
  { label: 'Microsoft Teams webhook', value: 'teams' },
  { label: 'Webhook', value: 'webhook' },
  ...(props.authEnabled ? [{ label: 'Browser', value: 'browser' }] : []),
]);

const slackDeliveryItems = [
  { label: 'Incoming webhook', value: 'webhook' },
  { label: 'Bot token (Web API)', value: 'api' },
];
const slackAppUrl = computed(() => slackCreateAppUrl(undefined, form.slackDelivery));
const slackApi = computed(() => form.type === 'slack' && form.slackDelivery === 'api');
/** A bot token is stored encrypted, which needs `PIWI_SECRET_KEY` on the server. */
const tokenNotStorable = computed(() => slackApi.value && !props.canStoreSecrets);

const config = computed<Record<string, unknown>>(() => {
  if (form.type === 'email') return { address: form.address.trim() };
  if (slackApi.value) return { token: form.token.trim(), channelId: form.channelId.trim() };
  if (form.type === 'slack' || form.type === 'teams') return { webhookUrl: form.webhookUrl.trim() };
  if (form.type === 'webhook') {
    return form.secret && props.canStoreSecrets
      ? { url: form.url.trim(), secret: form.secret }
      : { url: form.url.trim() };
  }
  return {};
});
const destination = computed(() => {
  if (form.type === 'email') return form.address;
  if (form.type === 'webhook') return form.url;
  if (slackApi.value) return form.channelId || form.token;
  return form.type === 'browser' ? '' : form.webhookUrl;
});
const problem = computed(() => channelConfigProblem(form.type, config.value));
const verdict = computed(() =>
  (form.type === 'slack' && !slackApi.value) || form.type === 'teams' || form.type === 'webhook'
    ? inspectChannelUrl(form.type, destination.value)
    : null,
);
const suggestedName = computed(() => suggestChannelName(form.type, destination.value));

const TYPE_LABELS: Record<'slack' | 'teams', string> = { slack: 'Slack', teams: 'Microsoft Teams' };

/** Move a pasted URL to the type it belongs to. */
function switchType(type: 'slack' | 'teams') {
  if (form.type === 'webhook') form.webhookUrl = form.url;
  form.type = type;
  form.slackDelivery = 'webhook';
}

function generateSecret() {
  form.secret = generateWebhookSecret();
}

// ── Test before saving ────────────────────────────────────────────────────────
interface TestResult {
  success: boolean;
  error?: string;
  hint?: string;
}
const testing = ref(false);
const testResult = ref<TestResult | null>(null);
/** The type and destination the result belongs to; editing either hides it. */
const testedFor = ref<string | null>(null);
const configKey = computed(() => JSON.stringify([form.type, config.value]));
const currentTest = computed(() => (testedFor.value === configKey.value ? testResult.value : null));

async function sendTest() {
  if (problem.value || form.type === 'browser') return;
  testing.value = true;
  const key = configKey.value;
  try {
    testResult.value = await $fetch<TestResult>('/api/channels/test', {
      method: 'POST',
      body: { type: form.type, config: config.value },
    });
  } catch (err) {
    testResult.value = { success: false, error: errorMessage(err) };
  } finally {
    testedFor.value = key;
    testing.value = false;
  }
}

// ── Save ─────────────────────────────────────────────────────────────────────
const saving = ref(false);

async function save() {
  if (problem.value || tokenNotStorable.value) return;
  saving.value = true;
  try {
    await $fetch('/api/channels', {
      method: 'POST',
      body: {
        name: form.name.trim() || suggestedName.value,
        type: form.type,
        config: config.value,
        global: form.global,
      },
    });
    toast.add({ title: 'Channel created', color: 'success' });
    emit('saved');
  } catch (err) {
    toast.add({ title: 'Failed to create channel', description: errorMessage(err), color: 'error' });
  } finally {
    saving.value = false;
  }
}

// ── Browser permission ──────────────────────────────────────────────────────────
const permission = ref<NotificationPermission | 'unsupported'>('default');
onMounted(() => {
  permission.value = 'Notification' in window ? Notification.permission : 'unsupported';
});
async function requestPermission() {
  if (permission.value !== 'default') return;
  permission.value = await Notification.requestPermission();
}
</script>

<template>
  <form
    class="mb-4 space-y-4 rounded-lg border border-default p-3 sm:p-4"
    data-shot="channel-form"
    data-tour="notification-channel-form"
    @submit.prevent="save"
  >
    <h4 class="text-sm font-semibold text-highlighted">New channel</h4>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <UFormField label="Type">
        <USelect v-model="form.type" :items="typeItems" value-key="value" class="w-full" />
      </UFormField>
      <UFormField label="Name">
        <UInput v-model="form.name" :placeholder="suggestedName" class="w-full" data-testid="channel-name" />
      </UFormField>
    </div>

    <!-- Email -->
    <template v-if="form.type === 'email'">
      <UFormField label="Email address">
        <UInput v-model="form.address" type="email" placeholder="team@example.com" class="w-full sm:max-w-md" />
      </UFormField>
      <CheckResultLine
        v-if="!smtpConfigured"
        state="warning"
        text="Email delivery is not set up on this instance, so this channel will not send yet."
        hint="An administrator configures SMTP through environment variables: see SMTP email delivery above."
      />
    </template>

    <!-- Slack -->
    <template v-else-if="form.type === 'slack'">
      <UFormField label="Send with">
        <URadioGroup
          v-model="form.slackDelivery"
          :items="slackDeliveryItems"
          value-key="value"
          orientation="horizontal"
          data-testid="slack-delivery"
        />
      </UFormField>

      <!-- Web API -->
      <template v-if="slackApi">
        <ol
          class="list-decimal space-y-1.5 ps-5 text-sm leading-relaxed text-highlighted"
          data-testid="slack-api-steps"
        >
          <li>
            <OutboundLink :href="slackAppUrl">Create a Slack app for Piwi</OutboundLink>. The link fills in the app,
            with the permissions it needs to post: <code>chat:write</code>, and <code>chat:write.public</code> for
            public channels it is not invited to.
          </li>
          <li>
            Choose <span class="font-semibold">Install to Workspace</span>, then copy the
            <span class="font-semibold">Bot User OAuth Token</span> from
            <span class="font-semibold">OAuth &amp; Permissions</span>.
          </li>
          <li>
            In Slack, open the channel’s details and copy the <span class="font-semibold">Channel ID</span> at the
            bottom. For a private channel, invite the app first with <code>/invite @Piwi</code>.
          </li>
        </ol>
        <p class="text-xs text-muted">
          Piwi posts with <OutboundLink :href="SLACK_POST_MESSAGE_GUIDE_URL">chat.postMessage</OutboundLink>, the same
          message the webhook sends.
        </p>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UFormField label="Bot token">
            <UInput
              v-model="form.token"
              type="password"
              autocomplete="off"
              placeholder="xoxb-…"
              class="w-full"
              data-testid="slack-bot-token"
            />
          </UFormField>
          <UFormField label="Channel ID">
            <UInput v-model="form.channelId" placeholder="C0123456789" class="w-full" data-testid="slack-channel-id" />
          </UFormField>
        </div>
        <CheckResultLine
          v-if="tokenNotStorable"
          state="warning"
          text="Storing a bot token needs PIWI_SECRET_KEY set on the server, so this channel cannot be saved yet."
          hint="Piwi encrypts the token with that key. Use an incoming webhook meanwhile."
        />
      </template>

      <!-- Incoming webhook -->
      <template v-else>
        <ol class="list-decimal space-y-1.5 ps-5 text-sm leading-relaxed text-highlighted" data-testid="slack-steps">
          <li>
            <OutboundLink :href="slackAppUrl">Create a Slack app for Piwi</OutboundLink>. The link fills in the app,
            with the one permission it needs to post.
          </li>
          <li>
            Pick the workspace, create the app, then choose <span class="font-semibold">Install to Workspace</span> and
            the channel to post to.
          </li>
          <li>Open <span class="font-semibold">Incoming Webhooks</span>, copy the webhook URL and paste it below.</li>
        </ol>
        <p class="text-xs text-muted">
          Already have an incoming webhook? Paste its URL.
          <OutboundLink :href="SLACK_INCOMING_WEBHOOKS_GUIDE_URL">Slack’s guide</OutboundLink>
        </p>
        <UFormField label="Slack webhook URL">
          <UInput
            v-model="form.webhookUrl"
            placeholder="https://hooks.slack.com/services/…"
            class="w-full"
            data-testid="slack-webhook-url"
          />
        </UFormField>
      </template>
    </template>

    <!-- Microsoft Teams -->
    <template v-else-if="form.type === 'teams'">
      <ol class="list-decimal space-y-1.5 ps-5 text-sm leading-relaxed text-highlighted" data-testid="teams-steps">
        <li>
          In Teams, open the channel’s <span class="font-semibold">⋯</span> menu and choose
          <span class="font-semibold">Workflows</span>.
        </li>
        <li>
          Pick <span class="font-semibold">Send webhook alerts to a channel</span>, choose the team and channel, and
          save.
        </li>
        <li>Copy the webhook URL the workflow shows and paste it below.</li>
      </ol>
      <p class="text-xs text-muted">
        <OutboundLink :href="TEAMS_WORKFLOWS_GUIDE_URL">Microsoft’s guide to Workflows webhooks</OutboundLink>
      </p>
      <UFormField>
        <template #label>
          <span class="inline-flex items-center gap-1"
            >Microsoft Teams webhook URL <HelpHint topic="notifications.teams"
          /></span>
        </template>
        <UInput
          v-model="form.webhookUrl"
          placeholder="https://….powerplatform.com/… or https://….logic.azure.com/…"
          class="w-full"
          data-testid="teams-webhook-url"
        />
      </UFormField>
    </template>

    <!-- Webhook -->
    <template v-else-if="form.type === 'webhook'">
      <UFormField label="Endpoint URL">
        <UInput
          v-model="form.url"
          placeholder="https://your-server.com/webhook"
          class="w-full"
          data-testid="webhook-url"
        />
      </UFormField>
    </template>

    <!-- Browser -->
    <template v-else-if="form.type === 'browser'">
      <p class="text-sm text-highlighted">
        Sends OS notifications to your open dashboard tabs. No configuration needed: subscribe it to events after
        saving.
      </p>
      <CheckResultLine v-if="permission === 'granted'" state="ok" text="Notifications are allowed in this browser." />
      <div v-else-if="permission === 'default'" class="flex flex-wrap items-center gap-2 text-sm text-highlighted">
        <UButton
          type="button"
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-bell-ring"
          label="Allow notifications"
          @click="requestPermission"
        />
        <span class="text-xs text-muted">The browser asks once.</span>
      </div>
      <CheckResultLine
        v-else-if="permission === 'denied'"
        state="warning"
        text="Notifications are blocked for this site."
        hint="Allow them in the browser’s site settings, then reload the page."
      />
      <CheckResultLine v-else state="warning" text="This browser does not support notifications." />
    </template>

    <CheckResultLine
      v-if="verdict && verdict.level !== 'ok'"
      :state="verdict.level === 'error' ? 'error' : 'warning'"
      data-testid="channel-url-check"
    >
      {{ verdict.message }}
      <button
        v-if="verdict.suggestType"
        type="button"
        :class="SENTENCE_LINK_CLASS"
        @click="switchType(verdict.suggestType)"
      >
        Switch to {{ TYPE_LABELS[verdict.suggestType] }}
      </button>
    </CheckResultLine>
    <CheckResultLine v-else-if="verdict" state="ok" :text="verdict.message" data-testid="channel-url-check" />

    <template v-if="form.type === 'webhook'">
      <UFormField
        label="Signing secret"
        :description="
          canStoreSecrets
            ? 'Optional. Piwi signs each body with it in X-Piwi-Signature (HMAC-SHA256), so your endpoint can reject forgeries.'
            : 'Needs PIWI_SECRET_KEY set on the server to be stored, so deliveries go unsigned for now.'
        "
      >
        <div class="flex flex-wrap items-center gap-2">
          <UInput
            v-model="form.secret"
            type="password"
            autocomplete="new-password"
            placeholder="Shared secret"
            class="min-w-0 flex-1 sm:max-w-md"
            :disabled="!canStoreSecrets"
          />
          <UButton
            type="button"
            color="neutral"
            variant="outline"
            icon="i-lucide-dices"
            label="Generate"
            :disabled="!canStoreSecrets"
            title="Fill in a random 256-bit secret"
            @click="generateSecret"
          />
          <UButton
            v-if="form.secret"
            type="button"
            color="neutral"
            variant="ghost"
            :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
            :label="copied ? 'Copied' : 'Copy'"
            title="Copy the secret to configure your endpoint with it"
            @click="copy(form.secret)"
          />
        </div>
      </UFormField>
      <p class="text-xs text-muted">
        <DocLink to="reference/notification-events#verifying-a-webhook">How to verify the signature</DocLink>
      </p>
    </template>

    <UCheckbox
      v-if="authEnabled && canSeeAdmin"
      v-model="form.global"
      label="Global channel"
      description="Visible to every user; anyone can subscribe to it."
    />
    <p v-if="!authEnabled" class="text-xs text-muted">Authentication is disabled, so channels are instance-wide.</p>

    <CheckResultLine
      v-if="currentTest"
      :state="currentTest.success ? 'ok' : 'error'"
      :text="
        currentTest.success
          ? 'Test sent. If it arrived, save: the channel starts verified.'
          : (currentTest.error ?? 'The test was not delivered.')
      "
      :hint="currentTest.hint"
      data-testid="channel-test-result"
    />

    <div class="flex flex-wrap items-center gap-2">
      <UButton
        v-if="form.type !== 'browser'"
        type="button"
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-send"
        label="Send test"
        :loading="testing"
        :disabled="!!problem || (form.type === 'email' && !smtpConfigured)"
        title="Send a test notification to this destination; nothing is saved"
        @click="sendTest"
      />
      <span v-if="problem && destination.trim()" class="text-xs text-muted">{{ problem }}</span>
      <div class="flex-1" />
      <UButton type="button" color="neutral" variant="ghost" size="sm" label="Cancel" @click="emit('cancel')" />
      <UButton
        type="submit"
        color="primary"
        size="sm"
        label="Save channel"
        :loading="saving"
        :disabled="!!problem || tokenNotStorable"
      />
    </div>
  </form>
</template>
