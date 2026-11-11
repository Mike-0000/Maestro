import type { CatalogSkill } from '@emdash/core/primitives/skills/api';
import React, { useState } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';
import { resolveSkillIcon } from './skillIcons';

/** Library marks are drawn in the current text colour, so they follow the theme. */
function processSvg(raw: string): string {
  let svg = raw.replace(/\bwidth="[^"]*"/g, '').replace(/\bheight="[^"]*"/g, '');
  svg = svg.replace('<svg ', '<svg fill="currentColor" ');
  return svg.replace('<svg ', '<svg class="h-full w-full" ');
}

interface SkillIconRendererProps {
  skill: CatalogSkill;
}

/**
 * The skill's mark on a small tile one step up from its row: a library glyph in the muted text
 * colour, a Skills.sh image as published, or the first letter.
 */
export const SkillIconRenderer: React.FC<SkillIconRendererProps> = ({ skill }) => {
  const [imgError, setImgError] = useState(false);

  const letter = skill.displayName.charAt(0).toUpperCase();

  const renderImageIcon = () => {
    if (!skill.iconUrl || imgError) return null;
    // Catalog logos are single-colour artwork: flatten them to the text colour of the theme.
    const monochrome = skill.source !== 'skillssh';
    return (
      <img
        src={skill.iconUrl}
        alt=""
        className={cn(
          'h-full w-full rounded-xs object-contain',
          monochrome && 'brightness-0 emdark:invert'
        )}
        onError={() => setImgError(true)}
        loading="lazy"
      />
    );
  };

  const renderIcon = () => {
    if (skill.source === 'skillssh') {
      const imageIcon = renderImageIcon();
      if (imageIcon) return imageIcon;
    }

    const svg = resolveSkillIcon(skill.catalogSkillId ?? skill.id, skill.source);
    if (svg) {
      return <div className="size-full" dangerouslySetInnerHTML={{ __html: processSvg(svg) }} />;
    }

    return renderImageIcon() ?? letter;
  };

  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-hover p-1.5 text-sm font-medium text-foreground-muted transition-colors group-hover:bg-surface-selected">
      {renderIcon()}
    </div>
  );
};
