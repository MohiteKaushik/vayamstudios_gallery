type Ask = (options: { title: string; body?: string; confirmLabel?: string }) => Promise<boolean>;

export async function confirmEventDeletion(ask: Ask, name: string): Promise<boolean> {
  if (!await ask({
    title: `Delete "${name}"?`,
    body: "This includes all photos in this event. They will move to the recycle bin and can be restored for 30 days.",
    confirmLabel: "Continue",
  })) return false;
  return ask({
    title: "Final confirmation",
    body: `Move "${name}" and all its photos to the recycle bin? They will no longer appear in the gallery. After 30 days, they are eligible for permanent deletion.`,
    confirmLabel: "Delete event and photos",
  });
}
