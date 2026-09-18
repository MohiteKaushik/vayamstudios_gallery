export function filterWaitingMembers<T extends { fullName: string; email: string }>(
  rows: readonly T[],
  query: string,
): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    const text = `${row.fullName} ${row.email}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
