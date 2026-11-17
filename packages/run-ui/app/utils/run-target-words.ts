import type {
  RunRequestCheckView,
  RunRequestPromptView,
  RunTargetConnectionView,
} from '@piwitests/editor/run-target-view';
import { ENGLISH_RUN_UI_WORDS, type RunUiPlainKey, type RunUiWords } from './run-ui-words';

const CONNECTION_STATE_KEYS: Record<RunTargetConnectionView['state'], RunUiPlainKey> = {
  none: 'runui_connectionStateNone',
  'signing-in': 'runui_connectionStateSigningIn',
  connecting: 'runui_connectionStateConnecting',
  online: 'runui_connectionStateOnline',
  offline: 'runui_connectionStateOffline',
  revoked: 'runui_connectionStateRevoked',
};

/** What the connection card says of a state of the connection to a team instance. */
export function connectionStateWords(
  state: RunTargetConnectionView['state'],
  words: RunUiWords = ENGLISH_RUN_UI_WORDS,
): string {
  return words.t(CONNECTION_STATE_KEYS[state]);
}

/** The icon and the text color of each level of a request's checks. */
export const CHECK_ICONS = {
  ok: 'i-lucide-circle-check',
  warn: 'i-lucide-triangle-alert',
  fail: 'i-lucide-circle-x',
} as const;
export const CHECK_COLORS = { ok: 'text-success', warn: 'text-warning', fail: 'text-error' } as const;

/** The host of a team instance's address, the address itself when it is not a URL, and a name for none. */
export function teamInstanceHost(
  instance: string | null | undefined,
  words: RunUiWords = ENGLISH_RUN_UI_WORDS,
): string {
  if (!instance) return words.t('runui_yourTeamInstance');
  try {
    return new URL(instance).host;
  } catch {
    return instance;
  }
}

/** The number of tests a request asks for: `a test` or `3 tests`. */
export function testCountWords(count: number, words: RunUiWords = ENGLISH_RUN_UI_WORDS): string {
  return count === 1 ? words.t('runui_aTest') : words.tn('runui_tests', count);
}

/** The options of a request as short phrases. */
export function optionWords(
  options: RunRequestPromptView['options'] | null | undefined,
  words: RunUiWords = ENGLISH_RUN_UI_WORDS,
): string[] {
  if (!options) return [];
  return [
    options.headed ? words.t('runui_optionHeaded') : words.t('runui_optionHeadless'),
    options.trace ? words.t('runui_optionTrace', { mode: options.trace }) : null,
    options.repeatEach && options.repeatEach > 1
      ? words.t('runui_optionRepeat', { times: words.number(options.repeatEach) })
      : null,
    options.workers ? words.tn('runui_optionWorkers', options.workers) : null,
    options.project ? words.t('runui_optionProject', { name: options.project }) : null,
  ].filter((word): word is string => !!word);
}

/** What a card for the connection says it is for. */
export function connectionIntro(words: RunUiWords = ENGLISH_RUN_UI_WORDS): string {
  return words.t('runui_connectionIntro');
}

/** Where a folder stands in git, in words: `on main at 1a2b3c4`; empty when neither is known. */
function gitPlace(branch: string, commit: string, words: RunUiWords): string {
  if (branch && commit) return words.t('runui_checkOnBranchAt', { branch, commit });
  if (branch) return words.t('runui_checkOnBranch', { branch });
  return commit ? words.t('runui_checkAtCommit', { commit }) : '';
}

/**
 * What a check of a run request says, in the language of `words`, from its code and values; its own sentence, as the
 * host wrote it, for a code the window does not know.
 */
export function requestCheckWords(
  check: Pick<RunRequestCheckView, 'code' | 'args' | 'message'>,
  words: RunUiWords = ENGLISH_RUN_UI_WORDS,
): string {
  const value = (name: string) => String(check.args?.[name] ?? '');
  switch (check.code) {
    case 'folder-none':
      return words.t('runui_checkFolderNone');
    case 'folder-gone':
      return words.t('runui_checkFolderGone');
    case 'folder-linked':
      return words.t('runui_checkFolderLinked', { folder: value('folder') });
    case 'folder-busy':
      return words.t('runui_checkFolderBusy');
    case 'config-missing':
      return words.t('runui_checkConfigMissing');
    case 'specs-missing': {
      const more = Number(check.args?.more ?? 0);
      return more > 0
        ? words.tn('runui_checkSpecsMissingMore', more, { files: value('files') })
        : words.t('runui_checkSpecsMissing', { files: value('files') });
    }
    case 'specs-found':
      return words.t('runui_checkSpecsFound');
    case 'playwright-missing':
      return words.t('runui_checkPlaywrightMissing');
    case 'playwright-installed':
      return words.t('runui_checkPlaywrightInstalled');
    case 'commit-differs':
      return words.t('runui_checkCommitDiffers', {
        here: gitPlace(value('branch'), value('commit'), words) || words.t('runui_checkOutsideGit'),
        there: gitPlace(value('sourceBranch'), value('sourceCommit'), words),
      });
    case 'commit-same':
      return words.t('runui_checkCommitSame');
    case 'changes-uncommitted':
      return words.t('runui_checkChangesUncommitted');
    case 'command-too-long':
      return words.t('runui_checkCommandTooLong', { max: words.number(Number(check.args?.max ?? 0)) });
    default:
      return unknownCode(check.code, check.message) ?? check.message;
  }
}

/**
 * The host's own sentence, for a code a newer host sends: the compiler fails here while a code of this version is not
 * worded above.
 */
function unknownCode(_code: never, sentence: string | null): string | null {
  return sentence;
}

/**
 * Why connecting to the team instance failed, in the language of `words` when the app worded it (`errorCode`), else
 * as the instance or the network said it; null with no error.
 */
export function connectionErrorWords(
  connection: Pick<RunTargetConnectionView, 'error' | 'errorCode' | 'errorArgs'>,
  words: RunUiWords = ENGLISH_RUN_UI_WORDS,
): string | null {
  switch (connection.errorCode) {
    case 'disconnected':
      return words.t('runui_connectionErrorDisconnected');
    case 'no-answer':
      return words.t('runui_connectionErrorNoAnswer');
    case 'answered-status':
      return words.t('runui_connectionErrorStatus', { status: String(connection.errorArgs?.status ?? '') });
    case 'sign-in-timed-out':
      return words.t('runui_connectionErrorSignInTimedOut');
    case 'sign-in-expired':
      return words.t('runui_connectionErrorSignInExpired');
    case 'denied':
      return words.t('runui_connectionErrorDenied');
    case null:
      return connection.error;
    default:
      return unknownCode(connection.errorCode, connection.error);
  }
}
