/**
 * The limits of the assistant's answer blocks, and the arguments the model
 * sends to make each one: the schema of every block tool and the checks that
 * need no database (lengths and counts, kebab-case ids unique within the
 * answer, at most one recommended option, entities from the conversation's
 * tool results). A block that fails a check is never sent; the model reads why.
 * The server adds what needs the instance: a guide's anchors and routes, a
 * patch's validation, a page's route.
 */
import { z } from 'zod';
import type {
  AssistantBlock,
  AssistantChoice,
  AssistantCommand,
  AssistantEntityRef,
  AssistantEntityType,
  AssistantGuidePlan,
} from '#shared/assistant';

export const ASSISTANT_BLOCK_LIMITS = {
  /** A block's id, an option's, a choice's or a step's: kebab-case. */
  idChars: 60,
  /** A block's title, an option's, a checklist's, a guide's and its stops'. */
  titleChars: 60,
  /** A question's or an options block's prompt, a checklist step's text. */
  promptChars: 300,
  /** A choice's label and detail, an option's summary and trade-off, an entity card's detail, a page link's label. */
  labelChars: 120,
  minOptions: 2,
  maxOptions: 4,
  minChoices: 2,
  maxChoices: 10,
  /** Choices when every one of them is an entity. */
  maxEntityChoices: 20,
  maxChecklistSteps: 12,
  /** A command's bash and its PowerShell, each. */
  commandChars: 2000,
  /** A code block, and a patch. */
  codeChars: 8000,
  maxGuideStops: 7,
  guideBodyChars: 360,
  /** Blocks of other kinds than text in one answer. */
  maxBlocks: 12,
} as const;

const L = ASSISTANT_BLOCK_LIMITS;

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const blockId = z
  .string()
  .max(L.idChars)
  .regex(KEBAB, 'must be kebab-case (a-z, 0-9, single hyphens)')
  .describe('Kebab-case, unique within this answer');
const itemId = z
  .string()
  .max(L.idChars)
  .regex(KEBAB, 'must be kebab-case (a-z, 0-9, single hyphens)')
  .describe('Kebab-case, unique within the block');
const title = z.string().trim().min(1).max(L.titleChars);
const label = z.string().trim().min(1).max(L.labelChars);

const ENTITY_TYPES = ['project', 'run', 'execution', 'cluster', 'test-case'] as const satisfies AssistantEntityType[];

const entityInput = z
  .object({ type: z.enum(ENTITY_TYPES), id: z.number().int().positive() })
  .describe('An entity a tool result of this conversation named, by its type and id');

const commandInput = {
  bash: z.string().min(1).max(L.commandChars).describe('The command for bash (Linux, macOS)'),
  powershell: z
    .string()
    .min(1)
    .max(L.commandChars)
    .optional()
    .describe('The same command for Windows PowerShell, when it differs from the bash one'),
};

const guideInput = {
  title: title.describe('The guide, at most 60 characters; **bold** is the only markup'),
  stops: z
    .array(
      z.object({
        anchor: z.string().max(100).describe('A guide anchor id that find_anchors returned'),
        route: z
          .string()
          .max(500)
          .optional()
          .describe(
            "The route the stop opens, from the app's root with real ids (/test-runs/12); needed when the anchor's page has an id and the user is not on it",
          ),
        title: title.describe('At most 60 characters; **bold** is the only markup'),
        body: z
          .string()
          .trim()
          .min(1)
          .max(L.guideBodyChars)
          .describe(
            'What to look at or do there, at most 360 characters; **bold** (a dashboard label) is the only markup',
          ),
      }),
    )
    .min(1)
    .max(L.maxGuideStops),
};

const guidePlan = z.object(guideInput);

