import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'vue/compiler-sfc';

type TemplateChildNode = NonNullable<
  NonNullable<ReturnType<typeof parse>['descriptor']['template']>['ast']
>['children'][number];
type ElementNode = Extract<TemplateChildNode, { tag: string }>;

/**
 * A `UFormField` (and `SettingsField`, which renders one) gives its one input id to every control inside it, the
 * controls of the components it holds and of the modals they open included, so each control's label clicks the
 * first. A field holds one control; several go in a `FormFieldGroup`. A control inside a nested `UFormField` takes
 * that field's id instead. Components resolve by file name, as `pathPrefix: false` registers them.
 */

const APP_DIR = fileURLToPath(new URL('../../app/', import.meta.url));

const FIELDS = new Set(['UFormField', 'SettingsField']);
const CONTROLS = new Set([
  'UCheckbox',
  'UCheckboxGroup',
  'UInput',
  'UInputMenu',
  'UInputNumber',
  'UInputTags',
  'UPinInput',
  'URadioGroup',
  'USelect',
  'USelectMenu',
  'USlider',
  'USwitch',
  'UTextarea',
]);

const ELEMENT = 1;
const DIRECTIVE = 7;

function templateOf(source: string): TemplateChildNode[] {
  return parse(source).descriptor.template?.ast?.children ?? [];
}

function pascal(tag: string): string {
  return tag.replace(/(^|-)([a-z])/g, (_, __, c: string) => c.toUpperCase());
}

function hasDirective(node: ElementNode, name: string): boolean {
  return node.props.some((p) => p.type === DIRECTIVE && p.name === name);
}

/** Counts the controls a field around these nodes would hand its id to; `component` resolves a component's own. */
function counter(component: (name: string) => number) {
  function nodes(list: TemplateChildNode[]): number {
    let total = 0;
    // A `v-if` chain renders one branch: it counts as its largest.
    let branch = -1;
    for (const node of list) {
      if (node.type !== ELEMENT) continue;
      const n = element(node);
      if (hasDirective(node, 'else') || hasDirective(node, 'else-if')) {
        branch = Math.max(branch, n);
        continue;
      }
      if (branch >= 0) total += branch;
      branch = -1;
      if (hasDirective(node, 'if')) branch = n;
      else total += n;
    }
    return total + Math.max(branch, 0);
  }
  function element(node: ElementNode): number {
    const tag = pascal(node.tag);
    if (FIELDS.has(tag)) return 0;
    const n = (CONTROLS.has(tag) ? 1 : 0) + nodes(node.children) + component(tag);
    return hasDirective(node, 'for') ? n * 2 : n;
  }
  return { nodes, element };
}

/** Every `.vue` file under app/, by its path. */
const files = readdirSync(APP_DIR, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.vue'));
const components = new Map(
  files
    .filter((f) => f.startsWith('components/'))
    .map((f) => [basename(f, '.vue'), templateOf(readFileSync(join(APP_DIR, f), 'utf8'))]),
);

const known = new Map<string, number>();
const visiting = new Set<string>();
function componentControls(name: string): number {
  const template = components.get(name);
  if (!template || visiting.has(name)) return 0;
  if (!known.has(name)) {
    visiting.add(name);
    known.set(name, appCounter.nodes(template));
    visiting.delete(name);
  }
  return known.get(name)!;
}
const appCounter = counter(componentControls);

/** The fields of a template, each with its line and how many controls it holds. */
function fields(list: TemplateChildNode[], found: { line: number; tag: string; controls: number }[] = []) {
  for (const node of list) {
    if (node.type !== ELEMENT) continue;
    if (FIELDS.has(pascal(node.tag))) {
      found.push({ line: node.loc.start.line, tag: node.tag, controls: appCounter.nodes(node.children) });
    }
    fields(node.children, found);
  }
  return found;
}

describe('a form field holds one control', () => {
  test('no UFormField or SettingsField under app/ holds several controls', () => {
    let seen = 0;
    const offenders = files.flatMap((file) => {
      const found = fields(templateOf(readFileSync(join(APP_DIR, file), 'utf8')));
      seen += found.length;
      return found.filter((f) => f.controls > 1).map((f) => `app/${file}:${f.line} ${f.tag} (${f.controls} controls)`);
    });
    expect(seen).toBeGreaterThan(100);
    expect(offenders, 'put the controls in a FormFieldGroup, or each in its own UFormField').toEqual([]);
  });

  test('the count follows branches, loops, nested fields and components', () => {
    const local = counter((name) => (name === 'TwoSwitches' ? 2 : 0));
    const count = (template: string) => local.nodes(templateOf(`<template>${template}</template>`));
    expect(count('<UInput /><USwitch />')).toBe(2);
    expect(count('<UInput v-if="a" /><USelect v-else-if="b" /><div v-else><UInput /><UInput /></div>')).toBe(2);
    expect(count('<UInput v-if="a" /><USelect v-else />')).toBe(1);
    expect(count('<div v-for="row in rows"><u-input /></div>')).toBe(2);
    expect(count('<UFormField><UInput /><UInput /></UFormField><UInput />')).toBe(1);
    expect(count('<TwoSwitches /><UButton />')).toBe(2);
  });
});
