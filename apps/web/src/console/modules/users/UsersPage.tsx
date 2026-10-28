// Users & roles (read-only): directory of demo users and the role -> permission matrix.
import { ROLE_PERMISSIONS, type Permission, type Role } from '@ct/contracts/browser';
import { opsApi, type UserWithPermissions } from '../../api';
import { ROLE_LABEL } from '../../shell/SignInPage';
import { useSession } from '../../session';
import { Avatar, Badge, Banner, Card, DataTable, Icon, Page, PageHeader, isForbidden, useApi, type Column } from '../../ui';

const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];

const PERMISSION_GROUPS: { label: string; perms: { id: Permission; text: string }[] }[] = [
  { label: 'Payments', perms: [
    { id: 'payments.read', text: 'View payments' },
    { id: 'payments.retry', text: 'Retry failed payments' },
    { id: 'payments.refund.request', text: 'Request refunds' },
    { id: 'payments.refund.approve', text: 'Approve refunds (four-eyes)' },
  ] },
  { label: 'Risk & compliance', perms: [
    { id: 'alerts.read', text: 'View alerts and cases' },
    { id: 'cases.work', text: 'Work cases (assign, notes)' },
    { id: 'cases.decide', text: 'Decide cases' },
    { id: 'cases.approve', text: 'Approve high-risk decisions' },
  ] },
  { label: 'Treasury', perms: [
    { id: 'recon.read', text: 'View reconciliation' },
    { id: 'recon.resolve', text: 'Resolve breaks' },
  ] },
  { label: 'Platform', perms: [
    { id: 'config.read', text: 'View configuration' },
    { id: 'config.request', text: 'Request config changes' },
    { id: 'config.approve', text: 'Approve config changes' },
    { id: 'audit.read', text: 'Read the audit log' },
    { id: 'users.read', text: 'View users and roles' },
    { id: 'developer.manage', text: 'Manage API keys & webhooks' },
  ] },
];

export default function UsersPage() {
  const { user } = useSession();
  const users = useApi((s) => opsApi.users(s), []);
  const cols: Column<UserWithPermissions>[] = [
    {
      id: 'name',
      header: 'User',
      cell: (u) => (
        <div className="ct-row">
          <Avatar initials={u.initials} />
          <div>
            <div className="ct-strong">{u.name} {u.id === user?.id && <Badge tone="info">You</Badge>}</div>
            <div className="ct-small ct-muted">{u.title}</div>
          </div>
        </div>
      ),
      sortValue: (u) => u.name,
    },
    { id: 'role', header: 'Role', cell: (u) => <Badge tone="accent">{ROLE_LABEL[u.role] ?? u.role}</Badge>, sortValue: (u) => u.role },
    { id: 'id', header: 'User ID', cell: (u) => <span className="ct-mono">{u.id}</span> },
    { id: 'perms', header: 'Permissions', numeric: true, cell: (u) => (u.permissions ?? ROLE_PERMISSIONS[u.role]).length, sortValue: (u) => (u.permissions ?? ROLE_PERMISSIONS[u.role]).length },
    { id: 'status', header: 'Status', cell: () => <Badge tone="ok" dot>Active</Badge> },
  ];
  return (
    <Page>
      <PageHeader title="Users & roles" subtitle="Who can do what. Roles are fixed in the demo environment; this view is read-only." />
      <div className="ct-stack">
        <Banner tone="info">All users are fictional demo identities. Role changes would go through a maker-checker change request in production.</Banner>
        <Card title="Users" subtitle={users.data ? `${users.data.length} users` : undefined} flush>
          <DataTable columns={cols} rows={users.data} rowKey={(u) => u.id} loading={users.loading} error={users.error} forbidden={isForbidden(users.errorObj)} onRetry={users.refresh} skeletonRows={6} initialSort={{ key: 'role', dir: 'asc' }} />
        </Card>
        <Card title="Permission matrix" subtitle="Roles × permissions (from the platform contract)" flush>
          <div className="ct-table-wrap">
            <table className="ct-table ct-table-compact ct-matrix">
              <thead>
                <tr>
                  <th>Permission</th>
                  {ROLES.map((r) => (
                    <th key={r} style={{ textAlign: 'center' }}>{ROLE_LABEL[r]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERMISSION_GROUPS.map((g) => [
                  <tr key={g.label}>
                    <td colSpan={ROLES.length + 1} style={{ background: 'var(--ct-surface-2)', fontWeight: 600, fontSize: 12 }}>{g.label}</td>
                  </tr>,
                  ...g.perms.map((p) => (
                    <tr key={p.id}>
                      <td>
                        {p.text} <code className="ct-small">{p.id}</code>
                      </td>
                      {ROLES.map((r) => {
                        const yes = ROLE_PERMISSIONS[r].includes(p.id);
                        return (
                          <td key={r} aria-label={`${ROLE_LABEL[r]}: ${yes ? 'granted' : 'not granted'}`}>
                            {yes ? <Icon name="check" className="ct-yes" /> : <span className="ct-no">—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  )),
                ])}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </Page>
  );
}
