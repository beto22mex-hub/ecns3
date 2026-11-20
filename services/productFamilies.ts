import catalog from './productFamilyCatalog.json';
import { canonicalFamily } from './families';

export const normalizeProduct = (value: unknown): string => String(value ?? '').trim().toUpperCase();
export const PRODUCT_FAMILY_CATALOG = catalog;
const families = new Map(catalog.map(row => [normalizeProduct(row.product), canonicalFamily(row.family)]));

export function productFamily(sku: unknown, assembly: unknown): string | undefined {
    return families.get(normalizeProduct(sku)) || families.get(normalizeProduct(assembly));
}

export const PRODUCT_FAMILY_UPDATE_SQL = `
    UPDATE c SET family = COALESCE(skuMatch.family, assemblyMatch.family)
    FROM dbo.component_changes AS c
    LEFT JOIN dbo.product_family_catalog AS skuMatch ON UPPER(LTRIM(RTRIM(c.sku))) = skuMatch.product
    LEFT JOIN dbo.product_family_catalog AS assemblyMatch ON UPPER(LTRIM(RTRIM(c.assembly))) = assemblyMatch.product
    WHERE COALESCE(skuMatch.family, assemblyMatch.family) IS NOT NULL
      AND ISNULL(c.family, '') COLLATE Latin1_General_100_BIN2 <> COALESCE(skuMatch.family, assemblyMatch.family) COLLATE Latin1_General_100_BIN2;
`;