/** The arguments of each block tool, by tool name. */
export const ASSISTANT_BLOCK_INPUTS = {
  show_code: z.object({
    id: blockId,
    language: z.string().trim().min(1).max(30).describe('The language, as a Markdown fence names it (ts, yaml, json)'),
    code: z.string().min(1).max(L.codeChars),
    title: title.optional(),
  }),
  show_command: z.object({ id: blockId, ...commandInput, title: title.optional() }),
  show_patch: z.object({
    id: blockId,
    patch: z.string().min(1).max(L.codeChars).describe('A unified diff, with repository-relative paths'),
    target: z
      .object({ type: z.enum(['run', 'execution', 'cluster']), id: z.number().int().positive() })
      .describe('The run, execution or failure cluster the patch fixes: its files are read at that run’s commit'),
    title: title.optional(),
  }),
  show_entity: z.object({
    id: blockId,
    entity: entityInput,
    detail: label.optional().describe('One line on why it matters here'),
  }),
  offer_options: z.object({
    id: blockId,
    prompt: z.string().trim().min(1).max(L.promptChars),
    options: z
      .array(
        z.object({
          id: itemId,
          title,
          summary: label.describe('What it does, in one line'),
          tradeoff: label.optional().describe('What it costs or risks, in one line'),
          effort: z.enum(['small', 'medium', 'large']).optional(),
          recommended: z.boolean().optional().describe('At most one option is recommended'),
          guide: guidePlan.optional().describe('A guide picking this option plays, instead of answering'),
        }),
      )
      .min(L.minOptions)
      .max(L.maxOptions),
  }),
  ask: z.object({
    id: blockId,
    prompt: z.string().trim().min(1).max(L.promptChars),
    multiple: z.boolean().default(false).describe('Checkboxes when true, radio buttons when false'),
    choices: z
      .array(
        z.object({
          id: itemId,
          label: label.optional().describe('Required unless the choice is an entity, whose name it defaults to'),
          detail: label.optional(),
          entity: entityInput.optional(),
          checked: z.boolean().optional().describe('Ticked when the question appears'),
        }),
      )
      .min(L.minChoices)
      .max(L.maxEntityChoices)
      .describe('At most 10 choices, or 20 when every choice is an entity'),
    other: z.boolean().default(false).describe('Offers an "Other" field the user types into'),
  }),
  checklist: z.object({
    id: blockId,
    title,
    steps: z
      .array(
        z.object({
          id: itemId,
          text: z.string().trim().min(1).max(L.promptChars),
          command: z.object(commandInput).optional(),
          guide: guidePlan.optional().describe('A guide showing where the step is done'),
        }),
      )
      .min(1)
      .max(L.maxChecklistSteps),
  }),
  show_guide: z.object({ id: blockId, ...guideInput }),
  navigate: z.object({
    id: blockId,
    route: z.string().trim().min(1).max(500).describe("A dashboard route from the app's root, with real ids"),
    label: label.describe('What the link opens, in a few words'),
  }),
} as const;

export type AssistantBlockTool = keyof typeof ASSISTANT_BLOCK_INPUTS;

/** Whether a block ends its answer: a question or options, whose pick comes back as the next question's reply. */
export function endsAssistantAnswer(block: AssistantBlock): boolean {
  return block.kind === 'question' || block.kind === 'options';
}

export function isAssistantBlockTool(name: string): name is AssistantBlockTool {
  return Object.hasOwn(ASSISTANT_BLOCK_INPUTS, name);
}

/** What a block's checks read: the entities of the conversation and the block ids the answer already used. */
interface AssistantBlockEnv {
  entity: (type: AssistantEntityType, id: number) => AssistantEntityRef | undefined;
  usedIds: ReadonlySet<string>;
}

/** A block a block tool makes: every kind but text, which streams. */
export type AssistantToolBlock = Exclude<AssistantBlock, { kind: 'text' }>;

type AssistantBlockCheck = { ok: true; block: AssistantToolBlock } | { ok: false; error: string };

const refusal = (error: string): AssistantBlockCheck => ({ ok: false, error });

function duplicateId(ids: readonly string[]): string | undefined {
  return ids.find((id, i) => ids.indexOf(id) !== i);
}

type Inputs = { [K in AssistantBlockTool]: z.infer<(typeof ASSISTANT_BLOCK_INPUTS)[K]> };

type Refuse = (entity: { type: AssistantEntityType; id: number }, where: string) => string | null;

/** A command as stored: the PowerShell form only when it differs from the bash one. */
function command(input: { bash: string; powershell?: string }): AssistantCommand {
  return {
    bash: input.bash,
    ...(input.powershell && input.powershell !== input.bash ? { powershell: input.powershell } : {}),
  };
}

