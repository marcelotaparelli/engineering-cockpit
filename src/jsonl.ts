import { SafeError } from "./model.ts";

export type JsonObject = Record<string, unknown>;

function concat(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

export class JsonlObjectParser {
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(
    readonly maxFrameBytes = 256 * 1024,
    readonly maxBufferBytes = 512 * 1024,
  ) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 2 ||
      !Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < maxFrameBytes) {
      throw new SafeError("invalid_jsonl_limits");
    }
  }

  push(chunk: Uint8Array): JsonObject[] {
    if (!(chunk instanceof Uint8Array)) throw new SafeError("jsonl_invalid_chunk");
    this.#buffer = concat(this.#buffer, chunk);
    if (this.#buffer.byteLength > this.maxBufferBytes) throw new SafeError("jsonl_buffer_limit");
    const objects: JsonObject[] = [];
    while (true) {
      const newline = this.#buffer.indexOf(10);
      if (newline < 0) {
        if (this.#buffer.byteLength > this.maxFrameBytes) throw new SafeError("jsonl_frame_limit");
        return objects;
      }
      if (newline > this.maxFrameBytes) throw new SafeError("jsonl_frame_limit");
      let frame = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (frame.at(-1) === 13) frame = frame.slice(0, -1);
      if (frame.byteLength === 0) throw new SafeError("jsonl_malformed");
      let text: string;
      try { text = this.#decoder.decode(frame); }
      catch { throw new SafeError("jsonl_invalid_utf8"); }
      let value: unknown;
      try { value = JSON.parse(text); }
      catch { throw new SafeError("jsonl_malformed"); }
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SafeError("jsonl_object_required");
      objects.push(value as JsonObject);
    }
  }

  finish(): JsonObject[] {
    if (this.#buffer.byteLength !== 0) throw new SafeError("jsonl_partial_frame");
    return [];
  }
}

export function encodeJsonl(value: JsonObject): Uint8Array {
  let encoded: string;
  try { encoded = `${JSON.stringify(value)}\n`; }
  catch { throw new SafeError("jsonl_encode_failed"); }
  return new TextEncoder().encode(encoded);
}
