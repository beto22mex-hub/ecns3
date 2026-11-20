import type { User } from '../types';
import { canonicalFamily, canonicalFamilies } from './families';
import { taskRecipients, escapeEmailHtml as h } from './taskOwnership';

export const REMINDER_DAYS = [5, 3, 1] as const;
export interface ReminderTask {
    id: string; ecnId: string; family: string; department: string; taskName: string;
    status: string; dueDate: string | Date; assignedUserId?: string; createdAt?: string | Date;
}
export interface ReminderContext { description: string; changes: Record<string, any>[] }
export interface ReminderDelivery { task: ReminderTask; user: User; days: number; dueDate: string; today: string }

export function calendarDate(now: Date, timeZone = 'America/Denver'): string {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const part = (type: string) => parts.find(item => item.type === type)!.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
}

export function reminderOffset(task: ReminderTask, today: string): number | undefined {
    if (!['Pendiente', 'En Proceso'].includes(task.status) || !task.dueDate) return;
    const due = task.dueDate instanceof Date ? task.dueDate.toISOString().slice(0, 10) : task.dueDate.slice(0, 10);
    const days = (Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000;
    return REMINDER_DAYS.some(offset => offset === days) ? days : undefined;
}

export function reminderHtml(delivery: ReminderDelivery, context: ReminderContext): string {
    const { task, user, days, dueDate } = delivery;
    const rows = context.changes.map(change => `<tr>${[canonicalFamily(change.family), change.sku, change.assembly, change.old_component, change.new_component, change.old_subassembly, change.new_subassembly].map(value => `<td style="border:1px solid #ccc;padding:6px">${h(value || '—')}</td>`).join('')}</tr>`).join('');
    return `<h2>Recordatorio: tarea por vencer en ${days} día(s)</h2><p>Hola ${h(user.name)}.</p>
        <p><strong>ECN:</strong> ${h(task.ecnId)} — ${h(context.description)}</p>
        <p><strong>Tarea:</strong> ${h(task.taskName)}</p><p><strong>Departamento:</strong> ${h(task.department)}</p>
        <p><strong>Familia:</strong> ${h(canonicalFamily(task.family))}</p><p><strong>Vencimiento:</strong> ${h(dueDate)}</p>
        <table style="border-collapse:collapse"><thead><tr>${['Familia', 'SKU', 'Ensamble', 'Componente viejo', 'Componente nuevo', 'Subensamble viejo', 'Subensamble nuevo'].map(label => `<th>${label}</th>`).join('')}</tr></thead>
        <tbody>${rows || '<tr><td colspan="7">Sin números de parte registrados.</td></tr>'}</tbody></table>`;
}

export async function runTaskReminders(deps: {
    today: string;
    getTasks(): Promise<ReminderTask[]>;
    getUsers(): Promise<User[]>;
    getContext(task: ReminderTask): Promise<ReminderContext>;
    claim(delivery: ReminderDelivery): Promise<string | undefined>;
    send(delivery: ReminderDelivery, context: ReminderContext): Promise<void>;
    finish(delivery: ReminderDelivery, token: string, sent: boolean): Promise<void>;
    onError(error: unknown): void;
}): Promise<void> {
    const tasks = await deps.getTasks();
    if (!tasks.length) return;
    const users = await deps.getUsers();
    for (const task of tasks) {
        const days = reminderOffset(task, deps.today);
        if (days === undefined) continue;
        try {
            const context = await deps.getContext(task);
            const family = canonicalFamily(task.family);
            const families = family && family !== 'GENERAL' ? [family] : canonicalFamilies(context.changes.map(change => change.family));
            const recipients = taskRecipients(users, task.department, families, task.assignedUserId);
            for (const user of recipients) {
                if (!user.email) continue;
                const delivery = { task, user, days, dueDate: task.dueDate instanceof Date ? task.dueDate.toISOString().slice(0, 10) : task.dueDate.slice(0, 10), today: deps.today };
                const token = await deps.claim(delivery);
                if (!token) continue;
                try {
                    await deps.send(delivery, context);
                    await deps.finish(delivery, token, true);
                } catch (error) {
                    await deps.finish(delivery, token, false);
                    deps.onError(error);
                }
            }
        } catch (error) { deps.onError(error); }
    }
}
