import type { CatalogSkill } from '@emdash/core/primitives/skills/api';
import React, { useState } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';
import { useLogoTone } from './logo-tone';
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
 * colour, a catalog logo in the theme's text colour (or as published when it is an opaque
 * picture), a Skills.sh image as published, or the first letter.
 */
export const SkillIconRenderer: React.FC<SkillIconRendererProps> = ({ skill }) => {
  const [imgError, setImgError] = useState(false);
  // Catalog logos on a transparent ground are flattened to the theme's text colour; opaque ones
  // (a square app icon) are drawn as published, or the flattening would leave a solid square.
  const flattenable = skill.source !== 'skillssh';
  const tone = useLogoTone(flattenable ? skill.iconUrl : undefined);

  const letter = skill.displayName.charAt(0).toUpperCase();

  const renderImageIcon = () => {
    if (!skill.iconUrl || imgError) return null;
    return (
      <img
        src={skill.iconUrl}
        alt=""
        data-tone={flattenable ? (tone ?? 'measuring') : undefined}
        className={cn(
          'h-full w-full rounded-xs object-contain',
          tone === 'glyph' && 'brightness-0 emdark:invert',
          // Hidden for the moment it takes to measure, so a tile never flashes as a square.
          tone === null && 'opacity-0'
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
