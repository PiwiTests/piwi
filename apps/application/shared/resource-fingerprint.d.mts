/**
 * Type declarations for the resource finding identity. See `resource-fingerprint.mjs`.
 */
import type { WireResourceFinding } from '@piwitests/core/wire';

export declare const RESOURCE_IDENTITY_VERSION: number;
export declare function resourceFingerprint(finding: WireResourceFinding): string;
export declare function resourceGroup(fingerprint: string, where: string): string;
export declare function identityFile(fingerprint: string): string | null;
export declare function openingLine(text: string | null | undefined): number | null;
export declare function isLeak(finding: Pick<WireResourceFinding, 'verdict'>): boolean;
