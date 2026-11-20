const FAMILY_ALIASES: Record<string, string> = {
    'SOUNDER BA': 'AMCO',
    'SOUNDER BASE': 'AMCO',
    'LI-ON': 'LI-ION TAMER'
};

export function canonicalFamily(value: unknown): string {
    const normalized = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toUpperCase() : '';
    if (/\b(?:AV|LEDS?|LS[\s-]*LF|OLYMPIA|P\s*52|ZEUS)\b/.test(normalized)) return 'AV';
    return FAMILY_ALIASES[normalized] || normalized;
}

export function canonicalFamilies(values: unknown[]): string[] {
    return [...new Set(values.map(canonicalFamily).filter(Boolean))];
}

export function normalizeFamilyData(value: any): any {
    if (Array.isArray(value)) return value.map(normalizeFamilyData);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if ((key === 'family' || key === 'Family') && typeof item === 'string') return [key, canonicalFamily(item)];
        if (key === 'families' && Array.isArray(item)) return [key, canonicalFamilies(item)];
        if (key === 'familyList' && typeof item === 'string') return [key, canonicalFamilies(item.split(',')).join(', ')];
        return [key, normalizeFamilyData(item)];
    }));
}
