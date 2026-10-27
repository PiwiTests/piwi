/**
 * The rules and JSON schema for extracting a test-function catalog entry from
 * pasted page-object-method/helper source code — one source of truth for
 * three consumers that must never drift apart:
 *  - `server/utils/ai-function-extract.ts`, which calls the instance's
 *    configured AI provider directly.
 *  - The dashboard's "Copy prompt for your own AI" flow (`buildExtractionPrompt`),
 *    for instances with no AI configured — paste the prompt into any external
 *    AI chat, paste the JSON reply back, no Piwi AI credits spent.
 *  - The MCP `create_test_function` tool description, so an MCP-connected
 *    coding agent extracting a function from code it's already reading
 *    follows the exact same rules.
 *
 * Framework-free so it can be imported from the browser (the dashboard page)
 * as well as the server and the MCP tool catalog.
 */
import type { z } from 'zod';
import { aiExtractedFunctionSchema } from './test-function-schemas';

/** A page-object method/helper is small; reject pasting a whole file — keeps cost/latency bounded and the model focused. */
export const MAX_EXTRACT_CODE_CHARS = 20_000;

/** The extraction rules alone, as a Markdown list: the part an agent filling `create_test_function` follows. */
export const EXTRACT_RULES = `- "kind" is "page-object-method" when the code is a class method acting on "this.page" (or a "page" property) — set "receiver" to a sensible instance variable name (camelCase of the class name) and "importName" to the class name. "kind" is "helper" for a standalone exported function taking a Playwright "page" as its first parameter — "receiver" and "importName" must be null in that case. Use "fixture" only if the function is clearly Playwright fixture setup, not a page action.
- "params" lists the function's own parameters, excluding the leading Playwright handle — that first parameter is often named "page", but may be named anything and typed "Page", "Locator", or a union like "Page | Locator"; if the first parameter is a Playwright handle of any kind, skip it. Infer "type" from the TypeScript annotation, or absent one, from how the value is used.
- A parameter whose type is an object/interface (an options bag like "{ label?: string; testId?: string }", very common in helpers) MUST be typed "object", never "string". Set its "fields" to the object's own property names — from the interface declaration if you can see it, otherwise from the properties the function body actually reads off it. If the parameter is declared as an object OR an array of that object, still type it "object" and list the single object's fields. Never flatten an object parameter into a scalar.
- "steps" is the ordered sequence of page interactions the function performs, one entry per Playwright locator-then-action call (".click()", ".fill(value)", ".check()", ".uncheck()", ".selectOption(value)", ".press(key)"; a "page.goto(...)" call becomes a "goto" step). For each step's "target": "getByTestId('x')" sets "testId" only; "getByRole('role', { name: 'X' })" sets both "role" and "name"; a bare "getByRole('role')" sets only "role"; "getByText"/"getByLabel"/"getByPlaceholder" set "name" to that text and leave "role" null. Skip a step whose locator can't be classified this way rather than guessing.
- "paramSources" maps a step's argument back to a function parameter when that argument IS the parameter (e.g. ".fill(username)" where "username" is a parameter) — "from" is "value" for fill/selectOption/press arguments, "testId" when the parameter is interpolated into a getByTestId call, "text" when interpolated into a name/text match. Omit an entry when a step's value is a literal, not a parameter. When the value comes from a FIELD of an object parameter (e.g. ".getByRole('option', { name: opt.value })"), set "param" to the parameter and "path" to that field name ("value") — one entry per field, and each field you reference this way must also appear in that parameter's "fields".
- "steps" must see through wrappers that aren't themselves page interactions: "test.step(...)" / "await test.step(...)" callbacks are transparent — extract the Playwright calls inside them as if the wrapper weren't there. The same goes for try/finally and "await Promise.all([...])".
- Branching and loops: when the body picks between alternative locators for the SAME logical interaction (an if/else chain over which option field was passed, a ".or(...)" locator), emit ONE step for that interaction using the most representative branch, and lower "confidence". Do not emit one step per branch — the pattern is matched against a real recording, which only ever took one path. For a loop that repeats an interaction an unknown number of times, emit the body once.
- A call to another helper in the same project that you cannot see the source of (e.g. "focusVSelect(...)", "getVSelectLocator(...)") is a real interaction you cannot classify. Do not silently drop it and do not guess its target: leave it out of "steps", lower "confidence", and name it in "notes".
- "confidence": your own 0-1 confidence that "steps" faithfully represents what the code does — lower it for loops, conditionals, or calls to other helper functions you can't see the inside of.
- "notes": one short sentence, only when something material could not be represented — unseen helper calls, branches you collapsed, or locators you had to skip. Null when the extraction is clean. This is shown to the user next to the confidence, so be specific about what is missing rather than generic.
- Never invent a step that isn't evidenced by an actual Playwright call in the code. A pattern of one or two well-grounded steps plus an honest "notes" is far more useful than a longer guessed one.`;

