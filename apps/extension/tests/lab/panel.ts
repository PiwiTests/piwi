import type { Page } from '@playwright/test';

/** The extension's panels, which draw in closed shadow roots, reached through the protocol as a person's click reaches them. */

export type DomNode = { backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

/** The node carrying `attribute` (with `value`, when given) anywhere in the page, closed shadow roots included. */
export function findNode(root: DomNode, attribute: string, value?: string): number | null {
  const attrs = root.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] === attribute && (value === undefined || attrs[i + 1] === value)) return root.backendNodeId;
  }
  for (const child of [...(root.children ?? []), ...(root.shadowRoots ?? [])]) {
    const found = findNode(child, attribute, value);
    if (found) return found;
  }
  return null;
}

/** Clicks the extension's control `key` (`data-piwi-control`) on the page, inside its panel's closed shadow root. */
export async function pressPanelControl(page: Page, key: string): Promise<boolean> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
    const backendNodeId = findNode(root, 'data-piwi-control', key);
    if (!backendNodeId) return false;
    const { object } = (await cdp.send('DOM.resolveNode', { backendNodeId })) as { object: { objectId: string } };
    await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { this.click(); }',
    });
    return true;
  } catch {
    return false;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}
