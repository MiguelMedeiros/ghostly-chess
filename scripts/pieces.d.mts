// Types for scripts/pieces.mjs, for the tests that import it.
import type { PieceTree } from "../src/generated/pieces.ts";

export const SETS: Record<string, string>;
export const OUT: string;
export const TAGS: string[];
export const ATTRIBUTES: string[];
export function pieceTree(text: string, file?: string): PieceTree;
export function generate(): string;
