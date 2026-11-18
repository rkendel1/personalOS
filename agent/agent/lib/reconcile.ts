export interface OperationRef {
  readonly binding: string;
  readonly key: string;
}

export type DestinationStatus =
  | {
      readonly kind: "committed";
      readonly operation: OperationRef;
      readonly receipt: string | null;
      readonly reported: unknown;
    }
  | { readonly kind: "not_applied"; readonly barred: boolean; readonly basis: string }
  | { readonly kind: "unknown"; readonly reason: string };

export type BusinessCheck =
  | { readonly kind: "present"; readonly evidence: string }
  | { readonly kind: "absent"; readonly evidence: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export type Finding =
  | { readonly kind: "completed"; readonly receipt: string | null; readonly reported: unknown }
  | { readonly kind: "not_executed"; readonly basis: string }
  | { readonly kind: "indeterminate"; readonly reason: string };

const sameOperation = (left: OperationRef, right: OperationRef) =>
  left.key === right.key && left.binding === right.binding;

function unavailable(check: BusinessCheck | undefined): string {
  return check?.kind === "unavailable" ? `: ${check.reason}` : "";
}

export function decide(
  operation: OperationRef,
  status: DestinationStatus,
  check: BusinessCheck | undefined,
): Finding {
  const indeterminate = (reason: string): Finding => ({ kind: "indeterminate", reason });
  if (status.kind === "unknown")
    return indeterminate(`the destination could not say: ${status.reason}`);
  if (status.kind === "committed") {
    if (!sameOperation(status.operation, operation))
      return indeterminate(
        "the destination answered about another operation than the original (key or binding differ)",
      );
    if (check?.kind === "present")
      return { kind: "completed", receipt: status.receipt, reported: status.reported };
    if (check?.kind === "absent")
      return indeterminate(
        `the destination reports the operation committed, but its business effect is absent: ${check.evidence}`,
      );
    return indeterminate(
      `the destination reports the operation committed, but its business effect could not be verified${unavailable(check)}`,
    );
  }
  if (!status.barred)
    return indeterminate(
      "the destination has no record of the operation, but does not guarantee it cannot still be applied; a missing record is not proof",
    );
  if (check?.kind === "absent") return { basis: status.basis, kind: "not_executed" };
  if (check?.kind === "present")
    return indeterminate(
      `the destination says the operation was not applied, but its business effect is present: ${check.evidence}`,
    );
  return indeterminate(
    `the destination says the operation was not applied, but the absence of its effect could not be verified${unavailable(check)}`,
  );
}
