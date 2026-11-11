import { EmptyState } from '@emdash/ui/react/components';
import { SettingsSection } from '@emdash/ui/react/patterns';
import React, { useCallback } from 'react';
import { SkillCard } from '@core/features/skills/browser/components/SkillCard';
import type { UseSkillsResult } from '@core/features/skills/browser/components/useSkills';
import { useOpenModal } from '@core/manifests/browser/modal-api';

type SkillsListProps = {
  skills: UseSkillsResult;
  onOpenTerminal?: (skillPath: string) => void;
};

export const SkillsList: React.FC<SkillsListProps> = ({ skills, onOpenTerminal }) => {
  const openConfirm = useOpenModal('confirmActionModal');
  const openSkillDetail = useOpenModal('skillDetailModal');

  const handleUninstallRequest = useCallback(
    async (skillId: string): Promise<boolean> => {
      const displayName =
        skills.catalog?.skills.find((skill) => skill.id === skillId)?.displayName ?? skillId;
      const outcome = await openConfirm({
        title: 'Uninstall skill?',
        description: `This will uninstall "${displayName}" from all agents. This action cannot be undone.`,
        confirmLabel: 'Uninstall',
      });
      if (!outcome.success) return false;
      return skills.uninstall(skillId);
    },
    [openConfirm, skills]
  );

  const handleOpenDetail = useCallback(
    (skill: UseSkillsResult['filteredSkills'][number]) => {
      void openSkillDetail({
        skill,
        onInstall: skills.install,
        onUninstall: handleUninstallRequest,
        onOpenTerminal,
      });
    },
    [handleUninstallRequest, onOpenTerminal, openSkillDetail, skills.install]
  );

  if (skills.isLoading) {
    return <EmptyState tone="loading" label="Loading skills…" className="min-h-64" />;
  }

  return (
    <div className="flex flex-col text-foreground">
      <div className="flex flex-col gap-10 pb-16">
        {skills.installedSkills.length > 0 && (
          <SettingsSection
            title="Installed"
            description="Available to every coding agent on this machine."
            gap="0.25rem"
          >
            {skills.installedSkills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                isInstalled={true}
                onInstall={skills.install}
                onUninstall={handleUninstallRequest}
                onClick={() => handleOpenDetail(skill)}
              />
            ))}
          </SettingsSection>
        )}
        {skills.recommendedSkills.length > 0 && (
          <SettingsSection
            title="Recommended"
            description="From the OpenAI and Anthropic skill libraries."
            gap="0.25rem"
          >
            {skills.recommendedSkills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                isInstalled={false}
                onInstall={skills.install}
                onUninstall={handleUninstallRequest}
                onClick={() => handleOpenDetail(skill)}
              />
            ))}
          </SettingsSection>
        )}
        {(skills.isSearchingSkillSh || skills.skillShSearchSkills.length > 0) && (
          <SettingsSection
            title="Skills.sh"
            description="Results from the Skills.sh directory."
            gap="0.25rem"
          >
            {skills.skillShSearchSkills.length === 0 && (
              <p role="status" className="py-2 text-xs text-foreground-muted">
                Searching Skills.sh…
              </p>
            )}
            {skills.skillShSearchSkills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                isInstalled={false}
                onInstall={skills.install}
                onUninstall={handleUninstallRequest}
                onClick={() => handleOpenDetail(skill)}
              />
            ))}
          </SettingsSection>
        )}
        {skills.installedSkills.length === 0 &&
          skills.recommendedSkills.length === 0 &&
          skills.skillShSearchSkills.length === 0 &&
          !skills.isSearchingSkillSh && (
            <EmptyState
              className="min-h-48"
              label={skills.searchQuery ? 'No skills match' : 'No skills yet'}
              description={
                skills.searchQuery
                  ? 'Try another word, or write the skill yourself.'
                  : 'Write a skill to teach your agents how you work.'
              }
            />
          )}
      </div>
    </div>
  );
};
