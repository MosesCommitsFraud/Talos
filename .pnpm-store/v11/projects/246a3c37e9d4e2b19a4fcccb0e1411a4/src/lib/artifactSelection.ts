import type { ArtifactSelection } from '@/api/types';

export function artifactSelectionLocator(selection: ArtifactSelection): string {
  const targets = selection.targets?.length ? selection.targets : [selection.target];
  const pages = targets.flatMap((target) => [target.page, target.pageEnd]).filter((value): value is number => typeof value === 'number');
  if (pages.length) {
    const first = Math.min(...pages);
    const last = Math.max(...pages);
    return `P${first}${last === first ? '' : `-P${last}`}`;
  }
  const slides = targets.map((target) => target.slide).filter((value): value is number => typeof value === 'number');
  if (slides.length) {
    const first = Math.min(...slides);
    const last = Math.max(...slides);
    return `S${first}${last === first ? '' : `-S${last}`}`;
  }
  const cells = targets.map((target) => target.cell).filter((value): value is string => !!value);
  if (cells.length) {
    const first = cells[0].split(':')[0];
    const last = cells[cells.length - 1].split(':').at(-1) ?? first;
    return first === last ? first : `${first}:${last}`;
  }
  return targets.length > 1 ? String(targets.length) : '';
}
