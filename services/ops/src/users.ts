// Fictional demo users (synthetic; no real people). Two analysts and two managers so four-eyes can be shown.
import { ROLE_PERMISSIONS, type Actor, type DemoUser, type Permission, type Role, type Severity } from '@ct/contracts';

export const DEMO_USERS: readonly DemoUser[] = [
  { id: 'u-maya', name: 'Maya Chen', title: 'Payment Operations Analyst', role: 'ops_analyst', initials: 'MC' },
  { id: 'u-daniel', name: 'Daniel Okafor', title: 'Compliance Analyst', role: 'compliance_analyst', initials: 'DO' },
  { id: 'u-amara', name: 'Amara Nwosu', title: 'Senior Compliance Analyst', role: 'compliance_analyst', initials: 'AN' },
  { id: 'u-priya', name: 'Priya Raman', title: 'Compliance Manager', role: 'compliance_manager', initials: 'PR' },
  { id: 'u-tomas', name: 'Tomas Lindqvist', title: 'Head of Financial Crime', role: 'compliance_manager', initials: 'TL' },
  { id: 'u-lucas', name: 'Lucas Meyer', title: 'Treasury Manager', role: 'treasury', initials: 'LM' },
  { id: 'u-sofia', name: 'Sofia Alvarez', title: 'Platform Administrator', role: 'admin', initials: 'SA' },
  { id: 'u-ken', name: 'Ken Adeyemi', title: 'Platform Engineer (Admin)', role: 'admin', initials: 'KA' },
  { id: 'u-hiro', name: 'Hiro Tanaka', title: 'Internal Auditor', role: 'auditor', initials: 'HT' },
];

export function findUser(id: string): DemoUser | undefined {
  return DEMO_USERS.find((u) => u.id === id);
}

export function permissionsOf(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function hasPermission(user: DemoUser, p: Permission): boolean {
  return ROLE_PERMISSIONS[user.role].includes(p);
}

export function actorOf(user: DemoUser): Actor {
  return { userId: user.id, name: user.name, role: user.role };
}

export const SYSTEM_ACTOR = { userId: 'system', name: 'System', role: 'system' } as const;

export const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

/** Case SLA by priority (minutes). */
export const SLA_MINUTES: Record<Severity, number> = { critical: 15, high: 60, medium: 240, low: 1440 };

/** Decisions on these priorities need a second person (cases.approve, different user) before they take effect. */
export function needsFourEyes(priority: Severity): boolean {
  return priority === 'high' || priority === 'critical';
}
