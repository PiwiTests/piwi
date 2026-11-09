import { describe, expect, it } from 'vitest';
import { desktopNotification } from '../../server/utils/desktop-notifications';

/** What `GET /api/desktop/notifications` sends the desktop shell for each notification event. */
describe('desktopNotification', () => {
  it('renders a failed run as the page’s browser notification does, with the run to open', () => {
    expect(
      desktopNotification({
        type: 'run.failed',
        projectId: 3,
        projectName: 'acme-web',
        runId: 146,
        branch: 'main',
        failedTests: 3,
        totalTests: 120,
        topFailures: [{ title: 'checkout › pays' }],
      }),
    ).toEqual({
      type: 'run.failed',
      projectId: 3,
      title: 'Piwi Dashboard',
      body: 'acme-web on main: 3/120 tests failed\n3 failed, 120 total\ncheckout › pays',
      path: '/test-runs/146',
      defaultOn: true,
    });
  });

  it('says which events a project nobody chose events for notifies on', () => {
    const cluster = desktopNotification({ type: 'cluster.new', projectId: 3, projectName: 'acme-web', clusterId: 9 });
    expect(cluster).toMatchObject({ path: '/failure-clusters/9', defaultOn: false });
    const incident = desktopNotification({ type: 'environment.incident', projectId: 3, reason: 'DNS failures' });
    expect(incident).toMatchObject({ defaultOn: true, body: 'Project #3: environment incident\nDNS failures' });
  });

  it('keeps a quality report, which is about no one project', () => {
    expect(desktopNotification({ type: 'report.ready', snapshotId: 4, title: 'Weekly' })).toMatchObject({
      projectId: null,
      body: 'Your quality report is ready: Weekly',
      path: '/reports/4',
    });
  });

  it('leaves out a run the app started, and an event with nothing to say', () => {
    expect(
      desktopNotification({ type: 'run.failed', projectId: 3, runId: 146, origin: 'desktop', failedTests: 1 }),
    ).toBeNull();
    expect(desktopNotification({ type: 'diagnosis.completed', projectId: 3 })).toBeNull();
    expect(desktopNotification({ type: 'auto_heal.pr_opened', projectId: 3 })).toBeNull();
  });
});