export const EXTRACT_SYSTEM_PROMPT = `You analyze a single Playwright page-object method or helper function's TypeScript/JavaScript source code and extract a structured, reusable pattern describing what it does. You never execute the code — this is text analysis only. Reply strictly as JSON matching the given schema, nothing else.

Rules:
${EXTRACT_RULES}`;

export const EXTRACT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    kind: { type: 'string', enum: ['page-object-method', 'helper', 'fixture'] },
    receiver: { type: ['string', 'null'] },
    importName: { type: ['string', 'null'] },
    params: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['string', 'number', 'boolean', 'object'] },
          fields: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'type'],
        additionalProperties: false,
      },
    },
    returnsPage: { type: 'boolean' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['goto', 'click', 'fill', 'check', 'uncheck', 'selectOption', 'press', 'assertVisible'],
          },
          target: {
            type: 'object',
            properties: {
              role: { type: ['string', 'null'] },
              name: { type: ['string', 'null'] },
              testId: { type: ['string', 'null'] },
            },
            additionalProperties: false,
          },
        },
        required: ['action', 'target'],
        additionalProperties: false,
      },
    },
    paramSources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          param: { type: 'string' },
          path: { type: ['string', 'null'] },
          stepIndex: { type: 'integer' },
          from: { type: 'string', enum: ['text', 'value', 'testId'] },
        },
        required: ['param', 'stepIndex', 'from'],
        additionalProperties: false,
      },
    },
    confidence: { type: 'number' },
    notes: { type: ['string', 'null'] },
  },
  required: ['name', 'kind', 'params', 'steps'],
  additionalProperties: false,
} as const;

/**
 * The full paste-able prompt for an external AI chat (ChatGPT, Claude.ai, an
 * IDE assistant, …) that has no separate "system message" slot to fill in —
 * rules, schema, and code all in one block the user copies in one click.
 */
export function buildExtractionPrompt(code: string): string {
  const trimmed = code.trim();
  return `${EXTRACT_SYSTEM_PROMPT}

Respond with ONLY a JSON object — no markdown code fences, no commentary — matching exactly this JSON schema:

${JSON.stringify(EXTRACT_JSON_SCHEMA, null, 2)}

Here is the function to analyze:

\`\`\`
${trimmed}
\`\`\``;
}

/** Same defensive 3-tier fallback as `parseDiagnosisJson` (`shared/ai-diagnosis.ts`): most providers/models return bare JSON, some wrap it in a fenced code block regardless of instructions. */
export function parseExtractedJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fenceStripped = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    try {
      return JSON.parse(fenceStripped);
    } catch {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start === -1 || end === -1 || end <= start) throw new Error('Could not extract JSON from the AI response');
      return JSON.parse(text.slice(start, end + 1));
    }
  }
}

export type ExtractedTestFunction = z.infer<typeof aiExtractedFunctionSchema> & {
  receiver: string | null;
  importName: string | null;
  returnsPage: boolean;
  paramSources: NonNullable<z.infer<typeof aiExtractedFunctionSchema>['paramSources']>;
  confidence: number;
  notes: string | null;
};

/** Below this, the review form warns rather than presenting the proposal as ready — see `notes` for what the model couldn't represent. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Parses and schema-validates a candidate extraction response — shared by
 * three callers that must apply the exact same standard to it: the real
 * AI-calling endpoint (`server/utils/ai-function-extract.ts`), the
 * no-AI-credits "paste the response back" endpoint
 * (`test-functions/validate-proposal.post.ts`, also mirrored client-side in
 * demo mode since this involves no AI call to fake), and the MCP
 * `create_test_function` tool.
 */
export function validateExtractedFunction(responseText: string): ExtractedTestFunction {
  let parsed: unknown;
  try {
    parsed = parseExtractedJsonLoose(responseText);
  } catch {
    throw new Error("The AI response wasn't valid JSON — try again, or fill in the pattern by hand.");
  }

  const validation = aiExtractedFunctionSchema.safeParse(parsed);
  if (!validation.success) {
    throw new Error(
      "The AI couldn't produce a valid pattern from that code — try a smaller function, or fill in the pattern by hand.",
    );
  }

  return {
    ...validation.data,
    receiver: validation.data.receiver ?? null,
    importName: validation.data.importName ?? null,
    returnsPage: validation.data.returnsPage ?? false,
    paramSources: validation.data.paramSources ?? [],
    confidence: validation.data.confidence ?? 0.7,
    notes: validation.data.notes ?? null,
  };
}
