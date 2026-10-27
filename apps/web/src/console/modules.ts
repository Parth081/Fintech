// Module registry: the shell builds the sidebar and routes from this list.
//   { id, label, icon, path, group, permission, component (lazy) }
// A module's component is a default-exported page; it reads its own sub-route with useConsoleRoute().
// Several entries may share one component (e.g. Alerts and Cases both load modules/risk and pick their
// view from the path: risk/alerts..., risk/cases...).
//
// Modules owned by other engineers (risk, treasury, config) are found with import.meta.glob, so the build
// works before their index.tsx exists; until then the entry renders a "coming soon" page.
import { createElement, lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { NavEntry } from './lib/nav';
import type { IconName } from './ui/Icon';
import { ComingSoon } from './ui/ComingSoon';

export type { NavEntry, NavGroup } from './lib/nav';

export interface ConsoleModule extends NavEntry {
  icon: IconName;
  component: LazyExoticComponent<ComponentType>;
  /** One line for the page header / search hints. */
  description?: string;
}

const external = import.meta.glob<{ default: ComponentType }>('./modules/{risk,treasury,config}/index.tsx');
const loaders = new Map<string, LazyExoticComponent<ComponentType>>();

/** Lazy component for a module folder that may not exist yet (falls back to "coming soon"). */
function guarded(folder: 'risk' | 'treasury' | 'config', title: string): LazyExoticComponent<ComponentType> {
  const cached = loaders.get(folder);
  if (cached) return cached;
  const load = external[`./modules/${folder}/index.tsx`];
  const component = lazy(async () => {
    if (load) {
      try {
        const mod = await load();
        if (mod && typeof mod.default === 'function') return mod;
      } catch (err) {
        console.error(`[console] module ${folder} failed to load`, err);
      }
    }
    return { default: () => createElement(ComingSoon, { title }) };
  });
  loaders.set(folder, component);
  return component;
}

const Overview = lazy(() => import('./modules/overview/OverviewPage'));
const Payments = lazy(() => import('./modules/payments/PaymentsModule'));
const Audit = lazy(() => import('./modules/audit/AuditPage'));
const Users = lazy(() => import('./modules/users/UsersPage'));
const Developers = lazy(() => import('./modules/developers/DevelopersPage'));

export const MODULES: readonly ConsoleModule[] = [
  { id: 'overview', label: 'Overview', icon: 'home', path: '', group: 'Operate', permission: null, component: Overview, description: 'Today across payments, risk, treasury and change control' },
  { id: 'payments', label: 'Payments', icon: 'payments', path: 'payments', group: 'Operate', permission: 'payments.read', component: Payments, description: 'Search, inspect and act on payments' },
  { id: 'refunds', label: 'Refunds', icon: 'refund', path: 'payments/refunds', group: 'Operate', permission: ['payments.refund.request', 'payments.refund.approve'], component: Payments, description: 'Refund requests and four-eyes approval' },
  { id: 'alerts', label: 'Alerts', icon: 'alert', path: 'risk/alerts', group: 'Risk & Compliance', permission: 'alerts.read', component: guarded('risk', 'Alerts & cases'), description: 'Sanctions, fraud and AML alerts' },
  { id: 'cases', label: 'Cases', icon: 'cases', path: 'risk/cases', group: 'Risk & Compliance', permission: 'alerts.read', component: guarded('risk', 'Alerts & cases'), description: 'Investigation and decisions' },
  { id: 'risk', label: 'Risk', icon: 'alert', path: 'risk', group: 'Risk & Compliance', permission: 'alerts.read', component: guarded('risk', 'Alerts & cases'), hidden: true },
  { id: 'treasury', label: 'Treasury & recon', icon: 'bank', path: 'treasury', group: 'Treasury', permission: 'recon.read', component: guarded('treasury', 'Treasury & reconciliation'), description: 'Positions, statements and reconciliation breaks' },
  { id: 'routing', label: 'Routing & providers', icon: 'routing', path: 'config', group: 'Platform', permission: 'config.read', component: guarded('config', 'Routing & providers'), description: 'Providers, routing rules and limits' },
  { id: 'changes', label: 'Change requests', icon: 'changes', path: 'config/changes', group: 'Platform', permission: 'config.read', component: guarded('config', 'Change requests'), description: 'Maker-checker configuration changes' },
  { id: 'audit', label: 'Audit log', icon: 'audit', path: 'audit', group: 'Platform', permission: 'audit.read', component: Audit, description: 'Every operator action, immutable' },
  { id: 'users', label: 'Users & roles', icon: 'users', path: 'users', group: 'Platform', permission: 'users.read', component: Users, description: 'Who can do what' },
  { id: 'developers', label: 'Developers', icon: 'code', path: 'developers', group: 'Platform', permission: 'developer.manage', component: Developers, description: 'API keys, webhooks and API reference' },
];
