export type FaultPoint =
  | "work.accepted"
  | "operation.prepared"
  | "invocation.record"
  | "checkpoint.final";

export interface FaultContext {
  readonly objective: string;
  readonly workId: string;
}

export async function fault(_point: FaultPoint, _context: FaultContext): Promise<void> {}
