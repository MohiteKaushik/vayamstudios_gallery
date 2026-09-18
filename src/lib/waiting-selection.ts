import type { WaitingRow } from "./api";

export function waitingSelection(row: Pick<WaitingRow, "userId" | "fullName" | "email">) {
  return {
    userId: row.userId,
    fullName: row.fullName || row.email || "Unnamed member",
    referenceUrl: `/media/face/${encodeURIComponent(row.userId)}`,
  };
}
