import { BadRequestError } from "./errors.ts";

export interface Chunk {
  /** Position of this chunk in the document, starting at zero. */
  index: number;
  /** The chunk text, taken verbatim from the source. */
  text: string;
  /** Offset of the first character in the source document. */
  start: number;
  /** Offset one past the last character in the source document. */
  end: number;
}

export interface ChunkOptions {
  /** Upper bound on chunk length, before overlap is added. */
  maxChars?: number;
  /** How much of the preceding text each chunk repeats. */
  overlapChars?: number;
}

const DEFAULT_MAX_CHARS = 900;
const DEFAULT_OVERLAP_CHARS = 150;

interface Segment {
  start: number;
  end: number;
}

const PARAGRAPH_BREAK = /\n[ \t]*\n\s*/g;
const SENTENCE_BREAK = /(?<=[.!?…])["')\]]*\s+/g;
const WORD_BREAK = /\s+/g;

/** Splits `text` on `pattern`, dropping blank pieces and keeping source offsets. */
function splitWithOffsets(text: string, segment: Segment, pattern: RegExp): Segment[] {
  const slice = text.slice(segment.start, segment.end);
  const out: Segment[] = [];
  let cursor = 0;
  pattern.lastIndex = 0;
  for (let m = pattern.exec(slice); m !== null; m = pattern.exec(slice)) {
    push(cursor, m.index);
    cursor = m.index + m[0].length;
    if (pattern.lastIndex === m.index) pattern.lastIndex += 1;
  }
  push(cursor, slice.length);
  return out;

  function push(from: number, to: number): void {
    if (slice.slice(from, to).trim() === "") return;
    out.push({ start: segment.start + from, end: segment.start + to });
  }
}

/** Breaks a segment down until every piece fits in `maxChars`, or cannot be split further. */
function segmentize(text: string, maxChars: number): Segment[] {
  const whole: Segment = { start: 0, end: text.length };
  let segments = splitWithOffsets(text, whole, PARAGRAPH_BREAK);
  for (const pattern of [SENTENCE_BREAK, WORD_BREAK]) {
    const next: Segment[] = [];
    let anyOversized = false;
    for (const segment of segments) {
      if (segment.end - segment.start <= maxChars) {
        next.push(segment);
        continue;
      }
      anyOversized = true;
      const parts = splitWithOffsets(text, segment, pattern);
      next.push(...(parts.length > 1 ? parts : [segment]));
    }
    segments = next;
    if (!anyOversized) break;
  }
  return segments;
}

/** Moves `offset` forward past whitespace, so a chunk never opens mid-word. */
function snapForward(text: string, offset: number, limit: number): number {
  let i = offset;
  while (i < limit && !/\s/.test(text[i] as string)) i += 1;
  while (i < limit && /\s/.test(text[i] as string)) i += 1;
  return i;
}

/**
 * Splits a document into overlapping chunks that respect paragraph, sentence
 * and word boundaries, in that order of preference.
 *
 * Offsets point back into the document that was passed in, so a hit can be
 * shown in its original context.
 */
export function chunk(text: string, options: ChunkOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new BadRequestError(`maxChars must be a positive integer, got ${String(maxChars)}`);
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0) {
    throw new BadRequestError(`overlapChars must be zero or more, got ${String(overlapChars)}`);
  }
  if (overlapChars >= maxChars) {
    throw new BadRequestError(`overlapChars (${overlapChars}) must be smaller than maxChars (${maxChars})`);
  }

  const segments = segmentize(text, maxChars);
  const groups: Segment[] = [];
  for (const segment of segments) {
    const open = groups[groups.length - 1];
    if (open !== undefined && segment.end - open.start <= maxChars) {
      open.end = segment.end;
    } else {
      groups.push({ ...segment });
    }
  }

  return groups.map((group, index) => {
    const wanted = Math.max(0, group.start - overlapChars);
    const start = index === 0 || wanted === group.start ? group.start : snapForward(text, wanted, group.start);
    return { index, text: text.slice(start, group.end), start, end: group.end };
  });
}
