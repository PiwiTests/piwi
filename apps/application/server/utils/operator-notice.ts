import type { DrizzleDB } from '#shared/handlers/db';
import { storedNotice, type OperatorNotice } from '#shared/operator-notice';
import { deleteAppSetting, getAppSetting, setAppSetting } from './app-settings';

/** The `app_settings` key the operator's notice is kept under. */
const NOTICE_KEY = 'operator_notice';

/** The notice the operator set, ended or not; null when none is set or the stored value is not one. */
export async function readOperatorNotice(db: DrizzleDB): Promise<OperatorNotice | null> {
  return storedNotice(await getAppSetting<unknown>(db, NOTICE_KEY));
}

export async function writeOperatorNotice(db: DrizzleDB, notice: OperatorNotice): Promise<void> {
  await setAppSetting(db, NOTICE_KEY, notice);
}

export async function clearOperatorNotice(db: DrizzleDB): Promise<void> {
  await deleteAppSetting(db, NOTICE_KEY);
}
