import { useEffect, useState } from 'react';
import { conversationSubject } from '@core/features/conversations/contributions/subject';
import type { MementoHandle } from '@core/primitives/mementos/browser';
import { useMementoClient } from '@core/primitives/mementos/react';
import { chatViewChoiceMemento, type ChatViewChoiceState } from '../../contributions/mementos';

type Hydrated = { conversationId: string; handle: MementoHandle<ChatViewChoiceState> };

/**
 * The remembered Conductor/Raw choice of a chat, or null while it is being read (and when there
 * is no chat). Read `handle.value` inside an observer.
 *
 * A `SubjectProvider` would do the same, but it renders a fallback while it hydrates, and the
 * raw view under this choice must never unmount.
 */
export function useChatViewChoice(
  conversationId: string | undefined
): MementoHandle<ChatViewChoiceState> | null {
  const client = useMementoClient();
  const [hydrated, setHydrated] = useState<Hydrated | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    const space = client.subject(conversationSubject({ conversationId }));
    const handle = space.handle(chatViewChoiceMemento);
    let active = true;
    void space.ready
      .catch((error: unknown) => client.reportError(error))
      .then(() => {
        if (active) setHydrated({ conversationId, handle });
      });
    return () => {
      active = false;
      setHydrated(null);
      void space.release().catch((error: unknown) => client.reportError(error));
    };
  }, [client, conversationId]);

  return hydrated && hydrated.conversationId === conversationId ? hydrated.handle : null;
}
