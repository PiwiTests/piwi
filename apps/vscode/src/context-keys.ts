import * as vscode from 'vscode';

const held = new Map<string, unknown>();

/** Sets a context key of the menus, and keeps its value for the status menu: VS Code gives no way to read one back. */
export function setContextKey(key: string, value: unknown): void {
  held.set(key, value);
  void vscode.commands.executeCommand('setContext', key, value);
}

/** A context key's value as this extension last set it. */
export function contextKey(key: string): unknown {
  return held.get(key);
}
