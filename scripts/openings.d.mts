// Types for scripts/openings.mjs, for the tests that import it.
export interface OpeningLine {
  eco: string;
  name: string;
  /** The EPD after each ply of the line. */
  epds: string[];
}
export interface OpeningRecord {
  key: number;
  family: number;
  variation: number;
  eco: number;
  ply: number;
  name: string;
}
export const OUT: string;
export const FILES: string[];
export const PIN: string;
export const RECORD_BYTES: number;
export function fnv1a(text: string): number;
export function epd(fen: string): string;
export function shortName(name: string): [string, string];
export function readLines(): OpeningLine[];
export function build(lines?: OpeningLine[]): { families: string[]; variations: string[]; records: OpeningRecord[]; table: string; maxPly: number };
export function generate(): string;