/** Each block tool's checks past its schema, and the block it builds. */
const BUILDERS: {
  [K in AssistantBlockTool]: (input: Inputs[K], env: AssistantBlockEnv, unknownEntity: Refuse) => AssistantBlockCheck;
} = {
  show_code: (i) => ({
    ok: true,
    block: { kind: 'code', id: i.id, language: i.language, code: i.code, title: i.title },
  }),
  show_command: (i) => ({ ok: true, block: { kind: 'command', id: i.id, command: command(i), title: i.title } }),
  show_patch: (i, _env, unknownEntity) => {
    const missing = unknownEntity(i.target, 'target');
    if (missing) return refusal(missing);
    return { ok: true, block: { kind: 'patch', id: i.id, patch: i.patch, validation: null, title: i.title } };
  },
  show_entity: (i, env, unknownEntity) => {
    const entity = env.entity(i.entity.type, i.entity.id);
    if (!entity) return refusal(unknownEntity(i.entity, 'entity')!);
    return { ok: true, block: { kind: 'entity', id: i.id, entity, detail: i.detail } };
  },
  offer_options: (i) => {
    const dup = duplicateId(i.options.map((o) => o.id));
    if (dup) return refusal(`options: two options have the id "${dup}"`);
    if (i.options.filter((o) => o.recommended).length > 1) return refusal('options: at most one option is recommended');
    const options = i.options.map((o) => ({ ...o, recommended: o.recommended || undefined }));
    return { ok: true, block: { kind: 'options', id: i.id, prompt: i.prompt, options } };
  },
  ask: (i, env, unknownEntity) => {
    const dup = duplicateId(i.choices.map((c) => c.id));
    if (dup) return refusal(`choices: two choices have the id "${dup}"`);
    if (i.choices.length > L.maxChoices && !i.choices.every((c) => c.entity)) {
      return refusal(
        `choices: at most ${L.maxChoices} choices, or ${L.maxEntityChoices} when every choice is an entity`,
      );
    }
    if (!i.multiple && i.choices.filter((c) => c.checked).length > 1) {
      return refusal('choices: a question with radio buttons (multiple false) has at most one checked choice');
    }
    const choices: AssistantChoice[] = [];
    for (const [n, c] of i.choices.entries()) {
      const entity = c.entity ? env.entity(c.entity.type, c.entity.id) : undefined;
      if (c.entity && !entity) return refusal(unknownEntity(c.entity, `choices.${n}.entity`)!);
      const choiceLabel = c.label ?? entity?.label;
      if (!choiceLabel) return refusal(`choices.${n}.label: a choice that is not an entity needs a label`);
      choices.push({ id: c.id, label: choiceLabel, detail: c.detail, entity, checked: c.checked || undefined });
    }
    return {
      ok: true,
      block: { kind: 'question', id: i.id, prompt: i.prompt, multiple: i.multiple, choices, other: i.other },
    };
  },
  checklist: (i) => {
    const dup = duplicateId(i.steps.map((s) => s.id));
    if (dup) return refusal(`steps: two steps have the id "${dup}"`);
    const steps = i.steps.map((s) => ({
      id: s.id,
      text: s.text,
      command: s.command ? command(s.command) : undefined,
      guide: s.guide,
    }));
    return { ok: true, block: { kind: 'checklist', id: i.id, title: i.title, steps } };
  },
  show_guide: (i) => ({ ok: true, block: { kind: 'guide', id: i.id, guide: { title: i.title, stops: i.stops } } }),
  navigate: (i) => ({ ok: true, block: { kind: 'navigate', id: i.id, route: i.route, label: i.label } }),
};

/**
 * Check one block tool's arguments and build its block. A guide is checked
 * only for its shape here: `blockGuides` lists the plans the server checks
 * against the registry, and a patch's validation is the server's to fill.
 */
export function checkAssistantBlock(
  tool: AssistantBlockTool,
  args: unknown,
  env: AssistantBlockEnv,
): AssistantBlockCheck {
  const parsed = ASSISTANT_BLOCK_INPUTS[tool].safeParse(args);
  if (!parsed.success) {
    return refusal(parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '));
  }
  if (env.usedIds.has(parsed.data.id)) {
    return refusal(`id: "${parsed.data.id}" is already the id of a block of this answer`);
  }
  const unknownEntity: Refuse = (entity, where) =>
    env.entity(entity.type, entity.id)
      ? null
      : `${where}: no tool result of this conversation named ${entity.type} ${entity.id}; read it with a tool first, or leave it out`;
  const build = BUILDERS[tool] as (
    input: unknown,
    env: AssistantBlockEnv,
    unknownEntity: Refuse,
  ) => AssistantBlockCheck;
  return build(parsed.data, env, unknownEntity);
}

/**
 * The guides a block carries, each with its place in the block tool's
 * arguments (empty for `show_guide`, whose arguments are the plan), for the
 * registry checks.
 */
export function blockGuides(block: AssistantBlock): Array<{ where: string; guide: AssistantGuidePlan }> {
  if (block.kind === 'guide') return [{ where: '', guide: block.guide }];
  if (block.kind === 'options') {
    return block.options.flatMap((o, n) => (o.guide ? [{ where: `options.${n}.guide`, guide: o.guide }] : []));
  }
  if (block.kind === 'checklist') {
    return block.steps.flatMap((s, n) => (s.guide ? [{ where: `steps.${n}.guide`, guide: s.guide }] : []));
  }
  return [];
}
