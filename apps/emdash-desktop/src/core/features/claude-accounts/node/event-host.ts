import { createEventStreamHost } from '@emdash/wire/live';
import { claudeAccountsContract } from '../api';

export const claudeAccountsEvents = createEventStreamHost(claudeAccountsContract.events);
