export function getNextSourcePath(
  selectedPaths: readonly string[],
  currentPath: string | null,
  availablePaths: ReadonlySet<string>,
): string | null {
  return (
    selectedPaths.find(
      (path) => path !== currentPath && availablePaths.has(path),
    ) ?? null
  );
}
