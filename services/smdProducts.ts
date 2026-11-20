import catalog from './smdProductCatalog.json';
import { normalizeProduct } from './productFamilies';
import { canonicalFamily } from './families';

export const SMD_PRODUCT_CATALOG = catalog;
export const smdBase = (value: unknown) => normalizeProduct(value).replace(/-\d{3}$/, '');
export const parseSmdAssemblies = (value: unknown): string[] => [...new Set(String(value ?? '').split(/[;,\n|]+/).map(normalizeProduct).filter(Boolean))];
export interface SmdProductLink { changeId?: string; ecnId?: string; sku: string; family: string; smdBase: string; matchedPart: string; sourceField: string }
const fields = ['assembly', 'old_subassembly', 'new_subassembly', 'old_component', 'new_component'] as const;
const catalogByBase = new Map<string, typeof catalog>();
for (const item of catalog) {
    const base = smdBase(item.smd);
    catalogByBase.set(base, [...(catalogByBase.get(base) || []), item]);
}

export function matchSmdProducts(change: Record<string, any>): SmdProductLink[] {
    const result: SmdProductLink[] = [];
    for (const field of fields) {
        const part = normalizeProduct(change[field]);
        for (const item of catalogByBase.get(smdBase(part)) || []) result.push({
            changeId: change.id, ecnId: change.ecn_id, sku: item.product, family: canonicalFamily(item.family),
            smdBase: smdBase(item.smd), matchedPart: part, sourceField: field
        });
    }
    return result;
}

export function relatedSmdData(change: Record<string, any>, links: SmdProductLink[]) {
    const relatedProducts = [...new Map(links.map(link => [`${link.sku}/${link.family}`, { sku: link.sku, family: link.family }])).values()];
    return {
        relatedProducts,
        relatedSkus: [...new Set([change.sku, ...relatedProducts.map(item => item.sku)].filter(Boolean))].sort(),
        relatedFamilies: [...new Set([canonicalFamily(change.family), ...relatedProducts.map(item => item.family)].filter(Boolean))].sort()
    };
}

export const SMD_LINK_VIEW_SQL = `
    ALTER VIEW dbo.component_change_smd_products AS
    SELECT DISTINCT c.id AS changeId, c.ecn_id AS ecnId, p.product AS sku, p.family,
        m.smd_base AS smdBase, part.part_number AS matchedPart, part.source_field AS sourceField
    FROM dbo.component_changes c
    CROSS APPLY (VALUES (c.assembly, 'assembly'), (c.old_subassembly, 'old_subassembly'),
        (c.new_subassembly, 'new_subassembly'), (c.old_component, 'old_component'),
        (c.new_component, 'new_component')) part(part_number, source_field)
    CROSS APPLY (SELECT UPPER(LTRIM(RTRIM(part.part_number))) AS value) normalized
    INNER JOIN dbo.smd_product_catalog m ON m.smd_base = CASE
        WHEN LEN(normalized.value)>4 AND RIGHT(normalized.value,4) LIKE '-[0-9][0-9][0-9]'
        THEN LEFT(normalized.value,LEN(normalized.value)-4) ELSE normalized.value END
    INNER JOIN dbo.product_family_catalog p ON p.product=m.product;
`;
