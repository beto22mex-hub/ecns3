import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { User } from '../types';
import { CHANGE_COORDINATOR_ROLE, escapeEmailHtml, parseUserFamilies, taskRecipients } from './taskOwnership';
import { canonicalDepartment, DEPARTMENTS } from './departments';

test('department catalog contains the 13 approved departments and rejects unknown entries', () => {
    assert.equal(DEPARTMENTS.length, 13);
    assert.equal(canonicalDepartment(' ingenieria de diseño '), 'Ingeniería de Diseño');
    assert.equal(canonicalDepartment('Planeacion (Produccion)'), 'Planeación (Producción)');
    assert.equal(canonicalDepartment('Operaciones / Producción'), 'Producción');
    assert.equal(canonicalDepartment('Ingeniería de Calidad'), 'Calidad');
    assert.equal(canonicalDepartment('Engineering'), undefined);
    assert.equal(canonicalDepartment(null), undefined);
});

test('legacy quality departments continue to receive tasks under the standardized name', () => {
    const user: User = { id: 'quality', name: 'Calidad', email: 'q@example.com', department: 'Ingeniería de Calidad', families: ['VESDA'] };
    assert.equal(taskRecipients([user], 'Calidad', ['VESDA']).length, 1);
});

const users: User[] = [
    { id: 'finance-a', name: 'Finanzas A', email: 'a@example.com', department: 'Finanzas', families: ['VESDA', 'FAAST'] },
    { id: 'finance-b', name: 'Finanzas B', email: 'b@example.com', department: 'Finanzas', families: ['Otra'] },
    { id: 'production', name: 'Producción', email: 'p@example.com', department: 'Producción', families: ['VESDA'] },
    { id: 'coordinator', name: 'Coordinador', email: 'c@example.com', department: 'Ingeniería de Producto', taskRole: CHANGE_COORDINATOR_ROLE, families: ['VESDA'] },
];

test('matches department and any owned family, with case and accent normalization', () => {
    assert.deepEqual(taskRecipients(users, ' finanzas ', ['vesda']).map(user => user.id), ['finance-a']);
    assert.deepEqual(taskRecipients(users, 'Operaciones / Producción', ['VESDA']).map(user => user.id), ['production']);
});

test('uses the explicit coordinator role, across departments, and respects family ownership', () => {
    assert.deepEqual(taskRecipients(users, 'Coordinación de Cambios de Ingeniería', ['VESDA']).map(user => user.id), ['coordinator']);
    assert.equal(taskRecipients(users, 'Coordinación de Cambios de Ingeniería', ['Otra']).length, 0);
});

test('notifies all matching owners and does not select arbitrary unrelated users', () => {
    assert.equal(taskRecipients(users, 'Finanzas', ['VESDA', 'Otra']).length, 2);
    assert.equal(taskRecipients(users, 'Aduanas', ['VESDA']).length, 0);
    assert.equal(taskRecipients(users, 'Finanzas', []).length, 0);
});

test('manual assignment overrides automatic routing and unknown IDs do not match', () => {
    assert.deepEqual(taskRecipients(users, 'Finanzas', ['Otra'], 'production').map(user => user.id), ['production']);
    assert.equal(taskRecipients(users, 'Finanzas', ['VESDA'], 'unknown').length, 0);
});

test('reads SQL JSON families and rejects invalid or empty entries', () => {
    assert.deepEqual(parseUserFamilies('["VESDA", " FAAST ", "VESDA", null, ""]'), ['VESDA', 'FAAST']);
    assert.deepEqual(parseUserFamilies('invalid'), []);
    assert.deepEqual(parseUserFamilies(null), []);
});

test('escapes task, ECN and part data before inserting it into email HTML', () => {
    assert.equal(escapeEmailHtml('<SKU & "part">'), '&lt;SKU &amp; &quot;part&quot;&gt;');
});
