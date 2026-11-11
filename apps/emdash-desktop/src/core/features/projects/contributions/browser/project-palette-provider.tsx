import { Command } from 'cmdk';
import { FolderOpen } from 'lucide-react';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import {
  matchPaletteText,
  type PaletteContext,
  type PaletteProviderDef,
  type PaletteProviderMatch,
  type PaletteProviderQuery,
  type PaletteProviderRenderProps,
} from '@core/primitives/palette/api';
import { PALETTE_ITEM_CLASS } from '@core/primitives/palette/browser/palette-item-styles';
import type { SearchItem } from '@core/primitives/search/api';
import {
  getIdleProjectPaletteEntities,
  searchProjectPaletteEntities,
} from './project-palette-source';

interface ProjectPaletteProviderDependencies {
  readonly search?: (input: PaletteProviderQuery) => Promise<readonly SearchItem[]>;
  readonly idle?: (context: PaletteContext) => readonly SearchItem[];
}

function ProjectPaletteRow({
  match,
  value,
  onSelect,
}: PaletteProviderRenderProps<PaletteProviderMatch>) {
  const { navigate } = useNavigate();
  const handleSelect = () => {
    onSelect();
    navigate(projectViewDef({ projectId: match.id }));
  };

  return (
    <Command.Item value={value} onSelect={handleSelect} className={PALETTE_ITEM_CLASS}>
      <FolderOpen size={16} className="shrink-0 text-foreground-passive" aria-hidden />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="max-w-[70%] min-w-0 shrink-0 truncate">{match.title}</span>
        {match.subtitle && (
          <span className="min-w-0 truncate text-tiny text-foreground-passive">
            {match.subtitle}
          </span>
        )}
      </span>
    </Command.Item>
  );
}

export function createProjectPaletteProvider({
  search = searchProjectPaletteEntities,
  idle = getIdleProjectPaletteEntities,
}: ProjectPaletteProviderDependencies = {}): PaletteProviderDef<'projects'> {
  return {
    kind: 'projects',
    keyword: '@projects',
    minQueryLength: 1,
    idle: (context) =>
      idle(context).map((item) => ({
        id: item.id,
        title: item.title,
        section: 'Projects',
        relevance: { band: 'fuzzy', score: 0 },
      })),
    search: async ({ query, context }) =>
      (await search({ query, context })).flatMap((item) => {
        if (item.kind !== 'project') return [];
        const relevance = matchPaletteText(query, {
          primary: [item.title],
          secondary: [item.subtitle],
        });
        if (!relevance) return [];
        return [
          {
            id: item.id,
            title: item.title,
            subtitle: item.subtitle || undefined,
            relevance: {
              ...relevance,
              contextAffinity: item.id === context.projectId ? 1 : 0,
            },
          },
        ];
      }),
    render: ProjectPaletteRow,
  };
}

export const projectPaletteProviderDefs = [createProjectPaletteProvider()] as const;
