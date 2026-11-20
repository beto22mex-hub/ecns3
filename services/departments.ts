export const DEPARTMENTS = [
    'Ingeniería de Manufactura',
    'Aduanas',
    'Materiales',
    'Planeación (Compras)',
    'Planeación (Producción)',
    'Sourcing',
    'Calidad',
    'Producción',
    'HSE (Seguridad)',
    'Recursos Humanos',
    'Ingeniería de Prueba',
    'Ingeniería de Diseño',
    'Finanzas'
].sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));

const key = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

export function canonicalDepartment(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = key(value);
    if (normalized === 'operaciones / produccion') return 'Producción';
    if (normalized === 'ingenieria de calidad') return 'Calidad';
    return DEPARTMENTS.find(department => key(department) === normalized);
}
