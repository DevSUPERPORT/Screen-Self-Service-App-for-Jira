/**
 * Atlassian's user privacy requirements: apps that store accountIds must report them regularly to the personal
 * data reporting API and erase the data of accounts Atlassian reports as closed.
 *
 * @file        src/backend/privacy.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { privacy } from '@forge/api';
import { kvs } from '@forge/kvs';
import { eraseAccount, storedAccounts } from './storage';

const LAST_RUN = 'privacy-last-report';
const EVERY_MS = 7 * 86400000; // Atlassian asks for a cycle of at most 7 days (and no more often than needed)
const BATCH = 90; // API limit per call

type Report = (accounts: { accountId: string; updatedAt: string }[]) => Promise<{ accountId: string; status: 'updated' | 'closed' }[]>;

/** Runs from the nightly trigger; does the actual report at most once a week. */
export async function reportPersonalData(report: Report = (a) => privacy.reportPersonalData(a), now = Date.now()) {
  const last = (await kvs.get(LAST_RUN)) as string | undefined;
  if (last && now - new Date(last).getTime() < EVERY_MS) return { reported: 0, erased: 0, skipped: true };
  const accounts = [...(await storedAccounts()).entries()].map(([accountId, updatedAt]) => ({ accountId, updatedAt }));
  let erased = 0;
  for (let i = 0; i < accounts.length; i += BATCH) {
    const updates = (await report(accounts.slice(i, i + BATCH))) ?? [];
    for (const u of updates) {
      // "updated" needs nothing: the app stores no profile data, display names are resolved when shown
      if (u.status === 'closed') { await eraseAccount(u.accountId); erased++; }
    }
  }
  await kvs.set(LAST_RUN, new Date(now).toISOString());
  return { reported: accounts.length, erased, skipped: false };
}
