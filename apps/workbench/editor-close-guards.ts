const guards = new Set<() => boolean>();
export function registerEditorCloseGuard(guard: () => boolean) {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}
export function canCloseEditors(except?: () => boolean) {
  return [...guards].every((guard) => guard === except || guard());
}
