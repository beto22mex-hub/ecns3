import type { User } from '../types';
import { canonicalDepartment } from './departments';
import { canonicalFamilies, canonicalFamily } from './families';

export const CHANGE_COORDINATOR_ROLE = 'engineering-change-coordinator';

export const normalizeResponsibility = (value: string) => value.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

export function parseUserFamilies(value: unknown): string[] {
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { return []; }
    }
    return Array.isArray(value) ? canonicalFamilies(value) : [];
}

export function taskRecipients(users: User[], department: string, families: string[], assignedUserId?: string): User[] {
    if (assignedUserId) return users.filter(user => user.id === assignedUserId);
    const normalizeDepartment = (value: string) => {
        return normalizeResponsibility(canonicalDepartment(value) || value);
    };
    const coordinatorTask = normalizeResponsibility(department) === 'coordinacion de cambios de ingenieria';
    return users.filter(user => {
        const responsible = coordinatorTask
            ? user.taskRole === CHANGE_COORDINATOR_ROLE
            : normalizeDepartment(user.department || '') === normalizeDepartment(department);
        return responsible && parseUserFamilies(user.families).some(family => families.some(target => canonicalFamily(target) === family));
    });
}

export const escapeEmailHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]!));
