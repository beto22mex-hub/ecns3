import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarDate, reminderOffset, reminderHtml, runTaskReminders, type ReminderTask, type ReminderDelivery } from './taskReminders';
import { canonicalFamily, canonicalFamilies, normalizeFamilyData } from './families';
import type { User } from '../types';

const task: ReminderTask = { id: 'task', ecnId: 'ECN-123', taskName: 'Costeo <material>', family: 'sounder ba', department: 'Finanzas', status: 'Pendiente', dueDate: '2026-11-24' };
const user: User = { id: 'owner', name: 'Responsable', email: 'owner@example.com', department: 'Finanzas', families: ['SOUNDER BASE'] };
const context = { description: 'Cambio & prueba', changes: [{ family: 'sounder ba', sku: 'SKU-1', assembly: 'ASM-1', old_component: 'OLD-1', new_component: 'NEW-1' }] };

test('unifies case, whitespace and explicit family aliases without merging distinct families', () => {
    assert.equal(canonicalFamily(' sounder   ba '), 'AMCO');
    assert.deepEqual(canonicalFamilies(['sounder ba', 'SOUNDER BASE', 'amco', 'vesda', 'VESDA', '']), ['AMCO', 'VESDA']);
    assert.equal(canonicalFamily('li-on'), 'LI-ION TAMER');
    assert.deepEqual(canonicalFamilies(['LI-ON', 'li-ion tamer']), ['LI-ION TAMER']);
    assert.equal(canonicalFamily('Sounder Base Plus'), 'SOUNDER BASE PLUS');
    for (const family of ['av', 'LED', 'led wall', 'LS-LF', 'ls lf', 'Olympia P52', 'Olympia', 'P52', 'Zeus', 'Serie Zeus nueva']) assert.equal(canonicalFamily(family), 'AV');
    assert.equal(canonicalFamily('CAVITY'), 'CAVITY');
    assert.deepEqual(normalizeFamilyData({ familyList: 'sounder ba, SOUNDER BASE', changes: [{ family: 'vesda' }] }), { familyList: 'AMCO', changes: [{ family: 'VESDA' }] });
});

test('reminds only at 5, 3 and 1 calendar days for open tasks', () => {
    for (const [today, expected] of [['2026-11-19', 5], ['2026-11-21', 3], ['2026-11-23', 1]] as const) assert.equal(reminderOffset(task, today), expected);
    for (const today of ['2026-11-20', '2026-11-24', '2026-11-25']) assert.equal(reminderOffset(task, today), undefined);
    for (const status of ['Completado', 'Cancelado']) assert.equal(reminderOffset({ ...task, status }, '2026-11-19'), undefined);
    assert.equal(reminderOffset({ ...task, status: 'En Proceso' }, '2026-11-19'), 5);
});

test('calendar dates use the configured timezone and ignore daylight-saving hour differences', () => {
    assert.equal(calendarDate(new Date('2026-11-20T01:00:00Z')), '2026-11-19');
    assert.equal(reminderOffset({ ...task, dueDate: '2026-11-03' }, '2026-10-29'), 5);
    assert.equal(reminderOffset({ ...task, dueDate: new Date('2026-11-24T00:00:00Z') }, '2026-11-19'), 5);
});

test('reminder includes task, ECN, old and new parts, SKU and escaped content', () => {
    const html = reminderHtml({ task, user, today: '2026-11-19', dueDate: '2026-11-24', days: 5 }, context);
    for (const value of ['ECN-123', 'SKU-1', 'ASM-1', 'OLD-1', 'NEW-1', 'AMCO', '2026-11-24', 'Costeo &lt;material&gt;', 'Cambio &amp; prueba']) assert.ok(html.includes(value));
});

function fixture() {
    const sent = new Set<string>();
    const claims = new Set<string>();
    const deliveries: ReminderDelivery[] = [];
    const errors: unknown[] = [];
    const key = (delivery: ReminderDelivery) => `${delivery.task.id}/${delivery.user.id}/${delivery.dueDate}/${delivery.days}`;
    const deps = {
        today: '2026-11-19', getTasks: async () => [task], getUsers: async () => [user], getContext: async () => context,
        claim: async (delivery: ReminderDelivery) => { const id = key(delivery); if (sent.has(id) || claims.has(id)) return; claims.add(id); return id; },
        send: async (delivery: ReminderDelivery) => { deliveries.push(delivery); },
        finish: async (_delivery: ReminderDelivery, token: string, success: boolean) => { claims.delete(token); if (success) sent.add(token); },
        onError: (error: unknown) => { errors.push(error); }
    };
    return { deps, deliveries, errors };
}

test('repeated scheduler checks send each milestone once per recipient and changed due dates get a new reminder', async () => {
    const { deps, deliveries } = fixture();
    await runTaskReminders(deps); await runTaskReminders(deps);
    assert.equal(deliveries.length, 1);
    deps.today = '2026-11-21'; await runTaskReminders(deps);
    assert.equal(deliveries.length, 2);
    deps.getTasks = async () => [{ ...task, dueDate: '2026-11-26' }]; await runTaskReminders(deps);
    assert.equal(deliveries.length, 3);
});

test('SMTP failure releases the claim so a later check can retry', async () => {
    const { deps, deliveries, errors } = fixture();
    const send = deps.send;
    deps.send = async () => { throw new Error('SMTP offline'); };
    await runTaskReminders(deps);
    assert.equal(errors.length, 1);
    deps.send = send; await runTaskReminders(deps);
    assert.equal(deliveries.length, 1);
});

test('does not send to users outside the task department and family or for closed tasks', async () => {
    const { deps, deliveries } = fixture();
    deps.getUsers = async () => [{ ...user, families: ['OTHER'] }]; await runTaskReminders(deps);
    deps.getUsers = async () => [user]; deps.getTasks = async () => [{ ...task, status: 'Completado' }]; await runTaskReminders(deps);
    assert.equal(deliveries.length, 0);
});
