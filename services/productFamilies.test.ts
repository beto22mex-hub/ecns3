import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT_FAMILY_CATALOG, productFamily } from './productFamilies';

test('contains all 460 unique products and the six supplied SBU families', () => {
    assert.equal(PRODUCT_FAMILY_CATALOG.length, 460);
    assert.equal(new Set(PRODUCT_FAMILY_CATALOG.map(row => row.product)).size, 460);
    const counts = Object.fromEntries([...new Set(PRODUCT_FAMILY_CATALOG.map(row => row.family))].sort().map(family => [family, PRODUCT_FAMILY_CATALOG.filter(row => row.family === family).length]));
    assert.deepEqual(counts, { AMCO: 142, AV: 203, FIPLEX: 61, 'HEAT DETECTOR': 8, 'LI-ION TAMER': 21, SECURITY: 25 });
});

test('matches every supplied product in either SKU or assembly with case and whitespace normalization', () => {
    for (const row of PRODUCT_FAMILY_CATALOG) {
        assert.equal(productFamily(` ${row.product.toLowerCase()} `, ''), row.family);
        assert.equal(productFamily('unknown', row.product), row.family);
    }
});

test('SKU takes precedence when assembly points to another family', () => {
    const amco = PRODUCT_FAMILY_CATALOG.find(row => row.family === 'AMCO')!;
    const av = PRODUCT_FAMILY_CATALOG.find(row => row.family === 'AV')!;
    assert.equal(productFamily(av.product, amco.product), 'AV');
});

test('unknown products are left alone and partial matches do not change unrelated parts', () => {
    assert.equal(productFamily('unknown', null), undefined);
    assert.equal(productFamily('', ''), undefined);
    assert.equal(productFamily('A2143-20-EXTRA', 'unknown'), undefined);
});
