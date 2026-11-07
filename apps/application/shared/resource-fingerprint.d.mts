/**
 * Type declarations for the resource finding identity. See `resource-fingerprint.mjs`.
 */
import type { WireResourceFinding } from '@piwitests/core/wire';

export declare const RESOURCE_IDENTITY_VERSION: number;
export declare function sourceFiles(text: string | null | undefined): string[];
export declare function resourceFingerprint(finding: WireResourceFinding): string;
export declare function resourceGroup(fingerprint: string): string;
export declare function openingLine(text: string | null | undefined): number | null;
export declare function isLeak(finding: Pick<WireResourceFinding, 'verdict'>): boolean;
