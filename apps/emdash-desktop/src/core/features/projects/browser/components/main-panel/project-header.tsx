import { Button, DropdownMenu, Heading } from '@emdash/ui/react/primitives';
import {
  EllipsisIcon,
  ExternalLink,
  FolderInput,
  FolderOpen,
  GithubIcon,
  Globe,
  Pencil,
  Trash2,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import {
  getProjectStore,
  projectDisplayName,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { useConfirmDeleteProject } from '@core/features/projects/contributions/browser/use-confirm-delete-project';
import { OpenInMenu } from '@core/features/settings/contributions/browser/open-in-menu';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { isGitHubDotComHost, parseRepositoryRef } from '@core/primitives/repository/api';

/**
 * The project page's header: the name in the page-title role with a quiet line under it (where
 * the repository lives and where the folder is), and two quiet actions on the right. No tile,
 * no rule: type and space carry it.
 */
export const ProjectHeader = observer(function ProjectHeader({ projectId }: { projectId: string }) {
  const store = getProjectStore(projectId);
  const project = store?.data;
  const displayName = projectDisplayName(store) ?? 'this project';
  const confirmDeleteProject = useConfirmDeleteProject();
  const openRename = useOpenModal('renameProjectModal');
  const repositoryStore = getGitRepositoryStore(projectId);
  const baseRemoteUrl = repositoryStore?.baseRemote?.url;
  const repository = parseRepositoryRef(repositoryStore?.canonicalRepositoryUrl);
  const isGithubUrl = repository ? isGitHubDotComHost(repository.host) : false;
  const repositoryUrl = isGithubUrl ? (repository?.repositoryUrl ?? baseRemoteUrl) : baseRemoteUrl;
  const repositoryLabel = repository?.nameWithOwner ?? baseRemoteUrl?.replace(/^https?:\/\//, '');

  if (!project) return null;

  const isRemote = project.type === 'ssh';
  const ProjectIcon = isRemote ? FolderInput : FolderOpen;

  return (
    <header className="flex min-w-0 items-start justify-between gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <ProjectIcon
            aria-label={isRemote ? 'Project on a machine' : 'Project on this computer'}
            role="img"
            data-project-identity={project.type}
            className="size-5 shrink-0 text-foreground-passive"
            strokeWidth={1.5}
          />
          <Heading level={1} tone="default" className="min-w-0 truncate">
            {displayName}
          </Heading>
        </div>
        <div className="flex min-w-0 items-center gap-x-4 pl-7.5 text-xs text-foreground-passive">
          {repositoryUrl && repositoryLabel ? (
            <Button
              type="button"
              variant="text"
              size="xs"
              className="group min-w-0 shrink gap-1.5"
              title={repositoryUrl}
              onClick={() => void openExternal(repositoryUrl)}
            >
              {isGithubUrl ? (
                <GithubIcon aria-hidden="true" className="size-3.5 shrink-0" />
              ) : (
                <Globe aria-hidden="true" className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{repositoryLabel}</span>
              <ExternalLink
                aria-hidden="true"
                className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              />
            </Button>
          ) : null}
          {project.path !== repositoryLabel ? (
            <span className="min-w-0 truncate font-mono" title={project.path}>
              {project.path}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <OpenInMenu
          path={project.path}
          className="h-7 bg-transparent"
          borderless
          isRemote={isRemote}
          sshConnectionId={isRemote ? project.connectionId : undefined}
        />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            render={
              <Button type="button" variant="ghost" size="sm" icon aria-label="Project actions" />
            }
          >
            <EllipsisIcon />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            <DropdownMenu.Item
              onClick={() => {
                void openRename({ projectId, currentName: displayName });
              }}
            >
              <Pencil />
              Rename Project
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              variant="destructive"
              onClick={() => {
                void confirmDeleteProject({ projectId, projectLabel: displayName });
              }}
            >
              <Trash2 />
              Remove Project
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </header>
  );
});
